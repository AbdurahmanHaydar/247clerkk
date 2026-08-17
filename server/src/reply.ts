/**
 * Composes the outbound reply for one inbound message.
 *
 * P0 is a deterministic echo so the pipe can be verified end to end without a
 * model in the loop. P2 replaces the body of composeReply with the Gemini
 * intake + qualification call; everything around it stays unchanged.
 */

export type ReplyContext = {
  tenantName: string;
  profileName: string | null;
  body: string | null;
  messageType: string;
  /** Oldest-first transcript of this conversation, excluding the current message. */
  history: { direction: "in" | "out"; body: string | null }[];
  tokenJustClaimed: string | null;
  dashboardUrl: string | null;
};

export async function composeReply(ctx: ReplyContext): Promise<string> {
  if (ctx.tokenJustClaimed && ctx.dashboardUrl) {
    const who = ctx.profileName ? ` ${ctx.profileName}` : "";
    return (
      `Hi${who} — you're connected to 247clerk. ` +
      `Your live dashboard: ${ctx.dashboardUrl}\n\n` +
      `Now send me a message the way one of your clients would, and watch it get triaged.`
    );
  }

  if (ctx.messageType !== "text") {
    return `I can only read text messages for now — send that through as text and I'll pick it up.`;
  }

  return `you said ${ctx.body ?? ""}`;
}
