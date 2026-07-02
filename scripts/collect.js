#!/usr/bin/env node
/**
 * Collect transactions for a date range (income + expenses merged).
 *
 * Usage:
 *   npm run collect
 *   npm run collect -- 2026/06/01-2026/06/30
 *   npm run collect -- 2026/04-2026/06
 *   npm run collect -- 2026/04 --json
 *   npm run collect -- 2026/04 --keeper   (developer: reuse keep-open session)
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

const KNOWN_FLAGS = new Set(['--json', '--keeper', '--dev']);

function parseCliArgs(argv) {
  const args = argv.filter((arg) => arg !== '--help' && arg !== '-h');

  if (args.length === 0) {
    return { rangeArg: null, useKeeper: false, writeJson: false };
  }

  const positional = args.filter((arg) => !arg.startsWith('--'));
  const flags = args.filter((arg) => arg.startsWith('--'));

  for (const flag of flags) {
    if (!KNOWN_FLAGS.has(flag)) {
      throw new Error(`Unknown option: ${flag}`);
    }
  }

  if (positional.length > 1) {
    throw new Error('Only one date range is allowed.');
  }

  if (positional.length === 1 && args[0] !== positional[0]) {
    throw new Error(
      'Date range must be the first argument, then options (e.g. npm run collect -- 2026/06 --json).',
    );
  }

  if (positional.length === 0) {
    return {
      rangeArg: null,
      useKeeper: flags.includes('--keeper') || flags.includes('--dev'),
      writeJson: flags.includes('--json'),
    };
  }

  const optionFlags = args.slice(1);
  for (const arg of optionFlags) {
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument "${arg}". Options go after the date range.`);
    }
  }

  return {
    rangeArg: positional[0],
    useKeeper: optionFlags.includes('--keeper') || optionFlags.includes('--dev'),
    writeJson: optionFlags.includes('--json'),
  };
}

let rangeArg;
let useKeeper;
let writeJson;

try {
  ({ rangeArg, useKeeper, writeJson } = parseCliArgs(process.argv.slice(2)));
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}

function printUsage() {
  console.log(`Usage:
  npm run collect
  npm run collect -- 2026/06/01-2026/06/30
  npm run collect -- 2026/05/01-2026/06/01
  npm run collect -- 2026/04-2026/06
  npm run collect -- 2026/04 --json
  npm run collect -- 2026/04 --keeper

Options (after the date range):
  --json                 Also write a JSON file (CSV is always written)
  --keeper               Use dev:keep-open browser session

Developer:
  npm run dev:keep-open
  npm run collect -- 2026/04 --keeper`);
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
