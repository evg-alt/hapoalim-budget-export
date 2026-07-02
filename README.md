# Bank Hapoalim budget export

Automate extraction of income and expenses from Bank Hapoalim’s **ניהול תקציב** (Personal Finance / budget management) page into a flat CSV you can analyze in a spreadsheet.

## Why this exists

After you log in to [Bank Hapoalim](https://www.bankhapoalim.co.il/) and open your personal area, the bank shows detailed spending and income from every source — direct debits from your account, each card you use, transfers, and more. The UI is useful for browsing but painful for analysis: categories are nested, months are separate tabs, and copying data by hand does not scale.

![Budget overview on the bank site (sensitive details blurred)](docs/pfm-overview-blurred.png)

This repository uses [Playwright](https://playwright.dev/) to open the real bank page, expand categories, and write a single merged table to `output/`.

## Requirements

- **Node.js** (v18+ recommended)

## Quick start

```bash
git clone <this-repo>
cd hapoalim-parsing
npm install
npm run collect
```

1. A browser window opens on the Hapoalim login page.
2. Log in manually (including OTP if the bank asks).
3. The script waits until you reach **ניהול תקציב** (budget management), then collects data and saves a CSV under `output/`.
4. The browser closes. **No cookies or session files are saved** on disk.

Collect a specific range:

```bash
npm run collect -- 2026/04-2026/06
npm run collect -- 2026/06/01-2026/06/30
npm run collect -- --json 2026/06    # optional JSON alongside CSV
```

## Date ranges

| Argument | Meaning |
|----------|---------|
| *(none)* | Latest month available on the bank’s month tabs |
| `2026/06` | Full June 2026 |
| `2026/04-2026/06` | Full months April–June 2026 |
| `2026/06/01-2026/06/30` | Exact inclusive dates |
| `2026/04/00-2026/06/30` | `00` = start/end of month |

The script loads every bank month tab that overlaps your range (both **הכנסות** income and **הוצאות** expenses), then filters by date when you gave exact days. Months with no tab yet or no data are skipped silently.

## Output format

File: `output/hapoalim_<start>_<end>.csv` (add `--json` for JSON too).

| Column | Description |
|--------|-------------|
| `סוג` | `הכנסות` (income) or `הוצאות` (expenses) |
| `קטגוריה` | Budget category |
| `תיאור` | Transaction description |
| `תאריך` | Date `YYYY/MM/DD` |
| `חשבון` | Account or last digits of card |
| `סכום` | Amount (no `₪`, commas, or spaces) |

Anonymized sample: [`examples/hapoalim_example.csv`](examples/hapoalim_example.csv)

**Do not commit your real `output/` files** — they contain financial data. The `output/` folder is gitignored.

## How it works

See [docs/architecture.md](docs/architecture.md) for the module layout and data flow.

## Security

- Default `npm run collect` uses a **temporary browser session**. Nothing is written to `.browser-profile/`.
- Your credentials and transactions stay on your machine. Review `output/` before sharing anything.

---

## For maintainers

Persistent browser + saved cookies are **only** for debugging selectors. Not recommended for normal use.

```bash
npm run dev:keep-open
npm run collect -- --keeper 2026/06
npm run dev:snapshot
```

Technical notes: [docs/developer-notes.md](docs/developer-notes.md)

## Project layout

```text
scripts/collect.js   Main entry point
lib/                 Collection logic and Playwright helpers
examples/            Anonymized sample CSV (safe to commit)
docs/                Architecture + developer notes
dev/                 Maintainer browser tools (not for end users)
output/              Your exports (gitignored)
```
