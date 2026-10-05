// Trust-boundary helpers for the company control plane.
//
// The control plane is NOT a public surface: /company/* mutations spend money
// (agent runs) and execute code (opencode workers in per-agent workdirs), and
// GET /company/stream continuously streams the whole company state. See
// docs/CEO_RUNBOOK.md §0 ("Trust boundary") for the operator-facing story.
//
// Two independent controls, both implemented in src/server.ts using the pure
// helpers below:
//   1. bind: the listener binds to loopback (config.host, default 127.0.0.1);
//   2. secret: every mutating /company/* request and the SSE stream must carry
//      the shared secret in `X-Company-Token` (or `?token=` for EventSource,
//      which cannot set headers). A peer that is not loopback is refused
//      outright for everything under /company/* unless the secret is presented.
//
// This module is dependency-free (no express import) so both the server and the
// tsx-run CLI harnesses in ops/ can use it.

import { timingSafeEqual } from "node:crypto";

/** Header carrying the shared secret. */
export const TOKEN_HEADER = "x-company-token";

/** True for IPv4/IPv6 loopback literals (and "localhost"). */
export function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (!addr) return false;
  const a = addr.trim().toLowerCase();
  if (a.startsWith("::ffff:")) return isLoopbackAddress(a.slice("::ffff:".length));
  if (a === "localhost" || a === "::1") return true;
  // 127.0.0.0/8
  if (a.startsWith("127.")) return true;
  return false;
}

export function isLoopbackHostName(host: string | undefined | null): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return isLoopbackAddress(end === -1 ? h.slice(1) : h.slice(1, end));
  }
  return isLoopbackAddress(h.replace(/:\d+$/, ""));
}

/** Constant-time string compare that never throws on length mismatch. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

type HeaderCarrier = {
  headers?: Record<string, unknown>;
  query?: unknown;
};

/**
 * Pull the presented secret out of a request: `X-Company-Token` first, then
 * `?token=` (the SSE fallback for browsers, which cannot set headers on
 * EventSource). Returns "" when nothing usable was presented.
 */
export function presentedToken(req: HeaderCarrier): string {
  const raw = req.headers?.[TOKEN_HEADER] ?? req.headers?.[TOKEN_HEADER.toUpperCase()];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header === "string" && header.trim()) return header.trim();

  const q = req.query;
  if (q && typeof q === "object") {
    const v = (q as Record<string, unknown>).token;
    const one = Array.isArray(v) ? v[0] : v;
    if (typeof one === "string" && one.trim()) return one.trim();
  }
  return "";
}

/**
 * Host-header allowlist for the secret-bootstrap endpoint (DNS-rebinding
 * defence): a rebinding page presents its own hostname, never localhost.
 * Extra names can be added with COMPANY_ALLOWED_HOSTS=a,b,c.
 */
export function hostAllowed(host: string | undefined | null, extra: string[] = []): boolean {
  if (!host) return true; // non-browser client (HTTP/1.0 style); peer check still applies
  if (isLoopbackHostName(host)) return true;
  return extra.some((h) => h.trim().toLowerCase() === host.trim().toLowerCase());
}

/** Operator-configured secret, if any. */
export function envToken(): string {
  return (process.env.COMPANY_AUTH_TOKEN ?? "").trim();
}

/**
 * Client-side helper for the local CLI harnesses: use COMPANY_AUTH_TOKEN when
 * set, else ask the loopback-only bootstrap endpoint for the secret that the
 * running server uses (the server reads it from .env).
 */
export async function resolveClientToken(base: string): Promise<string> {
  const fromEnv = envToken();
  if (fromEnv) return fromEnv;
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/company/auth/bootstrap`, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (!res.ok) return "";
    const body = (await res.json()) as { token?: unknown };
    return typeof body?.token === "string" ? body.token.trim() : "";
  } catch {
    return "";
  }
}

/** Headers a loopback CLI client should send for /company/* mutations. */
export async function companyAuthHeaders(base: string): Promise<Record<string, string>> {
  const token = await resolveClientToken(base);
  return token ? { [TOKEN_HEADER]: token } : {};
}
