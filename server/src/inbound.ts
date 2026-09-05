import type { PoolClient } from "pg";
import { config } from "./config.js";
import { tx } from "./db.js";
import { composeReply } from "./reply.js";
import { loadFlow } from "./flow.js";
import { extractToken } from "./tokens.js";

/** Shape n8n's Normalize node posts to /internal/wa/inbound. */
export type NormalizedInbound = {
  phoneNumberId: string;
  displayPhoneNumber?: string;
  waId: string;
  profileName?: string | null;
  messageId: string;
  timestamp?: string;
  type: string;
  text?: string | null;
  raw?: unknown;
};

export type InboundResult =
  | { action: "skip"; reason: string }
  | {
      action: "send_text";
      phoneNumberId: string;
      to: string;
      body: string;
      outboundRef: string;
    };

type TenantRow = {
  id: string;
  name: string;
  is_demo: boolean;
  flow: unknown;
  qualification_config: unknown;
};

type ContactRow = {
  id: string;
  blocked: boolean;
  profile_name: string | null;
  message_count: number;
};

type ConversationRow = {
  id: string;
  signup_token: string | null;
  flow_state: unknown;
  stale: boolean;
};

export function parseInbound(input: unknown): NormalizedInbound | null {
  if (typeof input !== "object" || input === null) return null;
  const value = input as Record<string, unknown>;
  const phoneNumberId = value["phoneNumberId"];
  const waId = value["waId"];
  const messageId = value["messageId"];
  if (typeof phoneNumberId !== "string" || typeof waId !== "string" || typeof messageId !== "string") {
    return null;
  }
  return {
    phoneNumberId,
    displayPhoneNumber: typeof value["displayPhoneNumber"] === "string" ? value["displayPhoneNumber"] : undefined,
    waId,
    profileName: typeof value["profileName"] === "string" ? value["profileName"] : null,
    messageId,
    timestamp: typeof value["timestamp"] === "string" ? value["timestamp"] : undefined,
    type: typeof value["type"] === "string" ? value["type"] : "text",
    text: typeof value["text"] === "string" ? value["text"] : null,
    raw: value["raw"],
  };
}

