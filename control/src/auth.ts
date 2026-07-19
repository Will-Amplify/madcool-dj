/**
 * Shared auth helpers for HTTP + WebSocket.
 *
 * Design: when bind host is non-loopback, DJ_TOKEN is required (refuse boot).
 * When token is set, every /v1/* request and /v1/live upgrade must match it.
 */

import { timingSafeEqual } from "node:crypto";

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "127.0.0.1" || h === "::1" || h === "localhost";
}

export function requireTokenForBind(host: string): void {
  const token = (process.env.DJ_TOKEN || "").trim();
  if (!isLoopbackHost(host) && !token) {
    throw new Error(
      `DJ_TOKEN is required when DJ_HOST=${host} (non-loopback). Set a strong token in .env or bind 127.0.0.1.`,
    );
  }
}

export function tokenMatches(provided: string | null | undefined): boolean {
  const expected = (process.env.DJ_TOKEN || "").trim();
  if (!expected) return true;
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function bearerFromHeader(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(" ");
  if (scheme !== "Bearer" || !value) return null;
  return value;
}
