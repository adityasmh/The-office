import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
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

function startServer(port) {
  return new Promise(function (resolve, reject) {
    const proc = spawn('npx', ['serve', '.', '-l', String(port)], {
      cwd: root,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', function (chunk) { stdout += chunk; });
    proc.stderr.on('data', function (chunk) { stderr += chunk; });

    const timeout = setTimeout(function () {
      proc.kill();
      reject(new Error('Server did not start within 10s'));
    }, 10000);

    proc.on('error', reject);

    function checkReady() {
      if (stdout.includes('Accepting connections') || stderr.includes('Accepting connections')) {
        clearTimeout(timeout);
        resolve(proc);
      } else {
        setTimeout(checkReady, 100);
      }
    }
    checkReady();
  });
}

function stopServer(proc) {
  return new Promise(function (resolve) {
    proc.on('close', resolve);
    proc.kill();
  });
}

async function runHeadless() {
  const port = 3456;
  const baseUrl = 'http://localhost:' + port;
  let server;

  try {
    server = await startServer(port);
  } catch (err) {
    console.error('Failed to start static server:', err.message);
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  async function checkPage(path, description) {
    const page = await context.newPage();
    const consoleErrors = [];
    const notFound = [];

    page.on('console', function (msg) {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    page.on('pageerror', function (err) {
      consoleErrors.push(err.message);
    });

    page.on('response', function (response) {
      if (response.status() === 404) {
        notFound.push(response.url());
      }
    });

    await page.goto(baseUrl + path, { waitUntil: 'networkidle' });

    // Give any late async errors a moment to surface.
    await page.waitForTimeout(200);

    assert(
      consoleErrors.length === 0,
      `${description}: no console/page errors (${consoleErrors.length})`
    );
    if (consoleErrors.length > 0) {
      consoleErrors.forEach(function (e) { console.log('  console error:', e.slice(0, 200)); });
    }

    assert(
      notFound.length === 0,
      `${description}: no 404 network responses (${notFound.length})`
    );
    if (notFound.length > 0) {
      notFound.forEach(function (u) { console.log('  404:', u); });
    }

    return page;
  }

  try {
    await checkPage('/', 'default UI at /');
    await checkPage('/?ui=legacy', 'legacy UI at /?ui=legacy');

    // Exercise the adapter's updateProjectStatus through the detail view.
    const detailPage = await checkPage('/?view=detail&id=alpha', 'detail view for alpha');

    await detailPage.waitForSelector('#ao-status-select', { state: 'visible' });
    await detailPage.selectOption('#ao-status-select', 'complete');
    await detailPage.click('#ao-save-status');

    const message = await detailPage.locator('#ao-save-message').textContent();
    assert(
      message.includes('updated'),
      'detail view save shows success message after status update'
    );

    const persistedStatus = await detailPage.evaluate(function () {
      return window.AgentOfficeData.getProjectById('alpha').status;
    });
    assert(
      persistedStatus === 'complete',
      `adapter persisted status "complete" for alpha (got "${persistedStatus}")`
    );

    const badgeText = await detailPage.locator('.ao-detail-header .badge').textContent();
    assert(
      badgeText === 'complete',
      `detail header badge renders "complete" (got "${badgeText}")`
    );

    await detailPage.close();
  } catch (err) {
    console.error('Headless UI check failed:', err.message);
    failed += 1;
  } finally {
    await browser.close();
    await stopServer(server);
  }

  if (failed > 0) {
    console.log(`\n${failed} headless assertion(s) failed.`);
    process.exit(1);
  } else {
    console.log('\nAll headless UI assertions passed.');
  }
}

runHeadless().catch(function (err) {
  console.error(err);
  process.exit(1);
});
