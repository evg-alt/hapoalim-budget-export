#!/usr/bin/env node
/**
 * Hapoalim PFM scraper
 *
 * Usage:
 *   node scrape.js                    # scrapes current month
 *   node scrape.js --months 3         # scrapes last 3 months
 *   node scrape.js --month "יוני 26"  # scrapes a specific month label
 *
 * Flow:
 *   1. Opens Chromium (headed) at the Hapoalim login URL
 *   2. Waits for YOU to log in (incl. OTP) — polls until PFM page is ready
 *   3. For each requested month:
 *      a. Navigates to that month tab
 *      b. Expands EXPENSES: clicks each category row to reveal transactions
 *      c. Expands INCOME: same
 *      d. Collects every transaction row
 *   4. Writes results to:
 *        hapoalim_<YYYYMM>.json   — raw JSON
 *        hapoalim_<YYYYMM>.csv    — spreadsheet-friendly CSV
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Persistent profile directory — keeps cookies/session between runs
const PROFILE_DIR = path.join(__dirname, '.browser-profile');

// ─── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const monthsCount = (() => {
  const i = args.indexOf('--months');
  return i !== -1 ? parseInt(args[i + 1], 10) : 1;
})();
const specificMonth = (() => {
  const i = args.indexOf('--month');
  return i !== -1 ? args[i + 1] : null;
})();

// ─── Helpers ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEBUG = args.includes('--debug');

const HEBREW_MONTHS = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
];

function normalizeText(text) {
  return String(text || '')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseMonthLabel(text) {
  const normalized = normalizeText(text);
  for (const month of HEBREW_MONTHS) {
    const match = normalized.match(new RegExp(`^(${month})\\s+(\\d{2})$`));
    if (match) return `${match[1]} ${match[2]}`;
  }
  return null;
}

async function waitForPFMFrame(page) {
  const iframe = page.locator('main iframe').first();
  await iframe.waitFor({ state: 'attached', timeout: 60_000 });

  const handle = await iframe.elementHandle();
  if (!handle) throw new Error('Cannot find the PFM iframe element');

  const frame = await handle.contentFrame();
  if (!frame) throw new Error('PFM iframe has no contentFrame yet');

  // Wait until the budget UI inside the iframe is actually rendered.
  await frame.locator('pfm-table-display, [class*="pfm"], button').first().waitFor({
    state: 'visible',
    timeout: 60_000,
  });

  return frame;
}

async function ensureBudgetView(page) {
  // The outer shell may be on /pfm while the budget iframe is not active yet.
  const budgetNav = page.getByRole('menuitem', { name: 'ניהול תקציב' });
  if (await budgetNav.count()) {
    await budgetNav.first().click();
    await sleep(1500);
    return;
  }

  const budgetSearch = page.getByText('ניהול תקציב', { exact: true });
  if (await budgetSearch.count()) {
    await budgetSearch.first().click();
    await sleep(1500);
  }
}

async function discoverMonthTabs(getFrame) {
  const frame = await getFrame();
  const buttons = await frame.getByRole('button').all();
  const labels = [];
  const seen = new Set();

  for (const button of buttons) {
    const raw = await button.innerText().catch(() => '');
    const label = parseMonthLabel(raw);
    if (label && !seen.has(label)) {
      seen.add(label);
      labels.push(label);
    }
  }

  if (DEBUG) {
    const allButtonTexts = [];
    for (const button of buttons.slice(0, 40)) {
      allButtonTexts.push(normalizeText(await button.innerText().catch(() => '')));
    }
    console.log('DEBUG button texts:', allButtonTexts.filter(Boolean).join(' | '));
  }

  return labels;
}

const LOGIN_URL =
  'https://login.bankhapoalim.co.il/ng-portals/auth/he/' +
  '?TYPE=33554432&REALMOID=06-6f6be178-8374-4bb2-b81e-b39649802626' +
  '&GUID=&SMAUTHREASON=0&METHOD=GET' +
  '&SMAGENTNAME=-SM-odWLjCh86qvUslArLh2Nb5vOYTQoUHuaNHl%2BF6VNWLFYBivtBMrjI921VcrskUEi' +
  '&TARGET=-SM-https:%2F%2Flogin.bankhapoalim.co.il%2Fng--portals%2Frb%2Fhe%2Fpfm';

const PFM_URL = 'https://login.bankhapoalim.co.il/ng-portals/rb/he/pfm';

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  // launchPersistentContext stores cookies/session in PROFILE_DIR so that
  // the next run skips the login screen automatically.
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    slowMo: 100,
    viewport: { width: 1280, height: 900 },
  });
  const page = context.pages()[0] || await context.newPage();

  // ── Step 1: Open login / PFM page ────────────────────────────────────────
  if (page.url().includes('/pfm')) {
    console.log('✅ Session restored — already on PFM page.');
    await page.bringToFront();
  } else {
    console.log('🌐 Opening Hapoalim login page...');
    await page.goto(LOGIN_URL);
  }

  // ── Step 2: Wait for PFM page ──────────────────────────────────────────────
  if (!page.url().includes('/pfm')) {
    console.log('⏳ Waiting for you to log in (including OTP)...');
    console.log('   The script will continue automatically once the PFM page is ready.\n');
    await page.waitForURL((url) => url.href.includes('/pfm'), { timeout: 5 * 60 * 1000 });
  }

  // Give the SPA + iframe a moment to fully hydrate
  await sleep(2000);
  console.log('✅ PFM page detected. Starting data extraction.\n');

  await ensureBudgetView(page);
  await sleep(1500);

  // ── Step 3: Get the inner iframe handle ───────────────────────────────────
  const getFrame = async () => waitForPFMFrame(page);

  // ── Step 4: Collect month tab labels visible in the nav ───────────────────
  await getFrame();

  // Determine which months to process
  let monthLabels = [];
  if (specificMonth) {
    const parsed = parseMonthLabel(specificMonth);
    monthLabels = [parsed || normalizeText(specificMonth)];
  } else {
    const allTabs = await discoverMonthTabs(getFrame);

    console.log('📅 Available month tabs:', allTabs.join(', ') || '(none found)');
    monthLabels = allTabs.slice(0, monthsCount);
  }

  if (monthLabels.length === 0) {
    console.error('\n❌ No month tabs found inside the PFM iframe.');
    console.error('   Try running with --debug to print button labels from the page.');
    console.error('   Or pass an explicit month, e.g.: --month "יוני 26"');
    await context.close();
    process.exit(1);
  }

  console.log(`📋 Will process months: ${monthLabels.join(', ')}\n`);

  // ── Step 5: Process each month ────────────────────────────────────────────
  const allResults = {};

  for (const monthLabel of monthLabels) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`📆 Processing month: ${monthLabel}`);
    console.log('═'.repeat(60));

    // Click the month tab
    const f = await getFrame();
    const [monthName, yearSuffix] = monthLabel.split(' ');
    const tabBtn = f.getByRole('button', { name: new RegExp(`^${monthName}\\s+${yearSuffix}$`) });
    await tabBtn.first().click();
    await sleep(1500);

    const monthData = { expenses: [], income: [] };

    // ── Expenses ──────────────────────────────────────────────────────────
    console.log('  💸 Collecting expenses...');
    monthData.expenses = await collectSection(page, getFrame, 'expenses');

    // ── Income ────────────────────────────────────────────────────────────
    console.log('  💰 Collecting income...');
    // Click the income summary card — div[role="button"], not <button>
    const f2 = await getFrame();
    const incomeBtn = f2.getByRole('button', { name: /ההכנסות שלי/ }).first();
    const incomeBtnCount = await incomeBtn.count();
    if (incomeBtnCount > 0) {
      await incomeBtn.click();
      await sleep(1500);
      monthData.income = await collectSection(page, getFrame, 'income');
    } else {
      console.log('    ⚠️  Income section button not found, skipping.');
    }

    allResults[monthLabel] = monthData;
    await saveResults(monthLabel, monthData);
  }

  console.log('\n\n✅ All done! Results saved to JSON and CSV files.');
  // Close context (not browser) — persistent context IS the browser instance here
  await context.close();
})();

// ─── collectSection ──────────────────────────────────────────────────────────
/**
 * Expands every category row in the currently visible section (expenses or income),
 * then scrapes all transaction rows.
 *
 * @param {import('playwright').Page} page
 * @param {() => Promise<import('playwright').Frame>} getFrame
 * @param {'expenses'|'income'} type
 * @returns {Promise<Transaction[]>}
 */
