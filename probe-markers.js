#!/usr/bin/env node
const { chromium } = require('playwright');
const { CDP_URL, readKeepOpenPid, normalizeText } = require('./pfm-helpers');

const MARKERS = [
  'ניהול תקציב',
  'על מה הוצאתי בחודש',
  'סה"כ הוצאות בש"ח',
  'סה״כ הוצאות בש"ח',
  'לפתוח הכל',
  'ההוצאות שלי',
];

(async () => {
  if (!readKeepOpenPid()) process.exit(1);
  const browser = await chromium.connectOverCDP(CDP_URL);
  const page = browser.contexts()[0].pages().find((p) => p.url().includes('bankhapoalim'));
  const handle = await page.locator('main iframe').first().elementHandle();
  const frame = handle ? await handle.contentFrame() : null;

  const report = { pageUrl: page.url(), pageTitle: await page.title(), markers: {} };

  for (const marker of MARKERS) {
    report.markers[marker] = {
      shell: await page.getByText(marker).count(),
      iframe: frame ? await frame.getByText(marker).count() : 0,
      shellVisible: await page.getByText(marker).first().isVisible().catch(() => false),
      iframeVisible: frame ? await frame.getByText(marker).first().isVisible().catch(() => false) : false,
    };
  }

  if (frame) {
    const heading = await frame.getByRole('heading', { name: /על מה הוצאתי בחודש/ }).first().innerText().catch(() => '');
    report.expensesHeading = normalizeText(heading);
    const totalCell = await frame.getByRole('cell', { name: /סה"כ הוצאות בש"ח|סה״כ הוצאות/ }).first().innerText().catch(() => '');
    report.totalRow = normalizeText(totalCell);
    report.totalRowCount = await frame.getByText(/סה"כ הוצאות|סה״כ הוצאות/).count();
  }

  console.log(JSON.stringify(report, null, 2));
  await browser.close();
})();
