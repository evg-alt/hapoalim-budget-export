const { HEBREW_MONTHS, parseMonthLabel } = require('./pfm-helpers');

function lastDayOfMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function formatIsoDate(year, month, day) {
  return `${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`;
}

function parseDatePart(str) {
  const parts = str.trim().split('/');
  if (parts.length < 2 || parts.length > 3) {
    throw new Error(`Invalid date part: ${str}`);
  }

  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  if (!year || month < 1 || month > 12) {
    throw new Error(`Invalid year/month: ${str}`);
  }

  if (parts.length === 2) {
    return { year, month, day: null };
  }

  const day = parseInt(parts[2], 10);
  if (Number.isNaN(day) || day < 0 || day > 31) {
    throw new Error(`Invalid day: ${str}`);
  }

  return { year, month, day };
}

function parseCollectRange(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) {
    throw new Error('Empty range');
  }

  if (!trimmed.includes('-')) {
    const part = parseDatePart(trimmed);
    const startDay = 1;
    const endDay = lastDayOfMonth(part.year, part.month);
    return {
      start: formatIsoDate(part.year, part.month, startDay),
      end: formatIsoDate(part.year, part.month, endDay),
      label: trimmed,
      monthOnly: true,
    };
  }

  const [startStr, endStr] = trimmed.split('-');
  const startPart = parseDatePart(startStr);
  const endPart = parseDatePart(endStr);

  const startIsMonthOnly = startStr.split('/').length === 2;
  const endIsMonthOnly = endStr.split('/').length === 2;

  let startDay;
  if (startIsMonthOnly || startPart.day === null || startPart.day === 0) {
    startDay = 1;
  } else {
    startDay = startPart.day;
  }

  let endDay;
  if (endIsMonthOnly || endPart.day === null || endPart.day === 0) {
    endDay = lastDayOfMonth(endPart.year, endPart.month);
  } else {
    endDay = endPart.day;
  }

  const start = formatIsoDate(startPart.year, startPart.month, startDay);
  const end = formatIsoDate(endPart.year, endPart.month, endDay);

  if (start > end) {
    throw new Error(`Range start after end: ${start} > ${end}`);
  }

  const monthOnly = startIsMonthOnly && endIsMonthOnly;

  return { start, end, label: trimmed, monthOnly };
}

function monthLabelToYyyyMm(label) {
  const parsed = parseMonthLabel(label);
  if (!parsed) return null;

  const [hebrew, yy] = parsed.split(' ');
  const month = HEBREW_MONTHS.indexOf(hebrew) + 1;
  if (month < 1) return null;

  const year = 2000 + parseInt(yy, 10);
  return { year, month, label: parsed };
}

function monthLabelSortKey(label) {
  const ym = monthLabelToYyyyMm(label);
  if (!ym) return -1;
  return ym.year * 12 + ym.month;
}

function yyyyMmToMonthLabel(year, month) {
  const hebrew = HEBREW_MONTHS[month - 1];
  const yy = String(year).slice(-2);
  return `${hebrew} ${yy}`;
}

function calendarMonthsBetween(startIso, endIso) {
  const [sy, sm] = startIso.split('/').map((n) => parseInt(n, 10));
  const [ey, em] = endIso.split('/').map((n) => parseInt(n, 10));

  const months = [];
  let y = sy;
  let m = sm;

  while (y < ey || (y === ey && m <= em)) {
    months.push({ year: y, month: m });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }

  return months;
}

function monthTabsForRange(range, availableTabs) {
  const needed = calendarMonthsBetween(range.start, range.end).map(({ year, month }) =>
    yyyyMmToMonthLabel(year, month),
  );

  const available = new Set(availableTabs);
  const tabs = needed.filter((tab) => available.has(tab));
  const missingMonths = needed.filter((tab) => !available.has(tab));

  if (tabs.length === 0) {
    throw new Error(
      `No bank month tabs overlap range ${range.start}–${range.end}. Available: ${availableTabs.join(', ')}`,
    );
  }

  return { tabs, missingMonths };
}

function pickLatestMonthTab(availableTabs) {
  if (!availableTabs.length) {
    throw new Error('No month tabs available on page');
  }

  return availableTabs.reduce((best, tab) =>
    (monthLabelSortKey(tab) > monthLabelSortKey(best) ? tab : best),
  );
}

function defaultRangeFromMonthTab(monthLabel) {
  const ym = monthLabelToYyyyMm(monthLabel);
  if (!ym) throw new Error(`Cannot parse month tab: ${monthLabel}`);

  return parseCollectRange(`${ym.year}/${String(ym.month).padStart(2, '0')}`);
}

function filterRowsByDateRange(rows, range) {
  return rows.filter((row) => row.date >= range.start && row.date <= range.end);
}

function rangeToFilename(range) {
  const safe = (d) => d.replace(/\//g, '-');
  return `hapoalim_${safe(range.start)}_${safe(range.end)}`;
}

module.exports = {
  parseCollectRange,
  monthLabelToYyyyMm,
  monthLabelSortKey,
  yyyyMmToMonthLabel,
  calendarMonthsBetween,
  monthTabsForRange,
  pickLatestMonthTab,
  defaultRangeFromMonthTab,
  filterRowsByDateRange,
  rangeToFilename,
};
