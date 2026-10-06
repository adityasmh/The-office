#!/usr/bin/env node
/**
 * ops/web-read-check.ts - proof for ops/web-read.ts.
 *
 * Uses only a local stub HTTP server on 127.0.0.1 (a free port) and injected
 * resolvers/fetch. It never touches the real internet. The stub is reachable
 * through the tool's test-only hooks (injected allow-list + loopback exemption)
 * which the real command line cannot enable.
 *
 * Run: npx tsx ops/web-read-check.ts
 */
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_ALLOW_DOMAINS,
  WebReadRefusal,
  envAllowDomains,
  hostAllowed,
  htmlToText,
  isPrivateOrLocalAddress,
  loadAllowDomains,
  renderJson,
  renderPlain,
  untrustedBanner,
  webRead,
} from './web-read.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WEB_READ = path.join(ROOT, 'ops', 'web-read.ts');

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    process.stdout.write(`PASS - ${name}\n`);
  } else {
    failed += 1;
    failures.push(name);
    process.stdout.write(`FAIL - ${name}${detail ? ` :: ${detail}` : ''}\n`);
  }
}

async function refusalCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return '(no refusal)';
  } catch (error) {
    if (error instanceof WebReadRefusal) return error.code;
    return `(other:${error instanceof Error ? error.message : String(error)})`;
  }
}

const HTML_PAGE = `<!doctype html>
<html><head><title>Stub Title</title><style>.x{color:red}</style></head>
<body>
<nav>NAVLINK <a href="/nav">Nav</a></nav>
<h1>Hello Heading</h1>
<script>var secret = 'SHOULD_NOT_APPEAR';</script>
<p>First paragraph with <a href="https://docs.github.com/en">Docs Link</a> and &amp; entity.</p>
<ul><li>Alpha</li><li>Beta</li></ul>
<footer>FOOTER_TEXT</footer>
<p>After footer <a href="/rel">Relative</a></p>
</body></html>`;

const BIG_BYTES = Math.floor(1.5 * 1024 * 1024);
const recorded = new Map<string, http.IncomingHttpHeaders>();

