/**
 * Runs an intake flow against one inbound WhatsApp message.
 *
 * The split of labour matters: the *shape* of the conversation — which step is
 * next, which branch a choice takes, when to stop — is decided here, in code,
 * from the flow the owner drew. Gemini is only ever asked to read answers out
 * of free text and to write a short acknowledgement. It cannot invent a
 * question, skip one, or decide someone is qualified.
 *
 * That also means the number keeps working when Gemini doesn't: with no model,
 * an ai question simply takes the whole message as its answer and the flow
 * carries on.
 */

import { generateJson } from "./gemini.js";
import {
  type Clause,
  type Condition,
  type EndStep,
  type Flow,
  type Option,
  type Outcome,
  type QuestionStep,
  type Step,
  isObject,
} from "./flow.js";

export type Verdict = "qualified" | "unqualified" | "needs_info" | "handoff";

/** Where a conversation stands. Persisted on conversations.flow_state. */
export type FlowState = {
  /** The question awaiting an answer, or null before the first reply. */
  at: string | null;
  answers: Record<string, string | null>;
  /** Failed attempts per step, so a question can't loop forever. */
  retries: Record<string, number>;
  done: boolean;
  outcome: Outcome | null;
};

export type RunInput = {
  flow: Flow;
  state: unknown;
  message: string;
  tenantName: string;
  profileName: string | null;
  history: { direction: "in" | "out"; body: string | null }[];
  /** Off in the simulator's "no model" mode, and whenever there's no API key. */
  useModel?: boolean;
};

export type RunResult = {
  reply: string;
  state: FlowState;
  verdict: Verdict;
  answers: Record<string, string | null>;
  /** Keys of required questions still unanswered. */
  missing: string[];
  model: string | null;
  /** Step ids touched this turn, oldest first. Drives the simulator's trace. */
  trace: string[];
};

/** How many times a required question is re-asked before the flow moves on. */
const MAX_RETRIES = 3;

/** Hard stop on a flow that loops back into itself. */
const MAX_HOPS = 64;

const AFTER_END =
  "Thanks — I've already got everything and passed it on. Someone will come back to you shortly.";

type ModelOutput = { slots?: Record<string, string | null>; declined?: boolean; ack?: string };

