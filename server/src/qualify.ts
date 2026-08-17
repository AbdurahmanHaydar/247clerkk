import { generateJson } from "./gemini.js";

export type IntakeQuestion = { key: string; ask: string };

export type QualificationConfig = {
  questions: IntakeQuestion[];
  bookingUrl?: string;
};

/**
 * The qualification rule, in one line: answer all three and you're a qualified
 * lead. Tenants can change the questions in tenants.qualification_config
 * without a deploy; these are the fallback if that column is empty.
 */
export const DEFAULT_QUESTIONS: IntakeQuestion[] = [
  {
    key: "matter_type",
    ask: "What kind of legal matter is it — for example an eviction, a divorce, or a contract dispute?",
  },
  { key: "timeline", ask: "How soon do you need this dealt with?" },
  { key: "contact_name", ask: "And who should the attorney ask for when they call you back?" },
];

export type Verdict = "qualified" | "unqualified" | "needs_info";

export type IntakeOutcome = {
  reply: string;
  verdict: Verdict;
  slots: Record<string, string | null>;
  missing: string[];
  /** Null when Gemini was unreachable and we fell back to the scripted path. */
  model: string | null;
};

type ModelOutput = {
  slots?: Record<string, string | null>;
  declined?: boolean;
  reply?: string;
};

export function resolveConfig(raw: unknown): QualificationConfig {
  const value = (raw ?? {}) as Record<string, unknown>;
  const questions = Array.isArray(value["questions"])
    ? (value["questions"] as unknown[]).flatMap((entry) => {
        const q = entry as Record<string, unknown>;
        return typeof q["key"] === "string" && typeof q["ask"] === "string"
          ? [{ key: q["key"], ask: q["ask"] }]
          : [];
      })
    : [];

  return {
    questions: questions.length > 0 ? questions : DEFAULT_QUESTIONS,
    bookingUrl: typeof value["bookingUrl"] === "string" ? value["bookingUrl"] : undefined,
  };
}

export async function runIntake(input: {
  tenantName: string;
  profileName: string | null;
  config: QualificationConfig;
  history: { direction: "in" | "out"; body: string | null }[];
  message: string;
  knownSlots: Record<string, string | null>;
}): Promise<IntakeOutcome> {
  const { questions, bookingUrl } = input.config;

  let output: ModelOutput | null = null;
  try {
    output = await generateJson<ModelOutput>({
      system: buildSystemPrompt(input.tenantName, questions),
      turns: buildTurns(input.history, input.message),
      responseSchema: buildSchema(questions),
    });
  } catch (error) {
    console.error("[intake] gemini failed, falling back to scripted question", error);
  }

  const slots = mergeSlots(questions, input.knownSlots, output?.slots);
  const missing = questions.filter((q) => !slots[q.key]).map((q) => q.key);

  if (output?.declined === true) {
    return {
      verdict: "unqualified",
      slots,
      missing,
      model: "gemini",
      reply:
        "No problem at all — I won't take up more of your time. " +
        "If things change, message this number any time and I'll pick it straight up.",
    };
  }

  if (missing.length === 0) {
    const name = slots["contact_name"] ?? input.profileName;
    return {
      verdict: "qualified",
      slots,
      missing,
      model: output ? "gemini" : null,
      reply:
        `Thanks${name ? `, ${name}` : ""} — that's everything the attorney needs. ` +
        `I've logged it and someone will come back to you.` +
        (bookingUrl ? `\n\nWant to lock in a time now? ${bookingUrl}` : ""),
    };
  }

  // Mid-intake: the model's phrasing is better than a script, but if it went
  // down we still have to ask something sensible.
  const nextQuestion = questions.find((q) => q.key === missing[0]);
  const reply = output?.reply?.trim() || nextQuestion?.ask || "Could you tell me a bit more?";

  return { verdict: "needs_info", slots, missing, model: output ? "gemini" : null, reply };
}

function buildSystemPrompt(tenantName: string, questions: IntakeQuestion[]): string {
  const list = questions.map((q, i) => `${i + 1}. ${q.key} — ${q.ask}`).join("\n");
  return [
    `You are the after-hours intake clerk for ${tenantName}, replying on WhatsApp.`,
    ``,
    `Your only job is to collect these three facts:`,
    list,
    ``,
    `Rules:`,
    `- Extract any fact the person has already given anywhere in the conversation, even in passing.`,
    `- Leave a slot null unless they actually answered it. Never guess or infer.`,
    `- Ask for ONE missing fact at a time, in the order listed above.`,
    `- Keep replies under 30 words, warm and plain. No bullet points, no formal letter openings.`,
    `- Never give legal advice, quote fees, or promise an outcome. You take details only.`,
    `- Set declined to true only if they clearly refuse to continue or say they are not interested.`,
    `- "reply" is your next WhatsApp message. If every fact is filled, acknowledge briefly and stop asking.`,
  ].join("\n");
}

function buildTurns(
  history: { direction: "in" | "out"; body: string | null }[],
  message: string,
): { role: "user" | "model"; text: string }[] {
  const turns = history
    .filter((entry) => entry.body)
    .map((entry) => ({
      role: entry.direction === "in" ? ("user" as const) : ("model" as const),
      text: entry.body as string,
    }));
  turns.push({ role: "user", text: message });
  return turns;
}

function buildSchema(questions: IntakeQuestion[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const question of questions) {
    properties[question.key] = { type: "STRING", nullable: true };
  }
  return {
    type: "OBJECT",
    properties: {
      slots: { type: "OBJECT", properties, required: questions.map((q) => q.key) },
      declined: { type: "BOOLEAN" },
      reply: { type: "STRING" },
    },
    required: ["slots", "declined", "reply"],
  };
}

/** Once a slot is filled it stays filled — later turns can't erase an answer. */
function mergeSlots(
  questions: IntakeQuestion[],
  known: Record<string, string | null>,
  fresh: Record<string, string | null> | undefined,
): Record<string, string | null> {
  const merged: Record<string, string | null> = {};
  for (const question of questions) {
    merged[question.key] = clean(known[question.key]) ?? clean(fresh?.[question.key]) ?? null;
  }
  return merged;
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "null" || trimmed.toLowerCase() === "unknown") return null;
  return trimmed;
}
