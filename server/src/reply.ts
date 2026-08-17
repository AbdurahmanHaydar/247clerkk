import { type QualificationConfig, type Verdict, runIntake } from "./qualify.js";

export type ReplyContext = {
  tenantName: string;
  profileName: string | null;
  body: string | null;
  messageType: string;
  /** Oldest-first transcript of this conversation, excluding the current message. */
  history: { direction: "in" | "out"; body: string | null }[];
  tokenJustClaimed: string | null;
  dashboardUrl: string | null;
  qualificationConfig: QualificationConfig;
  /** Answers already collected earlier in this conversation. */
  knownSlots: Record<string, string | null>;
};

export type ReplyResult = {
  body: string;
  qualification: {
    verdict: Verdict;
    slots: Record<string, string | null>;
    missing: string[];
    model: string | null;
  } | null;
};

export async function composeReply(ctx: ReplyContext): Promise<ReplyResult> {
  // The message carrying the signup code is plumbing, not intake — don't run it
  // through qualification.
  if (ctx.tokenJustClaimed && ctx.dashboardUrl) {
    const who = ctx.profileName ? ` ${ctx.profileName}` : "";
    return {
      body:
        `Hi${who} — you're connected to 247clerk. ` +
        `Your live dashboard: ${ctx.dashboardUrl}\n\n` +
        `Now message me the way one of your clients would, and watch it get handled.`,
      qualification: null,
    };
  }

  if (ctx.messageType !== "text" || !ctx.body) {
    return {
      body: "I can only read text messages for now — send that through as text and I'll pick it up.",
      qualification: null,
    };
  }

  const outcome = await runIntake({
    tenantName: ctx.tenantName,
    profileName: ctx.profileName,
    config: ctx.qualificationConfig,
    history: ctx.history,
    message: ctx.body,
    knownSlots: ctx.knownSlots,
  });

  return {
    body: outcome.reply,
    qualification: {
      verdict: outcome.verdict,
      slots: outcome.slots,
      missing: outcome.missing,
      model: outcome.model,
    },
  };
}
