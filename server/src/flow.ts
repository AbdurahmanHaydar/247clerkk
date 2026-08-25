/**
 * The intake flow: the conversation a tenant's clerk runs, as data.
 *
 * A flow is a small graph of steps wired together by id. The owner edits it in
 * /admin and it takes effect on the next inbound message — no deploy. Four
 * kinds of step:
 *
 *   message   say something and move on (greeting, holding line, sign-off)
 *   question  ask for one fact and store it under a key
 *   condition branch on the answers collected so far
 *   end       stop, with a verdict
 *
 * Questions run in one of two modes. A `strict` question is asked in exactly
 * the words you typed and its answer is validated locally — no model involved,
 * so it is predictable and free. An `ai` question lets Gemini read the answer
 * out of whatever the person wrote, including facts they volunteered several
 * messages earlier. Branching is always deterministic; the model never decides
 * where the conversation goes.
 */

export type FieldType = "text" | "longtext" | "choice" | "email" | "phone" | "number" | "date";
export type StepMode = "ai" | "strict";
export type Outcome = "qualified" | "unqualified" | "handoff";

export type ClauseOp =
  | "is"
  | "is_not"
  | "contains"
  | "not_contains"
  | "gt"
  | "lt"
  | "answered"
  | "empty";

export type Clause = { key: string; op: ClauseOp; value: string };

/** A whole condition: clauses combined with every / any. */
export type Condition = { match: "all" | "any"; clauses: Clause[] };

export type Option = { label: string; value: string; next: string | null };

export type Jump = { when: Condition; to: string };

export type MessageStep = {
  id: string;
  type: "message";
  label: string;
  text: string;
  next: string | null;
};

export type QuestionStep = {
  id: string;
  type: "question";
  label: string;
  /** Where the answer is stored, and the name it appears under on a lead. */
  key: string;
  ask: string;
  field: FieldType;
  mode: StepMode;
  options: Option[];
  required: boolean;
  /** Extra validation for strict questions. Ignored in ai mode. */
  pattern: string | null;
  invalidMessage: string | null;
  min: number | null;
  max: number | null;
  jumps: Jump[];
  next: string | null;
};

export type ConditionStep = {
  id: string;
  type: "condition";
  label: string;
  branches: Jump[];
  otherwise: string | null;
};

export type EndStep = {
  id: string;
  type: "end";
  label: string;
  outcome: Outcome;
  text: string;
  bookingUrl: string | null;
};

export type Step = MessageStep | QuestionStep | ConditionStep | EndStep;

export type Flow = {
  version: 1;
  name: string;
  start: string | null;
  steps: Step[];
  /** Where to go when someone says they're not interested. */
  onDecline: string | null;
};

export const FIELD_TYPES: FieldType[] = [
  "text",
  "longtext",
  "choice",
  "email",
  "phone",
  "number",
  "date",
];

const OPS: ClauseOp[] = ["is", "is_not", "contains", "not_contains", "gt", "lt", "answered", "empty"];
const OUTCOMES: Outcome[] = ["qualified", "unqualified", "handoff"];

/**
 * The flow every tenant gets until they edit one — the three questions the
 * clerk has always asked, so upgrading changes nothing until you touch it.
 */
export function defaultFlow(): Flow {
  return normalizeFlow({
    name: "Default intake",
    start: "matter",
    steps: [
      {
        id: "matter",
        type: "question",
        label: "Matter type",
        key: "matter_type",
        ask: "What kind of legal matter is it — for example an eviction, a divorce, or a contract dispute?",
        field: "text",
        mode: "ai",
        next: "timeline",
      },
      {
        id: "timeline",
        type: "question",
        label: "Timeline",
        key: "timeline",
        ask: "How soon do you need this dealt with?",
        field: "text",
        mode: "ai",
        next: "name",
      },
      {
        id: "name",
        type: "question",
        label: "Contact name",
        key: "contact_name",
        ask: "And who should the attorney ask for when they call you back?",
        field: "text",
        mode: "ai",
        next: "done",
      },
      {
        id: "done",
        type: "end",
        label: "Qualified",
        outcome: "qualified",
        text:
          "Thanks{{#contact_name}}, {{contact_name}}{{/contact_name}} — that's everything the attorney needs. " +
          "I've logged it and someone will come back to you.",
      },
      {
        id: "declined",
        type: "end",
        label: "Not interested",
        outcome: "unqualified",
        text:
          "No problem at all — I won't take up more of your time. " +
          "If things change, message this number any time and I'll pick it straight up.",
      },
    ],
    onDecline: "declined",
  });
}