export async function runFlow(input: RunInput): Promise<RunResult> {
  const { flow } = input;
  const state = normalizeState(input.state);
  const trace: string[] = [];

  if (state.done) {
    return {
      reply: AFTER_END,
      state,
      verdict: state.outcome ?? "qualified",
      answers: state.answers,
      missing: missingKeys(flow, state.answers),
      model: null,
      trace,
    };
  }

  // The question this message is answering. Null on the opening turn, when we
  // have asked nothing yet.
  const awaiting = state.at ? question(flow, state.at) : null;

  // Where the conversation stands before this message is applied. On the
  // opening turn that means walking in from the start, collecting any greeting.
  const opening: string[] = [];
  let pending = awaiting;
  if (!pending) {
    const landing = walk(flow, flow.start, state.answers, trace, opening);
    if (landing.kind === "end") return finish(flow, state, landing.step, opening, trace, null);
    pending = landing.step;
  }
  if (!pending) return finish(flow, state, null, opening, trace, null);
  if (trace[trace.length - 1] !== pending.id) trace.push(pending.id);

  /* ------------------------------------------------------- read the answer */

  let model: string | null = null;
  let declined = false;
  let ack = "";
  const fresh: Record<string, string | null> = {};

  const aiTargets = pending.mode === "ai" ? extractionTargets(flow, pending, state.answers) : [];

  if (aiTargets.length > 0 && input.useModel !== false) {
    try {
      const output = await generateJson<ModelOutput>({
        system: systemPrompt(input.tenantName, pending, aiTargets),
        turns: turns(input.history, input.message),
        responseSchema: schema(aiTargets),
      });
      model = "gemini";
      declined = output.declined === true;
      ack = tidy(output.ack);
      for (const target of aiTargets) {
        const value = clean(output.slots?.[target.key]);
        if (value) fresh[target.key] = coerce(target, value) ?? value;
      }
    } catch (error) {
      console.error("[flow] gemini failed, taking the message at face value", error);
    }
  }

  let invalid: string | null = null;

  if (awaiting && pending.mode === "strict") {
    // Strict questions are read here and nowhere else. No model is consulted,
    // so what counts as an answer is exactly what the flow says.
    const parsed = parseStrict(pending, input.message);
    if (parsed.error) invalid = parsed.error;
    else if (parsed.value) fresh[pending.key] = parsed.value;
  } else if (awaiting && !model) {
    // The model never got to read this one — an outage, or the simulator with
    // AI reading switched off. Rather than stall on a question nobody can hear
    // the answer to, take the message in front of us at face value.
    //
    // Only when the model genuinely did not run: if it did and left the slot
    // empty, it decided this message was not an answer, and it is better placed
    // to know that than we are.
    const taken = readAnswer(pending, input.message);
    if (taken) fresh[pending.key] = taken;
  }

  // On the opening turn the greeting does the talking; an acknowledgement in
  // front of it reads as if the clerk missed the introduction.
  if (!awaiting) ack = "";

  const answers = { ...state.answers, ...fresh };

  /* ------------------------------------------------------------- decide */

  if (declined) {
    const target = flow.onDecline ? byId(flow, flow.onDecline) : null;
    if (target && target.type === "end") {
      return finish(flow, { ...state, answers }, target, opening, trace, model);
    }
    return finish(flow, { ...state, answers }, declinedEnd(), opening, trace, model);
  }

  // Still on the same question: it was invalid, or nothing was given for a
  // question that needs one.
  const stillPending = invalid !== null || (pending.required && !answers[pending.key]);
  // Asking for the first time is not a retry — only a message that failed to
  // answer counts against the cap.
  const retries = (state.retries[pending.id] ?? 0) + (awaiting ? 1 : 0);

  if (stillPending && retries <= MAX_RETRIES) {
    const next: FlowState = {
      at: pending.id,
      answers,
      retries: { ...state.retries, [pending.id]: retries },
      done: false,
      outcome: null,
    };
    // A complaint about a bad answer replaces the acknowledgement of it.
    const lead = invalid ?? ack;
    const body = [...opening, [lead, prompt(pending, answers)].filter(Boolean).join(" ")]
      .filter(Boolean)
      .join("\n\n");
    return {
      reply: render(body, answers, input),
      state: next,
      verdict: "needs_info",
      answers,
      missing: missingKeys(flow, answers),
      model,
      trace,
    };
  }

  // Answered, skipped, or out of attempts — move on.
  const said = [...opening];
  const landing = walk(flow, resolveNext(flow, pending, answers), answers, trace, said);

  if (landing.kind === "end") {
    return finish(flow, { ...state, answers }, landing.step, said, trace, model);
  }
  if (!landing.step) return finish(flow, { ...state, answers }, null, said, trace, model);

  const asked = landing.step;
  const body = [...said, prompt(asked, answers)].filter(Boolean).join("\n\n");

  return {
    reply: render(ack ? `${ack}\n\n${body}` : body, answers, input),
    state: { at: asked.id, answers, retries: state.retries, done: false, outcome: null },
    verdict: "needs_info",
    answers,
    missing: missingKeys(flow, answers),
    model,
    trace,
  };
}

/* ------------------------------------------------------------- traversal */

type Landing =
  | { kind: "question"; step: QuestionStep }
  | { kind: "end"; step: EndStep }
  | { kind: "none"; step: null };

/**
 * Walks forward from a step id until it reaches a question that still needs an
 * answer, or an end. Message steps are collected into `said` on the way past;
 * conditions are evaluated; questions already answered are stepped over, which
 * is what lets someone who volunteers three facts at once skip three questions.
 */
function walk(
  flow: Flow,
  from: string | null,
  answers: Record<string, string | null>,
  trace: string[],
  said: string[],
): Landing {
  let id = from;

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (!id) return { kind: "none", step: null };
    const index = flow.steps.findIndex((step) => step.id === id);
    const step = flow.steps[index];
    if (!step) return { kind: "none", step: null };
    trace.push(step.id);

    const fallthrough = flow.steps[index + 1]?.id ?? null;

    if (step.type === "end") return { kind: "end", step };
    if (step.type === "message") {
      said.push(step.text);
      id = step.next ?? fallthrough;
      continue;
    }
    if (step.type === "condition") {
      const taken = step.branches.find((branch) => holds(branch.when, answers));
      id = taken ? taken.to : (step.otherwise ?? fallthrough);
      continue;
    }
    if (answers[step.key]) {
      id = resolveNext(flow, step, answers);
      continue;
    }
    return { kind: "question", step };
  }

  console.error("[flow] gave up walking — the flow loops back on itself");
  return { kind: "none", step: null };
}

