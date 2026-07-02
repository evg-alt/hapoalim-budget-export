#!/usr/bin/env python3
"""Plot daily balance by year from Hapoalim PFM CSV exports."""

from __future__ import annotations

import argparse
from pathlib import Path

import matplotlib.dates as mdates
import matplotlib.pyplot as plt
import pandas as pd

TYPE_INCOME = "הכנסות"
TYPE_EXPENSES = "הוצאות"
COLOR = "#e8a020"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Plot daily bank balance by year from a Hapoalim PFM CSV export."
    )
    parser.add_argument(
        "csv",
        nargs="?",
        type=Path,
        help="Path to hapoalim_*.csv (default: newest file in output/)",
    )
    parser.add_argument(
        "--account",
        help="Optional: filter to a single account/card (default: all transactions)",
    )
    balance_group = parser.add_mutually_exclusive_group()
    balance_group.add_argument(
        "--initial-balance",
        type=float,
        help="Balance on the day before the first transaction",
    )
    balance_group.add_argument(
        "--final-balance",
        type=float,
        help="Balance on the last day in the data (initial balance is derived)",
    )
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=Path("output/balance_by_year.png"),
        help="Output image path (default: output/balance_by_year.png)",
    )
    parser.add_argument(
        "--show",
        action="store_true",
        help="Open the plot window after saving",
    )
    return parser.parse_args()


def resolve_csv(path: Path | None) -> Path:
    if path is not None:
        if not path.exists():
            raise FileNotFoundError(f"CSV not found: {path}")
        return path

    output_dir = Path("output")
    candidates = sorted(output_dir.glob("hapoalim_*.csv"), key=lambda p: p.stat().st_mtime)
    if not candidates:
        raise FileNotFoundError("No hapoalim_*.csv found in output/. Run npm run collect first.")
    return candidates[-1]


def load_transactions(csv_path: Path, account: str | None) -> pd.DataFrame:
    df = pd.read_csv(csv_path, encoding="utf-8-sig")
    required = {"סוג", "תאריך", "סכום", "חשבון"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"CSV is missing columns: {', '.join(sorted(missing))}")

    df["תאריך"] = pd.to_datetime(df["תאריך"], format="%Y/%m/%d", errors="coerce")
    df["סכום"] = pd.to_numeric(df["סכום"], errors="coerce")
    df = df.dropna(subset=["תאריך", "סכום"])
    df = df[df["סוג"].isin([TYPE_INCOME, TYPE_EXPENSES])]

    if account is not None:
        df = df[df["חשבון"] == account]

    if df.empty:
        label = "all accounts" if account is None else f"account {account}"
        raise ValueError(f"No transactions found for {label}")

    df["signed_amount"] = df.apply(
        lambda row: row["סכום"] if row["סוג"] == TYPE_INCOME else -abs(row["סכום"]),
        axis=1,
    )
    return df.sort_values("תאריך")


def build_daily_net(df: pd.DataFrame) -> pd.Series:
    daily_net = (
        df.groupby(df["תאריך"].dt.normalize())["signed_amount"]
        .sum()
        .sort_index()
    )

    start = daily_net.index.min()
    end = daily_net.index.max()
    full_range = pd.date_range(start, end, freq="D")
    return daily_net.reindex(full_range, fill_value=0.0)


def resolve_initial_balance(
    daily_net: pd.Series,
    initial_balance: float | None,
    final_balance: float | None,
) -> float:
    if initial_balance is not None:
        return initial_balance
    if final_balance is not None:
        return final_balance - daily_net.cumsum().iloc[-1]
    return 0.0


def build_daily_balance(daily_net: pd.Series, initial_balance: float) -> pd.DataFrame:
    balance = initial_balance + daily_net.cumsum()
    daily = pd.DataFrame({"balance": balance})
    daily["year"] = daily.index.year
    return daily


def plot_balance_by_year(daily: pd.DataFrame, output: Path, title_suffix: str) -> None:
    years = sorted(daily["year"].unique())
    fig, axes = plt.subplots(
        nrows=len(years),
        ncols=1,
        figsize=(14, 4 * len(years)),
        sharex=False,
    )
    if len(years) == 1:
        axes = [axes]

    for ax, year in zip(axes, years):
        year_data = daily[daily["year"] == year]

        ax.plot(year_data.index, year_data["balance"], color=COLOR, linewidth=1.8)
        ax.fill_between(year_data.index, year_data["balance"], color=COLOR, alpha=0.35)

        ax.set_ylabel("Balance (NIS)")
        ax.grid(True, linestyle="--", alpha=0.5)
        ax.text(
            0.02,
            0.88,
            str(year),
            transform=ax.transAxes,
            fontsize=28,
            alpha=0.8,
            color="#444444",
        )

        ax.xaxis.set_major_locator(mdates.MonthLocator())
        ax.xaxis.set_major_formatter(mdates.DateFormatter("%b"))
        ax.set_xlim(
            pd.Timestamp(year=year, month=1, day=1),
            pd.Timestamp(year=year, month=12, day=31),
        )

    axes[-1].set_xlabel("Month")
    fig.suptitle(f"Daily balance{title_suffix}", fontsize=14, y=1.01)
    fig.tight_layout()

    output.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output, dpi=200, bbox_inches="tight")
    print(f"Saved {output}")


def main() -> None:
    args = parse_args()
    csv_path = resolve_csv(args.csv)

    df = load_transactions(csv_path, args.account)
    daily_net = build_daily_net(df)
    initial_balance = resolve_initial_balance(
        daily_net,
        args.initial_balance,
        args.final_balance,
    )
    daily = build_daily_balance(daily_net, initial_balance)

    title_suffix = f" ({args.account})" if args.account else ""

    plot_balance_by_year(daily, args.output, title_suffix)

    start = daily.index.min().date()
    end = daily.index.max().date()
    print(f"Source: {csv_path}")
    print(f"Transactions: {len(df)} | Days: {len(daily)} | Range: {start} → {end}")
    if args.final_balance is not None:
        print(
            f"Anchored to final balance {args.final_balance:,.2f} on {end} "
            f"(derived initial balance: {initial_balance:,.2f})"
        )
    elif args.initial_balance is None:
        print(
            "Note: no balance anchor set, so Y values are relative. "
            "Pass --initial-balance or --final-balance for real balances."
        )
    else:
        print(f"Initial balance: {initial_balance:,.2f}")

    if args.show:
        plt.show()


if __name__ == "__main__":
    main()