/* --------------------------------------------------------------- loading */

/**
 * Picks the flow for a tenant. Prefers the edited flow, falls back to the
 * legacy `qualification_config.questions` array, then to the built-in default.
 */
export function loadFlow(flowColumn: unknown, legacyConfig: unknown): Flow {
  if (isObject(flowColumn) && Array.isArray(flowColumn["steps"]) && flowColumn["steps"].length > 0) {
    return normalizeFlow(flowColumn);
  }
  const legacy = fromLegacyConfig(legacyConfig);
  return legacy ?? defaultFlow();
}

/** Turns the old `{questions:[{key,ask}], bookingUrl}` shape into a flow. */
export function fromLegacyConfig(raw: unknown): Flow | null {
  if (!isObject(raw)) return null;
  const questions = Array.isArray(raw["questions"]) ? raw["questions"] : [];
  const parsed = questions.flatMap((entry) => {
    if (!isObject(entry)) return [];
    const key = str(entry["key"]);
    const ask = str(entry["ask"]);
    return key && ask ? [{ key, ask }] : [];
  });
  if (parsed.length === 0) return null;

  const bookingUrl = str(raw["bookingUrl"]);
  const steps: unknown[] = parsed.map((question, index) => ({
    id: `q${index + 1}`,
    type: "question",
    label: titleize(question.key),
    key: question.key,
    ask: question.ask,
    field: "text",
    mode: "ai",
    next: index + 1 < parsed.length ? `q${index + 2}` : "done",
  }));

  steps.push({
    id: "done",
    type: "end",
    label: "Qualified",
    outcome: "qualified",
    text:
      "Thanks{{#contact_name}}, {{contact_name}}{{/contact_name}} — that's everything the attorney needs. " +
      "I've logged it and someone will come back to you.",
    bookingUrl,
  });
  steps.push({
    id: "declined",
    type: "end",
    label: "Not interested",
    outcome: "unqualified",
    text:
      "No problem at all — I won't take up more of your time. " +
      "If things change, message this number any time and I'll pick it straight up.",
  });

  return normalizeFlow({ name: "Imported intake", start: "q1", steps, onDecline: "declined" });
}

/* ------------------------------------------------------------ normalizing */

/**
 * Coerces anything into a structurally valid Flow, dropping what it cannot
 * understand. Never throws: a flow that came back malformed from the database
 * must still leave the number answering.
 */
export function normalizeFlow(raw: unknown): Flow {
  const value = isObject(raw) ? raw : {};
  const seen = new Set<string>();

  const steps = (Array.isArray(value["steps"]) ? value["steps"] : []).flatMap((entry, index) => {
    const step = normalizeStep(entry, index, seen);
    return step ? [step] : [];
  });

  const ids = new Set(steps.map((step) => step.id));
  // Drop references to steps that no longer exist rather than dead-ending a
  // live conversation on them.
  for (const step of steps) {
    if (step.type === "message") step.next = keep(step.next, ids);
    if (step.type === "question") {
      step.next = keep(step.next, ids);
      step.jumps = step.jumps.filter((jump) => ids.has(jump.to));
      step.options = step.options.map((option) => ({ ...option, next: keep(option.next, ids) }));
    }
    if (step.type === "condition") {
      step.branches = step.branches.filter((branch) => ids.has(branch.to));
      step.otherwise = keep(step.otherwise, ids);
    }
  }

  const start = keep(str(value["start"]), ids) ?? steps[0]?.id ?? null;

  return {
    version: 1,
    name: str(value["name"]) ?? "Intake flow",
    start,
    steps,
    onDecline: keep(str(value["onDecline"]), ids),
  };
}