/** Jump rules first, then the matched option's own branch, then `next`. */
function resolveNext(flow: Flow, step: QuestionStep, answers: Record<string, string | null>): string | null {
  for (const jump of step.jumps) {
    if (holds(jump.when, answers)) return jump.to;
  }
  if (step.field === "choice") {
    const chosen = step.options.find((option) => same(option.value, answers[step.key]));
    if (chosen?.next) return chosen.next;
  }
  if (step.next) return step.next;
  const index = flow.steps.findIndex((entry) => entry.id === step.id);
  return flow.steps[index + 1]?.id ?? null;
}

export function holds(condition: Condition, answers: Record<string, string | null>): boolean {
  if (condition.clauses.length === 0) return true;
  const results = condition.clauses.map((clause) => clauseHolds(clause, answers));
  return condition.match === "any" ? results.some(Boolean) : results.every(Boolean);
}

function clauseHolds(clause: Clause, answers: Record<string, string | null>): boolean {
  const actual = answers[clause.key] ?? "";
  const expected = clause.value ?? "";

  switch (clause.op) {
    case "is":
      return same(actual, expected);
    case "is_not":
      return !same(actual, expected);
    case "contains":
      return actual.toLowerCase().includes(expected.toLowerCase());
    case "not_contains":
      return !actual.toLowerCase().includes(expected.toLowerCase());
    case "gt":
      return numberOf(actual) !== null && numberOf(actual)! > Number(expected);
    case "lt":
      return numberOf(actual) !== null && numberOf(actual)! < Number(expected);
    case "answered":
      return actual.trim() !== "";
    case "empty":
      return actual.trim() === "";
  }
}

/* -------------------------------------------------------------- answering */

/** Parses and validates a strict answer. Never calls the model. */
function parseStrict(step: QuestionStep, message: string): { value?: string; error?: string } {
  const raw = message.trim();
  if (!raw) return step.required ? { error: complaint(step, "I didn't catch that.") } : {};

  if (step.field === "choice") {
    const chosen = matchOption(step, raw);
    if (!chosen) return { error: complaint(step, "Sorry, I didn't recognise that one.") };
    return { value: chosen };
  }

  if (step.field === "email") {
    const found = raw.match(/[^\s@]+@[^\s@]+\.[^\s@]{2,}/);
    if (!found) return { error: complaint(step, "That doesn't look like an email address.") };
    return { value: found[0] };
  }

  if (step.field === "phone") {
    const digits = raw.replace(/[^\d+]/g, "");
    if (digits.replace(/\D/g, "").length < 7) {
      return { error: complaint(step, "That doesn't look like a phone number.") };
    }
    return { value: digits };
  }

  if (step.field === "number") {
    const value = numberOf(raw);
    if (value === null) return { error: complaint(step, "I need that as a number.") };
    if (step.min !== null && value < step.min) {
      return { error: complaint(step, `That needs to be at least ${step.min}.`) };
    }
    if (step.max !== null && value > step.max) {
      return { error: complaint(step, `That needs to be ${step.max} or less.`) };
    }
    return { value: String(value) };
  }

  if (step.field === "date") {
    const parsed = parseDate(raw);
    if (!parsed) return { error: complaint(step, "I couldn't read that as a date.") };
    return { value: parsed };
  }

  if (step.pattern) {
    try {
      if (!new RegExp(step.pattern).test(raw)) return { error: complaint(step, "That isn't quite right.") };
    } catch {
      // A pattern that no longer compiles must not block a real person.
    }
  }
  if (step.min !== null && raw.length < step.min) {
    return { error: complaint(step, `Could you give me a bit more — at least ${step.min} characters.`) };
  }

  return { value: step.max !== null ? raw.slice(0, step.max) : raw };
}

/** What an ai question does with a message when the model is unavailable. */
function readAnswer(step: QuestionStep, message: string): string | null {
  const raw = message.trim();
  if (!raw) return null;
  if (step.field === "choice") return matchOption(step, raw);
  const parsed = parseStrict({ ...step, pattern: null, min: null, max: null }, raw);
  return parsed.value ?? null;
}

function matchOption(step: QuestionStep, raw: string): string | null {
  const needle = raw.trim().toLowerCase();

  const numbered = Number(needle);
  const picked = Number.isInteger(numbered) ? step.options[numbered - 1] : undefined;
  if (picked) return picked.value;
  const exact = step.options.find(
    (option) => option.label.toLowerCase() === needle || option.value.toLowerCase() === needle,
  );
  if (exact) return exact.value;

  const partial = step.options.filter(
    (option) => option.label.toLowerCase().includes(needle) || needle.includes(option.label.toLowerCase()),
  );
  return partial.length === 1 ? (partial[0] as Option).value : null;
}

