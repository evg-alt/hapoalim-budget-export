#!/usr/bin/env node
const { chromium } = require('playwright');
const { CDP_URL, readKeepOpenPid, getPFMFrame, normalizeText } = require('./pfm-helpers');

(async () => {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const page = browser.contexts()[0].pages().find((p) => p.url().includes('bankhapoalim'));
  const frame = await getPFMFrame(page);

  const hits = await frame.locator('button, [role="button"], a, div, span').filter({ hasText: 'ההכנסות שלי' }).all();
  const report = [];
  for (const [i, el] of hits.entries()) {
    if (i > 15) break;
    report.push({
      tag: await el.evaluate((n) => n.tagName),
      role: await el.getAttribute('role').catch(() => null),
      text: normalizeText(await el.innerText().catch(() => '')),
      visible: await el.isVisible().catch(() => false),
      className: await el.getAttribute('class').catch(() => ''),
    });
  }
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
})();
