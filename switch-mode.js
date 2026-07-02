#!/usr/bin/env node
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const {
  CDP_URL,
  EXPLORE_DIR,
  readKeepOpenPid,
  buildPageSnapshot,
  switchBudgetMode,
} = require('./pfm-helpers');

const mode = process.argv[2] || 'income'; // income | expenses

(async () => {
  if (!readKeepOpenPid()) {
    console.error('❌ keep-open browser is not running. Start: ./keep-open.sh');
    process.exit(1);
  }

  const browser = await chromium.connectOverCDP(CDP_URL);
  const page = browser.contexts()[0].pages().find((p) => p.url().includes('bankhapoalim'));
  if (!page) {
    console.error('❌ No Hapoalim page found');
    process.exit(1);
  }

  await switchBudgetMode(page, mode);
  const headingPattern = mode === 'income' ? /ההכנסות שלי בחודש/ : /על מה הוצאתי בחודש/;
  const frame = await page.locator('main iframe').first().elementHandle().then((h) => h.contentFrame());
  const afterHeading = await frame.getByRole('heading', { name: headingPattern }).first().innerText();
  console.log(`✅ Switched to ${mode} view: ${afterHeading.trim()}`);

  const snapshot = await buildPageSnapshot(page);
  fs.writeFileSync(path.join(EXPLORE_DIR, 'latest.json'), JSON.stringify(snapshot, null, 2), 'utf8');
  await page.screenshot({ path: path.join(EXPLORE_DIR, 'latest.png'), fullPage: true });

  await browser.close();
})();