/** Keeps a model answer inside the shape the question asked for. */
function coerce(step: QuestionStep, value: string): string | null {
  if (step.field === "choice") return matchOption(step, value);
  return value;
}

function complaint(step: QuestionStep, fallback: string): string {
  return step.invalidMessage ?? fallback;
}

function parseDate(raw: string): string | null {
  const dmy = raw.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (dmy) {
    const [, day, month, year] = dmy as unknown as [string, string, string, string];
    const full = year.length === 2 ? `20${year}` : year;
    const date = new Date(Number(full), Number(month) - 1, Number(day));
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
}

/**
 * Reads a number out of the way people actually write one: "R300k", "2.5m",
 * "1 200 000", "about 40". Shorthand matters because budget questions are the
 * commonest thing a flow branches on, and "R300k" parsed as 300 would send
 * someone down the wrong branch entirely.
 */
function numberOf(raw: string): number | null {
  const text = raw.replace(/[\s,]/g, "").toLowerCase();
  const found = text.match(/-?\d+(\.\d+)?/);
  if (!found) return null;

  const value = Number(found[0]);
  if (!Number.isFinite(value)) return null;

  const suffix = text.slice((found.index ?? 0) + found[0].length);
  if (/^(k|thousand)/.test(suffix)) return value * 1_000;
  if (/^(m|mil|million)/.test(suffix)) return value * 1_000_000;
  if (/^(b|bn|billion)/.test(suffix)) return value * 1_000_000_000;
  return value;
}

/* ---------------------------------------------------------------- the model */

/**
 * Every ai question still unanswered — the one on the table first. Letting the
 * model fill the others opportunistically is the whole reason ai mode exists:
 * someone who writes "it's an eviction, I'm Sipho, need it this week" should
 * not then be asked three questions.
 */
function extractionTargets(
  flow: Flow,
  pending: QuestionStep,
  answers: Record<string, string | null>,
): QuestionStep[] {
  const others = flow.steps.filter(
    (step): step is QuestionStep =>
      step.type === "question" && step.mode === "ai" && step.id !== pending.id && !answers[step.key],
  );
  const unique = new Map<string, QuestionStep>();
  for (const step of [pending, ...others]) if (!unique.has(step.key)) unique.set(step.key, step);
  return [...unique.values()];
}

function systemPrompt(tenantName: string, pending: QuestionStep, targets: QuestionStep[]): string {
  const describe = (step: QuestionStep) => {
    const options =
      step.field === "choice" && step.options.length > 0
        ? ` (must be exactly one of: ${step.options.map((option) => option.value).join(", ")})`
        : step.field !== "text" && step.field !== "longtext"
          ? ` (${step.field})`
          : "";
    return `- ${step.key}${options} — ${step.ask}`;
  };

  return [
    `You are the intake clerk for ${tenantName}, reading a WhatsApp conversation.`,
    ``,
    `You are not writing the reply. You are only reading the person's messages and`,
    `filling in what they have told you.`,
    ``,
    `The question just put to them:`,
    describe(pending),
    ``,
    targets.length > 1
      ? `Other facts you may fill in if — and only if — they have already given them:\n${targets
          .slice(1)
          .map(describe)
          .join("\n")}`
      : `There is nothing else to fill in.`,
    ``,
    `Rules:`,
    `- Leave a field null unless they actually gave it. Never guess, infer or invent.`,
    `- Read the whole conversation, not just the last message — a fact given in passing counts.`,
    `- For a field with a fixed list, return one of the listed values exactly, or null.`,
    `- Set declined to true only if they clearly refuse to continue or say they are not interested.`,
    `- ack: at most eight words acknowledging what they just said, or "" if there is nothing to acknowledge. Never ask a question in it.`,
  ].join("\n");
}

function turns(
  history: { direction: "in" | "out"; body: string | null }[],
  message: string,
): { role: "user" | "model"; text: string }[] {
  const past = history
    .filter((entry) => entry.body)
    .map((entry) => ({
      role: entry.direction === "in" ? ("user" as const) : ("model" as const),
      text: entry.body as string,
    }));
  return [...past, { role: "user" as const, text: message }];
}

function schema(targets: QuestionStep[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const step of targets) properties[step.key] = { type: "STRING", nullable: true };
  return {
    type: "OBJECT",
    properties: {
      slots: { type: "OBJECT", properties, required: targets.map((step) => step.key) },
      declined: { type: "BOOLEAN" },
      ack: { type: "STRING" },
    },
    required: ["slots", "declined", "ack"],
  };
}

/* ------------------------------------------------------------- composing */

/** The wording of a question as it goes out, with its options numbered. */
function prompt(step: QuestionStep, answers: Record<string, string | null>): string {
  const ask = fill(step.ask, answers);
  if (step.field !== "choice" || step.options.length === 0) return ask;
  const list = step.options.map((option, index) => `${index + 1}. ${option.label}`).join("\n");
  return `${ask}\n\n${list}`;
}

function finish(
  flow: Flow,
  state: FlowState,
  end: EndStep | null,
  said: string[],
  trace: string[],
  model: string | null,
): RunResult {
  const step = end ?? impliedEnd();
  if (end && trace[trace.length - 1] !== end.id) trace.push(end.id);

  const parts = [...said, fill(step.text, state.answers)];
  if (step.bookingUrl) parts.push(`Want to lock in a time now? ${step.bookingUrl}`);

  return {
    reply: parts.filter(Boolean).join("\n\n"),
    state: { ...state, at: null, done: true, outcome: step.outcome },
    verdict: step.outcome,
    answers: state.answers,
    missing: missingKeys(flow, state.answers),
    model,
    trace,
  };
}

/** What a flow that simply runs out of steps means. */
function impliedEnd(): EndStep {
  return {
    id: "__end",
    type: "end",
    label: "Qualified",
    outcome: "qualified",
    text: "Thanks — that's everything I need. I've logged it and someone will come back to you.",
    bookingUrl: null,
  };
}

function declinedEnd(): EndStep {
  return {
    id: "__declined",
    type: "end",
    label: "Not interested",
    outcome: "unqualified",
    text:
      "No problem at all — I won't take up more of your time. " +
      "If things change, message this number any time and I'll pick it straight up.",
    bookingUrl: null,
  };
}

/**
 * {{key}} drops in an answer; {{#key}}…{{/key}} keeps the enclosed text only
 * when that answer exists. Enough to write "Thanks{{#name}}, {{name}}{{/name}}"
 * without it reading badly when the name never came.
 */
export function fill(text: string, answers: Record<string, string | null>): string {
  return text
    .replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key: string, body: string) =>
      answers[key] ? body : "",
    )
    .replace(/\{\{(\w+)\}\}/g, (_, key: string) => answers[key] ?? "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function render(text: string, answers: Record<string, string | null>, input: RunInput): string {
  return fill(text, {
    ...answers,
    name: answers["contact_name"] ?? input.profileName ?? null,
    tenant: input.tenantName,
  });
}

