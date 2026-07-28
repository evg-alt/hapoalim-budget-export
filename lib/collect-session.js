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
  hasBudgetTableReady,
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

const EMPTY_MONTH_TIMEOUT_MS = 15_000;

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

async function tryCollectView(page, { mode, timeoutMs = 12_000 }) {
  const type = mode === 'income' ? TYPE_INCOME : TYPE_EXPENSES;

  try {
    let frame = await getPFMFrame(page);
    if (await isMonthEmpty(frame)) {
      console.log(`      (empty before ${mode} switch)`);
      return [];
    }

    console.log(`      → switch ${mode}...`);
    frame = await switchBudgetMode(page, mode, { timeoutMs });
    await sleep(500);

    frame = await getPFMFrame(page);
    if (await isMonthEmpty(frame)) {
      console.log(`      (empty after ${mode} switch)`);
      return [];
    }

    // Do NOT call waitForBudgetPageReady here — we are already on /pfm.
    // That helper re-waits page title/heading and can hang for a full minute
    // after a month tab change (e.g. July after June already worked).
    const deadline = Date.now() + Math.min(timeoutMs, 12_000);
    while (Date.now() < deadline) {
      if (await isMonthEmpty(frame)) return [];
      if (await hasBudgetTableReady(frame)) break;
      await sleep(200);
      frame = await getPFMFrame(page);
    }

    if (await isMonthEmpty(frame)) return [];
    if (!(await hasBudgetTableReady(frame))) {
      console.warn(`      ⚠️  ${mode}: table not ready after ${timeoutMs}ms — skipping`);
      return [];
    }

    console.log(`      → scrape ${mode}...`);
    return await collectMergedTable(frame, { type });
  } catch (err) {
    console.warn(`      ⚠️  ${mode} collect failed: ${err.message}`);
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
  if (!page.url().includes('/pfm')) {
    throw new Error('Not on PFM page');
  }

  if (reload) {
    const frame = await getPFMFrame(page).catch(() => null);
    if (frame && await hasBudgetTableReady(frame)) {
      console.log('📄 Budget table already loaded — skipping reload.');
    } else {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await sleep(2000);
    }
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

  if (loadState === 'timeout') {
    console.log('   (month tab slow to load — waiting extra 3s)');
    await sleep(3000);
  }

  console.log(`   💰 ${TYPE_INCOME}...`);
  let incomeRows = await tryCollectView(page, { mode: 'income', timeoutMs: 12_000 });
  console.log(`      → ${incomeRows.length} rows`);

  console.log(`   💸 ${TYPE_EXPENSES}...`);
  let expenseRows = await tryCollectView(page, { mode: 'expenses', timeoutMs: 12_000 });
  console.log(`      → ${expenseRows.length} rows`);

  if (!incomeRows.length && !expenseRows.length) {
    const retryFrame = await getPFMFrame(page);
    if (!(await isMonthEmpty(retryFrame))) {
      console.log('   ↻ retrying after 2s (month has data but scrape returned 0)...');
      await sleep(2000);
      incomeRows = await tryCollectView(page, { mode: 'income', timeoutMs: 12_000 });
      expenseRows = await tryCollectView(page, { mode: 'expenses', timeoutMs: 12_000 });
      console.log(`      → retry: ${incomeRows.length} income + ${expenseRows.length} expenses`);
    }
  }

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
