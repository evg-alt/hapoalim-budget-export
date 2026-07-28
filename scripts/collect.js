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

const KNOWN_FLAGS = new Set(['--json', '--keeper', '--dev', '--force-close', '--launch']);

function parseCliArgs(argv) {
  const args = argv.filter((arg) => arg !== '--help' && arg !== '-h');

  if (args.length === 0) {
    return {
      rangeArg: null,
      useKeeper: false,
      writeJson: false,
      forceClose: false,
      allowLaunch: false,
    };
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
      forceClose: flags.includes('--force-close'),
      allowLaunch: flags.includes('--launch'),
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
    forceClose: optionFlags.includes('--force-close'),
    allowLaunch: optionFlags.includes('--launch'),
  };
}

let rangeArg;
let useKeeper;
let writeJson;
let forceClose;
let allowLaunch;

try {
  ({ rangeArg, useKeeper, writeJson, forceClose, allowLaunch } = parseCliArgs(process.argv.slice(2)));
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

function verifyCollectResult(result) {
  const { range, rows, monthTabs, emptyMonths, rawCount } = result;
  const issues = [];

  if (!monthTabs.length && !emptyMonths.length) {
    issues.push('no bank months were processed');
  }

  const expectedMonths = monthTabs.length;
  const gotDataMonths = monthTabs.filter(() => true).length;

  if (expectedMonths > 0 && rawCount === 0) {
    issues.push(
      `0 raw rows from ${expectedMonths} month tab(s) — categories may still be collapsed`,
    );
  }

  if (!range.monthOnly && rows.length === 0 && monthTabs.length > 0) {
    issues.push(`0 rows after date filter ${range.start} → ${range.end}`);
  }

  return {
    ok: issues.length === 0,
    issues,
    summary: `${rows.length} filtered rows (${rawCount} raw) from months: ${monthTabs.join(', ') || 'none'}`,
  };
}

async function waitForUserAck(page, message) {
  console.log(`\n${message}`);
  if (process.stdin.isTTY) {
    console.log('Inspect the browser. Press Enter here when done...');
    await new Promise((resolve) => {
      process.stdin.resume();
      process.stdin.once('data', () => resolve());
    });
    return;
  }

  console.log('Non-interactive shell — leaving browser open for 8 minutes...');
  await page.waitForTimeout(8 * 60 * 1000);
}

(async () => {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  ensureOutputDir();

  let browser;
  let page;
  let result;
  let ownsBrowser = false;
  let verification = { ok: false, issues: ['collect did not run'] };

  try {
    ({ browser, page, ownsBrowser = false } = await openBrowserSession({ useKeeper, allowLaunch }));
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  try {
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
        console.log('Using keeper session (no page reload).');
      }
      result = await collectDateRange(page, { range, reload: !useKeeper });
    }

    verification = verifyCollectResult(result);
    console.log(`\n🔍 Verification: ${verification.summary}`);
    if (!verification.ok) {
      for (const issue of verification.issues) {
        console.log(`   ❌ ${issue}`);
      }
      ensureExploreDir();
      const shotPath = path.join(EXPLORE_DIR, 'collect-failed.png');
      await page.screenshot({ path: shotPath, fullPage: true }).catch(() => null);
      console.log(`   screenshot: ${shotPath}`);
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

    if (!verification.ok && !forceClose) {
      await waitForUserAck(
        page,
        '⚠️  Collect finished but verification FAILED — browser stays open.',
      );
    } else if (verification.ok && forceClose && ownsBrowser) {
      console.log('\n✅ Verification passed — closing browser (--force-close).');
    } else if (verification.ok) {
      console.log('\n✅ Verification passed — browser left open (default).');
    }
  } finally {
    if (browser && ownsBrowser && forceClose && verification.ok) {
      await browser.close();
    } else if (browser && !ownsBrowser) {
      console.log('Detached from keeper — window stays open.');
    } else if (browser && ownsBrowser) {
      console.log('Browser left open — close manually when done.');
    }
  }
})();
