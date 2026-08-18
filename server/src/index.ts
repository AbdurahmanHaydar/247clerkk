import { serve } from "@hono/node-server";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { cors } from "hono/cors";
import QRCode from "qrcode";
import { config } from "./config.js";
import { logEvent, pool, query, queryOne } from "./db.js";
import { handleInbound, parseInbound } from "./inbound.js";
import { buildWaLink, generateToken } from "./tokens.js";

const app = new Hono();

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

async function page(name: string): Promise<string> {
  return readFile(join(PUBLIC_DIR, name), "utf8");
}

app.use(
  "/api/*",
  cors({
    origin: ["https://247clerk.com", "https://www.247clerk.com", "http://localhost:5173"],
    allowMethods: ["GET", "POST", "OPTIONS"],
  }),
);

app.get("/health", async (c) => {
  const row = await queryOne<{ now: Date }>("select now() as now");
  return c.json({ ok: true, db: row?.now ?? null });
});

/* ---------------------------------------------------------------- internal */
// Called by n8n only. Shared secret, not exposed to browsers.

app.use("/internal/*", async (c, next) => {
  const provided = c.req.header("x-clerk-secret") ?? "";
  const expected = config.n8nSecret;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

app.post("/internal/wa/inbound", async (c) => {
  const payload = await c.req.json().catch(() => null);
  const msg = parseInbound(payload);
  if (!msg) return c.json({ action: "skip", reason: "malformed_payload" }, 400);

  try {
    const result = await handleInbound(msg);
    return c.json(result);
  } catch (error) {
    console.error("[inbound] failed", error);
    await logEvent(null, "inbound.error", msg.messageId, {
      message: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
    return c.json({ action: "skip", reason: "internal_error" }, 500);
  }
});

/** n8n reports back the wamid Meta assigned to the message it just sent. */
app.post("/internal/wa/sent", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const outboundRef = typeof body["outboundRef"] === "string" ? body["outboundRef"] : null;
  if (!outboundRef) return c.json({ error: "outboundRef required" }, 400);

  const waMessageId = typeof body["waMessageId"] === "string" ? body["waMessageId"] : null;
  const status = typeof body["status"] === "string" ? body["status"] : "sent";

  await query(`update messages set wa_message_id = coalesce($1, wa_message_id), status = $2 where id = $3`, [
    waMessageId,
    status,
    outboundRef,
  ]);
  return c.json({ ok: true });
});

/* --------------------------------------------------------------------- api */

type SessionDetails = { companyName?: string | null; contactName?: string | null; email?: string | null };

/** Mints a signup code against the demo tenant. Shared by /api/signup and /start. */
async function createSession(source: string, details: SessionDetails = {}): Promise<string | null> {
  const tenant = await queryOne<{ id: string }>(`select id from tenants where is_demo = true limit 1`);
  if (!tenant) return null;

  const token = generateToken();
  await query(
    `insert into signup_tokens (token, tenant_id, company_name, contact_name, email, source)
     values ($1, $2, $3, $4, $5, $6)`,
    [token, tenant.id, details.companyName ?? null, details.contactName ?? null, details.email ?? null, source],
  );
  await logEvent(tenant.id, "token.issued", token, { source });
  return token;
}

app.post("/api/signup", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const str = (key: string) => (typeof body[key] === "string" ? (body[key] as string).slice(0, 200) : null);

  const token = await createSession(str("source") ?? "landing", {
    companyName: str("companyName"),
    contactName: str("contactName"),
    email: str("email"),
  });
  if (!token) return c.json({ error: "no demo tenant configured" }, 500);

  return c.json({ token, waLink: buildWaLink(config.demoWaNumber, token) });
});

/** The session page polls this while it waits for the first WhatsApp message. */
app.get("/api/session/:token", async (c) => {
  const token = c.req.param("token").toUpperCase();
  const row = await queryOne<{
    claimed_at: Date | null;
    expires_at: Date;
    conversation_id: string | null;
    state: string | null;
  }>(
    `select t.claimed_at, t.expires_at, c.id as conversation_id, c.state
       from signup_tokens t
       left join conversations c on c.signup_token = t.token
      where t.token = $1`,
    [token],
  );
  if (!row) return c.json({ error: "not_found" }, 404);

  const connected = row.claimed_at !== null;
  const waLink = buildWaLink(config.demoWaNumber, token);

  return c.json({
    connected,
    expired: row.expires_at.getTime() < Date.now(),
    conversationId: row.conversation_id,
    state: row.state,
    waLink,
    // Only needed by the pre-connection view; skip the work once they're in.
    qrSvg: connected ? null : await QRCode.toString(waLink, { type: "svg", margin: 0 }),
  });
});

/** Transcript for the live dashboard. */
app.get("/api/session/:token/messages", async (c) => {
  const token = c.req.param("token").toUpperCase();
  const conversation = await queryOne<{ id: string; state: string }>(
    `select id, state from conversations where signup_token = $1`,
    [token],
  );
  if (!conversation) return c.json({ messages: [], state: null });

  const messages = await query(
    `select direction, body, type, created_at from messages
      where conversation_id = $1 order by created_at asc`,
    [conversation.id],
  );
  const qualification = await queryOne(
    `select verdict, score, matter_type, reasons, extracted from qualifications
      where conversation_id = $1 order by created_at desc limit 1`,
    [conversation.id],
  );

  return c.json({ state: conversation.state, messages, qualification: qualification ?? null });
});

/* ------------------------------------------------------------------- pages */

/**
 * The one link the landing page needs. Mints a session server-side and hands
 * the visitor their own dashboard URL — no form, no account, nothing to lose
 * on refresh.
 */
app.get("/start", async (c) => {
  const token = await createSession(c.req.query("src") ?? "start");
  if (!token) return c.text("No demo tenant configured.", 500);
  return c.redirect(`/s/${token}`, 302);
});

app.get("/s/:token", async (c) => c.html(await page("session.html")));

app.get("/book", async (c) =>
  config.bookingUrl ? c.redirect(config.bookingUrl, 302) : c.html(await page("book.html")),
);

app.notFound((c) => c.redirect("https://247clerk.com/", 302));

// Binds on all interfaces so the n8n container can reach us on the docker
// bridge (172.18.0.1). ufw keeps this port closed to the public internet —
// see server/README.md.
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`[247clerk] listening on ${config.host}:${info.port}`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
  });
}
