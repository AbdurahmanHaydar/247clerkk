import { randomInt } from "node:crypto";

/** No O/0/I/1 — these get read aloud and retyped by humans. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PREFIX = "CLK-";

export function generateToken(): string {
  let body = "";
  for (let i = 0; i < 6; i++) body += ALPHABET[randomInt(ALPHABET.length)];
  return PREFIX + body;
}

/**
 * Pulls the signup code out of a message body.
 *
 * The wa.me prefilled text is fully editable and people trim it, so we never
 * expect an exact match — we scan anywhere in the message for the code shape.
 */
export function extractToken(body: string | undefined | null): string | null {
  if (!body) return null;
  const match = body.match(/\bCLK[-\s]?([A-Za-z0-9]{6})\b/);
  if (!match?.[1]) return null;
  return PREFIX + match[1].toUpperCase();
}

/** The deep link that carries the code into WhatsApp. */
export function buildWaLink(number: string, token: string): string {
  const text = `Hi 247clerk — I'd like to see the demo. My code is ${token}`;
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}
