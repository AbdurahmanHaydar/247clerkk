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
  demoWaNumber: required("DEMO_WA_NUMBER"),
  publicAppUrl: process.env.PUBLIC_APP_URL ?? "https://app.247clerk.com",
  /** Free messages a single phone number gets on the shared demo number. */
  demoMessageCap: Number(process.env.DEMO_MESSAGE_CAP ?? 25),
};
