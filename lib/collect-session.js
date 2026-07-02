const {
  getPFMFrame,
  ensureBudgetView,
  waitForBudgetPageReady,
  switchBudgetMode,
  sleep,
  discoverMonthTabs,
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

const EMPTY_MONTH_TIMEOUT_MS = 10_000;

async function selectMonth(frame, monthLabel) {
  const [monthName, yearSuffix] = monthLabel.split(' ');
  await frame.getByRole('button', { name: new RegExp(`^${monthName}\\s+${yearSuffix}$`) }).first().click();
  await sleep(1500);
}

async function listAvailableMonthTabs(page) {
  await ensureBudgetView(page);
  const frame = await getPFMFrame(page);
  return discoverMonthTabs(async () => frame);
}

async function tryCollectView(page, { mode, timeoutMs = EMPTY_MONTH_TIMEOUT_MS }) {
  const type = mode === 'income' ? TYPE_INCOME : TYPE_EXPENSES;

  try {
    await switchBudgetMode(page, mode, { timeoutMs });
    const frame = await waitForBudgetPageReady(page, { view: mode, timeoutMs });
    return await collectMergedTable(frame, { type });
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
  const frame = await getPFMFrame(page);

  try {
    await selectMonth(frame, monthLabel);
  } catch {
    return { rows: [], emptyMonth: true };
  }

  console.log(`\n📆 ${monthLabel}`);

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
