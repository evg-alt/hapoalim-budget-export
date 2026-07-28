const { chromium } = require('playwright');
const fs = require('fs');
const {
  CDP_URL,
  LOGIN_URL,
  PROFILE_DIR,
  PID_FILE,
  readKeepOpenPid,
  ensureBudgetView,
  waitForBudgetPageReady,
  hasBudgetTableReady,
  getPFMFrame,
} = require('./pfm-helpers');

async function connectKeeperBrowser() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const page = browser.contexts()[0]?.pages().find((p) => p.url().includes('bankhapoalim'));
  if (!page) {
    throw new Error(
      'Keeper browser is up but no Hapoalim tab found. Open the bank site in that window first.',
    );
  }

  console.log('✅ Attached to keeper browser (existing window).');
  return { browser, page, mode: 'keeper', ownsBrowser: false };
}

async function waitForPfmReady(page) {
  if (!page.url().includes('/pfm')) {
    console.log('Waiting for the budget page (ניהול תקציב / PFM)...');
    await page.waitForURL((url) => url.href.includes('/pfm'), { timeout: 5 * 60 * 1000 });
  }

  await ensureBudgetView(page);

  try {
    await waitForBudgetPageReady(page, { view: 'any', timeoutMs: 30_000 });
  } catch {
    const frame = await getPFMFrame(page).catch(() => null);
    if (frame && await hasBudgetTableReady(frame)) {
      console.log('✅ Budget table visible — continuing.');
      return;
    }
    throw new Error('Budget page not ready — open ניהול תקציב with category table visible.');
  }
}

function keeperIsRunning() {
  if (!readKeepOpenPid()) return false;
  try {
    fs.accessSync(PID_FILE, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function openBrowserSession({ useKeeper = false, allowLaunch = false } = {}) {
  const shouldUseKeeper = useKeeper || keeperIsRunning();

  if (shouldUseKeeper) {
    try {
      return await connectKeeperBrowser();
    } catch (err) {
      if (!allowLaunch) {
        throw new Error(
          `${err.message}\n` +
          'Start keeper first: npm run dev:keep-open\n' +
          'Or pass --launch to open a new browser (only if user explicitly asked).',
        );
      }
      console.warn(`⚠️  Keeper attach failed (${err.message}); launching new browser because --launch was set.`);
    }
  }

  if (!allowLaunch) {
    throw new Error(
      'No keeper browser to attach to.\n' +
      '  npm run dev:keep-open   # once — log in, keep window open\n' +
      '  npm run collect -- <range> --keeper\n' +
      'Use --launch only if the user explicitly asked to open a new window.',
    );
  }

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    slowMo: 50,
    viewport: { width: 1400, height: 900 },
  });

  const page = context.pages()[0] || await context.newPage();
  if (!page.url().includes('bankhapoalim')) {
    console.log('Opening Bank Hapoalim login page...');
    console.log('Log in manually in the browser window (including OTP if required).');
    await page.goto(LOGIN_URL);
  }

  await waitForPfmReady(page);
  return { browser: context, page, mode: 'launched', ownsBrowser: true };
}

module.exports = {
  connectKeeperBrowser,
  waitForPfmReady,
  openBrowserSession,
  keeperIsRunning,
};
