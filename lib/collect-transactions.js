const { normalizeText, sleep } = require('./pfm-helpers');

const TYPE_INCOME = 'הכנסות';
const TYPE_EXPENSES = 'הוצאות';

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
  const openAll = frame.getByText('לפתוח הכל', { exact: true });
  if (await openAll.count()) {
    await openAll.first().click();
    await sleep(1500);
  }

  const transactions = [];
  const categoryRows = await frame.locator('tr.expandable-row[role="button"]').all();

  for (const catRow of categoryRows) {
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
  collectMergedTable,
  transactionsToCsv,
};
