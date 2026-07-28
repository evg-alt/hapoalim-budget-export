const { normalizeText, sleep } = require('./pfm-helpers');

const TYPE_INCOME = 'הכנסות';
const TYPE_EXPENSES = 'הוצאות';
const OPEN_ALL_LABEL = 'לפתוח הכל';
const CLOSE_ALL_LABEL = 'לסגור הכל';

async function countCollapsedCategories(frame) {
  return frame.locator('tr.expandable-row[role="button"][aria-expanded="false"]').count();
}

async function countSubTableRows(frame) {
  return frame.locator('tr[id^="collapsable-row"] tbody tr').count();
}

async function clickOpenAll(frame) {
  const openAll = frame.locator('a, button, [role="button"]').filter({ hasText: /לפתוח הכל/ });
  if (!(await openAll.count())) {
    const fallback = frame.getByText(/לפתוח הכל/);
    if (!(await fallback.count())) return false;
    const btn = fallback.first();
    if (!(await btn.isVisible().catch(() => false))) return false;
    console.log('      📂 clicking לפתוח הכל (text node)...');
    await btn.click({ timeout: 8000 }).catch(() => btn.click({ force: true }));
    return true;
  }

  const btn = openAll.first();
  if (!(await btn.isVisible().catch(() => false))) return false;

  console.log('      📂 clicking לפתוח הכל...');
  try {
    await btn.click({ timeout: 8000 });
  } catch {
    await btn.evaluate((el) => el.click());
  }
  return true;
}

async function expandAllCategories(frame) {
  await frame.getByText(/לפתוח הכל/).first()
    .waitFor({ state: 'visible', timeout: 20_000 })
    .catch(() => null);

  if (await clickOpenAll(frame)) {
    await sleep(2000);
  }

  let collapsed = await countCollapsedCategories(frame);
  if (collapsed > 0) {
    await frame.evaluate(() => {
      const target = [...document.querySelectorAll('a, button, span, div')]
        .find((el) => (el.textContent || '').includes('לפתוח הכל'));
      target?.click();
    });
    await sleep(2000);
    collapsed = await countCollapsedCategories(frame);
  }

  if (collapsed > 0) {
    console.log(`      📂 expanding ${collapsed} categories one by one...`);
    const rows = await frame.locator('tr.expandable-row[role="button"][aria-expanded="false"]').all();
    for (const row of rows) {
      try {
        await row.click({ timeout: 3000 });
      } catch {
        await row.evaluate((el) => el.click());
      }
      await sleep(120);
    }
    await sleep(1500);
    collapsed = await countCollapsedCategories(frame);
  }

  const closeAllVisible = await frame.getByText(CLOSE_ALL_LABEL, { exact: true }).first()
    .isVisible().catch(() => false);
  const subRows = await countSubTableRows(frame);
  const categoryCount = await frame.locator('tr.expandable-row[role="button"]').count();

  console.log(
    `      📂 expand check: categories=${categoryCount}, collapsed=${collapsed}, ` +
    `sub-rows=${subRows}, close-all=${closeAllVisible}`,
  );

  return { collapsed, subRows, categoryCount, closeAllVisible };
}

function parseCategoryName(rowText) {
  const text = normalizeText(rowText);
  const withoutBadge = text.replace(/\s+\d+\s+הוצאות מחכות לסידור.*$/, '').trim();
  const match = withoutBadge.match(/^(.+?)\s+[\d,]+\.\d{2}\s*₪/);
  if (match) return match[1].trim();
  return withoutBadge.split('₪')[0].trim();
}

function isFooterRow(cells) {
  return cells.some((c) => c.includes('סה"כ') || c.includes("סה''כ"));
}

function formatTransactionDate(ddmmyy) {
  const m = normalizeText(ddmmyy).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (!m) return ddmmyy;

  const day = m[1].padStart(2, '0');
  const month = m[2].padStart(2, '0');
  const yy = parseInt(m[3], 10);
  const year = yy >= 70 ? 1900 + yy : 2000 + yy;

  return `${year}/${month}/${day}`;
}

function parseTransactionRow(cells) {
  if (cells.length < 3) return null;
  if (isFooterRow(cells)) return null;

  const amountIdx = cells.findIndex((c) => c.includes('₪'));
  if (amountIdx < 0) return null;

  const description = cells[0];
  const rawDate = cells[1] || '';
  const account = cells[2] || '';
  const amount = cells[amountIdx];

  if (!description || !rawDate.match(/\d{2}\/\d{2}\/\d{2}/)) return null;

  return {
    description,
    date: formatTransactionDate(rawDate),
    account,
    amount: normalizeAmount(amount),
  };
}

function normalizeAmount(amount) {
  return String(amount || '').replace(/[,\s₪]/g, '');
}

async function collectMergedTable(frame, { type }) {
  const categoryRows = await frame.locator('tr.expandable-row[role="button"]').all();
  if (!categoryRows.length) {
    console.log('      ⚠️  no category rows on page');
    return [];
  }

  const expandState = await expandAllCategories(frame);
  if (expandState.categoryCount > 0 && expandState.subRows === 0) {
    console.log('      ⚠️  categories visible but no transaction sub-rows — retrying expand...');
    await sleep(1500);
    await expandAllCategories(frame);
  }

  const transactions = [];
  const freshCategoryRows = await frame.locator('tr.expandable-row[role="button"]').all();

  for (const catRow of freshCategoryRows) {
    const category = parseCategoryName(await catRow.innerText().catch(() => ''));

    const subTableRows = await catRow.evaluate((el) => {
      const rows = [];
      let sib = el.nextElementSibling;
      while (sib && sib.tagName === 'TR') {
        if (sib.id && sib.id.startsWith('collapsable-row')) {
          const trs = sib.querySelectorAll('tbody tr');
          for (const tr of trs) {
            const cells = [...tr.querySelectorAll('td')].map((td) =>
              (td.innerText || '').replace(/\s+/g, ' ').trim(),
            ).filter(Boolean);
            if (cells.length) rows.push(cells);
          }
          break;
        }
        if (sib.classList.contains('expandable-row')) break;
        sib = sib.nextElementSibling;
      }
      return rows;
    });

    for (const cells of subTableRows) {
      const parsed = parseTransactionRow(cells.map(normalizeText));
      if (!parsed) continue;

      transactions.push({
        type,
        category,
        description: parsed.description,
        date: parsed.date,
        account: parsed.account,
        amount: parsed.amount,
      });
    }
  }

  return transactions;
}

function transactionsToCsv(rows) {
  const headers = ['סוג', 'קטגוריה', 'תיאור', 'תאריך', 'חשבון', 'סכום'];
  const lines = [
    headers.join(','),
    ...rows.map((r) =>
      [r.type, r.category, r.description, r.date, r.account, r.amount]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(','),
    ),
  ];
  return `\uFEFF${lines.join('\n')}`;
}

module.exports = {
  TYPE_INCOME,
  TYPE_EXPENSES,
  formatTransactionDate,
  normalizeAmount,
  expandAllCategories,
  collectMergedTable,
  transactionsToCsv,
};