function normalizeStep(raw: unknown, index: number, seen: Set<string>): Step | null {
  if (!isObject(raw)) return null;

  const id = uniqueId(str(raw["id"]), index, seen);
  const label = str(raw["label"]) ?? "";
  const type = str(raw["type"]);

  if (type === "message") {
    const text = str(raw["text"]);
    if (!text) return null;
    return { id, type: "message", label: label || "Message", text, next: str(raw["next"]) };
  }

  if (type === "condition") {
    return {
      id,
      type: "condition",
      label: label || "Condition",
      branches: normalizeJumps(raw["branches"]),
      otherwise: str(raw["otherwise"]),
    };
  }

  if (type === "end") {
    const outcome = str(raw["outcome"]);
    return {
      id,
      type: "end",
      label: label || "End",
      outcome: OUTCOMES.includes(outcome as Outcome) ? (outcome as Outcome) : "qualified",
      text: str(raw["text"]) ?? "Thanks — I've logged that and someone will come back to you.",
      bookingUrl: str(raw["bookingUrl"]),
    };
  }

  // Anything else is treated as a question; that is what an unknown or missing
  // type most likely meant.
  const key = slug(str(raw["key"])) ?? `answer_${index + 1}`;
  const ask = str(raw["ask"]);
  if (!ask) return null;

  const field = str(raw["field"]);
  const mode = str(raw["mode"]);
  const options = (Array.isArray(raw["options"]) ? raw["options"] : []).flatMap((entry) => {
    if (typeof entry === "string") {
      return entry.trim() ? [{ label: entry.trim(), value: entry.trim(), next: null }] : [];
    }
    if (!isObject(entry)) return [];
    const optionLabel = str(entry["label"]) ?? str(entry["value"]);
    if (!optionLabel) return [];
    return [{ label: optionLabel, value: str(entry["value"]) ?? optionLabel, next: str(entry["next"]) }];
  });

  return {
    id,
    type: "question",
    label: label || titleize(key),
    key,
    ask,
    field: FIELD_TYPES.includes(field as FieldType) ? (field as FieldType) : "text",
    mode: mode === "strict" ? "strict" : "ai",
    options,
    required: raw["required"] !== false,
    pattern: str(raw["pattern"]),
    invalidMessage: str(raw["invalidMessage"]),
    min: num(raw["min"]),
    max: num(raw["max"]),
    jumps: normalizeJumps(raw["jumps"]),
    next: str(raw["next"]),
  };
}

function normalizeJumps(raw: unknown): Jump[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!isObject(entry)) return [];
    const to = str(entry["to"]);
    if (!to) return [];
    return [{ when: normalizeCondition(entry["when"]), to }];
  });
}

export function normalizeCondition(raw: unknown): Condition {
  // A bare array of clauses is accepted and means "all of these".
  const source = Array.isArray(raw) ? { match: "all", clauses: raw } : isObject(raw) ? raw : {};
  const clauses = (Array.isArray(source["clauses"]) ? source["clauses"] : []).flatMap((entry) => {
    if (!isObject(entry)) return [];
    const key = slug(str(entry["key"]));
    const op = str(entry["op"]);
    if (!key || !OPS.includes(op as ClauseOp)) return [];
    return [{ key, op: op as ClauseOp, value: str(entry["value"]) ?? "" }];
  });
  return { match: source["match"] === "any" ? "any" : "all", clauses };
}

