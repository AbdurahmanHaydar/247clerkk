import { config } from "./config.js";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

export type GeminiTurn = { role: "user" | "model"; text: string };

export type GeminiRequest = {
  system: string;
  turns: GeminiTurn[];
  /** OpenAPI-subset schema. Gemini returns JSON conforming to it. */
  responseSchema: Record<string, unknown>;
  temperature?: number;
};

/**
 * A model that has just failed is not tried again until this passes. Without it
 * every inbound message pays the same failure twice over before reaching the
 * fallback, and a model that is 503-ing under load stays that way for minutes.
 */
const benched = new Map<string, number>();

/**
 * Calls Gemini and parses the structured response.
 *
 * Whoever is waiting on this is holding a WhatsApp conversation open, and n8n
 * gives the whole request 30 seconds before it aborts and the reply never gets
 * sent. So the call is bounded twice: each attempt gets `geminiTimeoutMs`, and
 * every attempt together gets `geminiBudgetMs`. Running out of either is a
 * failure like any other — the caller degrades to a deterministic reply rather
 * than going silent, which is far better than a late answer nobody receives.
 *
 * Each model gets one attempt, in order, and any that fails is benched so the
 * next message goes straight to one that works. The fallback is the retry —
 * a second go at a model that just failed is time the sender does not have.
 */
export async function generateJson<T>(request: GeminiRequest): Promise<T> {
  const deadline = Date.now() + config.geminiBudgetMs;
  const models = [config.geminiModel, config.geminiFallbackModel].filter(
    (model, index, all) => model && all.indexOf(model) === index,
  );

  const usable = models.filter((model) => (benched.get(model) ?? 0) <= Date.now());
  if (usable.length === 0) throw new Error(`gemini: ${models.join(", ")} all benched after a recent failure`);

  let lastError: unknown;
  for (const model of usable) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    try {
      return await callOnce<T>(model, request, Math.min(config.geminiTimeoutMs, remaining));
    } catch (error) {
      lastError = error;
      bench(model);
    }
  }
  throw lastError ?? new Error("gemini: no models configured");
}

function bench(model: string): void {
  benched.set(model, Date.now() + config.geminiCooldownMs);
  console.error(`[gemini] ${model} benched for ${Math.round(config.geminiCooldownMs / 1000)}s`);
}

async function callOnce<T>(model: string, request: GeminiRequest, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${ENDPOINT}/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": config.geminiApiKey },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: request.system }] },
        contents: request.turns.map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] })),
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: request.responseSchema,
          temperature: request.temperature ?? 0.2,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`gemini ${model} ${response.status}: ${(await response.text()).slice(0, 400)}`);
    }

    const payload = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error(`gemini ${model}: empty response`);

    return JSON.parse(text) as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`gemini ${model}: timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
