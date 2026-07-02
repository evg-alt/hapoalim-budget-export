#!/usr/bin/env node
/**
 * Connect to the live keep-open browser and dump what's on screen.
 *
 * Usage:
 *   ./snapshot.sh
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const {
  CDP_URL,
  EXPLORE_DIR,
  ensureExploreDir,
  readKeepOpenPid,
  ensureBudgetView,
  buildPageSnapshot,
} = require('./pfm-helpers');

(async () => {
  ensureExploreDir();

  const pid = readKeepOpenPid();
  if (!pid) {
    console.error('❌ keep-open browser is not running.');
    console.error('   Start it first: ./keep-open.sh');
    process.exit(1);
  }

  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (err) {
    console.error(`❌ Could not connect to browser at ${CDP_URL}`);
    console.error(`   ${err.message}`);
    process.exit(1);
  }

  const context = browser.contexts()[0];
  const page = context.pages().find((p) => p.url().includes('bankhapoalim')) || context.pages()[0];
  if (!page) {
    console.error('❌ No page found in the open browser.');
    process.exit(1);
  }

  if (page.url().includes('/pfm')) {
    await ensureBudgetView(page).catch(() => null);
  }

  const snapshot = await buildPageSnapshot(page);
  const jsonPath = path.join(EXPLORE_DIR, 'latest.json');
  const pngPath = path.join(EXPLORE_DIR, 'latest.png');

  fs.writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2), 'utf8');
  await page.screenshot({ path: pngPath, fullPage: true });

  console.log(`URL: ${snapshot.pageUrl}`);
  console.log(`Month tabs: ${snapshot.iframe?.monthTabs?.join(', ') || '(none)'}`);
  console.log(`Category buttons: ${snapshot.iframe?.categoryButtons?.length || 0}`);
  console.log(`Tables: ${snapshot.iframe?.tables?.length || 0}`);
  console.log(`Saved: ${jsonPath}`);
  console.log(`Saved: ${pngPath}`);

  await browser.close(); // disconnect only; keeper browser stays open
})();
