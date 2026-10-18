// ops/budget-go-probe.ts - BUDGET (docs/BUDGET_SPEC.md §1): "find the least
// fragile source ... and document which one you used" for the OpenCode Go
// remaining allowance.
//
// This probe is read-only and prints only MASKED evidence. It never prints the
// API key or the session cookie (nor any response that contains them): every
// body goes through maskSecrets() first, and the secrets themselves are printed
// only as a presence flag + length + a short SHA-256 prefix.
//
// Usage:
//   npx tsx ops/budget-go-probe.ts            # every candidate, in priority order
//   npx tsx ops/budget-go-probe.ts --json     # machine-readable summary
//
// The hard rules from the work order apply: no login is automated, no page is
// clicked, nothing is written.

import "dotenv/config";
import crypto from "node:crypto";

type Candidate = {
  name: string;
  url: string;
  auth: "key" | "cookie" | "none";
  note: string;
};

// Ordered exactly like the spec's source preference: (a) an endpoint that takes
// the existing OPENCODE_API_KEY, then (b) the JSON behind the usage/billing page
// with the CEO's pasted session cookie.
const CANDIDATES: Candidate[] = [
  { name: "go-usage (key)", url: "https://opencode.ai/zen/go/v1/usage", auth: "key", note: "Go API surface; 401 without a key, so it exists" },
  { name: "go-usage-alt (key)", url: "https://opencode.ai/zen/go/v1/usage/limits", auth: "key", note: "alternate path of the same surface" },
  { name: "go-models (key)", url: "https://opencode.ai/zen/go/v1/models", auth: "key", note: "documented model list; checked for embedded quota fields" },
  { name: "zen-usage (key)", url: "https://opencode.ai/zen/v1/usage", auth: "key", note: "Zen (non-Go) API surface" },
  { name: "api-opencode-usage", url: "https://api.opencode.ai/usage", auth: "none", note: "public 200 (9 B) - checked for a body" },
  { name: "console-api-usage (cookie)", url: "https://opencode.ai/api/console/usage", auth: "cookie", note: "console JSON guess" },
  { name: "console-api-go-usage (cookie)", url: "https://opencode.ai/api/console/go/usage", auth: "cookie", note: "console JSON guess (Go scoped)" },
  { name: "console-api-billing (cookie)", url: "https://opencode.ai/api/console/billing", auth: "cookie", note: "console JSON guess" },
  { name: "console-api-subscription (cookie)", url: "https://opencode.ai/api/console/subscription", auth: "cookie", note: "console JSON guess" },
  { name: "console-page (cookie)", url: "https://opencode.ai/console", auth: "cookie", note: "the page the CEO reads; 307 to /auth without a session" },
  { name: "go-usage (cookie)", url: "https://opencode.ai/zen/go/v1/usage", auth: "cookie", note: "same key endpoint, tried with the browser session" },
];

function fingerprint(secret: string | undefined): string {
  if (!secret) return "absent";
  const h = crypto.createHash("sha256").update(secret).digest("hex").slice(0, 8);
  return `present len=${secret.length} sha256:${h}`;
}

function maskSecrets(text: string, secrets: string[]): string {
  let out = String(text ?? "");
  for (const s of secrets) {
    if (!s) continue;
    out = out.split(s).join("<redacted-secret>");
    // Cookies are frequently split into name=value pairs; also redact the value part.
    const eq = s.indexOf("=");
    if (eq > 0 && eq < s.length - 1) out = out.split(s.slice(eq + 1)).join("<redacted-secret>");
  }
  return out
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<redacted-email>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<redacted-id>")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, "$1<redacted-token>")
    .replace(/(sk-[A-Za-z0-9._-]{6,})/gi, "<redacted-key>")
    .replace(/(set-cookie[^\n]{0,20}:?\s*)[^\n;]+/gi, "$1<redacted-cookie>");
}

type ProbeResult = {
  name: string;
  url: string;
  auth: Candidate["auth"];
  note: string;
  status: number | null;
  ok: boolean;
  contentType?: string;
  bytes?: number;
  body: string;
  error?: string;
};

async function probe(c: Candidate, apiKey: string | undefined, cookie: string | undefined): Promise<ProbeResult> {
  const base: ProbeResult = { name: c.name, url: c.url, auth: c.auth, note: c.note, status: null, ok: false, body: "" };
  const headers: Record<string, string> = { accept: "application/json, text/html;q=0.9" };
  if (c.auth === "key") {
    if (!apiKey) return { ...base, error: "no OPENCODE_API_KEY in the environment" };
    headers.authorization = `Bearer ${apiKey}`;
    headers["user-agent"] = "local-ai-company-budget/1.0";
  } else if (c.auth === "cookie") {
    if (!cookie) return { ...base, error: "no OPENCODE_SESSION_COOKIE in the environment" };
    headers.cookie = cookie;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  try {
    const r = await fetch(c.url, { method: "GET", headers, redirect: "manual", signal: ac.signal });
    const text = await r.text().catch(() => "");
    return {
      ...base,
      status: r.status,
      ok: r.ok,
      contentType: r.headers.get("content-type") ?? undefined,
      bytes: text.length,
      body: text,
    };
  } catch (e) {
    return { ...base, error: String((e as Error)?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const asJson = process.argv.includes("--json");
  const apiKey = process.env.OPENCODE_API_KEY || undefined;
  const cookie = process.env.OPENCODE_SESSION_COOKIE || undefined;
  const secrets = [apiKey ?? "", cookie ?? ""].filter(Boolean);

  const results: ProbeResult[] = [];
  for (const c of CANDIDATES) {
    // Skip the key probes outright when there is no key (never guess).
    const r = await probe(c, apiKey, cookie);
    results.push(r);
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          apiKey: fingerprint(apiKey),
          sessionCookie: fingerprint(cookie),
          results: results.map((r) => ({
            name: r.name,
            url: r.url,
            auth: r.auth,
            status: r.status,
            ok: r.ok,
            contentType: r.contentType,
            bytes: r.bytes,
            error: r.error,
            body: maskSecrets(r.body, secrets).slice(0, 4000),
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log("OPENCODE GO QUOTA-SOURCE PROBE (read-only, masked)");
  console.log("====================================================");
  console.log(`OPENCODE_API_KEY          ${fingerprint(apiKey)}`);
  console.log(`OPENCODE_SESSION_COOKIE   ${fingerprint(cookie)}`);
  console.log("");
  for (const r of results) {
    const status = r.error ? `ERR (${r.error})` : String(r.status);
    console.log(`- ${r.name}  [auth=${r.auth}]  -> ${status}${r.bytes !== undefined ? `  ${r.bytes} B  ${r.contentType ?? ""}` : ""}`);
    console.log(`    ${r.url}`);
    console.log(`    why: ${r.note}`);
    const body = maskSecrets(r.body, secrets).trim();
    if (body) {
      const shown = body.length > 600 ? body.slice(0, 600) + ` …(+${body.length - 600} chars)` : body;
      for (const line of shown.split(/\r?\n/).slice(0, 12)) console.log(`    | ${line}`);
    }
    console.log("");
  }
}

main().catch((e) => {
  console.error("probe failed:", String(e));
  process.exit(1);
});
