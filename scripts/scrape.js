#!/usr/bin/env node
/**
 * Hapoalim PFM scraper
 *
 * Usage:
 *   npm run scrape
 *   npm run scrape -- --months 3
 *   npm run scrape -- --month "יוני 26"
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const {
  PROFILE_DIR,
  OUTPUT_DIR,
  LOGIN_URL,
  sleep,
  normalizeText,
  parseMonthLabel,
  ensureBudgetView,
  ensureOutputDir,
  waitForBudgetPageReady,
  discoverMonthTabs,
  switchBudgetMode,
} = require('../lib/pfm-helpers');

const args = process.argv.slice(2);
const monthsCount = (() => {
  const i = args.indexOf('--months');
  return i !== -1 ? parseInt(args[i + 1], 10) : 1;
})();
const specificMonth = (() => {
  const i = args.indexOf('--month');
  return i !== -1 ? args[i + 1] : null;
})();
const DEBUG = args.includes('--debug');

(async () => {
  ensureOutputDir();

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    slowMo: 100,
    viewport: { width: 1280, height: 900 },
  });
  const page = context.pages()[0] || await context.newPage();

  if (page.url().includes('/pfm')) {
    console.log('✅ Session restored — already on PFM page.');
    await page.bringToFront();
  } else {
    console.log('🌐 Opening Hapoalim login page...');
    await page.goto(LOGIN_URL);
  }

  if (!page.url().includes('/pfm')) {
    console.log('⏳ Waiting for you to log in (including OTP)...');
    console.log('   The script will continue automatically once the PFM page is ready.\n');
    await page.waitForURL((url) => url.href.includes('/pfm'), { timeout: 5 * 60 * 1000 });
  }

  await ensureBudgetView(page);
  const getFrame = async () => waitForBudgetPageReady(page, { view: 'expenses' });
  await getFrame();
  console.log('✅ Budget page ready. Starting data extraction.\n');

  let monthLabels = [];
  if (specificMonth) {
    monthLabels = [parseMonthLabel(specificMonth) || normalizeText(specificMonth)];
  } else {
    const allTabs = await discoverMonthTabs(getFrame, { debug: DEBUG });
    console.log('📅 Available month tabs:', allTabs.join(', ') || '(none found)');
    monthLabels = allTabs.slice(0, monthsCount);
  }

  if (monthLabels.length === 0) {
    console.error('\n❌ No month tabs found inside the PFM iframe.');
    console.error('   Try: npm run scrape -- --debug');
    console.error('   Or:  npm run scrape -- --month "יוני 26"');
    await context.close();
    process.exit(1);
  }

  console.log(`📋 Will process months: ${monthLabels.join(', ')}\n`);

  for (const monthLabel of monthLabels) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`📆 Processing month: ${monthLabel}`);
    console.log('═'.repeat(60));

    const frame = await getFrame();
    const [monthName, yearSuffix] = monthLabel.split(' ');
    await frame.getByRole('button', { name: new RegExp(`^${monthName}\\s+${yearSuffix}$`) }).first().click();
    await sleep(1500);

    const monthData = { expenses: [], income: [] };

    console.log('  💸 Collecting expenses...');
    monthData.expenses = await collectSection(getFrame, 'expenses');

    console.log('  💰 Collecting income...');
    await switchBudgetMode(page, 'income');
    monthData.income = await collectSection(
      async () => waitForBudgetPageReady(page, { view: 'income' }),
      'income',
    );

    saveResults(monthLabel, monthData);
  }

  console.log('\n\n✅ All done! Results saved under output/');
  await context.close();
})();

async function collectSection(getFrame, type) {
  const transactions = [];
  const frame = await getFrame();

  const openAll = frame.getByText('לפתוח הכל', { exact: true });
  if (await openAll.count()) {
    console.log('    📂 Clicking "לפתוח הכל"');
    await openAll.first().click();
    await sleep(1500);
  } else {
    let attempts = 0;
    while (attempts < 30) {
      const f = await getFrame();
      const categoryButtons = await f.locator('button[aria-expanded="false"]').all();
      if (categoryButtons.length === 0) break;

      for (const btn of categoryButtons) {
        const txt = normalizeText(await btn.innerText().catch(() => ''));
        if (txt) {
          console.log(`    📂 Expanding: ${txt}`);
          await btn.click();
          await sleep(400);
        }
      }
      attempts++;
    }
  }

  const rows = await (await getFrame()).$$('tbody tr');

  for (const row of rows) {
    const cells = await row.$$('td');
    if (cells.length < 3) continue;

    const cellTexts = await Promise.all(cells.map((c) => c.innerText().then((t) => t.trim())));
    if (cellTexts.some((t) => t.includes('סה"כ') || t.includes("סה''כ"))) continue;
    if (cellTexts.every((t) => !t)) continue;

    transactions.push({
      type,
      description: cellTexts[0] || '',
      date: cellTexts[1] || '',
      account: cellTexts[2] || '',
      paymentMethod: cellTexts[3] || '',
      action: cellTexts[4] || '',
      amount: cellTexts[5] || cellTexts[cellTexts.length - 1] || '',
      rawCells: cellTexts,
    });
  }

  console.log(`    → Found ${transactions.length} rows`);
  return transactions;
}

function saveResults(monthLabel, data) {
  const safeName = monthLabel.replace(/\s+/g, '_').replace(/[^\w-]/g, '');
  const base = path.join(OUTPUT_DIR, `hapoalim_${safeName}`);

  fs.writeFileSync(`${base}.json`, JSON.stringify({ month: monthLabel, ...data }, null, 2), 'utf8');
  console.log(`  💾 Saved: ${base}.json`);

  const rows = [
    ['type', 'description', 'date', 'account', 'paymentMethod', 'action', 'amount'],
    ...data.expenses.map((t) => [t.type, t.description, t.date, t.account, t.paymentMethod, t.action, t.amount]),
    ...data.income.map((t) => [t.type, t.description, t.date, t.account, t.paymentMethod, t.action, t.amount]),
  ];
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  fs.writeFileSync(`${base}.csv`, `\uFEFF${csv}`, 'utf8');
  console.log(`  💾 Saved: ${base}.csv`);
}
