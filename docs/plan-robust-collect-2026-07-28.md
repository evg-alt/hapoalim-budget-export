# Plan: Robust Hapoalim PFM collect

**Status:** planned  
**Created:** 2026-07-28  
**Context:** Incremental export of Bank Hapoalim **ניהול תקציב** via Playwright. After the Jul 2026 scrape session we hit hangs on month-tab switches (especially **הכנסות** after a successful prior month), silent “0 rows”, collapsed categories, and accidental browser restarts. This plan hardens the scraper without pretending the bank UI is a stable API.

**Related:** [architecture.md](architecture.md), [developer-notes.md](developer-notes.md), `.agents/rules/browser-session.md`, `.cursor/rules/browser-session.mdc`

---

## Goal

Make `npm run collect` / CDP diagnostic collect:

1. **Fail loudly and fast** when the UI is not in the expected state (no 60s silent hangs).
2. **Never** open a second browser or close the bank window without explicit user permission.
3. **Assert** each step (month loaded → mode switched → expanded → scraped) with measurable invariants.
4. Keep **incremental overlap + merge** as the default update path.

**Non-goals:** Official Open Banking API, headless unattended cron without a logged-in session, perfect zero-breakage forever.

---

## Reality check (what “good” means here)

This is **UI scraping of a third-party SPA in an iframe**. Best practice for that class of tool is:

- Explicit state machine + postconditions  
- Short timeouts + retries with a clear reason  
- Attach-only session (CDP / keeper)  
- Diagnostics on failure (screenshot + markers)

It is **not** a banking integration best practice (that would be bank export file / API). Treat robustness as “rarely breaks, always explains why,” not “never breaks.”

---

## Current pain points (from 2026-07-28)

| Symptom | Likely cause | Fix bucket |
|---------|--------------|------------|
| Hung on **הכנסות** for July after June worked | Re-calling `waitForBudgetPageReady` (full page/title/heading wait) mid-session | P0 state machine |
| 0 rows while categories visible | `לפתוח הכל` not clicked / exact text match / expand not verified | P0 expand assert |
| Agent opened/killed browser | Ephemeral `launch` + `browser.close` + process kill | P0 session policy (mostly done) |
| Silent empty month | `tryCollectView` catch → `[]` with weak logging | P0 fail visibility |
| July looked empty earlier, later had data | Timing / empty-month race vs real empty | P1 empty vs timeout distinction |

Partial mitigations already landed (2026-07-28): CDP attach (`dev:diagnostic`), expand fallbacks, short mode-switch timeouts, no `waitForBudgetPageReady` inside `tryCollectView`, browser-session rules, merge script.

---

## Target architecture

```text
                    ┌─────────────────────────┐
                    │  Session (CDP attach)   │
                    │  ownsBrowser = false    │
                    └───────────┬─────────────┘
                                │
                    ┌───────────▼─────────────┐
                    │  CollectRange           │
                    │  for each bank month    │
                    └───────────┬─────────────┘
                                │
         ┌──────────────────────┼──────────────────────┐
         ▼                      ▼                      ▼
   selectMonth            collectView(income)    collectView(expenses)
   assert: loaded|empty   assert: mode+table     assert: mode+table
                                │                      │
                                ▼                      ▼
                          expandAll + assert subRows
                                │
                                ▼
                          scrape → rows[]
                                │
                                ▼
                          filter by date → CSV
                                │
                                ▼
                          merge_exports (overlap)
```

Each arrow has a **named state** and a **pass/fail invariant**. No step proceeds on “probably ready.”

---

## Work packages

### P0 — Correctness & hang elimination (do first)

#### P0.1 Explicit month state machine

**File focus:** `lib/collect-session.js`, optionally new `lib/collect-states.js`

States per bank month:

| State | Meaning | Exit condition |
|-------|---------|----------------|
| `SELECTING` | Clicked month tab | Heading/month markers match **or** empty banner |
| `EMPTY` | `אין נתונים להצגה` | Stop month (not an error) |
| `MODE_INCOME` / `MODE_EXPENSES` | Summary card switched | Table ready **or** empty |
| `EXPANDING` | Clicked `לפתוח הכל` / per-row expand | `collapsed==0` and (`subRows>0` **or** categories==0) |
| `SCRAPED` | Rows parsed | Row count logged |
| `FAILED` | Timeout / invariant | Error with state name + last markers |

**Done when:** No path calls full-page `waitForBudgetPageReady` after the initial attach; month collect never waits > ~12–15s without logging a state transition.

#### P0.2 Expand invariant (hard fail)

**File focus:** `lib/collect-transactions.js`

After expand:

- If `categoryCount > 0` and `subRows == 0` → **retry once**, then **throw** (do not return `[]`).
- Prefer regex `/לפתוח הכל/` + role/button locator; keep DOM `evaluate` click as fallback.
- Log: `categories`, `collapsed`, `subRows`, `closeAllVisible`.

**Done when:** Collapsed table cannot produce a “successful” 0-row collect for a non-empty month.