function missingKeys(flow: Flow, answers: Record<string, string | null>): string[] {
  return flow.steps
    .filter((step): step is QuestionStep => step.type === "question" && step.required)
    .filter((step) => !answers[step.key])
    .map((step) => step.key);
}

/* ------------------------------------------------------------------ state */

export function normalizeState(raw: unknown): FlowState {
  const value = isObject(raw) ? raw : {};
  const answers: Record<string, string | null> = {};
  if (isObject(value["answers"])) {
    for (const [key, entry] of Object.entries(value["answers"])) {
      const cleaned = clean(entry);
      if (cleaned) answers[key] = cleaned;
    }
  }
  const retries: Record<string, number> = {};
  if (isObject(value["retries"])) {
    for (const [key, entry] of Object.entries(value["retries"])) {
      if (typeof entry === "number" && Number.isFinite(entry)) retries[key] = entry;
    }
  }
  const outcome = value["outcome"];
  return {
    at: typeof value["at"] === "string" ? value["at"] : null,
    answers,
    retries,
    done: value["done"] === true,
    outcome:
      outcome === "qualified" || outcome === "unqualified" || outcome === "handoff" ? outcome : null,
  };
}

function question(flow: Flow, id: string): QuestionStep | null {
  const step = byId(flow, id);
  return step && step.type === "question" ? step : null;
}

function byId(flow: Flow, id: string): Step | null {
  return flow.steps.find((step) => step.id === id) ?? null;
}

function same(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

/** The model's acknowledgement, kept short and stripped of any question. */
function tidy(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed || trimmed.includes("?")) return "";
  return trimmed.split(" ").slice(0, 12).join(" ");
}

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  return lower === "null" || lower === "unknown" || lower === "n/a" ? null : trimmed;
}
