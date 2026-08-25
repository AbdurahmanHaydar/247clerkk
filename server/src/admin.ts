import { timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import { config } from "./config.js";
import { query, queryOne } from "./db.js";
import { registerFlows } from "./flows.js";

/**
 * The owner-only view. Everything the demo collects — who tried it, their
 * WhatsApp number, every message, the verdict the clerk reached — in one page.
 *
 * The only credential is the UUID in the URL. That is deliberately modest
 * security: it is a 122-bit unguessable secret, it never appears on a public
 * page, and the routes 404 identically for a wrong token as for a missing one.
 * It is also the whole key, so treat the link like a password.
 */

function authorized(provided: string): boolean {
  const expected = config.adminToken;
  if (!expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

type Serve = (name: string) => Promise<string>;

export function registerAdmin(app: Hono, page: Serve): void {
  // Wrong or missing token looks exactly like a route that was never there.
  // The middleware pattern carries no :token param of its own, so read the
  // segment straight off the path.
  app.use("/admin/*", async (c, next) => {
    if (!authorized(c.req.path.split("/")[2] ?? "")) return c.notFound();
    c.header("x-robots-tag", "noindex, nofollow");
    c.header("cache-control", "no-store");
    await next();
  });

  app.get("/admin/:token", async (c) => c.html(await page("admin.html")));

  // Reading and editing the intake conversation itself.
  registerFlows(app);

  /** Everything the list view needs, in one round trip. */
  app.get("/admin/:token/data", async (c) => {
    const [stats, people, unclaimed, visitors] = await Promise.all([
      queryOne(STATS_SQL),
      query(PEOPLE_SQL),
      query(UNCLAIMED_SQL),
      query(VISITORS_SQL),
    ]);
    return c.json({ stats: stats ?? {}, people, unclaimed, visitors });
  });

  /** Every raw detail captured for one visitor id. */
  app.get("/admin/:token/visitors/:vid", async (c) => {
    const visits = await query(VISITS_SQL, [c.req.param("vid").slice(0, 100)]);
    if (!visits.length) return c.json({ error: "not_found" }, 404);
    return c.json({ visits });
  });

  /** One person: their details plus every conversation and message. */
  app.get("/admin/:token/people/:id", async (c) => {
    const id = c.req.param("id");
    if (!/^[0-9a-f-]{36}$/i.test(id)) return c.json({ error: "not_found" }, 404);

    const contact = await queryOne(CONTACT_SQL, [id]);
    if (!contact) return c.json({ error: "not_found" }, 404);

    const [conversations, messages, qualifications, tokens, events, visits] = await Promise.all([
      query(CONVERSATIONS_SQL, [id]),
      query(MESSAGES_SQL, [id]),
      query(QUALIFICATIONS_SQL, [id]),
      query(TOKENS_SQL, [id]),
      query(EVENTS_SQL, [id]),
      query(CONTACT_VISITS_SQL, [id]),
    ]);

    return c.json({ contact, conversations, messages, qualifications, tokens, events, visits });
  });

  /**
   * Spreadsheet copy of the list — one row per person. Flows collect whatever
   * the owner configured, so the answer columns are whatever actually turned
   * up rather than a fixed three.
   */
  app.get("/admin/:token/leads.csv", async (c) => {
    const people = await query<Record<string, unknown>>(PEOPLE_SQL);

    const answerKeys = new Set<string>();
    for (const person of people) {
      for (const key of Object.keys((person["extracted"] ?? {}) as Record<string, unknown>)) {
        // contact_name already has a column of its own from the signup form.
        if (key !== "contact_name") answerKeys.add(key);
      }
    }

    const columns = [
      "wa_id",
      "profile_name",
      "contact_name",
      "company_name",
      "email",
      "verdict",
      ...[...answerKeys].sort(),
      "source",
      "message_total",
      "conversation_count",
      "ip",
      "city",
      "country",
      "browser",
      "os",
      "device",
      "first_seen_at",
      "last_seen_at",
    ];
    const rows = people.map((person) => {
      const slots = (person["extracted"] ?? {}) as Record<string, unknown>;
      return columns
        .map((column) => csv(person[column] ?? slots[column] ?? ""))
        .join(",");
    });

    c.header("content-type", "text/csv; charset=utf-8");
    c.header("content-disposition", `attachment; filename="247clerk-leads-${today()}.csv"`);
    return c.body([columns.join(","), ...rows].join("\n"));
  });
}

function csv(value: unknown): string {
  const text = value instanceof Date ? value.toISOString() : String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ queries */

const STATS_SQL = `
  select
    (select count(*) from contacts)                                            as people,
    (select count(*) from contacts where last_seen_at > now() - interval '24 hours') as people_24h,
    (select count(*) from conversations)                                       as conversations,
    (select count(*) from messages)                                            as messages,
    (select count(*) from messages where direction = 'in')                     as messages_in,
    (select count(distinct contact_id) from conversations where state = 'qualified') as qualified,
    (select count(*) from signup_tokens)                                       as tokens_issued,
    (select count(*) from signup_tokens where claimed_at is not null)          as tokens_claimed,
    (select count(*) from visits)                                              as visits,
    (select count(distinct coalesce(visitor_id, 'ip:' || ip)) from visits)     as visitors,
    (select count(*) from visits where kind in ('cta.click', 'wa.click'))      as clicks`;

// One row per person. The lateral joins pull their newest verdict and the
// signup details they gave the landing page before they ever opened WhatsApp.
const PEOPLE_SQL = `
  select ct.id,
         ct.wa_id,
         ct.profile_name,
         ct.message_count,
         ct.blocked,
         ct.first_seen_at,
         ct.last_seen_at,
         t.name    as tenant_name,
         t.is_demo,
         (select count(*) from conversations c where c.contact_id = ct.id) as conversation_count,
         (select count(*) from messages m
            join conversations c on c.id = m.conversation_id
           where c.contact_id = ct.id)                                    as message_total,
         q.verdict,
         q.matter_type,
         q.extracted,
         q.created_at as verdict_at,
         s.token,
         s.company_name,
         s.contact_name,
         s.email,
         s.source,
         v.ip,
         v.client_ip,
         v.city,
         v.region,
         v.country,
         v.country_code,
         v.isp,
         v.browser,
         v.browser_version,
         v.os,
         v.device,
         v.referrer,
         v.timezone,
         v.screen,
         v.visitor_id
    from contacts ct
    join tenants t on t.id = ct.tenant_id
    left join lateral (
      select q.verdict, q.matter_type, q.extracted, q.created_at
        from qualifications q
        join conversations c on c.id = q.conversation_id
       where c.contact_id = ct.id
       order by q.created_at desc
       limit 1
    ) q on true
    left join lateral (
      select token, company_name, contact_name, email, source
        from signup_tokens
       where claimed_by_contact_id = ct.id
       order by claimed_at desc
       limit 1
    ) s on true
    -- What we know about the browser they came from: matched on the token they
    -- carried into WhatsApp, or on the visitor id behind that token.
    left join lateral (
      select v.*
        from visits v
       where v.token in (select token from signup_tokens where claimed_by_contact_id = ct.id)
          or (v.visitor_id is not null and v.visitor_id in (
                select visitor_id from signup_tokens
                 where claimed_by_contact_id = ct.id and visitor_id is not null))
       order by v.created_at desc
       limit 1
    ) v on true
   order by ct.last_seen_at desc
   limit 500`;

// Links handed out that never turned into a WhatsApp message. The drop-off.
const UNCLAIMED_SQL = `
  select t.token, t.company_name, t.contact_name, t.email, t.source, t.created_at, t.expires_at,
         t.expires_at < now() as expired,
         t.visitor_id,
         v.ip, v.client_ip, v.city, v.region, v.country, v.country_code, v.isp,
         v.browser, v.browser_version, v.os, v.device, v.referrer, v.timezone,
         -- Did they get as far as opening WhatsApp, or leave before that?
         exists (select 1 from visits w
                  where w.kind = 'wa.click'
                    and (w.token = t.token or (t.visitor_id is not null and w.visitor_id = t.visitor_id)))
           as opened_whatsapp
    from signup_tokens t
    left join lateral (
      select v.* from visits v
       where v.token = t.token
          or (t.visitor_id is not null and v.visitor_id = t.visitor_id)
       order by v.created_at desc
       limit 1
    ) v on true
   where t.claimed_at is null
   order by t.created_at desc
   limit 200`;

const CONTACT_SQL = `
  select ct.id, ct.wa_id, ct.profile_name, ct.message_count, ct.blocked,
         ct.first_seen_at, ct.last_seen_at, t.name as tenant_name, t.is_demo
    from contacts ct
    join tenants t on t.id = ct.tenant_id
   where ct.id = $1`;

const CONVERSATIONS_SQL = `
  select id, state, signup_token, started_at, last_inbound_at, last_outbound_at, session_expires_at
    from conversations
   where contact_id = $1
   order by started_at desc`;

const MESSAGES_SQL = `
  select m.id, m.conversation_id, m.direction, m.type, m.body, m.status,
         m.wa_message_id, m.created_at
    from messages m
    join conversations c on c.id = m.conversation_id
   where c.contact_id = $1
   order by m.created_at asc
   limit 2000`;

const QUALIFICATIONS_SQL = `
  select q.id, q.conversation_id, q.verdict, q.score, q.matter_type, q.reasons,
         q.extracted, q.model, q.created_at
    from qualifications q
    join conversations c on c.id = q.conversation_id
   where c.contact_id = $1
   order by q.created_at desc`;

const TOKENS_SQL = `
  select token, company_name, contact_name, email, source, utm, created_at, claimed_at, expires_at
    from signup_tokens
   where claimed_by_contact_id = $1
   order by created_at desc`;

// The audit trail, matched either by the person's token or by contactId in the
// event payload.
const EVENTS_SQL = `
  select kind, ref, data, created_at
    from events
   where data->>'contactId' = $1::text
      or ref in (select token from signup_tokens where claimed_by_contact_id = $1::uuid)
   order by created_at desc
   limit 200`;

/**
 * One row per visitor, newest first: the whole top of the funnel, including the
 * people who read the page and never touched the button. Visitors with no
 * visitor id (localStorage blocked, or a bot) fall back to being keyed by IP.
 */
const VISITORS_SQL = `
  with latest as (
    select distinct on (coalesce(visitor_id, 'ip:' || ip))
           coalesce(visitor_id, 'ip:' || ip) as vid,
           visitor_id, ip, client_ip, city, region, country, country_code, isp,
           browser, browser_version, os, device, referrer, source, timezone,
           language, screen, page_url, user_agent, created_at
      from visits
     order by coalesce(visitor_id, 'ip:' || ip), created_at desc
  ),
  totals as (
    select coalesce(visitor_id, 'ip:' || ip) as vid,
           min(created_at) as first_at,
           max(created_at) as last_at,
           count(*) as events,
           count(*) filter (where kind = 'cta.click') as cta_clicks,
           count(*) filter (where kind = 'wa.click')  as wa_clicks,
           bool_or(kind = 'start.view') as reached_start,
           array_remove(array_agg(distinct token), null) as tokens
      from visits
     group by 1
  )
  select l.*, t.first_at, t.last_at, t.events, t.cta_clicks, t.wa_clicks,
         t.reached_start, t.tokens,
         exists (
           select 1 from signup_tokens s
            where s.claimed_at is not null
              and (s.token = any (t.tokens) or (l.visitor_id is not null and s.visitor_id = l.visitor_id))
         ) as messaged
    from latest l
    join totals t using (vid)
   order by t.last_at desc
   limit 500`;

/** Every raw event for one visitor, newest first. */
const VISITS_SQL = `
  select id, kind, token, source, ip, client_ip, user_agent, browser, browser_version,
         os, device, city, region, country, isp, ip_timezone, language, timezone,
         screen, referrer, page_url, utm, client, headers, geo, created_at
    from visits
   where coalesce(visitor_id, 'ip:' || ip) = $1
   order by created_at desc
   limit 200`;

/** Everything captured for the browser behind a person who actually messaged. */
const CONTACT_VISITS_SQL = `
  select v.id, v.kind, v.token, v.source, v.ip, v.client_ip, v.user_agent, v.browser,
         v.browser_version, v.os, v.device, v.city, v.region, v.country, v.isp,
         v.ip_timezone, v.language, v.timezone, v.screen, v.referrer, v.page_url,
         v.utm, v.client, v.headers, v.geo, v.visitor_id, v.created_at
    from visits v
   where v.token in (select token from signup_tokens where claimed_by_contact_id = $1)
      or (v.visitor_id is not null and v.visitor_id in (
            select visitor_id from signup_tokens
             where claimed_by_contact_id = $1 and visitor_id is not null))
   order by v.created_at desc
   limit 100`;
