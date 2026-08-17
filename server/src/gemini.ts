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
 * Calls Gemini and parses the structured response.
 *
 * Tries the primary model, then the fallback on 5xx — `gemini-flash-latest`
 * returns 503 under load often enough that a single model is not safe to sit in
 * front of a live WhatsApp number. Throws if every attempt fails; the caller is
 * expected to degrade to a deterministic reply rather than go silent.
 */
export async function generateJson<T>(request: GeminiRequest): Promise<T> {
  const models = [config.geminiModel, config.geminiFallbackModel].filter(
    (model, index, all) => model && all.indexOf(model) === index,
  );

  let lastError: unknown;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await callOnce<T>(model, request);
      } catch (error) {
        lastError = error;
        if (!(error instanceof RetryableError)) throw error;
        if (attempt === 0) await sleep(400);
      }
    }
  }
  throw lastError ?? new Error("gemini: no models configured");
}

class RetryableError extends Error {}

async function callOnce<T>(model: string, request: GeminiRequest): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

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
      const detail = (await response.text()).slice(0, 400);
      const message = `gemini ${model} ${response.status}: ${detail}`;
      // 429/5xx are worth another shot; 4xx means we sent something wrong.
      if (response.status >= 500 || response.status === 429) throw new RetryableError(message);
      throw new Error(message);
    }

    const payload = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new RetryableError(`gemini ${model}: empty response`);

    return JSON.parse(text) as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new RetryableError(`gemini ${model}: timed out`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
