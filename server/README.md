# 247clerk server

The app that sits behind n8n. n8n owns the Meta webhook registration and the
WhatsApp credentials; this app owns conversation state, tenant routing, lead
qualification and everything the dashboard reads.

```
WhatsApp Cloud API
      │
      ▼
n8n (backend.durih.com)  WhatsApp Trigger → Normalize → HTTP POST
      │                                                    │
      │                             http://172.18.0.1:3000/internal/wa/inbound
      ▼                                                    ▼
n8n Send message  ◄───── { action, to, body, outboundRef }  this app + Postgres
      │
      └─► POST /internal/wa/sent   (records the wamid Meta assigned)
```

## Why this split

Meta allows exactly one webhook URL per WhatsApp app, and n8n's WhatsApp Trigger
already holds it with working credentials. Rather than move the registration, n8n
stays as the pipe and forwards every message here. Conversation state, dedup and
dashboard queries live in Postgres where they are queryable.

## Layout

| Path | What it is |
| --- | --- |
| `db/001_init.sql` | Schema. Applied to the `clerk` database. |
| `src/inbound.ts` | The core handler: tenant routing, dedup, token claim, reply. |
| `src/reply.ts` | Chooses between welcome, intake and fallback replies. |
| `src/qualify.ts` | The three intake questions and the verdict rule. |
| `src/gemini.ts` | Gemini client: structured output, retry, model fallback. |
| `src/tokens.ts` | `CLK-XXXXXX` signup codes and wa.me deep links. |
| `src/admin.ts` | Owner-only dashboard queries, behind the `ADMIN_TOKEN` path. |
| `src/visits.ts` | Visitor capture: IP, headers, geo lookup, rate limiting. |
| `src/ua.ts` | User-agent parsing. No dependency; client hints beat it when offered. |
| `public/t.js` | The tracker both the landing page and the session page load. |
| `db/002_visits.sql` | The `visits` table. Apply with `db/migrate.mjs`. |
| `public/session.html` | The live demo dashboard served at `/s/:token`. |
| `public/admin.html` | The owner dashboard served at `/admin/:token`. |
| `public/book.html` | Placeholder for `/book`; set `BOOKING_URL` to redirect instead. |
| `n8n/247clerk-inbound.json` | The n8n workflow. Secret is a placeholder — fill it in n8n. |

## The visitor journey

```
247clerk.com  ──►  app.247clerk.com/start   mints a code, redirects
                            │
                            ▼
                   /s/CLK-XXXXXX            QR + "Open WhatsApp", polling
                            │
              first WhatsApp message claims the code
                            ▼
                   /s/CLK-XXXXXX            transcript + live lead verdict
```

`/start` mints the session server-side and redirects, so there is no form to
fill, nothing to lose on refresh, and the dashboard URL is shareable. The page
polls `/api/session/:token` every 2s.

Anyone holding the code can view that conversation — it is the visitor's own
chat and the code is single-use random, but it is not authentication. Real
login (magic link) belongs with per-tenant onboarding, not the demo.

## Visitor capture

Every arrival is recorded in `visits`, so the funnel is visible before anyone
says a word:

```
page.view      landed on 247clerk.com
cta.click      pressed "Try it on WhatsApp"      ─┐ t.js, in the browser
session.view   landed on /s/CLK-XXXXXX            │
wa.click       pressed "Open WhatsApp"           ─┘
start.view     hit /start                          server-side, always recorded
```

`public/t.js` is loaded by `index.html` on the marketing site and by
`session.html` here. It wires itself to every link pointing at `/start` or
`wa.me`, so a new CTA is tracked without touching the tracker. On click it
stamps the link with `?vid=`, which is how a click on 247clerk.com and the token
minted a second later on app.247clerk.com are known to be the same person.

