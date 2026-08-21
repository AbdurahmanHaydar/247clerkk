import type { Context } from "hono";
import { config } from "./config.js";
import { query } from "./db.js";
import { parseAgent } from "./ua.js";

/**
 * Visitor capture.
 *
 * Two halves meet here. The browser sends what only it knows — the ipify
 * answer, screen, timezone, client hints — to /api/track. The server adds what
 * the browser could lie about: the connecting IP, the request headers, and the
 * geo lookup done against that IP. Neither half is trusted to be complete; a
 * visit row is written even if the client payload never arrives.
 */

export type VisitKind = "page.view" | "cta.click" | "session.view" | "wa.click" | "start.view";

const KINDS: VisitKind[] = ["page.view", "cta.click", "session.view", "wa.click", "start.view"];

export function isVisitKind(value: unknown): value is VisitKind {
  return typeof value === "string" && (KINDS as string[]).includes(value);
}

/** Request headers worth keeping. Client hints carry the honest browser version. */
const KEEP_HEADERS = [
  "user-agent",
  "accept-language",
  "referer",
  "origin",
  "dnt",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "sec-ch-ua-platform-version",
  "sec-ch-ua-model",
  "sec-ch-ua-arch",
  "sec-ch-ua-full-version-list",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "x-forwarded-for",
  "x-real-ip",
  "cf-connecting-ip",
  "true-client-ip",
  "cf-ipcountry",
  "cf-ray",
  "accept-encoding",
];

export type VisitInput = {
  kind: VisitKind;
  token?: string | null;
  visitorId?: string | null;
  source?: string | null;
  client?: Record<string, unknown>;
};

/**
 * Writes the visit and returns immediately. The geo lookup is a third-party
 * round trip, so it lands a moment later with an update — nothing the visitor
 * is waiting on ever blocks on it.
 */
export async function recordVisit(c: Context, input: VisitInput): Promise<void> {
  const client = input.client ?? {};
  const ip = clientIp(c);
  const headers = pickHeaders(c);
  const userAgent = str(client["userAgent"]) ?? c.req.header("user-agent") ?? null;
  const agent = parseAgent(userAgent);
  const hints = client["uaData"] as Record<string, unknown> | undefined;

  const rows = await query<{ id: string }>(
    `insert into visits (visitor_id, token, kind, source, ip, client_ip, user_agent,
                         browser, browser_version, os, device, language, timezone, screen,
                         referrer, page_url, utm, client, headers, country_code)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     returning id`,
    [
      str(input.visitorId),
      str(input.token)?.toUpperCase() ?? null,
      input.kind,
      str(input.source),
      ip,
      str(client["ip"]),
      userAgent,
      // Client hints beat the UA string when the browser offers them.
      str(hints?.["brand"]) ?? agent.browser,
      str(hints?.["uaFullVersion"]) ?? agent.browserVersion,
      hintsOs(hints) ?? agent.os,
      str(client["device"]) ?? agent.device,
      str(client["language"]) ?? firstLanguage(c.req.header("accept-language")),
      str(client["timezone"]),
      str(client["screen"]),
      str(client["referrer"]) ?? c.req.header("referer") ?? null,
      str(client["url"]),
      json(client["utm"]),
      json(trim(client)),
      json(headers),
      c.req.header("cf-ipcountry") ?? null,
    ],
  );

  const id = rows[0]?.id;
  if (id && ip) void enrich(id, ip);
}

/** Records a visit without ever throwing into the request path. */
export function recordVisitSafely(c: Context, input: VisitInput): void {
  recordVisit(c, input).catch((error) => {
    console.error("[visits] failed to record", error);
  });
}

/* ------------------------------------------------------------------ the IP */

/**
 * Caddy sits in front, so the socket address is never the visitor.
 *
 * Cloudflare fronts app.247clerk.com, and there X-Forwarded-For arrives holding
 * a Cloudflare edge address, not the visitor — CF-Connecting-IP is the only
 * header with the real one. CF-Ray tells us the request genuinely came through
 * Cloudflare rather than someone hand-writing the header at the origin.
 */