function uniqueId(raw: string | null, index: number, seen: Set<string>): string {
  let id = (raw ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || `s${index + 1}`;
  while (seen.has(id)) id = `${id}_${seen.size}`;
  seen.add(id);
  return id;
}

function keep(id: string | null, ids: Set<string>): string | null {
  return id && ids.has(id) ? id : null;
}

/* ------------------------------------------------------------- validating */

export type FlowProblem = { level: "error" | "warning"; stepId: string | null; message: string };

/**
 * What the editor shows before it lets you save. Errors block the save;
 * warnings are things that are legal but probably not what you meant.
 *
 * Runs against the *raw* input so it can complain about what normalizing would
 * silently discard.
 */
export function validateFlow(raw: unknown): { flow: Flow; problems: FlowProblem[] } {
  const problems: FlowProblem[] = [];
  const value = isObject(raw) ? raw : {};
  const rawSteps = Array.isArray(value["steps"]) ? value["steps"] : [];

  if (rawSteps.length === 0) {
    problems.push({ level: "error", stepId: null, message: "A flow needs at least one step." });
  }

  const ids = new Set<string>();
  const keys = new Map<string, string>();

  for (const [index, entry] of rawSteps.entries()) {
    if (!isObject(entry)) {
      problems.push({ level: "error", stepId: null, message: `Step ${index + 1} is not a step.` });
      continue;
    }
    const id = str(entry["id"]);
    const type = str(entry["type"]) ?? "question";
    const where = id ?? `step ${index + 1}`;

    if (!id) {
      problems.push({ level: "error", stepId: null, message: `Step ${index + 1} has no id.` });
    } else if (ids.has(id)) {
      problems.push({ level: "error", stepId: id, message: `Two steps share the id "${id}".` });
    } else {
      ids.add(id);
    }

    if (type === "question") {
      const key = str(entry["key"]);
      const ask = str(entry["ask"]);
      if (!ask) {
        problems.push({ level: "error", stepId: id, message: `"${where}" has no question text.` });
      }
      if (!key) {
        problems.push({ level: "error", stepId: id, message: `"${where}" has no answer name.` });
      } else if (keys.has(key) && keys.get(key) !== id) {
        problems.push({
          level: "warning",
          stepId: id,
          message: `Two questions both save to "${key}" — the second will overwrite the first.`,
        });
      } else if (key) {
        keys.set(key, id ?? "");
      }
      const options = Array.isArray(entry["options"]) ? entry["options"] : [];
      if (str(entry["field"]) === "choice" && options.length === 0) {
        problems.push({ level: "error", stepId: id, message: `"${where}" is a choice with no options.` });
      }
      if (str(entry["mode"]) === "strict" && str(entry["pattern"])) {
        try {
          new RegExp(str(entry["pattern"]) as string);
        } catch {
          problems.push({ level: "error", stepId: id, message: `"${where}" has an invalid pattern.` });
        }
      }
    }

    if (type === "message" && !str(entry["text"])) {
      problems.push({ level: "error", stepId: id, message: `"${where}" has no message text.` });
    }
  }

  // Dangling references. Reported before normalizing quietly strips them.
  for (const [index, entry] of rawSteps.entries()) {
    if (!isObject(entry)) continue;
    const id = str(entry["id"]);
    const where = id ?? `step ${index + 1}`;
    for (const [what, target] of references(entry)) {
      if (target && !ids.has(target)) {
        problems.push({
          level: "error",
          stepId: id,
          message: `"${where}" ${what} a step that doesn't exist ("${target}").`,
        });
      }
    }
  }

  const start = str(value["start"]);
  if (start && !ids.has(start)) {
    problems.push({ level: "error", stepId: null, message: `The flow starts at "${start}", which doesn't exist.` });
  }

  const flow = normalizeFlow(raw);

  if (!flow.steps.some((step) => step.type === "end")) {
    problems.push({
      level: "warning",
      stepId: null,
      message: "No end step — the conversation is treated as qualified once it runs out of questions.",
    });
  }
  for (const step of unreachable(flow)) {
    problems.push({ level: "warning", stepId: step.id, message: `"${step.label}" can never be reached.` });
  }

  return { flow, problems };
}

function* references(entry: Record<string, unknown>): Generator<[string, string | null]> {
  yield ["continues to", str(entry["next"])];
  yield ["falls through to", str(entry["otherwise"])];
  for (const list of ["jumps", "branches"]) {
    for (const jump of Array.isArray(entry[list]) ? (entry[list] as unknown[]) : []) {
      if (isObject(jump)) yield ["jumps to", str(jump["to"])];
    }
  }
  for (const option of Array.isArray(entry["options"]) ? (entry["options"] as unknown[]) : []) {
    if (isObject(option)) yield ["sends an option to", str(option["next"])];
  }
}

/**
 * Steps nothing points at. Walks forward from the start the same way the
 * engine does, including the implicit "fall through to the next step in the
 * list" that an unset `next` means.
 */
function unreachable(flow: Flow): Step[] {
  const reached = new Set<string>();
  const queue = [flow.start, flow.onDecline].filter((id): id is string => Boolean(id));

  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (reached.has(id)) continue;
    reached.add(id);

    const index = flow.steps.findIndex((step) => step.id === id);
    const step = flow.steps[index];
    if (!step || step.type === "end") continue;

    const fallthrough = flow.steps[index + 1]?.id ?? null;
    if (step.type === "message") queue.push(step.next ?? fallthrough ?? "");
    if (step.type === "question") {
      queue.push(step.next ?? fallthrough ?? "");
      for (const jump of step.jumps) queue.push(jump.to);
      for (const option of step.options) if (option.next) queue.push(option.next);
    }
    if (step.type === "condition") {
      for (const branch of step.branches) queue.push(branch.to);
      queue.push(step.otherwise ?? fallthrough ?? "");
    }
  }

  return flow.steps.filter((step) => !reached.has(step.id));
}

