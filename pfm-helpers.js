const fs = require('fs');
const path = require('path');

const PROFILE_DIR = path.join(__dirname, '.browser-profile');
const EXPLORE_DIR = path.join(__dirname, 'explore');
const CDP_URL = 'http://127.0.0.1:9333';
const PID_FILE = path.join(EXPLORE_DIR, 'keep-open.pid');

const LOGIN_URL =
  'https://login.bankhapoalim.co.il/ng-portals/auth/he/' +
  '?TYPE=33554432&REALMOID=06-6f6be178-8374-4bb2-b81e-b39649802626' +
  '&GUID=&SMAUTHREASON=0&METHOD=GET' +
  '&SMAGENTNAME=-SM-odWLjCh86qvUslArLh2Nb5vOYTQoUHuaNHl%2BF6VNWLFYBivtBMrjI921VcrskUEi' +
  '&TARGET=-SM-https:%2F%2Flogin.bankhapoalim.co.il%2Fng--portals%2Frb%2Fhe%2Fpfm';

const HEBREW_MONTHS = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function ensureExploreDir() {
  fs.mkdirSync(EXPLORE_DIR, { recursive: true });
}

function isPidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readKeepOpenPid() {
  if (!fs.existsSync(PID_FILE)) return null;
  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
  if (!pid || !isPidRunning(pid)) {
    fs.rmSync(PID_FILE, { force: true });
    return null;
  }
  return pid;
}

/**
 * Signals that the budget expenses view is fully loaded.
 * Verified on live page 2026-07-02.
 */
const BUDGET_READY_MARKERS = {
  /** document.title — coarse, outer shell */
  pageTitle: 'ניהול תקציב',
  /** iframe heading — budget section title */
  budgetHeading: /ניהול תקציב/,
  /** iframe heading — changes with month/year, e.g. "על מה הוצאתי בחודש יוני 2026" */
  expensesHeading: /על מה הוצאתי בחודש/,
  /** iframe table footer cell — expenses table fully rendered */
  expensesTotal: 'סה"כ הוצאות בש"ח',
  /** iframe control — category table interactive */
  openAll: 'לפתוח הכל',
  /** iframe table header */
  categoryColumn: 'קטגוריה',
};

async function getPFMFrame(page, { timeoutMs = 60_000 } = {}) {
  const iframe = page.locator('main iframe').first();
  await iframe.waitFor({ state: 'attached', timeout: timeoutMs });

  const handle = await iframe.elementHandle();
  if (!handle) throw new Error('Cannot find the PFM iframe element');

  const frame = await handle.contentFrame();
  if (!frame) throw new Error('PFM iframe has no contentFrame yet');

  return frame;
}

/**
 * Wait until the budget page is truly ready for scraping (not just URL=/pfm).
 * Returns the iframe FrameLocator content frame.
 */
async function waitForBudgetPageReady(page, { timeoutMs = 60_000, view = 'expenses' } = {}) {
  await page.waitForURL((url) => url.href.includes('/pfm'), { timeout: timeoutMs });

  await page.waitForFunction(
    (titlePart) => document.title.includes(titlePart),
    BUDGET_READY_MARKERS.pageTitle,
    { timeout: timeoutMs },
  );

  const frame = await getPFMFrame(page, { timeoutMs });

  await frame.getByRole('heading', { name: BUDGET_READY_MARKERS.budgetHeading }).first()
    .waitFor({ state: 'visible', timeout: timeoutMs });

  if (view === 'expenses') {
    await frame.getByRole('heading', { name: BUDGET_READY_MARKERS.expensesHeading })
      .waitFor({ state: 'visible', timeout: timeoutMs });

    await frame.getByText(BUDGET_READY_MARKERS.expensesTotal, { exact: true })
      .waitFor({ state: 'visible', timeout: timeoutMs });
  } else if (view !== 'any') {
    throw new Error(`Unknown budget view: ${view}`);
  }

  await frame.getByText(BUDGET_READY_MARKERS.openAll, { exact: true })
    .waitFor({ state: 'visible', timeout: timeoutMs });

  await frame.getByRole('columnheader', { name: BUDGET_READY_MARKERS.categoryColumn, exact: true })
    .waitFor({ state: 'visible', timeout: timeoutMs });

  return frame;
}