export function clientIp(c: Context): string | null {
  if (c.req.header("cf-ray")) {
    const cf = c.req.header("cf-connecting-ip") ?? c.req.header("true-client-ip");
    if (cf) return normalise(cf.trim());
  }

  // Direct through Caddy: the left-most entry is the visitor, the rest proxies.
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return normalise(first);
  }
  const real = c.req.header("x-real-ip");
  if (real) return normalise(real.trim());

  // Direct hit (local development, or n8n on the docker bridge).
  const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming
    ?.socket?.remoteAddress;
  return socket ? normalise(socket) : null;
}

/** ::ffff:1.2.3.4 is an IPv4 address wearing an IPv6 hat. */
function normalise(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

/* ----------------------------------------------------------------- the geo */

type Geo = Record<string, unknown>;

const geoCache = new Map<string, { geo: Geo; at: number }>();
const GEO_TTL = 24 * 60 * 60 * 1000;

async function enrich(visitId: string, ip: string): Promise<void> {
  try {
    const geo = await lookupGeo(ip);
    if (!geo) return;
    const connection = (geo["connection"] ?? {}) as Record<string, unknown>;
    await query(
      `update visits
          set geo = $1, city = $2, region = $3, country = $4, country_code = $5,
              latitude = $6, longitude = $7, isp = $8, ip_timezone = $9
        where id = $10`,
      [
        JSON.stringify(geo),
        str(geo["city"]),
        str(geo["region"]),
        str(geo["country"]),
        str(geo["country_code"]),
        num(geo["latitude"]),
        num(geo["longitude"]),
        str(connection["isp"]) ?? str(connection["org"]) ?? null,
        str((geo["timezone"] as Record<string, unknown> | undefined)?.["id"]),
        visitId,
      ],
    );
  } catch (error) {
    console.error("[visits] geo lookup failed", error);
  }
}

/** Private ranges never leave the building — there is nothing to look up. */
function isPrivate(ip: string): boolean {
  return (
    /^(10\.|127\.|169\.254\.|192\.168\.|::1|fc|fd)/i.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  );
}

async function lookupGeo(ip: string): Promise<Geo | null> {
  if (!config.geoEnabled || isPrivate(ip)) return null;

  const hit = geoCache.get(ip);
  if (hit && Date.now() - hit.at < GEO_TTL) return hit.geo;

  const response = await fetch(config.geoUrl.replace("{ip}", encodeURIComponent(ip)), {
    signal: AbortSignal.timeout(4000),
    headers: { accept: "application/json" },
  });
  if (!response.ok) return null;

  const geo = (await response.json()) as Geo;
  if (geo["success"] === false) return null;

  if (geoCache.size > 5000) geoCache.clear();
  geoCache.set(ip, { geo, at: Date.now() });
  return geo;
}

/* ------------------------------------------------------------ rate limiting */

const hits = new Map<string, { count: number; resetAt: number }>();

/** /api/track is public and unauthenticated. This is the whole defence. */
export function rateLimited(ip: string | null, limit = 120, windowMs = 60_000): boolean {
  if (!ip) return false;
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || entry.resetAt < now) {
    if (hits.size > 10_000) hits.clear();
    hits.set(ip, { count: 1, resetAt: now + windowMs });
    return false;
  }
  entry.count += 1;
  return entry.count > limit;
}

/* ------------------------------------------------------------------ helpers */

function pickHeaders(c: Context): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of KEEP_HEADERS) {
    const value = c.req.header(name);
    if (value) out[name] = value.slice(0, 512);
  }
  return out;
}

function firstLanguage(header: string | undefined): string | null {
  return header?.split(",")[0]?.split(";")[0]?.trim() || null;
}

function hintsOs(hints: Record<string, unknown> | undefined): string | null {
  const platform = str(hints?.["platform"]);
  if (!platform) return null;
  const version = str(hints?.["platformVersion"]);
  return version ? `${platform} ${version}` : platform;
}

function str(value: unknown): string | null {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return typeof value === "string" && value.length > 0 ? value.slice(0, 1000) : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function json(value: unknown): string {
  const payload = value && typeof value === "object" ? value : {};
  const text = JSON.stringify(payload);
  // A public endpoint should never let a caller decide how much we store.
  return text.length > 16_000 ? JSON.stringify({ truncated: true }) : text;
}

/** Drops the keys already promoted to their own columns. */
function trim(client: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(client)) {
    if (key === "utm") continue;
    copy[key] = value;
  }
  return copy;
}
