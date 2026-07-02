const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const PROFILE_DIR = path.join(REPO_ROOT, '.browser-profile');
const EXPLORE_DIR = path.join(REPO_ROOT, 'explore');
const OUTPUT_DIR = path.join(REPO_ROOT, 'output');
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

const BUDGET_READY_MARKERS = {
  pageTitle: 'ניהול תקציב',
  budgetHeading: /ניהול תקציב/,
  expensesHeading: /על מה הוצאתי בחודש/,
  incomeHeading: /ההכנסות שלי בחודש/,
  expensesTotal: 'סה"כ הוצאות בש"ח',
  incomeTotal: 'סה"כ הכנסות בש"ח',
  openAll: 'לפתוח הכל',
  categoryColumn: 'קטגוריה',
  noData: 'אין נתונים להצגה',
};

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

function monthLabelSortKey(label) {
  const parsed = parseMonthLabel(label);
  if (!parsed) return -1;

  const [hebrew, yy] = parsed.split(' ');
  const month = HEBREW_MONTHS.indexOf(hebrew) + 1;
  if (month < 1) return -1;

  return (2000 + parseInt(yy, 10)) * 12 + month;
}

async function collectVisibleMonthTabLabels(frame) {
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

  return labels;
}

async function scrollMonthBarFallback(frame, direction) {
  const strip = frame.locator('.month-upper-selector');
  if (await strip.count()) {
    const className = direction === 'older' ? 'arrow-right' : 'arrow-left';
    const arrow = strip.locator(`div.${className}`).first();
    if (await arrow.count()) {
      await arrow.click();
      return 'clicked-fallback-strip';
    }
  }

  // Codegen fallback: repeated iframe button clicks (right arrow ≈ nth(1), left ≈ nth(0)).
  const index = direction === 'older' ? 1 : 0;
  const buttons = frame.getByRole('button');
  if ((await buttons.count()) > index) {
    await buttons.nth(index).click();
    return 'clicked-fallback-nth';
  }

  return 'no-scroll';
}

async function scrollMonthBar(frame, direction) {
  const selector = direction === 'older' ? 'div.arrow.arrow-right' : 'div.arrow.arrow-left';
  const arrow = frame.locator(selector).first();
  if (await arrow.count()) {
    await arrow.click();
    return 'clicked-arrow';
  }
  return scrollMonthBarFallback(frame, direction);
}

