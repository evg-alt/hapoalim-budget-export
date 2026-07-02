#!/usr/bin/env node
/** Step-by-step month bar scroll diagnostic on keeper browser. */

const { chromium } = require('playwright');
const {
  CDP_URL,
  readKeepOpenPid,
  collectVisibleMonthTabLabels,
  getPFMFrame,
  ensureBudgetView,
  waitForBudgetPageReady,
  scrollMonthBar,
  monthLabelSortKey,
  sleep,
} = require('../lib/pfm-helpers');

(async () => {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const page = browser.contexts()[0].pages().find((p) => p.url().includes('bankhapoalim'));
  await ensureBudgetView(page);
  await waitForBudgetPageReady(page, { view: 'any', timeoutMs: 60_000 });
  const frame = await getPFMFrame(page);

  const dump = async (label) => {
    const tabs = await collectVisibleMonthTabLabels(frame);
    const sorted = [...tabs].sort((a, b) => monthLabelSortKey(a) - monthLabelSortKey(b));
    console.log(`\n${label} (${tabs.length}): ${sorted[0]} … ${sorted[sorted.length - 1]}`);
    return tabs;
  };

  await dump('Start');

  // Jump to newest month tab if present
  const newest = frame.getByRole('button', { name: /^יולי\s+26$/ }).first();
  if (await newest.count()) {
    await newest.click();
    await sleep(800);
    await dump('After click יולי 26');
  }

  for (let i = 0; i < 8; i += 1) {
    const action = await scrollMonthBar(frame, 'newer');
    await sleep(400);
    const tabs = await dump(`newer #${i + 1} (${action})`);
    if (action === 'no-scroll' || action === 'stuck-container') break;
  }

  await dump('At newest end');

  const seen = new Set();
  const merge = (batch) => batch.forEach((t) => seen.add(t));

  merge(await collectVisibleMonthTabLabels(frame));
  for (let i = 0; i < 15; i += 1) {
    const before = seen.size;
    const action = await scrollMonthBar(frame, 'older');
    await sleep(450);
    merge(await collectVisibleMonthTabLabels(frame));
    const sorted = [...seen].sort((a, b) => monthLabelSortKey(a) - monthLabelSortKey(b));
    console.log(`older #${i + 1} (${action}): total=${seen.size} range=${sorted[0]}…${sorted[sorted.length - 1]}`);
    if (seen.size === before && (action === 'no-scroll' || action === 'stuck-container')) break;
  }

  const all = [...seen].sort((a, b) => monthLabelSortKey(a) - monthLabelSortKey(b));
  console.log(`\nAll discovered (${all.length}):\n${all.join(', ')}`);
  console.log(`\nHas פברואר 24: ${all.includes('פברואר 24')}`);
  console.log(`Has יוני 24: ${all.includes('יוני 24')}`);

  await browser.close();
})();
