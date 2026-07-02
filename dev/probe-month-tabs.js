#!/usr/bin/env node
/** Connect to keeper browser and test month-tab discovery with scrolling. */

const { chromium } = require('playwright');
const {
  CDP_URL,
  readKeepOpenPid,
  collectVisibleMonthTabLabels,
  getPFMFrame,
  ensureBudgetView,
  waitForBudgetPageReady,
  discoverMonthTabs,
} = require('../lib/pfm-helpers');
const { listAvailableMonthTabs } = require('../lib/collect-session');
const { monthTabsForRange, parseCollectRange } = require('../lib/date-range');

(async () => {
  if (!readKeepOpenPid()) {
    console.error('❌ Keeper not running. Start: npm run dev:keep-open');
    process.exit(1);
  }

  const browser = await chromium.connectOverCDP(CDP_URL);
  const page = browser.contexts()[0]?.pages().find((p) => p.url().includes('bankhapoalim'))
    || browser.contexts()[0]?.pages()[0];

  if (!page) {
    console.error('❌ No bank page in keeper browser.');
    process.exit(1);
  }

  console.log(`URL: ${page.url()}`);
  if (!page.url().includes('/pfm')) {
    console.error('❌ Navigate to ניהול תקציב (/pfm) in the keeper browser, then re-run.');
    process.exit(1);
  }

  await ensureBudgetView(page);
  await waitForBudgetPageReady(page, { view: 'any', timeoutMs: 60_000 });

  const frame = await getPFMFrame(page);
  const visibleOnly = await collectVisibleMonthTabLabels(frame);
  console.log(`\nVisible without scroll (${visibleOnly.length}):`);
  console.log(visibleOnly.join(', ') || '(none)');

  const allTabs = await discoverMonthTabs(async () => frame, { debug: true });
  console.log(`\nAfter scroll discovery (${allTabs.length}):`);
  console.log(allTabs.join(', ') || '(none)');

  const range = parseCollectRange('2024/02-2026/07');
  const { tabs, missingMonths } = monthTabsForRange(range, allTabs);
  console.log(`\nRange ${range.start}–${range.end}`);
  console.log(`Would collect (${tabs.length}): ${tabs.join(', ')}`);
  if (missingMonths.length) {
    console.log(`Still missing (${missingMonths.length}): ${missingMonths.join(', ')}`);
  } else {
    console.log('No missing months in range.');
  }

  const hasFeb24 = allTabs.some((t) => t.includes('24') && t.startsWith('פברואר'));
  console.log(`\n✅ פברואר 24 found: ${hasFeb24 ? 'yes' : 'NO'}`);

  await browser.close();
})();