#### P0.3 Stop silent swallows

**File focus:** `lib/collect-session.js` `tryCollectView`

- Distinguish: `empty` vs `timeout` vs `expand_failed` vs `parse_failed`.
- Only return `[]` for true empty.
- For failures: log + optional screenshot under `explore/`, bubble or mark month `FAILED`.

**Done when:** A hang or missed expand cannot look like “bank has no data.”

#### P0.4 Session policy enforced in code (finish)

**File focus:** `lib/browser-launch.js`, `scripts/collect.js`, `dev/diagnostic-collect.js`

Already partially done. Finish:

- Default collect path: **attach CDP** (`HAPOALIM_CDP_URL` or `:9222` or keeper `:9333`).
- `--launch` only when user explicitly asks for a new window.
- Never `browser.close()` on attach sessions; `--force-close` only when `ownsBrowser`.
- Document one canonical flow in README “For agents” / developer-notes.

**Done when:** Bare `npm run collect` without CDP fails with a clear “start keeper / use agent Chrome” message instead of spawning Chromium by accident.

---

### P1 — Operability

#### P1.1 Step logger

Structured console lines:

```text
[יולי 26] SELECTING → MODE_INCOME → EXPANDING (cats=2 sub=3) → SCRAPED n=3
```

Optional `--json-log` line stream for agents.

#### P1.2 Failure artifacts

On `FAILED`: write `explore/fail-<timestamp>.{png,json}` with URL, month label, mode, markers (`openAll`, `collapsed`, `empty`).

#### P1.3 Empty vs slow load

- Cap empty detection; if neither empty nor table within timeout → `FAILED` (not `EMPTY`).
- Document that current calendar month may lag card postings (overlap collect remains recommended).

#### P1.4 First-class incremental workflow

Document + maybe thin wrapper:

```bash
npm run collect -- 2026/06/29-2026/07/28 --keeper --json
python3 analysis/merge_exports.py output/<base>.csv output/<new>.csv \
  --overlap-from 2026/06/29 -o output/hapoalim_merged.csv
```

Optional: `npm run collect:update -- --overlap-from YYYY/MM/DD` that picks latest base CSV and merges.

#### P1.5 Wire `dev:diagnostic` into normal path

Either make `collect --keeper` use the same attach logic as diagnostic (`:9222` first), or document diagnostic as the agent-preferred entrypoint.

---

### P2 — Regression safety

#### P2.1 Smoke probes (manual / semi-auto)

Keep `dev/probe-*.js`; add `dev/probe-expand.js` that:

1. Attaches CDP  
2. Expands current view  
3. Exits non-zero if categories>0 and subRows==0  

Run before full multi-month collect when UI feels flaky.

#### P2.2 Fixture-based unit tests (no live bank)

- Pure functions: date-range parse/filter, CSV merge/dedupe, amount/date normalize.
- Optional: frozen HTML fixtures of expanded/collapsed tables if we can capture anonymized snippets.

#### P2.3 Changelog discipline

Update [developer-notes.md](developer-notes.md) Changelog whenever a selector or wait strategy changes (already the living doc).

---

### P3 — Later / optional

- Persistent keeper as the only human login path; agents never see login page.
- Deduplicate identical rows within a single scrape (bank sometimes lists duplicates).
- Balance chart (`analysis/plot_balance.py`) smoke after merge.
- Evaluate whether bank offers any downloadable statement that reduces scrape surface (unlikely for PFM categories).

---

## Suggested implementation order

1. **P0.2 + P0.3** — expand assert + no silent empty (highest user pain).  
2. **P0.1** — strip remaining full-page waits from mid-collect.  
3. **P0.4** — lock attach-only defaults.  
4. **P1.1 + P1.2** — observability.  
5. **P1.4** — polish incremental UX.  
6. **P2.*** — probes/tests as time allows.

Each step should be a **small PR / commit** that can be verified with one CDP collect of a two-month range (e.g. last month + current).

---

## Verification checklist (definition of done for the plan)

- [ ] Two-month collect (`יוני` + `יולי`) via existing CDP tab completes without hangs >15s on any step.  
- [ ] Collapsed categories → hard fail or successful expand (never silent 0).  
- [ ] True empty month → logged `EMPTY`, not `FAILED`.  
- [ ] No second Chromium window; bank tab remains open after collect.  
- [ ] Overlap merge produces monotonic date range and documented row counts.  
- [ ] Agent rules (browser-session) match actual CLI defaults.  
- [ ] developer-notes Changelog updated.

---

## Risks & constraints

- Bank front-end changes can break selectors overnight — fixtures and probes mitigate detection, not breakage.  
- Session/OTP stays manual; unattended cron is out of scope.  
- Do not commit real `output/*.csv` or `.browser-profile`.  
- Agents must not kill/restart the CDP browser without user permission (project rule).

---

## Out of scope (explicit)

- Replacing Playwright with Browser MCP for this task.  
- Storing credentials in the repo.  
- Full rewrite in Python (Node + Playwright is fine; merge/plot stay Python).
