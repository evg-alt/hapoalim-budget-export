#!/usr/bin/env node
/**
 * Collect transactions for a date range (income + expenses merged).
 *
 * Usage:
 *   npm run collect
 *   npm run collect -- 2026/06/01-2026/06/30
 *   npm run collect -- 2026/04-2026/06
 *   npm run collect -- --json 2026/04
 *   npm run collect -- --keeper 2026/04   (developer: reuse keep-open session)
 */

const fs = require('fs');
const path = require('path');
const {
  OUTPUT_DIR,
  EXPLORE_DIR,
  ensureOutputDir,
  ensureExploreDir,
} = require('../lib/pfm-helpers');
const { openBrowserSession } = require('../lib/browser-launch');
const { collectDateRange, resolveDefaultRange } = require('../lib/collect-session');
const { parseCollectRange, rangeToFilename } = require('../lib/date-range');
const { transactionsToCsv } = require('../lib/collect-transactions');

const cliArgs = process.argv.slice(2).filter((arg) => arg !== '--help' && arg !== '-h');
const useKeeper = cliArgs.includes('--keeper') || cliArgs.includes('--dev');
const writeJson = cliArgs.includes('--json');
const rangeArg = cliArgs.find((arg) => !arg.startsWith('--'));

function printUsage() {
  console.log(`Usage:
  npm run collect
  npm run collect -- 2026/06/01-2026/06/30
  npm run collect -- 2026/05/01-2026/06/01
  npm run collect -- 2026/04/00-2026/06/30
  npm run collect -- 2026/04-2026/06
  npm run collect -- 2026/04

Options:
  --json                 Also write a JSON file (CSV is always written)

Developer (persistent session):
  npm run dev:keep-open
  npm run collect -- --keeper 2026/04`);
}

function printTable(rows, limit = 15) {
  console.log('\n--- Merged table (sample) ---');
  console.log('| סוג | קטגוריה | תיאור | תאריך | חשבון | סכום |');
  console.log('|-----|---------|-------|-------|-------|------|');
  for (const r of rows.slice(0, limit)) {
    console.log(`| ${r.type} | ${r.category} | ${r.description} | ${r.date} | ${r.account} | ${r.amount} |`);
  }
  if (rows.length > limit) {
    console.log(`... and ${rows.length - limit} more rows`);
  }
}

(async () => {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  ensureOutputDir();

  let browser;
  let page;

  try {
    ({ browser, page } = await openBrowserSession({ useKeeper }));
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  try {
    let result;

    if (!rangeArg) {
      console.log('No range given — using latest available bank month');
      const { range } = await resolveDefaultRange(page);
      result = await collectDateRange(page, { range, reload: !useKeeper });
    } else {
      let range;
      try {
        range = parseCollectRange(rangeArg);
      } catch (err) {
        console.error(`❌ ${err.message}`);
        printUsage();
        process.exit(1);
      }

      if (useKeeper) {
        console.log('Reloading PFM page...');
      }
      result = await collectDateRange(page, { range, reload: useKeeper });
    }

    const { range, rows, monthTabs, missingMonths, emptyMonths, rawCount } = result;
    const base = path.join(OUTPUT_DIR, rangeToFilename(range));

    const incomeCount = rows.filter((r) => r.type === 'הכנסות').length;
    const expenseCount = rows.filter((r) => r.type === 'הוצאות').length;

    fs.writeFileSync(`${base}.csv`, transactionsToCsv(rows), 'utf8');

    if (writeJson) {
      const payload = {
        range,
        monthTabs,
        missingMonths,
        emptyMonths,
        rawCount,
        incomeCount,
        expenseCount,
        totalCount: rows.length,
        rows,
      };
      fs.writeFileSync(`${base}.json`, JSON.stringify(payload, null, 2), 'utf8');
    }

    if (useKeeper) {
      ensureExploreDir();
      fs.writeFileSync(path.join(EXPLORE_DIR, 'merged-latest.json'), JSON.stringify(rows, null, 2), 'utf8');
      await page.screenshot({ path: path.join(EXPLORE_DIR, 'merged-latest.png'), fullPage: true });
    }

    console.log(`\n✅ Done: ${incomeCount} income + ${expenseCount} expenses = ${rows.length} rows`);
    console.log(`   ${base}.csv`);
    if (writeJson) {
      console.log(`   ${base}.json`);
    }

    printTable(rows);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
})();
