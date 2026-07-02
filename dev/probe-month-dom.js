#!/usr/bin/env node
const { chromium } = require('playwright');
const { CDP_URL, getPFMFrame, waitForBudgetPageReady, sleep } = require('../lib/pfm-helpers');

(async () => {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const page = browser.contexts()[0].pages().find((p) => p.url().includes('/pfm'));
  const frame = await waitForBudgetPageReady(page, { view: 'any', timeoutMs: 60_000 });

  const info = await frame.evaluate(() => {
    const months = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
    const norm = (t) => String(t||'').replace(/\s+/g,' ').trim();
    const isMonth = (t) => months.some((m) => new RegExp(`^${m}\\s+\\d{2}$`).test(norm(t)));
    const tabs = [...document.querySelectorAll('[role="button"]')].filter((el) => isMonth(el.textContent));
    const target = tabs.find((el) => norm(el.textContent) === 'יולי 24');
    if (!target) return { error: 'no target' };

    let container = target.parentElement;
    while (container && container !== document.body) {
      if (container.scrollWidth > container.clientWidth + 2) {
        const before = { sl: container.scrollLeft, sw: container.scrollWidth, cw: container.clientWidth, dir: getComputedStyle(container).direction };
        const tr = target.getBoundingClientRect();
        const cr = container.getBoundingClientRect();
        const offset = (tr.left + tr.right) / 2 - (cr.left + cr.right) / 2;
        container.scrollLeft += offset;
        const after = target.getBoundingClientRect();
        return {
          before,
          offset,
          afterScrollLeft: container.scrollLeft,
          inView: after.right > cr.left && after.left < cr.right,
          targetRect: { left: tr.left, right: tr.right },
          containerRect: { left: cr.left, right: cr.right },
        };
      }
      container = container.parentElement;
    }
    return { error: 'no container' };
  });

  console.log(JSON.stringify(info, null, 2));
  await browser.close();
})();
