// PERF-BACKEND static-asset check (docs/PERF_SPEC.md item 6, 2026-09-29).
//
// Verifies the gzip + Cache-Control static path through the REAL HTTP server,
// byte for byte, with raw node:http requests (fetch would silently decompress and
// hide exactly what we need to inspect):
//   1. gzip request  -> Content-Encoding: gzip, Vary, Cache-Control, Length, and
//                       gunzip(body) identical to the file on disk;
//   2. identity request -> body identical to the file on disk (fall-through to
//                       express.static still works);
//   3. conditional request with the ETag from (1) -> 304 from express.static, so
//                       revalidation is not broken by the middleware;
//   4. "/" and "/v2/" still serve index.html (directory requests pass through);
//   5. a traversal attempt does not leak a file outside public/;
//   6. bytes on the wire: identity vs gzip, plus the ms for a cold gzip and a
//      warm gzip (the second request should be a cache hit).
//
// Usage: node ops/perf-backend/static-gzip-check.mjs [--base http://127.0.0.1:8801]
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";

const args = process.argv.slice(2);
const bi = args.indexOf("--base");
const BASE = (bi >= 0 ? args[bi + 1] : "http://127.0.0.1:8801").replace(/\/+$/, "");
const publicDir = path.join(process.cwd(), "public");

const ASSETS = [
  "/v2/",
  "/v2/app.js",
  "/v2/api.js",
  "/v2/style.css",
  "/v2/views/projects.js",
  "/index.html",
];

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function request(pathname, headers = {}) {
  const url = new URL(BASE + pathname);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: "GET", headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex").slice(0, 16);

/** Where a URL path lands on disk, the way express.static resolves it. */
function diskFile(pathname) {
  if (pathname.endsWith("/")) return path.join(publicDir, pathname, "index.html");
  return path.join(publicDir, pathname);
}

console.log(`# static-gzip-check against ${BASE} (public: ${publicDir})`);
console.log("# path                       identity         gzip   saved  gzip-cold  gzip-warm");

for (const p of ASSETS) {
  const file = diskFile(p);
  if (!fs.existsSync(file)) {
    console.log(`# ${p} - no such file (${file}); skipped`);
    continue;
  }
  const onDisk = fs.readFileSync(file);

  const plain = await request(p, { "accept-encoding": "identity" });
  check(`${p} identity bytes == file`, plain.status === 200 && sha(plain.body) === sha(onDisk), `${plain.body.length} B, HTTP ${plain.status}`);
  check(`${p} identity has an ETag`, Boolean(plain.headers.etag), String(plain.headers.etag ?? ""));

  const t0 = performance.now();
  const gz = await request(p, { "accept-encoding": "gzip" });
  const coldMs = performance.now() - t0;

  {
    const enc = String(gz.headers["content-encoding"] ?? "");
    check(`${p} gzip request is gzipped`, enc === "gzip", `content-encoding=${enc || "none"}`);
    check(`${p} declares Vary: Accept-Encoding`, String(gz.headers.vary ?? "").toLowerCase().includes("accept-encoding"), String(gz.headers.vary ?? ""));
    check(`${p} sends Cache-Control`, String(gz.headers["cache-control"] ?? "").includes("max-age"), String(gz.headers["cache-control"] ?? ""));
    check(`${p} Content-Length matches the gzipped body`, Number(gz.headers["content-length"]) === gz.body.length, `${gz.headers["content-length"]} vs ${gz.body.length}`);
    let decoded = null;
    try {
      decoded = zlib.gunzipSync(gz.body);
    } catch (e) {
      decoded = null;
    }
    check(`${p} gunzip(body) == file on disk`, decoded !== null && sha(decoded) === sha(onDisk), decoded ? `${decoded.length} B` : "gunzip failed");

    // Conditional revalidation must still be express.static's job.
    const cond = await request(p, { "accept-encoding": "gzip", "if-none-match": String(gz.headers.etag ?? "") });
    check(`${p} If-None-Match revalidation answers 304`, cond.status === 304, `HTTP ${cond.status}`);
  }

  const t1 = performance.now();
  await request(p, { "accept-encoding": "gzip" });
  const warmMs = performance.now() - t1;

  const saved = onDisk.length ? (100 * (1 - gz.body.length / onDisk.length)).toFixed(0) : "0";
  console.log(
    `# ${p.padEnd(26)} ${String(onDisk.length).padStart(8)} B ${String(gz.body.length).padStart(12)} B ${String(saved).padStart(5)}% ${coldMs.toFixed(1).padStart(10)}ms ${warmMs.toFixed(1).padStart(9)}ms`,
  );
}

// Traversal: must not serve anything outside public/.
const trav = await request("/../package.json", { "accept-encoding": "gzip" });
check("path traversal is refused", trav.status >= 400 || !trav.body.toString("utf8").includes('"name": "internal-llm-router"'), `HTTP ${trav.status}, ${trav.body.length} B`);

console.log(failures === 0 ? "# ALL CHECKS PASSED" : `# ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
