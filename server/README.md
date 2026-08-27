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
| `src/flow.ts` | The intake flow: its shape, validation, and the legacy import. |
| `src/engine.ts` | Runs a flow against one message. Branching is code; the model only reads. |
| `src/flows.ts` | Admin routes behind the builder: load, save, roll back, simulate. |
| `src/gemini.ts` | Gemini client: structured output, retry, model fallback. |
| `src/tokens.ts` | `CLK-XXXXXX` signup codes and wa.me deep links. |
| `src/admin.ts` | Owner-only dashboard queries, behind the `ADMIN_TOKEN` path. |
| `src/visits.ts` | Visitor capture: IP, headers, geo lookup, rate limiting. |
| `src/ua.ts` | User-agent parsing. No dependency; client hints beat it when offered. |
| `public/t.js` | The tracker both the landing page and the session page load. |
| `db/002_visits.sql` | The `visits` table. Apply with `db/migrate.mjs`. |
| `db/003_flows.sql` | `tenants.flow`, `conversations.flow_state`, `flow_revisions`. |
| `db/004_session_flows.sql` | `signup_tokens.flow` — the conversation a visitor builds for themselves. |
| `src/templates.ts` | The starter conversations the demo builder offers. |
| `public/session.html` | The live demo dashboard served at `/s/:token`. |
| `public/admin.html` | The owner dashboard served at `/admin/:token`. |
| `public/book.html` | Placeholder for `/book`; set `BOOKING_URL` to redirect instead. |
| `n8n/247clerk-inbound.json` | The n8n workflow. Secret is a placeholder — fill it in n8n. |

## The visitor journey

```
247clerk.com  ──►  app.247clerk.com/start   mints a code, redirects
                            │
                            ▼
                   /s/CLK-XXXXXX  (build)   pick a trade, edit the questions
                            │
                    "Save and open WhatsApp"
                            ▼
                   /s/CLK-XXXXXX  (connect) QR + "Open WhatsApp", polling
                            │
              first WhatsApp message claims the code
                            ▼
                   /s/CLK-XXXXXX  (live)    transcript + live lead verdict
```

`/start` mints the session server-side and redirects, so there is no form to
fill, nothing to lose on refresh, and the dashboard URL is shareable. The page
polls `/api/session/:token` every 2s.

All three stages are the same URL. Which one shows is decided by the session:
no flow saved yet and not connected means the builder, otherwise the link, and
once a message has landed, the transcript. **Edit the questions** goes back to
the builder from either of the later stages, and applies from the next message.

### The visitor builds their own conversation

This is the demo's whole pitch — you configure what the clerk asks *before* you
test it, and it answers in your words a moment later. The builder writes the
same flow format the engine runs; there is no second implementation.

It is deliberately smaller than the owner's builder in `/admin`: a greeting,
some questions, one ending, and a "not a fit" toggle on any option of a list
question (which compiles to that option branching to the unqualified end). No
conditions, no jump rules — those stay in the admin builder.

The flow lives on `signup_tokens.flow`, **not** on the tenant. It has to: every
trial lead shares one demo number, so a tenant-level flow would mean the last
person to press save rewrote the conversation for everyone. `handleInbound`
resolves the flow in that order — the conversation's signup code first, then
the tenant, then the legacy config, then the built-in default.

Because that flow is untrusted text this number will send back out,
`checkPublicFlow()` caps it: 14 steps, 8 questions, 6 options, 320 characters
per message, no condition steps, and no booking link of the visitor's choosing.
The blast radius is small — the clerk only ever replies to whoever messaged it —
but a code can be passed to someone else, so the caps are not optional.

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

Four tabs: **People** (anyone who messaged, with their transcript and the
browser they arrived from), **Unused links** (issued and never used, now showing
where each one came from and whether they got as far as opening WhatsApp),
**Visitors** (everyone who landed on the page at all, with IP, city, ISP, device
and every raw detail captured), and **Conversation** (the flow builder below).

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

