#!/usr/bin/env node
/** Test selecting an off-screen month tab via ensureMonthTabVisible. */

const { chromium } = require('playwright');
const {
  CDP_URL,
  getPFMFrame,
  ensureBudgetView,
  waitForBudgetPageReady,
  sleep,
} = require('../lib/pfm-helpers');
const { selectMonth } = require('../lib/collect-session');

(async () => {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const page = browser.contexts()[0].pages().find((p) => p.url().includes('bankhapoalim'));
  await ensureBudgetView(page);
  await waitForBudgetPageReady(page, { view: 'any', timeoutMs: 60_000 });
  const frame = await getPFMFrame(page);

  await frame.getByRole('button', { name: /^יולי\s+26$/ }).first().click();
  await sleep(800);

  const target = 'יולי 24';
  console.log(`Selecting ${target} from יולי 26...`);
  await selectMonth(frame, target);

  const heading = await frame.getByRole('heading', { name: /על מה הוצאתי|ההכנסות שלי/ }).first().innerText();
  console.log(`Heading after click: ${heading}`);
  console.log(`✅ Selected ${target}`);

  await browser.close();
})();