Two halves make up a row. The browser posts what only it knows to `/api/track` —
the [ipify](https://www.ipify.org/) answer, screen, viewport, timezone, language,
CPU cores, memory, connection type, referrer, UTM, and the high-entropy client
hints that carry the real browser and OS version. The server adds what the
browser could lie about: the connecting IP from `X-Forwarded-For`, the request
headers, and a geo lookup of that IP (city, region, country, ISP) through
`GEOIP_URL`. The lookup happens after the row is written, so nothing a visitor
waits on ever blocks on a third party.

`/api/track` is public by necessity — it is called before anyone has identified
themselves. It is rate limited to 120 requests per minute per IP, capped at 32KB
a request, and rejects any `kind` outside the five above. Beacons are sent as
`text/plain` so they never trigger a CORS preflight and a click is never delayed.

Bots and link previews are marked `device = 'bot'` rather than dropped, so the
funnel is not quietly inflated by Facebook and Slack fetching the page.

Set `GEOIP_ENABLED=false` to stop sending IPs to the lookup provider; everything
else keeps working. IP and device details are personal information under POPIA —
`privacy-policy.html` should say that you collect them and why.

## The admin dashboard

`https://app.247clerk.com/admin/<ADMIN_TOKEN>` — everyone who has messaged the
demo number, their WhatsApp number and profile name, every message in both
directions, the verdict the clerk reached and what it extracted, plus the links
that were issued and never used. `Export CSV` gives one row per person.

Three tabs: **People** (anyone who messaged, with their transcript and the
browser they arrived from), **Unused links** (issued and never used, now showing
where each one came from and whether they got as far as opening WhatsApp), and
**Visitors** (everyone who landed on the page at all, with IP, city, ISP, device
and every raw detail captured).

The UUID in the path is the only credential, so treat the link like a password.
A wrong token gets the same 302 to the marketing site as any unknown path, so
the route is not discoverable by probing, and the page is `noindex` and
`no-store`. Set the token with:

```bash
node -e "console.log(crypto.randomUUID())"   # put it in .env as ADMIN_TOKEN
```

Leave `ADMIN_TOKEN` empty and the routes do not exist at all. Rotating it is a
one-line `.env` change plus `systemctl restart 247clerk`; the old link dies
immediately.

## Infrastructure on this host

- **Postgres** — database `clerk`, role `clerk`, in the existing `n8n-postgres-1`
  container on `127.0.0.1:5432`. Separate database from `n8n`'s own.
- **Service** — `systemctl status 247clerk`, logs via `journalctl -u 247clerk -f`.
- **Caddy** — `app.247clerk.com` → `localhost:3000`. `/internal/*` is refused over
  the public hostname; n8n reaches it on the docker bridge instead.
- **ufw** — port 3000 is open to `172.16.0.0/12` (docker) only, closed publicly.

## Multi-tenancy

Inbound is routed by `metadata.phone_number_id` → `tenants.wa_phone_number_id`.
The shared demo number is just the row with `is_demo = true`. When a customer
brings their own number, insert a tenant row with their `phone_number_id` and
nothing else in the pipeline changes.

## Idempotency

`messages.wa_message_id` is unique. Meta retries webhooks; that constraint is what
stops a double reply. A retry returns `{"action":"skip","reason":"duplicate"}`.

## Qualification

Three questions — `matter_type`, `timeline`, `contact_name`. Answer all three and
the lead is **qualified**; refuse and it's **unqualified**; anything in between is
`needs_info` while collecting.

The split is deliberate: Gemini extracts the answers and phrases the next
question, but the *verdict is computed in code* from which slots are filled. The
model never decides who is qualified. Slots are sticky — once filled, a later
turn can't erase an answer.

Questions live in `tenants.qualification_config`, so changing them is a SQL
update, not a deploy:

```sql
update tenants set qualification_config = jsonb_set(
  qualification_config, '{questions}', '[...]'::jsonb) where is_demo = true;
```

If Gemini is unreachable the handler falls back to asking the next unanswered
question verbatim and records `model = null`. The number never goes silent.

## The 24h window

Meta only permits free-form replies within 24h of the contact's last inbound
message. `conversations.session_expires_at` tracks it, and a conversation whose
last inbound is older than that is closed and a fresh one opened. Anything sent
outside the window needs a pre-approved template.

## Local development

```bash
npm install
npm run build
node --env-file=.env dist/index.js
```

Migrations are idempotent and applied one file at a time:

```bash
node --env-file=.env db/migrate.mjs db/002_visits.sql
```

Copy `.env.example` to `.env` first. Never commit `.env`.
