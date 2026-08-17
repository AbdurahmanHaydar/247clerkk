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
| `src/reply.ts` | The seam where the model plugs in. |
| `src/tokens.ts` | `CLK-XXXXXX` signup codes and wa.me deep links. |
| `n8n/247clerk-inbound.json` | The n8n workflow. Secret is a placeholder — fill it in n8n. |

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

Copy `.env.example` to `.env` first. Never commit `.env`.