function makeStub(): http.Server {
  const server = http.createServer((req, res) => {
    req.on('error', () => undefined);
    res.on('error', () => undefined);
    let route = '/';
    try {
      route = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`).pathname;
    } catch {
      route = req.url ?? '/';
    }
    const redirect = (location: string, status = 302): void => {
      res.writeHead(status, { location, 'content-type': 'text/plain' });
      res.end('redirecting');
    };
    switch (route) {
      case '/ok':
        recorded.set(route, req.headers);
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('stub ok\n');
        return;
      case '/html':
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(HTML_PAGE);
        return;
      case '/json':
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end('{"ok":true,"n":1}');
        return;
      case '/image':
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        return;
      case '/big':
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(Buffer.alloc(BIG_BYTES, 0x41));
        return;
      case '/redirect-unlisted':
        redirect('http://unlisted.test/secret');
        return;
      case '/redirect-private':
        redirect('http://10.0.0.5:9/private');
        return;
      case '/r1':
        redirect('/r2');
        return;
      case '/r2':
        redirect('/r3');
        return;
      case '/r3':
        redirect('/r4');
        return;
      case '/r4':
        redirect('/r5');
        return;
      case '/r5':
        redirect('/ok');
        return;
      case '/s1':
        redirect('/s2');
        return;
      case '/s2':
        redirect('/ok');
        return;
      default:
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
    }
  });
  server.on('clientError', () => undefined);
  return server;
}

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [TSX_CLI, WEB_READ, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const fakeHtmlFetch = (async () =>
  new Response('<html><body><h1>OK</h1></body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })) as unknown as never;

const allowDomains = ['127.0.0.1'];
const stubOptions = { domains: allowDomains, unsafeTestPermitLoopback: true };

async function main(): Promise<void> {
  const server = makeStub();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;

  try {
    // 1. Allow-list policy: allowed hosts pass, unlisted hosts are refused.
    const policyOk =
      hostAllowed('github.com', DEFAULT_ALLOW_DOMAINS) &&
      hostAllowed('docs.github.com', DEFAULT_ALLOW_DOMAINS) &&
      hostAllowed('raw.githubusercontent.com', DEFAULT_ALLOW_DOMAINS) &&
      hostAllowed('en.wikipedia.org', DEFAULT_ALLOW_DOMAINS) &&
      !hostAllowed('evil.example.com', DEFAULT_ALLOW_DOMAINS) &&
      !hostAllowed('notgithub.com', DEFAULT_ALLOW_DOMAINS) &&
      !hostAllowed('github.com.evil.test', DEFAULT_ALLOW_DOMAINS);
    check('allow-list: listed host and subdomain pass, unlisted look-alikes are refused', policyOk);
    const allowedDownload = await webRead('https://docs.github.com/en/actions', {
      domains: DEFAULT_ALLOW_DOMAINS,
      resolver: async () => ['140.82.121.3'],
      fetchImpl: fakeHtmlFetch,
    });
    check(
      'allow-list: an allowed host completes a read (injected resolver + fetch)',
      allowedDownload.status === 200 && allowedDownload.text.includes('OK'),
    );
    check(
      'allow-list: an unlisted host is refused with not-allowed',
      (await refusalCode(() =>
        webRead('https://evil.example.com/', {
          domains: DEFAULT_ALLOW_DOMAINS,
          resolver: async () => ['140.82.121.3'],
        }),
      )) === 'not-allowed',
    );
    check(
      'allow-list: the shipped allow-list file matches the built-in defaults',
      JSON.stringify(
        (await loadAllowDomains()).slice().sort(),
      ) === JSON.stringify(DEFAULT_ALLOW_DOMAINS.slice().sort()),
    );
    check(
      'allow-list: WEB_READ_ALLOW adds one-run domains without editing the file',
      JSON.stringify(envAllowDomains({ WEB_READ_ALLOW: 'Example.COM, dev.to' } as NodeJS.ProcessEnv)) ===
        JSON.stringify(['example.com', 'dev.to']),
    );

    // 2. Refusals: credentials, loopback/private/link-local, fake private resolver.
    check(
      'refused: credentials in the URL',
      (await refusalCode(() =>
        webRead('https://user:pw@github.com/x', {
          domains: DEFAULT_ALLOW_DOMAINS,
          resolver: async () => ['140.82.121.3'],
        }),
      )) === 'credentials',
    );
    check(
      'refused: localhost resolving to 127.0.0.1',
      (await refusalCode(() =>
        webRead('http://localhost:9/', { domains: ['localhost'], resolver: async () => ['127.0.0.1'] }),
      )) === 'private-address',
    );
    check(
      'refused: 127.0.0.1 (loopback literal)',
      (await refusalCode(() => webRead('http://127.0.0.1/', { domains: ['127.0.0.1'] }))) ===
        'private-address',
    );
    check(
      'refused: 10.0.0.1 (private literal)',
      (await refusalCode(() => webRead('http://10.0.0.1/', { domains: ['10.0.0.1'] }))) ===
        'private-address',
    );
    check(
      'refused: 192.168.1.1 (private literal)',
      (await refusalCode(() => webRead('http://192.168.1.1/', { domains: ['192.168.1.1'] }))) ===
        'private-address',
    );
    check(
      'refused: 169.254.169.254 (link-local metadata literal)',
      (await refusalCode(() =>
        webRead('http://169.254.169.254/latest/meta-data/', { domains: ['169.254.169.254'] }),
      )) === 'private-address',
    );
    check(
      'refused: [::1] (IPv6 loopback literal)',
      (await refusalCode(() => webRead('http://[::1]/', { domains: ['[::1]'] }))) ===
        'private-address',
    );
    check(
      'refused: a fake resolver result of a private address on an allowed host',
      (await refusalCode(() =>
        webRead('https://raw.githubusercontent.com/x/y', {
          domains: DEFAULT_ALLOW_DOMAINS,
          resolver: async () => ['140.82.121.3', '10.0.0.7'],
        }),
      )) === 'private-address',
    );
    const predicateOk =
      isPrivateOrLocalAddress('127.0.0.1') &&
      isPrivateOrLocalAddress('10.0.0.1') &&
      isPrivateOrLocalAddress('192.168.1.1') &&
      isPrivateOrLocalAddress('169.254.169.254') &&
      isPrivateOrLocalAddress('::1') &&
      isPrivateOrLocalAddress('::ffff:127.0.0.1') &&
      isPrivateOrLocalAddress('fe80::1') &&
      isPrivateOrLocalAddress('fd00::1') &&
      isPrivateOrLocalAddress('0.0.0.0') &&
      !isPrivateOrLocalAddress('140.82.121.3') &&
      !isPrivateOrLocalAddress('8.8.8.8') &&
      !isPrivateOrLocalAddress('2606:4700::1111');
    check('refused: address classifier flags loopback/private/link-local and passes public IPs', predicateOk);

    // 3. Redirects: every hop is re-checked; at most 3 are followed.
    check(
      'refused: redirect to an unlisted host',
      (await refusalCode(() => webRead(`${base}/redirect-unlisted`, stubOptions))) ===
        'redirect-not-allowed',
    );
    check(
      'refused: redirect to a private address',
      (await refusalCode(() =>
        webRead(`${base}/redirect-private`, {
          domains: ['127.0.0.1', '10.0.0.5'],
          unsafeTestPermitLoopback: true,
        }),
      )) === 'redirect-private-address',
    );
    check(
      'refused: more than 3 redirects',
      (await refusalCode(() => webRead(`${base}/r1`, stubOptions))) === 'too-many-redirects',
    );
    const shortChain = await webRead(`${base}/s1`, stubOptions);
    check(
      'redirects: an allowed 2-hop chain is followed and read',
      shortChain.status === 200 && shortChain.text.includes('stub ok'),
    );

    // 4. HTML to text.
    const converted = htmlToText(HTML_PAGE, 'http://127.0.0.1:1234/page');
    check(
      'html: drops script and style content',
      !converted.includes('SHOULD_NOT_APPEAR') && !converted.includes('color:red'),
    );
    check(
      'html: keeps headings, list items and link text with URLs',
      converted.includes('Hello Heading') &&
        converted.includes('- Alpha') &&
        converted.includes('Docs Link [https://docs.github.com/en]') &&
        converted.includes('Relative [http://127.0.0.1:1234/rel]'),
    );
    check(
      'html: drops nav and footer, decodes entities, collapses blank lines',
      !converted.includes('NAVLINK') &&
        !converted.includes('FOOTER_TEXT') &&
        converted.includes('and & entity.') &&
        !/\n{3,}/.test(converted),
    );
    const htmlViaFetch = await webRead(`${base}/html`, { ...stubOptions, maxChars: 100000 });
    check(
      'html: the converter is used for text/html responses',
      htmlViaFetch.text.includes('Hello Heading') && !htmlViaFetch.text.includes('SHOULD_NOT_APPEAR'),
    );

    // 5. Output cap + banner + json shape.
    const capped = await webRead(`${base}/html`, { ...stubOptions, maxChars: 80 });
    check(
      'cap: output is cut at --max-chars and says so',
      capped.truncated && capped.text.includes('cut off at 80 characters') && capped.text.length < 250,
      `len=${capped.text.length} truncated=${capped.truncated}`,
    );
    const plain = await webRead(`${base}/ok`, stubOptions);
    check(
      'banner: the untrusted banner is the first line of the plain output',
      renderPlain(plain).split(/\r?\n/)[0] === untrustedBanner('127.0.0.1'),
      renderPlain(plain).split(/\r?\n/)[0],
    );
    const json = JSON.parse(renderJson(plain)) as Record<string, unknown>;
    check(
      'banner/json: the banner leads the text and the JSON has exactly the promised keys',
      String(json.text).split(/\r?\n/)[0] === untrustedBanner('127.0.0.1') &&
        JSON.stringify(Object.keys(json).sort()) ===
          JSON.stringify(['host', 'status', 'text', 'truncated', 'url']),
    );

    // 6. Content type and download cap.
    check(
      'refused: a non-text content type (image/png)',
      (await refusalCode(() => webRead(`${base}/image`, stubOptions))) === 'content-type',
    );
    const big = await webRead(`${base}/big`, { ...stubOptions, maxChars: BIG_BYTES * 2 });
    check(
      'cap: a body over 1 MB is cut off at the byte cap',
      big.truncated &&
        big.text.includes('byte download cap and was cut off') &&
        big.text.length <= 1024 * 1024 + 200,
    );

    // 7. No cookies and no auth headers are ever sent.
    const sent = recorded.get('/ok') ?? {};
    const headerKeys = Object.keys(sent).map((key) => key.toLowerCase());
    check(
      'headers: no cookie and no authorization header are sent',
      !headerKeys.includes('cookie') && !headerKeys.includes('authorization'),
      `sent: ${headerKeys.join(',')}`,
    );
    check(
      'headers: the user agent says it is a read-only fetcher',
      /read-only/i.test(String(sent['user-agent'] ?? '')),
      String(sent['user-agent'] ?? '(missing)'),
    );

    // 8. The command line cannot relax the rules.
    const unknownFlag = runCli(['--unsafe-test-permit-loopback', 'http://127.0.0.1:1/']);
    check(
      'cli: an unknown (test-only) switch is rejected, so the CLI cannot enable private access',
      unknownFlag.status === 1 && /unknown option/.test(unknownFlag.stderr),
      `status=${unknownFlag.status} stderr=${unknownFlag.stderr.trim()}`,
    );
    const cliCredentials = runCli(['https://user:pw@github.com/x']);
    check(
      'cli: credentials in a URL exit 1 with a plain reason',
      cliCredentials.status === 1 && /credentials/.test(cliCredentials.stderr),
      `status=${cliCredentials.status} stderr=${cliCredentials.stderr.trim()}`,
    );
    const cliUnlisted = runCli(['http://evil.example.com/']);
    check(
      'cli: an unlisted host exits 1 with a plain reason (no network needed)',
      cliUnlisted.status === 1 && /allow-list/.test(cliUnlisted.stderr),
      `status=${cliUnlisted.status} stderr=${cliUnlisted.stderr.trim()}`,
    );
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  process.stdout.write(`\nSUMMARY - ${passed} passed, ${failed} failed\n`);
  if (failures.length > 0) process.stdout.write(`FAILED: ${failures.join(' | ')}\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  process.stdout.write(`FAIL - check harness crashed: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
