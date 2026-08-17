-- 247clerk core schema
-- Multi-tenant from day one: inbound WhatsApp is routed by metadata.phone_number_id.
-- The shared demo number is simply the tenant with is_demo = true.

create extension if not exists pgcrypto;

create table if not exists tenants (
  id                   uuid primary key default gen_random_uuid(),
  slug                 text not null unique,
  name                 text not null,
  vertical             text,
  -- Meta Cloud API routing key. Null until the tenant brings their own number.
  wa_phone_number_id   text unique,
  wa_display_number    text,
  is_demo              boolean not null default false,
  business_hours       jsonb not null default '{}'::jsonb,
  qualification_config jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now()
);

create table if not exists contacts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  -- International format, no leading +, exactly as Meta sends wa_id.
  wa_id         text not null,
  profile_name  text,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  -- Abuse control on the shared demo number.
  message_count integer not null default 0,
  blocked       boolean not null default false,
  unique (tenant_id, wa_id)
);

-- The code embedded in the wa.me?text= deep link. Binds a browser session to a
-- phone number on the very first inbound message, and only then.
create table if not exists signup_tokens (
  token                 text primary key,
  tenant_id             uuid not null references tenants(id) on delete cascade,
  company_name          text,
  contact_name          text,
  email                 text,
  source                text,
  utm                   jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  expires_at            timestamptz not null default now() + interval '7 days',
  claimed_by_contact_id uuid references contacts(id) on delete set null,
  claimed_at            timestamptz
);

create table if not exists conversations (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  contact_id         uuid not null references contacts(id) on delete cascade,
  -- open | qualified | unqualified | needs_info | booked | closed
  state              text not null default 'open',
  signup_token       text references signup_tokens(token) on delete set null,
  started_at         timestamptz not null default now(),
  last_inbound_at    timestamptz,
  last_outbound_at   timestamptz,
  -- Meta's free-form reply window: last_inbound_at + 24h. Past this we need a template.
  session_expires_at timestamptz
);

create table if not exists messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  tenant_id       uuid not null references tenants(id) on delete cascade,
  direction       text not null check (direction in ('in', 'out')),
  -- Meta retries webhooks; this unique constraint is what stops double replies.
  wa_message_id   text unique,
  type            text not null default 'text',
  body            text,
  raw             jsonb,
  status          text,
  created_at      timestamptz not null default now()
);

create table if not exists qualifications (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  tenant_id       uuid not null references tenants(id) on delete cascade,
  -- qualified | unqualified | needs_info
  verdict         text not null,
  score           integer,
  matter_type     text,
  reasons         jsonb not null default '[]'::jsonb,
  extracted       jsonb not null default '{}'::jsonb,
  model           text,
  created_at      timestamptz not null default now()
);

create table if not exists appointments (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  contact_id  uuid not null references contacts(id) on delete cascade,
  starts_at   timestamptz,
  provider    text,
  external_id text,
  status      text not null default 'pending',
  created_at  timestamptz not null default now()
);

-- Append-only audit trail: webhook received, token claimed, reply sent, model called.
create table if not exists events (
  id         bigserial primary key,
  tenant_id  uuid references tenants(id) on delete cascade,
  kind       text not null,
  ref        text,
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists messages_conversation_idx      on messages (conversation_id, created_at);
create index if not exists conversations_tenant_idx       on conversations (tenant_id, last_inbound_at desc);
create index if not exists contacts_tenant_wa_idx         on contacts (tenant_id, wa_id);
create index if not exists qualifications_conversation_idx on qualifications (conversation_id, created_at desc);
create index if not exists events_tenant_kind_idx         on events (tenant_id, kind, created_at desc);

-- Seed: the shared demo number every trial lead messages first.
insert into tenants (slug, name, vertical, wa_phone_number_id, wa_display_number, is_demo)
values ('247clerk-demo', '247clerk (demo)', 'legal', '1247968325064237', '27705862968', true)
on conflict (slug) do nothing;
