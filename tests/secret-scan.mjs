import { readFileSync, statSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const secretPatterns = [
  { name: 'OpenAI-style key', re: /\b(sk-[a-zA-Z0-9]{20,})\b/i },
  { name: 'API_KEY assignment', re: /API_KEY\s*=\s*['"]?[a-zA-Z0-9_\-]{8,}/i },
  { name: 'private key block', re: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/i },
  { name: 'token/secret/password assignment', re: /(token|secret|password)\s*[:=]\s*['"]?[a-zA-Z0-9_\-]{16,}/i }
];

function isEnvFile(name) {
  return name === '.env' || /^\.env\./.test(name);
}

function isPlaceholderEnvFile(name) {
  // Allowlist example / placeholder env files such as .env.example or .env.local.example.
  return /^\.env(\..+)?\.example$/.test(name);
}

function* walk(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

function getFiles() {
  const git = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  if (git.status === 0 && git.stdout.trim().length > 0) {
    return git.stdout
      .split('\n')
      .map(function (line) { return line.trim(); })
      .filter(Boolean)
      .map(function (relative) { return join(root, relative); });
  }
  console.log('git ls-files unavailable; falling back to tree walk (excluding node_modules/.git)');
  return Array.from(walk(root));
}

function isText(filePath) {
  try {
    const buf = readFileSync(filePath);
    if (buf.length === 0) return true;
    // Treat as binary if any null byte appears in the first 8 KB.
    const sample = buf.slice(0, Math.min(buf.length, 8192));
    for (let i = 0; i < sample.length; i += 1) {
      if (sample[i] === 0) return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

const scannerPath = join(__dirname, 'secret-scan.mjs');
const files = getFiles();
let hits = 0;

for (const filePath of files) {
  if (filePath === scannerPath) continue;
  const name = basename(filePath);
  if (isPlaceholderEnvFile(name)) {
    // Skip example/placeholder env files entirely; they document required variables
    // without containing real secrets.
    continue;
  }
  if (isEnvFile(name)) {
    console.log(`HIT: .env file detected: ${filePath}`);
    hits += 1;
    continue;
  }
  if (!isText(filePath)) continue;
  const text = readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const pattern of secretPatterns) {
      const match = line.match(pattern.re);
      if (match) {
        console.log(`HIT: ${pattern.name} in ${filePath}:${i + 1}`);
        console.log('  ' + line.trim().slice(0, 120));
        hits += 1;
      }
    }
  }
}

if (hits > 0) {
  console.log(`\n${hits} secret pattern hit(s) found.`);
  process.exit(1);
} else {
  console.log('No secret patterns found.');
  process.exit(0);
}