async function collectSection(page, getFrame, type) {
  const transactions = [];
  const f = await getFrame();

  // Best-effort: expand everything at once
  const openAll = f.getByText('לפתוח הכל', { exact: true });
  if (await openAll.count()) {
    console.log('    📂 Clicking "לפתוח הכל"');
    await openAll.first().click();
    await sleep(1500);
  } else {
    // Fallback: expand collapsed category buttons one by one
    let attempts = 0;
    while (attempts < 30) {
      const frame = await getFrame();
      const categoryButtons = await frame.locator('button[aria-expanded="false"]').all();
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

  const frame = await getFrame();

  // Transaction rows contain cells: description, date, account/card, payment method, amount
  // They live inside <tbody> under the expanded category sections.
  const rows = await frame.$$('tbody tr');

  for (const row of rows) {
    const cells = await row.$$('td');
    if (cells.length < 3) continue; // skip header/summary rows

    const cellTexts = await Promise.all(cells.map((c) => c.innerText().then((t) => t.trim())));

    // Skip rows that are themselves category summaries (they have "סה"כ" in them)
    if (cellTexts.some((t) => t.includes('סה"כ') || t.includes("סה''כ"))) continue;
    // Skip empty rows
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

// ─── saveResults ─────────────────────────────────────────────────────────────
async function saveResults(monthLabel, data) {
  // Build a safe filename from the month label
  const safeName = monthLabel.replace(/\s+/g, '_').replace(/[^\w-]/g, '');
  const outDir = path.dirname(path.resolve(__filename));
  const base = path.join(outDir, `hapoalim_${safeName}`);

  // JSON
  fs.writeFileSync(base + '.json', JSON.stringify({ month: monthLabel, ...data }, null, 2), 'utf8');
  console.log(`  💾 Saved: ${base}.json`);

  // CSV
  const rows = [
    ['type', 'description', 'date', 'account', 'paymentMethod', 'action', 'amount'],
    ...data.expenses.map((t) => [t.type, t.description, t.date, t.account, t.paymentMethod, t.action, t.amount]),
    ...data.income.map((t) => [t.type, t.description, t.date, t.account, t.paymentMethod, t.action, t.amount]),
  ];
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  fs.writeFileSync(base + '.csv', '\uFEFF' + csv, 'utf8'); // BOM for Excel
  console.log(`  💾 Saved: ${base}.csv`);
}
