-- Everything we can learn about a visitor at the moment they reach for the
-- demo. One row per tracked action: landing page view, "Try it on WhatsApp"
-- click, session page view, "Open WhatsApp" click.
--
-- The browser half (ipify, screen, timezone, client hints) arrives on
-- /api/track; the server half (real IP from X-Forwarded-For, headers, geo
-- lookup) is added here where the browser cannot lie about it.

create table if not exists visits (
  id              bigserial primary key,
  -- Random id the browser keeps in localStorage. The only thing that ties a
  -- click on 247clerk.com to the token minted a second later on app.247clerk.com.
  visitor_id      text,
  token           text references signup_tokens(token) on delete set null,
  -- page.view | cta.click | session.view | wa.click
  kind            text not null,
  source          text,
  -- What our server saw. Ground truth; the client cannot forge it.
  ip              text,
  -- What ipify told the browser. Differs from ip behind VPNs and proxies.
  client_ip       text,
  user_agent      text,
  browser         text,
  browser_version text,
  os              text,
  device          text,
  city            text,
  region          text,
  country         text,
  country_code    text,
  latitude        double precision,
  longitude       double precision,
  isp             text,
  ip_timezone     text,
  language        text,
  timezone        text,
  screen          text,
  referrer        text,
  page_url        text,
  utm             jsonb not null default '{}'::jsonb,
  -- The full browser payload and request headers, kept verbatim so a question
  -- we haven't thought of yet is still answerable.
  client          jsonb not null default '{}'::jsonb,
  headers         jsonb not null default '{}'::jsonb,
  geo             jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists visits_token_idx   on visits (token, created_at desc);
create index if not exists visits_visitor_idx on visits (visitor_id, created_at desc);
create index if not exists visits_kind_idx    on visits (kind, created_at desc);
create index if not exists visits_created_idx on visits (created_at desc);

-- The visitor id is carried into /start as ?vid=, so a token can be traced back
-- to the click that produced it even before the visitor says a word.
alter table signup_tokens add column if not exists visitor_id text;
create index if not exists signup_tokens_visitor_idx on signup_tokens (visitor_id);
