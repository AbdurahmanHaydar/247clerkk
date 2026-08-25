import type { Flow } from "./flow.js";
import { type FlowState, type Verdict, runFlow } from "./engine.js";

export type ReplyContext = {
  tenantName: string;
  profileName: string | null;
  body: string | null;
  messageType: string;
  /** Oldest-first transcript of this conversation, excluding the current message. */
  history: { direction: "in" | "out"; body: string | null }[];
  tokenJustClaimed: string | null;
  dashboardUrl: string | null;
  /** The tenant's configured intake conversation. */
  flow: Flow;
  /** Where this conversation had got to, from conversations.flow_state. */
  flowState: unknown;
};

export type ReplyResult = {
  body: string;
  /** Null when the message never reached the flow — plumbing, or unreadable. */
  intake: {
    verdict: Verdict;
    answers: Record<string, string | null>;
    missing: string[];
    model: string | null;
    state: FlowState;
  } | null;
};

export async function composeReply(ctx: ReplyContext): Promise<ReplyResult> {
  // The message carrying the signup code is plumbing, not intake — don't run it
  // through the flow.
  if (ctx.tokenJustClaimed && ctx.dashboardUrl) {
    const who = ctx.profileName ? ` ${ctx.profileName}` : "";
    return {
      body:
        `Hi${who} — you're connected to 247clerk. ` +
        `Your live dashboard: ${ctx.dashboardUrl}\n\n` +
        `Now message me the way one of your clients would, and watch it get handled.`,
      intake: null,
    };
  }

  if (ctx.messageType !== "text" || !ctx.body) {
    return {
      body: "I can only read text messages for now — send that through as text and I'll pick it up.",
      intake: null,
    };
  }

  const outcome = await runFlow({
    flow: ctx.flow,
    state: ctx.flowState,
    message: ctx.body,
    tenantName: ctx.tenantName,
    profileName: ctx.profileName,
    history: ctx.history,
  });

  return {
    body: outcome.reply,
    intake: {
      verdict: outcome.verdict,
      answers: outcome.answers,
      missing: outcome.missing,
      model: outcome.model,
      state: outcome.state,
    },
  };
}
