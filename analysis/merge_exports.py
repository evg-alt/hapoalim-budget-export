#!/usr/bin/env python3
"""Merge a base Hapoalim CSV with an incremental export (overlap-safe).

Keeps all rows from the base file strictly before --overlap-from, then appends
every row from the incremental file. Rows in the overlap window from the base
file are dropped in favour of the fresh scrape.

Usage:
  python3 analysis/merge_exports.py \\
    output/hapoalim_2024-02-01_2026-07-31.csv \\
    output/hapoalim_2026-06-29_2026-07-28.csv \\
    --overlap-from 2026/06/29 \\
    -o output/hapoalim_merged.csv
"""

from __future__ import annotations

import argparse
import csv
from pathlib import Path

FIELDS = ["סוג", "קטגוריה", "תיאור", "תאריך", "חשבון", "סכום"]


def read_rows(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def write_rows(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS, quoting=csv.QUOTE_ALL)
        writer.writeheader()
        writer.writerows(rows)


def merge(base: list[dict[str, str]], incremental: list[dict[str, str]], overlap_from: str) -> list[dict[str, str]]:
    kept = [r for r in base if r["תאריך"] < overlap_from]
    merged = kept + incremental
    merged.sort(key=lambda r: (r["תאריך"], r["סוג"], r["קטגוריה"], r["תיאור"]))
    return merged


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base_csv", type=Path, help="Older full export")
    parser.add_argument("incremental_csv", type=Path, help="Fresh export (includes overlap)")
    parser.add_argument(
        "--overlap-from",
        required=True,
        help="Drop base rows on/after this date (YYYY/MM/DD); use incremental instead",
    )
    parser.add_argument("-o", "--output", type=Path, required=True)
    args = parser.parse_args()

    base = read_rows(args.base_csv)
    incremental = read_rows(args.incremental_csv)
    merged = merge(base, incremental, args.overlap_from)

    write_rows(args.output, merged)

    print(f"base rows:         {len(base)}")
    print(f"incremental rows:  {len(incremental)}")
    print(f"kept from base:    {len([r for r in base if r['תאריך'] < args.overlap_from])}")
    print(f"merged rows:       {len(merged)}")
    if merged:
        print(f"date range:        {merged[0]['תאריך']} .. {merged[-1]['תאריך']}")
    print(f"wrote:             {args.output}")


if __name__ == "__main__":
    main()
