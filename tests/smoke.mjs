import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

let failed = 0;
function assert(condition, message) {
  if (condition) {
    console.log('PASS: ' + message);
  } else {
    console.log('FAIL: ' + message);
    failed += 1;
  }
}

function runScript(path, sandbox) {
  const code = readFileSync(path, 'utf8');
  runInNewContext(code, sandbox, { filename: path });
}

function loadSources() {
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
    Math,
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {}
    },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve([]) }),
    document: {
      querySelectorAll: () => []
    }
  };

  runScript(join(root, 'js', 'data.js'), sandbox);
  runScript(join(root, 'js', 'ui.js'), sandbox);

  // Expose the local computeStats helper without editing the source file.
  const overviewPath = join(root, 'js', 'views', 'overview.js');
  const overviewCode = readFileSync(overviewPath, 'utf8');
  const wrappedOverviewCode = overviewCode.replace(
    /\s*\}\)\(\);\s*$/,
    '\n  window.__computeStats = computeStats;\n})();'
  );
  sandbox.window.Router = { navigate: () => {} };
  runInNewContext(wrappedOverviewCode, sandbox, { filename: overviewPath });

  return {
    Data: sandbox.window.Data,
    UI: sandbox.window.UI,
    computeStats: sandbox.window.__computeStats
  };
}

async function runSmoke() {
  const { Data, UI, computeStats } = loadSources();

  // UI helpers from js/ui.js
  assert(
    UI.statusBadge('on-track') === '<span class="badge badge-success">on-track</span>',
    'statusBadge renders on-track with success tone'
  );
  assert(
    UI.statusBadge('paused') === '<span class="badge badge-warning">paused</span>',
    'statusBadge renders paused with warning tone'
  );
  assert(
    UI.statusBadge('unknown') === '<span class="badge badge-muted">unknown</span>',
    'statusBadge falls back to muted tone'
  );
  assert(
    UI.formatCurrency(124000) === '$124,000',
    'formatCurrency formats 124000 as $124,000'
  );
  assert(
    UI.escapeHtml('<script>alert("x")</script>') === '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    'escapeHtml escapes HTML special characters'
  );

  // computeStats from js/views/overview.js
  const projects = await Data.loadProjects();
  const initialSnapshot = projects.map(function (p) {
    return { id: p.id, status: p.status };
  });
  const stats = computeStats(projects);
  assert(stats.total === 4, 'computeStats total is 4');
  assert(stats.healthy === 2, 'computeStats healthy is 2 (on-track + active)');
  assert(stats.atRisk === 1, 'computeStats atRisk is 1');

  // Round-trip persistence: update mutates the in-session store and getProjectById reflects it.
  const updated = await Data.updateProjectStatus('alpha', 'complete');
  const fetched = Data.getProjectById('alpha');
  assert(updated === fetched, 'updateProjectStatus and getProjectById return the same object');
  assert(fetched.status === 'complete', 'round-trip persists status "complete"');
  assert(
    typeof fetched.updatedAt === 'string' && fetched.updatedAt.length > 0,
    'round-trip sets a non-empty updatedAt timestamp'
  );

  // Load the captured fixture and compare everything except the dynamic timestamp.
  const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'data-roundtrip.json'), 'utf8'));
  assert(
    JSON.stringify(fixture.initialSnapshot) === JSON.stringify(initialSnapshot),
    'loadProjects snapshot matches fixture initialSnapshot'
  );
  assert(
    fetched.status === fixture.fetched.status && fetched.id === fixture.fetched.id,
    'round-trip status/id matches fixture (excluding updatedAt)'
  );
  assert(fixture.sameReference === true, 'fixture records same reference after update');

  // Required scripts must exit 0.
  const scripts = [
    'hello-company.mjs',
    'agents/coder-1/hello-company.mjs',
    'agents/coder-2/hello-company.mjs',
    's2-eng-heartbeat.mjs',
    's2b-eng-heartbeat.mjs',
    's2-eng-throughput.mjs',
    's2b-eng-throughput.mjs'
  ];
  for (const script of scripts) {
    const result = spawnSync('node', [script], { cwd: root, encoding: 'utf8' });
    assert(
      result.status === 0,
      `node ${script} exits 0 (status=${result.status})`
    );
  }

  if (failed > 0) {
    console.log(`\n${failed} assertion(s) failed.`);
    process.exit(1);
  } else {
    console.log('\nAll smoke assertions passed.');
  }
}

runSmoke().catch(function (err) {
  console.error(err);
  process.exit(1);
});
