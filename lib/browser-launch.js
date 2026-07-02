const { chromium } = require('playwright');
const { CDP_URL, LOGIN_URL, readKeepOpenPid, ensureBudgetView, waitForBudgetPageReady } = require('./pfm-helpers');

async function launchEphemeralBrowser() {
  const browser = await chromium.launch({
    headless: false,
    slowMo: 50,
  });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
  });
  const page = await context.newPage();

  console.log('Opening Bank Hapoalim login page...');
  console.log('Log in manually in the browser window (including OTP if required).');
  await page.goto(LOGIN_URL);

  return { browser, page, mode: 'ephemeral' };
}

async function waitForPfmReady(page) {
  if (!page.url().includes('/pfm')) {
    console.log('Waiting for the budget page (ניהול תקציב / PFM)...');
    await page.waitForURL((url) => url.href.includes('/pfm'), { timeout: 5 * 60 * 1000 });
  }

  await ensureBudgetView(page);
  await waitForBudgetPageReady(page, { view: 'any', timeoutMs: 5 * 60 * 1000 });
}

async function connectKeeperBrowser() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const page = browser.contexts()[0]?.pages().find((p) => p.url().includes('bankhapoalim'));
  if (!page) {
    throw new Error('No Hapoalim page found. Open the bank site in the keeper browser first.');
  }

  return { browser, page, mode: 'keeper' };
}

async function openBrowserSession({ useKeeper = false } = {}) {
  if (useKeeper) {
    if (!readKeepOpenPid()) {
      throw new Error('Keeper browser is not running. Start: npm run dev:keep-open');
    }
    return connectKeeperBrowser();
  }

  const session = await launchEphemeralBrowser();
  await waitForPfmReady(session.page);
  return session;
}

module.exports = {
  launchEphemeralBrowser,
  waitForPfmReady,
  connectKeeperBrowser,
  openBrowserSession,
};
