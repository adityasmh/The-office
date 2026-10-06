# REPORT R5-web-read: a safe text-only web reader for workers

Status: DONE. Proof 32 passed / 0 failed.

## Files created (only these)

- `ops/web-read.ts` - the tool. Policy (scheme, allow-list, credentials, address
  classification), injectable resolver, manual redirect following (max 3, every hop
  re-checked), 10s timeout, 1MB download cap, `text/*` + `application/json` only,
  header-free request with a read-only user agent, dependency-free HTML-to-text,
  `--max-chars` cap, always-first UNTRUSTED banner, `--json {url, host, status,
  truncated, text}`, CLI that exits 1 with a plain reason.
- `ops/web-read.allow.json` - the shipped conservative allow-list (the 12 domains
  named in the order: github.com, raw.githubusercontent.com, docs.github.com,
  developer.mozilla.org, nodejs.org, typescriptlang.org, npmjs.com,
  news.ycombinator.com, dev.to, arxiv.org, wikipedia.org, stackoverflow.com).
- `ops/web-read-check.ts` - the proof. Local stub HTTP server on 127.0.0.1 on a free
  port, injected allow-list, injected resolver and injected fetch. No real internet.
- `docs/WEB_READ.md` - usage, safety rules, the wording a worker order should use,
  and plainly what it cannot do (no JavaScript pages, no logins, no sites outside
  the allow-list, no binaries). No site is listed as "supported".

## Commands run (each once, foreground)

`npx tsc --noEmit` was NOT run: nothing was added under `src/`, and `tsconfig.json`
only includes `src`, so it would not cover `ops/`. See open issues.

```
> npx tsx ops/web-read-check.ts
PASS - allow-list: listed host and subdomain pass, unlisted look-alikes are refused
PASS - allow-list: an allowed host completes a read (injected resolver + fetch)
PASS - allow-list: an unlisted host is refused with not-allowed
PASS - allow-list: the shipped allow-list file matches the built-in defaults
PASS - allow-list: WEB_READ_ALLOW adds one-run domains without editing the file
PASS - refused: credentials in the URL
PASS - refused: localhost resolving to 127.0.0.1
PASS - refused: 127.0.0.1 (loopback literal)
PASS - refused: 10.0.0.1 (private literal)
PASS - refused: 192.168.1.1 (private literal)
PASS - refused: 169.254.169.254 (link-local metadata literal)
PASS - refused: [::1] (IPv6 loopback literal)
PASS - refused: a fake resolver result of a private address on an allowed host
PASS - refused: address classifier flags loopback/private/link-local and passes public IPs
PASS - refused: redirect to an unlisted host
PASS - refused: redirect to a private address
PASS - refused: more than 3 redirects
PASS - redirects: an allowed 2-hop chain is followed and read
PASS - html: drops script and style content
PASS - html: keeps headings, list items and link text with URLs
PASS - html: drops nav and footer, decodes entities, collapses blank lines
PASS - html: the converter is used for text/html responses
PASS - cap: output is cut at --max-chars and says so
PASS - banner: the untrusted banner is the first line of the plain output
PASS - banner/json: the banner leads the text and the JSON has exactly the promised keys
PASS - refused: a non-text content type (image/png)
PASS - cap: a body over 1 MB is cut off at the byte cap
PASS - headers: no cookie and no authorization header are sent
PASS - headers: the user agent says it is a read-only fetcher
PASS - cli: an unknown (test-only) switch is rejected, so the CLI cannot enable private access
PASS - cli: credentials in a URL exit 1 with a plain reason
PASS - cli: an unlisted host exits 1 with a plain reason (no network needed)

SUMMARY - 32 passed, 0 failed
```

First run (same command) reported `SUMMARY - 31 passed, 1 failed`, failing
`cap: output is cut at --max-chars and says so`. Cause: my fixture, not the tool -
the stub HTML page renders to about 170 characters, so a 200-character cap never
engaged and the tool correctly reported `truncated=false`. I lowered the test cap to
80 characters and re-ran once (no loop); all 32 then passed. The tool code itself was
not changed after the first run.

## How the safety rules are proven without the real internet

- Allow-list and the private-address rule are injectable function options
  (`domains`, `resolver`, `fetchImpl`) plus one test-only switch
  (`unsafeTestPermitLoopback`) that permits only literal 127.0.0.0/8 / ::1 so the
  stub on 127.0.0.1 is reachable. The CLI never sets any of them, and an unknown CLI
  option exits 1 (`cli: an unknown (test-only) switch is rejected`).
- The stub records request headers; the check asserts no `cookie` and no
  `authorization` header and that the user agent says read-only.
- Redirect escapes are real: the stub issues 302s to an unlisted host, to a private
  address, and a 5-hop chain; each is refused with its own code, and every hop is
  re-checked before any connection is attempted.

## Open issues

1. `ops/*.ts` is outside the project `tsconfig.json` (`include: ["src"]`), so
   `npx tsc --noEmit` does not typecheck the new tool. It is exercised end to end by
   the proof through tsx, but a dedicated typecheck of `ops/` would need a separate
   tsconfig or an explicit file list. Not changed here because the order forbids
   editing anything outside the named files.
2. `npmjs.com` and `news.ycombinator.com` may rate-limit or block automated fetchers
   in practice; docs/WEB_READ.md says the allow-list is a safety list, not a support
   guarantee, and lists no site as "supported".
3. HTML rendering is regex-based by design (no library). Deeply malformed markup or
   client-rendered pages yield partial text; documented as a limitation.
4. A body larger than 1 MB is truncated at the cap and the output says so (the order
   asked for "cut off", not refusal).
