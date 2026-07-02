const {
  getPFMFrame,
  ensureBudgetView,
  waitForBudgetPageReady,
  switchBudgetMode,
  sleep,
  discoverMonthTabs,
  clickMonthTab,
  isMonthEmpty,
  waitForMonthLoaded,
} = require('./pfm-helpers');
const {
  TYPE_INCOME,
  TYPE_EXPENSES,
  collectMergedTable,
} = require('./collect-transactions');
const {
  monthTabsForRange,
  pickLatestMonthTab,
  defaultRangeFromMonthTab,
  filterRowsByDateRange,
} = require('./date-range');

const EMPTY_MONTH_TIMEOUT_MS = 6_000;

async function selectMonth(page, monthLabel) {
  const frame = await getPFMFrame(page);
  const beforeHeading = await frame.getByRole('heading').first().innerText().catch(() => '');
  await clickMonthTab(frame, monthLabel);
  const activeFrame = await getPFMFrame(page);
  return waitForMonthLoaded(activeFrame, {
    timeoutMs: EMPTY_MONTH_TIMEOUT_MS,
    monthLabel,
    beforeHeading,
  });
}

async function listAvailableMonthTabs(page) {
  await ensureBudgetView(page);
  await waitForBudgetPageReady(page, { view: 'any', timeoutMs: 90_000 });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const frame = await getPFMFrame(page);
    const labels = await discoverMonthTabs(async () => frame, {
      debug: attempt === 4,
    });
    if (labels.length) {
      console.log(`📅 Found ${labels.length} month tabs`);
      return labels;
    }
    await sleep(1500);
  }

  throw new Error(
    'Could not find month tabs on the budget page. ' +
      'Open ניהול תקציב, wait until categories load, then run collect again.',
  );
}

async function tryCollectView(page, { mode, timeoutMs = EMPTY_MONTH_TIMEOUT_MS }) {
  const type = mode === 'income' ? TYPE_INCOME : TYPE_EXPENSES;

  try {
    const frame = await getPFMFrame(page);
    if (await isMonthEmpty(frame)) return [];

    await switchBudgetMode(page, mode, { timeoutMs });
    const activeFrame = await getPFMFrame(page);
    if (await isMonthEmpty(activeFrame)) return [];

    const readyFrame = await waitForBudgetPageReady(page, {
      view: mode,
      timeoutMs,
      allowEmpty: true,
    });
    if (await isMonthEmpty(readyFrame)) return [];

    return await collectMergedTable(readyFrame, { type });
  } catch {
    return [];
  }
}

async function collectView(page, { mode }) {
  const rows = await tryCollectView(page, { mode, timeoutMs: 60_000 });
  if (!rows.length) {
    throw new Error(`No data for ${mode} view`);
  }
  return rows;
}

async function preparePage(page, { reload = true } = {}) {
  if (reload) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2000);
  }

  if (!page.url().includes('/pfm')) {
    throw new Error('Not on PFM page');
  }

  await ensureBudgetView(page);
}

async function collectBankMonth(page, monthLabel) {
  let loadState;
  try {
    loadState = await selectMonth(page, monthLabel);
  } catch {
    return { rows: [], emptyMonth: true };
  }

  console.log(`\n📆 ${monthLabel}`);

  const currentFrame = await getPFMFrame(page);
  if (loadState === 'empty' || await isMonthEmpty(currentFrame)) {
    console.log('   (אין נתונים להצגה — skipping)');
    return { rows: [], emptyMonth: true };
  }

  console.log(`   💰 ${TYPE_INCOME}...`);
  const incomeRows = await tryCollectView(page, { mode: 'income' });
  console.log(`      → ${incomeRows.length} rows`);

  console.log(`   💸 ${TYPE_EXPENSES}...`);
  const expenseRows = await tryCollectView(page, { mode: 'expenses' });
  console.log(`      → ${expenseRows.length} rows`);

  const rows = [...incomeRows, ...expenseRows];
  return {
    rows,
    emptyMonth: rows.length === 0,
  };
}

async function collectDateRange(page, { range, reload = true }) {
  await preparePage(page, { reload });

  const availableTabs = await listAvailableMonthTabs(page);
  const { tabs, missingMonths } = monthTabsForRange(range, availableTabs);

  console.log(`📅 Range: ${range.start} → ${range.end}`);
  console.log(`📋 Bank months to collect: ${tabs.join(', ')}`);
  if (missingMonths.length) {
    console.log(
      `⚠️  Not on bank UI (skipped): ${missingMonths.slice(0, 6).join(', ')}` +
        (missingMonths.length > 6 ? ` … +${missingMonths.length - 6} more` : ''),
    );
    console.log(
      '   (Online budget history is ~2 years; older months need bank office/phone.)',
    );
  }

  let allRows = [];
  const collectedMonths = [];
  const emptyMonths = [];

  for (const tab of tabs) {
    const { rows, emptyMonth } = await collectBankMonth(page, tab);
    if (emptyMonth) {
      emptyMonths.push(tab);
    } else {
      collectedMonths.push(tab);
    }
    allRows = allRows.concat(rows);
  }

  const filtered = range.monthOnly
    ? allRows
    : filterRowsByDateRange(allRows, range);

  if (range.monthOnly) {
    console.log(`\n🔎 Month-range request: ${filtered.length} rows from available months`);
  } else {
    console.log(`\n🔎 After date filter: ${filtered.length} rows (from ${allRows.length} raw)`);
  }

  return {
    range,
    monthTabs: collectedMonths,
    missingMonths,
    emptyMonths,
    rawCount: allRows.length,
    rows: filtered,
  };
}

async function resolveDefaultRange(page) {
  await preparePage(page, { reload: true });
  const tabs = await listAvailableMonthTabs(page);
  const latest = pickLatestMonthTab(tabs);
  const range = defaultRangeFromMonthTab(latest);
  console.log(`📅 Default: latest bank month "${latest}" → ${range.start}–${range.end}`);
  return { range, latestTab: latest, availableTabs: tabs };
}

module.exports = {
  selectMonth,
  collectView,
  tryCollectView,
  preparePage,
  collectBankMonth,
  collectDateRange,
  resolveDefaultRange,
  listAvailableMonthTabs,
};