export async function handleInbound(msg: NormalizedInbound): Promise<InboundResult> {
  return tx(async (client) => {
    const tenant = await one<TenantRow>(
      client,
      `select id, name, is_demo, flow, qualification_config from tenants where wa_phone_number_id = $1`,
      [msg.phoneNumberId],
    );
    if (!tenant) return skip("unknown_tenant");

    const contact = await one<ContactRow>(
      client,
      `insert into contacts (tenant_id, wa_id, profile_name, message_count)
       values ($1, $2, $3, 1)
       on conflict (tenant_id, wa_id) do update
         set last_seen_at  = now(),
             profile_name  = coalesce(excluded.profile_name, contacts.profile_name),
             message_count = contacts.message_count + 1
       returning id, blocked, profile_name, message_count`,
      [tenant.id, msg.waId, msg.profileName],
    );
    if (!contact) return skip("contact_upsert_failed");
    if (contact.blocked) return skip("blocked");

    // A returning visitor comes back with a fresh code from the session page.
    // The code, not the phone number, decides which run of the demo this is, so
    // it gets claimed before anything reads the conversation.
    const claimedToken = await claimToken(client, tenant.id, contact.id, msg.text);

    // A new code restarts the demo: the finished conversation is closed so the
    // flow runs from the top again, and the free messages start over.
    const messageCount = claimedToken
      ? await restartDemoAllowance(client, contact.id)
      : contact.message_count;

    const conversation = await resolveConversation(client, tenant.id, contact.id, claimedToken !== null);

    // Meta retries webhooks. The unique constraint on wa_message_id is the real
    // guard — if this insert returns nothing we have already replied to it.
    const inserted = await one<{ id: string }>(
      client,
      `insert into messages (conversation_id, tenant_id, direction, wa_message_id, type, body, raw)
       values ($1, $2, 'in', $3, $4, $5, $6)
       on conflict (wa_message_id) do nothing
       returning id`,
      [conversation.id, tenant.id, msg.messageId, msg.type, msg.text, JSON.stringify(msg.raw ?? null)],
    );
    if (!inserted) return skip("duplicate");

    await client.query(
      `update conversations
          set last_inbound_at = now(), session_expires_at = now() + interval '24 hours'
        where id = $1`,
      [conversation.id],
    );

    if (claimedToken) await bindToken(client, tenant.id, conversation.id, claimedToken);

    // Abuse and cost control on the shared demo number: one closing message,
    // then silence — until a new code arrives and the allowance restarts.
    if (tenant.is_demo && messageCount > config.demoMessageCap) {
      if (messageCount > config.demoMessageCap + 1) return skip("demo_cap");
      return send(
        client,
        tenant.id,
        conversation.id,
        msg,
        `That's the end of the free demo — thanks for putting it through its paces. ` +
          `Book 15 minutes to get this running on your own number: ${config.publicAppUrl}/book`,
      );
    }

    // The conversation a visitor built for themselves on the session page wins
    // over the tenant's. It has to: every trial lead shares the demo number, so
    // the tenant's own flow is the fallback, not the answer.
    const flowToken = conversation.signup_token ?? claimedToken;
    const tokenFlow = flowToken
      ? await one<{ flow: unknown }>(client, `select flow from signup_tokens where token = $1`, [flowToken])
      : undefined;

    const history = await rows<{ direction: "in" | "out"; body: string | null }>(
      client,
      `select direction, body from messages
        where conversation_id = $1 and id <> $2
        order by created_at asc
        limit 40`,
      [conversation.id, inserted.id],
    );

    const result = await composeReply({
      tenantName: tenant.name,
      profileName: contact.profile_name,
      body: msg.text ?? null,
      messageType: msg.type,
      history,
      tokenJustClaimed: claimedToken,
      dashboardUrl: claimedToken ? `${config.publicAppUrl}/s/${claimedToken}` : null,
      flow: loadFlow(tokenFlow?.flow ?? tenant.flow, tenant.qualification_config),
      flowState: conversation.flow_state,
    });

    if (result.intake) {
      const { verdict, answers, missing, model, state } = result.intake;
      await client.query(
        `insert into qualifications
           (conversation_id, tenant_id, verdict, score, matter_type, reasons, extracted, model)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          conversation.id,
          tenant.id,
          verdict,
          Object.keys(answers).length,
          answers["matter_type"] ?? null,
          JSON.stringify(
            missing.length === 0
              ? ["every question in the flow answered"]
              : missing.map((key) => `missing: ${key}`),
          ),
          JSON.stringify(answers),
          model,
        ],
      );
      // The flow position has to be saved even when the verdict has not moved,
      // or the next message re-asks the question we just sent.
      await client.query(`update conversations set state = $1, flow_state = $2 where id = $3`, [
        verdict,
        JSON.stringify(state),
        conversation.id,
      ]);
    }

    return send(client, tenant.id, conversation.id, msg, result.body);
  });
}

/**
 * Reuses the live conversation, or opens a new one when the last inbound
 * message is older than Meta's 24h session window.
 */
async function resolveConversation(
  client: PoolClient,
  tenantId: string,
  contactId: string,
  restart: boolean,
): Promise<ConversationRow> {
  const existing = await one<ConversationRow>(
    client,
    `select id, signup_token, flow_state,
            (last_inbound_at is not null and last_inbound_at < now() - interval '24 hours') as stale
       from conversations
      where contact_id = $1 and state <> 'closed'
      order by started_at desc
      limit 1`,
    [contactId],
  );
  if (existing && !existing.stale && !restart) return existing;

  if (existing) {
    await client.query(`update conversations set state = 'closed' where id = $1`, [existing.id]);
  }

  const created = await one<ConversationRow>(
    client,
    `insert into conversations (tenant_id, contact_id) values ($1, $2)
     returning id, signup_token, flow_state, false as stale`,
    [tenantId, contactId],
  );
  if (!created) throw new Error("failed to create conversation");
  return created;
}

/**
 * Binds the browser session to this phone number. Happens on any message that
 * carries a valid, unclaimed code: the first one starts the demo, and a later
 * one — a second code built on the session page — starts it over. Each code is
 * claimable once, so re-sending the same one changes nothing.
 */
async function claimToken(
  client: PoolClient,
  tenantId: string,
  contactId: string,
  body: string | null | undefined,
): Promise<string | null> {
  const token = extractToken(body);
  if (!token) return null;

  const claimed = await one<{ token: string }>(
    client,
    `update signup_tokens
        set claimed_by_contact_id = $1, claimed_at = now()
      where token = $2
        and tenant_id = $3
        and claimed_at is null
        and expires_at > now()
      returning token`,
    [contactId, token, tenantId],
  );
  if (!claimed) return null;
  return claimed.token;
}

/** Points the conversation at the code it is running, once that conversation exists. */
async function bindToken(
  client: PoolClient,
  tenantId: string,
  conversationId: string,
  token: string,
): Promise<void> {
  const bound = await one<{ contact_id: string }>(
    client,
    `update conversations set signup_token = $1 where id = $2 returning contact_id`,
    [token, conversationId],
  );
  await client.query(
    `insert into events (tenant_id, kind, ref, data) values ($1, 'token.claimed', $2, $3)`,
    [tenantId, token, JSON.stringify({ contactId: bound?.contact_id ?? null, conversationId })],
  );
}

/**
 * Gives the contact the free-message allowance the new code came with. The cap
 * is per demo run, not per phone number for life.
 */
async function restartDemoAllowance(client: PoolClient, contactId: string): Promise<number> {
  const row = await one<{ message_count: number }>(
    client,
    `update contacts set message_count = 1 where id = $1 returning message_count`,
    [contactId],
  );
  return row?.message_count ?? 1;
}

async function send(
  client: PoolClient,
  tenantId: string,
  conversationId: string,
  msg: NormalizedInbound,
  body: string,
): Promise<InboundResult> {
  const outbound = await one<{ id: string }>(
    client,
    `insert into messages (conversation_id, tenant_id, direction, type, body, status)
     values ($1, $2, 'out', 'text', $3, 'pending')
     returning id`,
    [conversationId, tenantId, body],
  );
  if (!outbound) throw new Error("failed to record outbound message");

  await client.query(`update conversations set last_outbound_at = now() where id = $1`, [conversationId]);

  return {
    action: "send_text",
    phoneNumberId: msg.phoneNumberId,
    to: msg.waId,
    body,
    outboundRef: outbound.id,
  };
}

function skip(reason: string): InboundResult {
  return { action: "skip", reason };
}

async function one<T extends Record<string, unknown>>(
  client: PoolClient,
  text: string,
  params: unknown[],
): Promise<T | undefined> {
  const result = await client.query<T>(text, params);
  return result.rows[0];
}

async function rows<T extends Record<string, unknown>>(
  client: PoolClient,
  text: string,
  params: unknown[],
): Promise<T[]> {
  const result = await client.query<T>(text, params);
  return result.rows;
}
