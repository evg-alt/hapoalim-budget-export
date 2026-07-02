# Hapoalim PFM parsing — best practices

**Living document.** Update this file as we discover what works (and what stopped working) while parsing the Bank Hapoalim budget page.

**Last updated:** 2026-07-02  
**Target URL:** `https://login.bankhapoalim.co.il/ng-portals/rb/he/pfm`  
**Code:** `lib/`, `scripts/collect.js`, `dev/`

---

## How to use this file

- **Maintainers:** read this before changing scraper logic or selectors.
- **After each discovery session:** append to [Changelog](#changelog) and adjust sections below.
- **When a practice fails:** move it to [Deprecated / replaced](#deprecated--replaced) with the reason and the replacement.
- **Do not** duplicate long prose elsewhere — link here instead.

---

## Page architecture

The UI has two layers:

| Layer | Where | What lives there |
|-------|--------|------------------|
| **Outer shell** | Top-level `page` | Bank nav, search, `document.title`, menu item **ניהול תקציב** |
| **Budget app** | `page.locator('main iframe').first()` | Month tabs, summary cards, category table, transaction sub-tables |

**Practice:** almost all scraping happens **inside the iframe**. Outer shell is only for navigation to the budget section.

```javascript
const iframe = page.locator('main iframe').first();
const handle = await iframe.elementHandle();
const frame = await handle.contentFrame();
```

**Custom element:** budget table area uses `pfm-table-display` (useful as a loose “content exists” signal, not as sole readiness check).

---

## Browser & session

### Persistent profile (recommended)

Use `chromium.launchPersistentContext('.browser-profile', …)` so login + OTP survive between runs.

- **Do** reuse the same profile directory for `dev/keep-open.js` and `--keeper` collect runs.
- **Do not** run `dev:keep-open` and `collect --keeper` against a conflicting second profile — Chromium locks the profile.

### Playwright install

Playwright is a **local devDependency** (`npm install`). Chromium is installed via `postinstall`.

### Credentials

- **Never** hardcode or commit user code, password, or OTP.
- Login is manual on first run (or when session expires).
- `.browser-profile/` and `explore/` stay gitignored.

---

## Live exploration workflow (recommended while developing)

1. `npm run dev:keep-open` — headed browser stays open; CDP on `http://127.0.0.1:9333`
2. User navigates / logs in as needed
3. `npm run dev:snapshot` — writes `explore/latest.json` + `explore/latest.png` without closing the browser
4. `npm run switch-mode -- income|expenses` — toggle summary cards

**Practice:** prefer snapshot + probe scripts over guessing selectors from recordings alone.

---

## Page readiness — what to wait for

### ❌ Not sufficient

| Signal | Why it fails |
|--------|----------------|
| URL contains `/pfm` | SPA route can load before iframe content |
| Fixed `sleep(3000)` | Racey; too short after login, wasteful when fast |
| Any `button` in iframe | Month tabs and categories load at different times |
| `locator('button')` only | Summary cards are `div[role="button"]`, not `<button>` |

### ✅ Reliable sequence (expenses view)

Verified on live page 2026-07-02:

1. `page.waitForURL(url => url.href.includes('/pfm'))`
2. `document.title` includes **ניהול תקציב**
3. Iframe attached + `contentFrame()` available
4. Iframe heading: `/ניהול תקציב/`
5. Iframe heading: `/על מה הוצאתי בחודש/` (month/year vary — use regex)
6. Iframe text (exact): **סה"כ הוצאות בש"ח** (table footer — strong signal)
7. Iframe text (exact): **לפתוח הכל**
8. Column header (exact): **קטגוריה**

Implemented as `waitForBudgetPageReady(page, { view: 'expenses' })` in `pfm-helpers.js`.

### ✅ Income view (after switching mode)

1. Click income summary card (see [Mode switching](#mode-switching))
2. Iframe heading: `/ההכנסות שלי בחודש/`
3. Iframe text (exact): **סה"כ הכנסות בש"ח**

### Outer shell navigation

If URL is `/pfm` but iframe is empty or wrong view, click **ניהול תקציב** in the outer shell:

```javascript
page.getByRole('menuitem', { name: 'ניהול תקציב' })
// fallback: page.getByText('ניהול תקציב', { exact: true })
```

---

## Mode switching (expenses ↔ income)

Three summary cards in `.pfm-budget-overview`:

| Card | Label | CSS hint |
|------|-------|----------|
| Income | **ההכנסות שלי** | `.informer-budget.incomes` |
| Expenses | **ההוצאות שלי** | `.informer-budget` (expenses variant) |
| Bottom line | **השורה התחתונה** | not needed for scraping |

### ✅ Works

```javascript
frame.getByRole('button', { name: /ההכנסות שלי/ }).first().click()
frame.getByRole('button', { name: /ההוצאות שלי/ }).first().click()
```

`getByRole('button')` matches `div[role="button"]`.

### ❌ Does not work

```javascript
frame.locator('button').filter({ hasText: 'ההכנסות שלי' })  // misses role=button divs
```

**Note:** accessible name / `innerText` on cards is messy, e.g. `12,345 .67ההכנסות שלי ₪` — match on label substring via regex, not exact full text.

Use `switchBudgetMode(page, 'income' | 'expenses')` in `pfm-helpers.js`.

---

## Month navigation

### Tab labels

Format: `{Hebrew month} {2-digit year}` — e.g. **יוני 26**, **מאי 25**.

- Use explicit Hebrew month list (`HEBREW_MONTHS` in `pfm-helpers.js`), not generic `\S+` regex.
- Normalize whitespace: NBSP and narrow spaces appear in DOM → `normalizeText()`.

### Clicking a month

Implemented in `clickMonthTab()` (`pfm-helpers.js`):

1. **Scroll** off-screen tabs into range via `ensureMonthTabVisible()` (arrow buttons on `.month-upper-selector`).
2. **Plan A (preferred):** DOM `el.click()` inside `frame.evaluate()` — works even when the tab is outside the viewport.
3. **Plan B (fallback):** Playwright locator after scroll:

```javascript
frame.getByRole('button', { name: new RegExp(`^${monthName}\\s+${yearSuffix}$`) }).click()
```

### Scrolling the month bar

1. **Plan A:** `div.arrow.arrow-right` (older) / `div.arrow-left` (newer).
2. **Plan B:** month-strip class arrows, then codegen-style `getByRole('button').nth(1)` / `nth(0)` (right / left).

`scrollLeft` on the container does **not** work on this UI.

### Empty months

Some tabs (often oldest/newest in range) show **אין נתונים להצגה** instead of income/expense cards and the category table. Treat as empty immediately — do not wait for mode buttons or `לפתוח הכל`.

`isMonthEmpty()` / `waitForMonthLoaded()` in `pfm-helpers.js`; `collectBankMonth()` skips further collection for that tab.

### Discovery

Collect month tabs from iframe (`[role="button"]` on `<li>` elements in `monthList`). All tabs are present in the DOM (~25); the month bar scrolls horizontally so only a subset is in the viewport at once.

- **Scroll** the month list container (or arrow buttons on the strip) before **clicking** off-screen tabs when using Plan B — Playwright cannot click tabs outside the viewport.
- **Online retention:** the bank shows about **two years** of months online; older history is not in the UI (request from branch/phone). Example: range `2024/02` may start at **יולי 24** on the tab bar, not February 2024.

---

## Expanding categories

### ✅ Preferred: expand all at once

```javascript
await frame.getByText('לפתוח הכל', { exact: true }).click()
```

Wait ~1–1.5s for sub-tables to render.

### Category row selector (verified 2026-07-02, income view)

Category rows are **`<tr role="button" class="expandable-row collapse-toggle">`**, not `<button>`.

```javascript
await frame.locator('tr.expandable-row[role="button"]').first().click()
// aria-expanded becomes "true"; sub-table appears below
```

After expand, a **nested sub-table** appears with transaction columns.

**Income sub-table columns:** `ההכנסה` · `מתי` · `החשבון/הכרטיס` · `מה תרצה לעשות?` · `סכום`  
**Expenses sub-table columns:** `על מה הוצאתי` · `מתי` · `איך שילמתי` · `מה תרצה לעשות?` · `סכום`

Example income row after expanding **משכורת/קצבה** (June 2026):

| ההכנסה | מתי | החשבון/הכרטיס | סכום |
|--------|-----|---------------|------|
| משכורת-נט | 2026/06/14 | 123-456789 | 10,000.00 ₪ |

Example rows after expanding **הכנסות אחרות** (June 2026):

| ההכנסה | מתי | החשבון/הכרטיס | סכום |
|--------|-----|---------------|------|
| ביטוח לאומי | 2026/06/02 | 123-456789 | 500.00 ₪ |
| העברה מחשבון חיסכון | 2026/06/11 | 123-456789 | 500.00 ₪ |

Skip sub-table footer row `סה"כ {category name}`.

### Fallback: per-category

Category rows are buttons with `aria-expanded="false"` when collapsed. Text looks like:

`בריאות 8,580.62 ₪ 31.29%`

Loop until no collapsed buttons remain (cap iterations to avoid infinite loop).

### Special case: שונות

May include badge text: `שונות 29 הוצאות מחכות לסידור …` — still one expandable category; match with regex / partial text, not exact label.

---

## Scraping transaction rows

### Table structure

1. **Category table** — columns: קטגוריה, סך הכל בקטגוריה, % of total
2. **Sub-table per category** (after expand) — columns differ slightly for income vs expenses:
   - Expenses: על מה הוצאתי, מתי, איך שילמתי, …, סכום
   - Income: הכנסה, מתי, החשבון/הכרטיס, …, סכום

### Row collection (current approach)

```javascript
const rows = await frame.$$('tbody tr')
// read td innerText per row
```

### Skip these rows

- Footer / totals containing **סה"כ**
- Empty rows
- Category header rows (usually fewer cells or no transaction-like data)

**Status:** column → field mapping not fully validated end-to-end

---

## Text & encoding quirks

- Headings may contain invisible Unicode (e.g. LTR mark before year in `על מה הוצאתי בחודש יוני ‎2026`) — prefer regex headings over exact string equality.
- Amounts use Hebrew formatting: `18,765.43 ₪`, sometimes with odd spacing in button labels.
- Quote glyph in **סה"כ** is ASCII double quote `"`, not Hebrew gershayim `״` — use the form verified in live probe.

---

## Verification checklist

Before claiming “page is ready to scrape”:

- [ ] URL is `/pfm`
- [ ] Correct mode heading visible (expenses or income)
- [ ] Correct footer total visible (`סה"כ הוצאות בש"ח` or `סה"כ הכנסות בש"ח`)
- [ ] `לפתוח הכל` visible
- [ ] At least one month tab parseable
- [ ] Category table has header **קטגוריה**

Quick manual check: `npm run dev:snapshot` and inspect `explore/latest.json`.

---

## Deprecated / replaced

| Old approach | Problem | Replacement |
|--------------|---------|-------------|
| Wait only for `/pfm` URL | Iframe empty | `waitForBudgetPageReady()` |
| `frame.locator('button')` for mode switch | Misses `div[role="button"]` | `getByRole('button', { name: /…/ })` |
| `button[aria-expanded="false"]` for categories | Categories are `<tr role="button">` | `tr.expandable-row[role="button"]` |
| `/^\S+\s+\d{2}$/` for month tabs | Failed on Hebrew / spacing | `HEBREW_MONTHS` + `parseMonthLabel()` |
| `npm install playwright` locally | Fragile global `NODE_PATH` setup | `playwright` in `devDependencies` + `npm install` |
| Browser MCP for this task | User wants Playwright only | `npm run dev:keep-open` + `npm run dev:snapshot` |
| Playwright `.click()` on off-screen month tab | Outside viewport error | DOM `evaluate` click (Plan A) + arrow scroll |
| `collect --keeper` reloads page | Kicks session to login | `reload: !useKeeper` in `scripts/collect.js` |

---

## Changelog

| Date | Change |
|------|--------|
| 2026-07-02 | Initial document from first exploration session: iframe architecture, readiness markers, mode switch, month tabs, expand-all, session profile, CDP snapshot workflow |
| 2026-07-02 | Category rows are `tr.expandable-row[role="button"]`; income sub-table columns verified on משכורת/קצבה |
| 2026-07-02 | `npm run collect` — date-range CLI; collect overlapping bank months, filter by `תאריך`; output `סכום` without `₪`/commas |
| 2026-07-02 | Month bar scroll + DOM tab click; empty-month fast path (`אין נתונים להצגה`); `--keeper` no reload; ~2-year online history documented |

---

## Date-range collection (`npm run collect`)

Collect full bank months that overlap the requested range, then filter rows by `תאריך` (`YYYY/MM/DD`) for day-precise ranges. Month-only ranges (`2026/04-2026/06`) include all rows from collected months. Missing bank tabs or months with no data yet are skipped silently (often because online history is capped at ~2 years).

| CLI argument | Meaning |
|--------------|---------|
| *(none)* | Latest available bank month tab, full month |
| `2026/06` | Full June 2026 |
| `2026/04-2026/06` | Full months April–June 2026 |
| `2026/06/01-2026/06/30` | Exact inclusive dates |

Implementation: `lib/date-range.js` (parse), `lib/collect-session.js` (multi-tab pipeline), `scripts/collect.js` (CLI).

Output files: `output/hapoalim_{start}_{end}.csv` / `.json`.

## Related files

- `lib/pfm-helpers.js` — canonical implementations
- `scripts/collect.js` — main data extraction
- `dev/` — live browser tools for maintainers (`probe-month-tabs.js`, `probe-month-scroll.js`, `probe-select-month.js` for month-bar debugging)