## The intake flow

What the clerk asks is configuration, not code. A tenant's flow is a small graph
of steps stored in `tenants.flow`, edited in the **Conversation** tab of the
admin dashboard, and live on the very next inbound message — no deploy, no SQL.

Four kinds of step:

| Step | What it does |
| --- | --- |
| `message` | Says something and moves on. Greeting, holding line, sign-off. |
| `question` | Asks for one fact and stores it under a key. |
| `condition` | Branches on the answers collected so far. |
| `end` | Stops, with a verdict: qualified, unqualified, or handoff. |

Steps run top to bottom unless something sends the conversation elsewhere: a
question's `next`, an option's own branch, or a jump rule that fires when the
answers match. The first step in the list is always where a conversation starts.

### Two ways to ask

Every question is either **strict** or **ai**, and the choice is per question:

- **strict** — sent word for word and validated locally against its answer type
  (choice, email, phone, number, date, or a regex). No model call, so it is
  predictable and free. It only ever hears the reply to that one question.
- **ai** — Gemini reads the answer out of whatever the person wrote, including
  facts they volunteered several messages earlier. Someone who opens with "it's
  an eviction, I'm Sipho, need it this week" answers three questions at once and
  the flow steps over all three.

What the model is *never* asked to do is decide where the conversation goes. It
returns extracted values, a declined flag, and at most eight words of
acknowledgement. Which step comes next, which branch a choice takes and what the
verdict is are all computed in `src/engine.ts` from the flow as drawn.

That split is also what makes an outage survivable. If Gemini is unreachable the
handler logs it, takes the message in front of it as the answer to the question
on the table, and carries on with `model = null` recorded. The number never goes
silent and the flow never stalls.

Which means the model call must **fail fast**, not eventually succeed. n8n gives
the whole inbound request 30 seconds before it aborts, and an aborted request
never reaches the Send node — the reply is composed, written to `messages` as
`pending`, and never delivered, so the number looks dead from the outside. So
one attempt is capped at `GEMINI_TIMEOUT_MS` and every attempt together at
`GEMINI_BUDGET_MS`. Each model gets a single attempt; the fallback *is* the
retry. A model that fails is benched for `GEMINI_COOLDOWN_MS`, so the message
after an outage starts goes straight to one that works instead of paying the
same timeout again.

### State

`conversations.flow_state` holds the step awaiting an answer, every answer so
far, and the per-step retry count. Answers are sticky — a later turn cannot
erase one. A required question that goes unanswered three times is skipped
rather than asked forever.

`{{key}}` in any message drops in an answer, and `{{#key}}…{{/key}}` keeps its
contents only when that answer exists, so `Thanks{{#name}}, {{name}}{{/name}}`
reads correctly either way. `{{name}}` and `{{tenant}}` always resolve.

### The builder

The **Conversation** tab edits the flow for any tenant: add, reorder and delete
steps, set jump rules, and try the whole thing against made-up messages in the
panel beside it. The simulator replays the draft — unsaved changes included —
through the real engine and shows which steps each message walked through, so a
branch can be checked before a client ever hits it. Turn *AI reading* off to see
exactly what the flow does with no model at all.

Every save is validated first: dangling jumps, duplicate ids, a choice with no
options and a missing question all block the save, because a broken flow means a
live WhatsApp number stops making sense. Warnings — an unreachable step, two
questions writing to one key — are shown but allowed.

Every save is also kept in `flow_revisions`, and the History dropdown restores
any of them in one click.

### Tenants that have no flow

`loadFlow()` falls back in order: `tenants.flow`, then the legacy
`tenants.qualification_config.questions` array converted into a flow, then the
built-in default — `matter_type`, `timeline`, `contact_name`, exactly the three
questions this always asked. Nothing changes for a tenant until someone edits
their flow and saves it.

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
node --env-file=.env db/migrate.mjs db/003_flows.sql
```

Copy `.env.example` to `.env` first. Never commit `.env`.