async function waitForPFMFrame(page, { timeoutMs = 15_000 } = {}) {
  try {
    return await waitForBudgetPageReady(page, { timeoutMs, view: 'any' });
  } catch {
    // Looser fallback for snapshots while page is still loading
    const iframe = page.locator('main iframe').first();
    const hasIframe = await iframe.count();
    if (!hasIframe) return null;

    await iframe.waitFor({ state: 'attached', timeout: timeoutMs }).catch(() => null);
    const handle = await iframe.elementHandle();
    if (!handle) return null;

    const frame = await handle.contentFrame();
    if (!frame) return null;

    await frame.locator('button, pfm-table-display, table').first().waitFor({
      state: 'visible',
      timeout: timeoutMs,
    }).catch(() => null);

    return frame;
  }
}

async function switchBudgetMode(page, mode = 'income') {
  const frame = await getPFMFrame(page);
  const label = mode === 'income' ? 'ההכנסות שלי' : 'ההוצאות שלי';
  const headingPattern = mode === 'income' ? /ההכנסות שלי בחודש/ : /על מה הוצאתי בחודש/;
  const totalLabel = mode === 'income' ? 'סה"כ הכנסות בש"ח' : 'סה"כ הוצאות בש"ח';

  // Summary cards are div[role="button"], not <button>
  await frame.getByRole('button', { name: new RegExp(label) }).first().click();
  await sleep(1200);

  await frame.getByRole('heading', { name: headingPattern }).waitFor({ state: 'visible', timeout: 30_000 });
  await frame.getByText(totalLabel, { exact: true }).waitFor({ state: 'visible', timeout: 30_000 }).catch(() => null);

  return frame;
}
  const budgetNav = page.getByRole('menuitem', { name: 'ניהול תקציב' });
  if (await budgetNav.count()) {
    await budgetNav.first().click();
    await sleep(1200);
    return;
  }

  const budgetSearch = page.getByText('ניהול תקציב', { exact: true });
  if (await budgetSearch.count()) {
    await budgetSearch.first().click();
    await sleep(1200);
  }
}

async function collectButtons(scope, limit = 60) {
  const buttons = await scope.getByRole('button').all();
  const out = [];
  for (const button of buttons.slice(0, limit)) {
    const text = normalizeText(await button.innerText().catch(() => ''));
    if (!text) continue;
    out.push({
      text,
      month: parseMonthLabel(text),
      expanded: await button.getAttribute('aria-expanded').catch(() => null),
    });
  }
  return out;
}

async function collectHeadings(scope) {
  const headings = await scope.locator('h1, h2, h3, h4, [role="heading"]').all();
  const out = [];
  for (const heading of headings.slice(0, 20)) {
    const text = normalizeText(await heading.innerText().catch(() => ''));
    if (text) out.push(text);
  }
  return out;
}

async function collectTableInfo(frame) {
  if (!frame) return null;

  const tables = await frame.locator('table').all();
  const tableInfos = [];

  for (const [index, table] of tables.entries()) {
    const headers = await table.locator('th').allTextContents().catch(() => []);
    const rowCount = await table.locator('tbody tr').count().catch(() => 0);
    tableInfos.push({
      index,
      headers: headers.map(normalizeText).filter(Boolean),
      rowCount,
    });
  }

  return tableInfos;
}

async function buildPageSnapshot(page) {
  const snapshot = {
    capturedAt: new Date().toISOString(),
    pageUrl: page.url(),
    pageTitle: await page.title().catch(() => ''),
    shellButtons: await collectButtons(page, 40),
    shellHeadings: await collectHeadings(page),
    iframe: null,
  };

  const frame = await waitForPFMFrame(page, { timeoutMs: 10_000 });
  if (!frame) return snapshot;

  const iframeButtons = await collectButtons(frame, 80);
  snapshot.iframe = {
    buttons: iframeButtons,
    monthTabs: iframeButtons.filter((b) => b.month).map((b) => b.month),
    headings: await collectHeadings(frame),
    tables: await collectTableInfo(frame),
    categoryButtons: iframeButtons
      .filter((b) => !b.month && /₪/.test(b.text))
      .map((b) => b.text),
    texts: {
      openAll: await frame.getByText('לפתוח הכל', { exact: true }).count(),
      closeAll: await frame.getByText('לסגור הכל', { exact: true }).count(),
      myExpenses: await frame.getByText('ההוצאות שלי').count(),
      myIncome: await frame.getByText('ההכנסות שלי').count(),
    },
  };

  return snapshot;
}

module.exports = {
  PROFILE_DIR,
  EXPLORE_DIR,
  CDP_URL,
  PID_FILE,
  LOGIN_URL,
  BUDGET_READY_MARKERS,
  sleep,
  normalizeText,
  parseMonthLabel,
  ensureExploreDir,
  readKeepOpenPid,
  getPFMFrame,
  waitForBudgetPageReady,
  waitForPFMFrame,
  switchBudgetMode,
  ensureBudgetView,
  buildPageSnapshot,
};