async function getViewportMonthTabLabels(frame) {
  return frame.evaluate((months) => {
    const normalize = (text) =>
      String(text || '')
        .replace(/[\u00a0\u2007\u202f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const isMonth = (text) => {
      const normalized = normalize(text);
      for (const month of months) {
        if (new RegExp(`^${month}\\s+\\d{2}$`).test(normalized)) return true;
      }
      return false;
    };

    const strip = document.querySelector('.month-upper-selector');
    const sr = strip?.getBoundingClientRect();
    const labels = [];
    const seen = new Set();

    for (const el of document.querySelectorAll('[role="button"]')) {
      const label = normalize(el.textContent || '');
      if (!isMonth(label) || seen.has(label)) continue;

      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (sr) {
        if (r.right <= sr.left + 2 || r.left >= sr.right - 2) continue;
      } else if (r.right <= 0 || r.left >= window.innerWidth) {
        continue;
      }

      seen.add(label);
      labels.push(label);
    }

    return labels;
  }, HEBREW_MONTHS);
}

async function isMonthTabInViewport(frame, monthLabel) {
  const [monthName, yearSuffix] = monthLabel.split(' ');
  return frame.evaluate(({ monthName, yearSuffix }) => {
    const normalize = (text) =>
      String(text || '').replace(/\s+/g, ' ').trim();

    const target = `${monthName} ${yearSuffix}`;
    const strip = document.querySelector('.month-upper-selector');
    const sr = strip?.getBoundingClientRect();
    for (const el of document.querySelectorAll('[role="button"]')) {
      if (normalize(el.textContent || '') !== target) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      if (!sr) return r.right > 0 && r.left < window.innerWidth;
      return r.right > sr.left + 2 && r.left < sr.right - 2;
    }
    return false;
  }, { monthName, yearSuffix });
}

async function ensureMonthTabVisible(frame, monthLabel) {
  const targetKey = monthLabelSortKey(monthLabel);
  let lastViewport = '';

  for (let step = 0; step < 20; step += 1) {
    if (await isMonthTabInViewport(frame, monthLabel)) {
      return;
    }

    const viewport = await getViewportMonthTabLabels(frame);
    if (!viewport.length) {
      throw new Error(`Month tab not in DOM: ${monthLabel}`);
    }

    const keys = viewport.map(monthLabelSortKey).filter((k) => k >= 0);
    const minKey = Math.min(...keys);
    const maxKey = Math.max(...keys);
    const direction = targetKey < minKey ? 'older' : 'newer';

    const viewportKey = viewport.join(',');
    if (viewportKey === lastViewport) {
      const fallback = await scrollMonthBarFallback(frame, direction);
      if (fallback !== 'no-scroll') {
        await sleep(400);
        continue;
      }
      break;
    }
    lastViewport = viewportKey;

    await scrollMonthBar(frame, direction);
    await sleep(400);
  }
}

async function clickMonthTabPlaywright(frame, monthLabel) {
  const [monthName, yearSuffix] = monthLabel.split(' ');
  const pattern = new RegExp(`^${monthName}\\s+${yearSuffix}$`);
  const tab = frame.getByRole('button', { name: pattern }).first();
  if (!(await tab.count())) return false;
  await tab.click();
  return true;
}

async function clickMonthTab(frame, monthLabel) {
  const [monthName, yearSuffix] = monthLabel.split(' ');
  await ensureMonthTabVisible(frame, monthLabel);

  const clickedDom = await frame.evaluate(({ monthName, yearSuffix }) => {
    const normalize = (text) => String(text || '').replace(/\s+/g, ' ').trim();
    const target = `${monthName} ${yearSuffix}`;
    const el = [...document.querySelectorAll('[role="button"]')].find(
      (node) => normalize(node.textContent || '') === target,
    );
    if (!el) return false;
    el.click();
    return true;
  }, { monthName, yearSuffix });

  if (clickedDom) return;

  try {
    if (await clickMonthTabPlaywright(frame, monthLabel)) return;
  } catch {
    await ensureMonthTabVisible(frame, monthLabel);
    if (await clickMonthTabPlaywright(frame, monthLabel)) return;
  }

  throw new Error(`Month tab not found: ${monthLabel}`);
}
async function discoverMonthTabs(getFrame, { debug = false } = {}) {
  const frame = await getFrame();
  const labels = await collectVisibleMonthTabLabels(frame);
  labels.sort((a, b) => monthLabelSortKey(a) - monthLabelSortKey(b));

  if (debug) {
    console.log(`DEBUG month tabs (${labels.length}): ${labels.join(', ')}`);
  }

  return labels;
}

function ensureExploreDir() {
  fs.mkdirSync(EXPLORE_DIR, { recursive: true });
}

function ensureOutputDir() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
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

async function getPFMFrame(page, { timeoutMs = 60_000 } = {}) {
  const iframe = page.locator('main iframe').first();
  await iframe.waitFor({ state: 'attached', timeout: timeoutMs });

  const handle = await iframe.elementHandle();
  if (!handle) throw new Error('Cannot find the PFM iframe element');

  const frame = await handle.contentFrame();
  if (!frame) throw new Error('PFM iframe has no contentFrame yet');

  return frame;
}

async function isMonthEmpty(frame) {
  const locator = frame.getByText(BUDGET_READY_MARKERS.noData);
  if (!(await locator.count())) return false;
  return locator.first().isVisible().catch(() => false);
}

async function hasBudgetTableReady(frame) {
  const [openAll, categoryColumn] = await Promise.all([
    frame.getByText(BUDGET_READY_MARKERS.openAll, { exact: true }).first()
      .isVisible().catch(() => false),
    frame.getByRole('columnheader', { name: BUDGET_READY_MARKERS.categoryColumn, exact: true }).first()
      .isVisible().catch(() => false),
  ]);
  return openAll && categoryColumn;
}

async function hasViewHeading(frame, view) {
  const pattern = view === 'income'
    ? BUDGET_READY_MARKERS.incomeHeading
    : BUDGET_READY_MARKERS.expensesHeading;
  return frame.getByRole('heading', { name: pattern }).first()
    .isVisible().catch(() => false);
}

async function isBudgetViewReady(frame, view) {
  if (view === 'any') {
    return await hasBudgetTableReady(frame);
  }

  if (!(await hasViewHeading(frame, view))) return false;
  if (await isMonthEmpty(frame)) return true;
  return await hasBudgetTableReady(frame);
}

function headingMatchesMonthLabel(headingText, monthLabel) {
  const [monthName, yearSuffix] = monthLabel.split(' ');
  const year = String(2000 + parseInt(yearSuffix, 10));
  const normalized = normalizeText(headingText);
  return normalized.includes(monthName)
    && (normalized.includes(yearSuffix) || normalized.includes(year));
}

async function waitForMonthLoaded(frame, {
  timeoutMs = 6000,
  monthLabel,
  beforeHeading = '',
} = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const previousHeading = normalizeText(beforeHeading);

  while (Date.now() < deadline) {
    const heading = normalizeText(
      await frame.getByRole('heading').first().innerText().catch(() => ''),
    );
    const elapsed = Date.now() - startedAt;
    const headingChanged = Boolean(heading) && heading !== previousHeading;
    const monthSwitched = headingMatchesMonthLabel(heading, monthLabel);

    if (await hasBudgetTableReady(frame) && (!monthLabel || monthSwitched || headingChanged)) {
      return 'data';
    }

    if (await isMonthEmpty(frame)) {
      if (monthSwitched || headingChanged || elapsed > 1000) {
        return 'empty';
      }
    }

    await sleep(200);
  }

  const heading = normalizeText(
    await frame.getByRole('heading').first().innerText().catch(() => ''),
  );
  if (await isMonthEmpty(frame) && (
    headingMatchesMonthLabel(heading, monthLabel)
    || heading !== previousHeading
  )) {
    return 'empty';
  }
  if (await hasBudgetTableReady(frame)) return 'data';
  return 'timeout';
}

async function waitForBudgetPageReady(page, { timeoutMs = 60_000, view = 'expenses', allowEmpty = true } = {}) {
  await page.waitForURL((url) => url.href.includes('/pfm'), { timeout: timeoutMs });

  await page.waitForFunction(
    (titlePart) => document.title.includes(titlePart),
    BUDGET_READY_MARKERS.pageTitle,
    { timeout: timeoutMs },
  );

  const frame = await getPFMFrame(page, { timeoutMs });

  await frame.getByRole('heading', { name: BUDGET_READY_MARKERS.budgetHeading }).first()
    .waitFor({ state: 'visible', timeout: timeoutMs });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const activeFrame = await getPFMFrame(page, { timeoutMs: 5000 });

    if (allowEmpty && await isMonthEmpty(activeFrame)) {
      return activeFrame;
    }

    if (view === 'any') {
      if (await hasBudgetTableReady(activeFrame)) {
        return activeFrame;
      }
    } else if (await isBudgetViewReady(activeFrame, view)) {
      return activeFrame;
    }

    await sleep(250);
  }

  throw new Error(`Budget page not ready (view=${view})`);
}

async function waitForPFMFrame(page, { timeoutMs = 15_000 } = {}) {
  try {
    return await waitForBudgetPageReady(page, { timeoutMs, view: 'any' });
  } catch {
    const iframe = page.locator('main iframe').first();
    if (!(await iframe.count())) return null;

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

async function ensureBudgetView(page) {
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

async function switchBudgetMode(page, mode = 'income', { timeoutMs = 30_000 } = {}) {
  const frame = await getPFMFrame(page);
  if (await isMonthEmpty(frame)) return frame;

  const label = mode === 'income' ? 'ההכנסות שלי' : 'ההוצאות שלי';
  const button = frame.getByRole('button', { name: new RegExp(label) }).first();

  if (!(await button.count())) {
    if (await isMonthEmpty(frame)) return frame;
    throw new Error(`Budget mode button not found: ${label}`);
  }

  await button.click();
  await sleep(400);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const activeFrame = await getPFMFrame(page);
    if (await isMonthEmpty(activeFrame)) return activeFrame;
    if (await hasViewHeading(activeFrame, mode)) return activeFrame;
    await sleep(200);
  }

  const finalFrame = await getPFMFrame(page);
  if (await isMonthEmpty(finalFrame)) return finalFrame;
  throw new Error(`Budget mode not ready: ${mode}`);
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
  REPO_ROOT,
  PROFILE_DIR,
  EXPLORE_DIR,
  OUTPUT_DIR,
  CDP_URL,
  PID_FILE,
  LOGIN_URL,
  BUDGET_READY_MARKERS,
  HEBREW_MONTHS,
  sleep,
  normalizeText,
  parseMonthLabel,
  ensureExploreDir,
  ensureOutputDir,
  readKeepOpenPid,
  getPFMFrame,
  waitForBudgetPageReady,
  waitForPFMFrame,
  ensureBudgetView,
  switchBudgetMode,
  isMonthEmpty,
  waitForMonthLoaded,
  discoverMonthTabs,
  ensureMonthTabVisible,
  clickMonthTab,
  collectVisibleMonthTabLabels,
  getViewportMonthTabLabels,
  scrollMonthBar,
  monthLabelSortKey,
  buildPageSnapshot,
};
