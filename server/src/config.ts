function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? "0.0.0.0",
  databaseUrl: required("DATABASE_URL"),
  n8nSecret: required("N8N_SECRET"),
  geminiApiKey: required("GEMINI_API_KEY"),
  // Pinned rather than *-latest so the intake behaviour doesn't shift underneath
  // us. The fallback covers the 503s the flash endpoints throw under load.
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-3.7-flash",
  geminiFallbackModel: process.env.GEMINI_FALLBACK_MODEL ?? "gemini-2.5-flash",
  /** Per-attempt ceiling on one Gemini call. */
  geminiTimeoutMs: Number(process.env.GEMINI_TIMEOUT_MS ?? 8_000),
  /** Ceiling on every attempt together. n8n aborts the inbound request at 30s
   *  and the reply is then composed but never sent, so the model never gets to
   *  spend more of that than this. */
  geminiBudgetMs: Number(process.env.GEMINI_BUDGET_MS ?? 15_000),
  /** How long a model that just failed is skipped for. */
  geminiCooldownMs: Number(process.env.GEMINI_COOLDOWN_MS ?? 60_000),
  demoWaNumber: required("DEMO_WA_NUMBER"),
  /** Secret path segment for the owner-only dashboard at /admin/:token.
   *  Unset means the admin routes don't exist at all. */
  adminToken: process.env.ADMIN_TOKEN ?? "",
  publicAppUrl: process.env.PUBLIC_APP_URL ?? "https://app.247clerk.com",
  /** Set to a Cal.com (or similar) link and /book redirects there instead of
   *  serving the placeholder page. */
  bookingUrl: process.env.BOOKING_URL ?? "",
  /** Turns the IP -> city/ISP lookup on /api/track on and off. The visitor's
   *  IP is the only thing sent to the provider. */
  geoEnabled: (process.env.GEOIP_ENABLED ?? "true") !== "false",
  /** {ip} is substituted. ipwho.is is free, https and needs no key. */
  geoUrl: process.env.GEOIP_URL ?? "https://ipwho.is/{ip}",
  /** Free messages one demo run gets on the shared demo number. Resets when the
   *  same number comes back with a new signup code. */
  demoMessageCap: Number(process.env.DEMO_MESSAGE_CAP ?? 60),
};
