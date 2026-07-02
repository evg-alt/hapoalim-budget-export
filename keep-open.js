#!/usr/bin/env node
/**
 * Keep a headed Playwright browser open for interactive exploration.
 * Exposes CDP on :9333 so snapshot.js can inspect the live page anytime.
 *
 * Usage:
 *   ./keep-open.sh
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const {
  PROFILE_DIR,
  EXPLORE_DIR,
  PID_FILE,
  LOGIN_URL,
  sleep,
  ensureExploreDir,
  readKeepOpenPid,
  ensureBudgetView,
  buildPageSnapshot,
  waitForBudgetPageReady,
} = require('./pfm-helpers');

async function writeInitialSnapshot(page) {
  const snapshot = await buildPageSnapshot(page);
  const jsonPath = path.join(EXPLORE_DIR, 'latest.json');
  fs.writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2), 'utf8');

  const pngPath = path.join(EXPLORE_DIR, 'latest.png');
  await page.screenshot({ path: pngPath, fullPage: true }).catch(() => null);

  console.log(`📸 Snapshot saved: ${jsonPath}`);
}

(async () => {
  ensureExploreDir();

  const existingPid = readKeepOpenPid();
  if (existingPid) {
    console.log(`Browser keeper already running (pid ${existingPid}).`);
    console.log('Run ./snapshot.sh to inspect the current page.');
    process.exit(0);
  }

  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');

  const cleanup = () => {
    fs.rmSync(PID_FILE, { force: true });
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', cleanup);

  console.log('🌐 Launching persistent browser (stays open)...');
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    slowMo: 50,
    viewport: { width: 1400, height: 900 },
    args: ['--remote-debugging-port=9333'],
  });

  const page = context.pages()[0] || await context.newPage();

  if (page.url().includes('/pfm')) {
    console.log('✅ Reusing saved session.');
    await page.bringToFront();
  } else {
    console.log('🔐 Opening login page — log in manually if needed.');
    await page.goto(LOGIN_URL);
  }

  console.log('\nBrowser is open. You can navigate anywhere in Hapoalim.');
  console.log('When you want me to analyze the screen, tell me and I will run ./snapshot.sh');
  console.log('Press Ctrl+C here when you want to close the browser.\n');

  // Poll: whenever URL hits /pfm, refresh snapshot automatically
  let lastUrl = '';
  while (true) {
    const url = page.url();
    if (url !== lastUrl) {
      lastUrl = url;
      console.log(`📍 ${url}`);
      if (url.includes('/pfm')) {
        await ensureBudgetView(page).catch(() => null);
        await waitForBudgetPageReady(page, { timeoutMs: 60_000 }).catch(() => null);
        await writeInitialSnapshot(page).catch((err) => {
          console.log(`   (snapshot skipped: ${err.message})`);
        });
      }
    }
    await sleep(2000);
  }
})();
