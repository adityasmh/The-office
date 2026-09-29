import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const dataPath = join(root, 'js', 'data.js');

function loadData() {
  const code = readFileSync(dataPath, 'utf8');
  const sandbox = {
    window: {},
    console,
    setTimeout,
    clearTimeout,
    Promise,
    Date,
    Error,
    Array,
    Object,
    String,
    Number,
    JSON,
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {}
    },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
  };
  runInNewContext(code, sandbox, { filename: dataPath });
  return sandbox.window.Data;
}

async function capture() {
  const Data = loadData();
  const initialProjects = await Data.loadProjects();
  // Snapshot statuses immediately, because loadProjects returns shallow copies
  // of the in-session project objects that updateProjectStatus mutates in place.
  const initialSnapshot = initialProjects.map(function (p) {
    return { id: p.id, status: p.status };
  });

  const updated = await Data.updateProjectStatus('alpha', 'complete');
  const fetched = Data.getProjectById('alpha');

  const fixture = {
    description: 'loadProjects -> updateProjectStatus(alpha, "complete") -> getProjectById(alpha)',
    initialSnapshot: initialSnapshot,
    updated: {
      id: updated.id,
      status: updated.status,
      updatedAt: updated.updatedAt
    },
    fetched: {
      id: fetched.id,
      status: fetched.status,
      updatedAt: fetched.updatedAt
    },
    sameReference: updated === fetched
  };

  mkdirSync(join(__dirname, 'fixtures'), { recursive: true });
  writeFileSync(
    join(__dirname, 'fixtures', 'data-roundtrip.json'),
    JSON.stringify(fixture, null, 2) + '\n'
  );
  console.log('Captured fixture to tests/fixtures/data-roundtrip.json');
}

capture().catch(function (err) {
  console.error(err);
  process.exit(1);
});
