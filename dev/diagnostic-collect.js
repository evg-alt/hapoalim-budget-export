#!/usr/bin/env node
/**
 * Diagnostic collect via existing CDP browser (agent Chrome :9222 or keeper :9333).
 * Does NOT launch or close the browser — only disconnects Playwright.
 *
 * Usage:
 *   node dev/diagnostic-collect.js
 *   HAPOALIM_CDP_URL=http://127.0.0.1:9222 node dev/diagnostic-collect.js -- 2026/06/29-2026/07/28
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const {
  CDP_URL,
  EXPLORE_DIR,
  OUTPUT_DIR,
  ensureExploreDir,
  ensureOutputDir,
  getPFMFrame,
  hasBudgetTableReady,
  isMonthEmpty,
} = require('../lib/pfm-helpers');
const { collectDateRange } = require('../lib/collect-session');
const { parseCollectRange, rangeToFilename } = require('../lib/date-range');
const { expandAllCategories, transactionsToCsv } = require('../lib/collect-transactions');

const CDP_CANDIDATES = [
  process.env.HAPOALIM_CDP_URL,
  'http://127.0.0.1:9222',
  CDP_URL,
].filter(Boolean);

async function connectBankPage() {
  let lastErr;
  for (const cdpUrl of CDP_CANDIDATES) {
    try {
      const browser = await chromium.connectOverCDP(cdpUrl);
      const pages = browser.contexts().flatMap((c) => c.pages());
      const page = pages.find((p) => p.url().includes('/pfm'))
        || pages.find((p) => p.url().includes('bankhapoalim'));
      if (!page) {
        await browser.close();
        throw new Error(`no Hapoalim tab (pages: ${pages.map((p) => p.url()).join(', ')})`);
      }
      console.log(`✅ CDP attach: ${cdpUrl}`);
      console.log(`   tab: ${page.url()}`);
      return { browser, page, cdpUrl };
    } catch (err) {
      lastErr = err;
      console.log(`   CDP ${cdpUrl}: ${err.message}`);
    }
  }
  throw lastErr || new Error('No CDP endpoint available');
}

async function diagnoseFrame(page) {
  const frame = await getPFMFrame(page);
  const heading = await frame.getByRole('heading').first().innerText().catch(() => '');
  const empty = await isMonthEmpty(frame);
  const tableReady = await hasBudgetTableReady(frame);
  const openAllVisible = await frame.getByText(/לפתוח הכל/).first().isVisible().catch(() => false);
  const closeAllVisible = await frame.getByText(/לסגור הכל/).first().isVisible().catch(() => false);
  const categories = await frame.locator('tr.expandable-row[role="button"]').count();
  const collapsed = await frame.locator('tr.expandable-row[role="button"][aria-expanded="false"]').count();

  return {
    heading: heading.trim(),
    empty,
    tableReady,
    openAllVisible,
    closeAllVisible,
    categories,
    collapsed,
  };
}

(async () => {
  const rangeArg = process.argv.slice(2).find((a) => !a.startsWith('--')) || '2026/06/29-2026/07/28';
  let range;
  try {
    range = parseCollectRange(rangeArg);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  ensureExploreDir();
  ensureOutputDir();

  let browser;
  let page;
  try {
    ({ browser, page } = await connectBankPage());
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  try {
    console.log('\n--- Before expand ---');
    const before = await diagnoseFrame(page);
    console.log(JSON.stringify(before, null, 2));

    const frame = await getPFMFrame(page);
    const expandBefore = await expandAllCategories(frame);
    console.log('\n--- Expand result ---');
    console.log(JSON.stringify(expandBefore, null, 2));

    console.log('\n--- After expand ---');
    const after = await diagnoseFrame(page);
    console.log(JSON.stringify(after, null, 2));

    await page.screenshot({ path: path.join(EXPLORE_DIR, 'diagnostic-before-collect.png'), fullPage: true });

    console.log(`\n--- Collect ${range.start} → ${range.end} (no reload) ---`);
    const result = await collectDateRange(page, { range, reload: false });

    const outBase = path.join(OUTPUT_DIR, `diagnostic_${rangeToFilename(range)}`);
    fs.writeFileSync(`${outBase}.csv`, transactionsToCsv(result.rows), 'utf8');
    fs.writeFileSync(`${outBase}.json`, JSON.stringify({
      range: result.range,
      monthTabs: result.monthTabs,
      emptyMonths: result.emptyMonths,
      rawCount: result.rawCount,
      rowCount: result.rows.length,
      sample: result.rows.slice(0, 10),
    }, null, 2), 'utf8');

    console.log(`\n✅ Diagnostic collect: ${result.rows.length} rows (${result.rawCount} raw)`);
    console.log(`   months: ${result.monthTabs.join(', ') || '(none)'}`);
    console.log(`   empty: ${result.emptyMonths.join(', ') || '(none)'}`);
    console.log(`   csv: ${outBase}.csv`);

    if (result.rows.length === 0 && result.monthTabs.length > 0) {
      console.log('\n❌ Verification FAILED: months collected but 0 rows — likely still collapsed');
      process.exitCode = 1;
    } else if (result.rows.length > 0) {
      console.log('\n✅ Verification OK — sample rows:');
      for (const r of result.rows.slice(0, 5)) {
        console.log(`   ${r.date} | ${r.type} | ${r.description} | ${r.amount}`);
      }
    }
  } finally {
    if (browser) {
      await browser.close();
      console.log('\nDetached from CDP — browser window left open.');
    }
  }
})();