/* ------------------------------------------------------------------ utils */

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function slug(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return cleaned || null;
}

function titleize(key: string): string {
  return key.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}


/* ------------------------------------------------------- the public builder */

/**
 * What an anonymous visitor is allowed to save.
 *
 * The flow they build is text this number will send back out over WhatsApp, so
 * it is untrusted input with a delivery mechanism attached. The blast radius is
 * small — the clerk only ever replies to whoever messaged it, so the worst case
 * is someone sending themselves their own words — but a code can be passed on,
 * and unbounded text on a metered channel is its own problem. Hence caps, and
 * only the three step kinds the visitor-facing builder can actually produce.
 */
export const PUBLIC_LIMITS = {
  steps: 14,
  questions: 8,
  options: 6,
  text: 320,
} as const;

export function checkPublicFlow(flow: Flow): FlowProblem[] {
  const problems: FlowProblem[] = [];
  const say = (message: string, stepId: string | null = null) =>
    problems.push({ level: "error", stepId, message });

  if (flow.steps.length > PUBLIC_LIMITS.steps) {
    say(`That's more than ${PUBLIC_LIMITS.steps} steps — trim it down a little.`);
  }

  const questions = flow.steps.filter((step) => step.type === "question");
  if (questions.length === 0) say("Add at least one question.");
  if (questions.length > PUBLIC_LIMITS.questions) {
    say(`${PUBLIC_LIMITS.questions} questions is the most the demo will run.`);
  }

  for (const step of flow.steps) {
    if (step.type === "condition") {
      say(`"${step.label}" isn't something the demo builder can run.`, step.id);
      continue;
    }
    const text = step.type === "question" ? step.ask : step.type === "message" ? step.text : step.text;
    if (text.length > PUBLIC_LIMITS.text) {
      say(`"${step.label}" is longer than ${PUBLIC_LIMITS.text} characters.`, step.id);
    }
    if (step.type === "question" && step.options.length > PUBLIC_LIMITS.options) {
      say(`"${step.label}" has more than ${PUBLIC_LIMITS.options} options.`, step.id);
    }
    if (step.type === "end" && step.bookingUrl) {
      // Nobody gets to point the demo's closing message at a link of their own.
      step.bookingUrl = null;
    }
  }

  return problems;
}
