#!/usr/bin/env python3
"""Generate reproducible figures for the trader and replication reports."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import matplotlib.dates as mdates
import matplotlib.pyplot as plt
from matplotlib.colors import TwoSlopeNorm
import numpy as np
import pandas as pd

from edge_analysis import (
    CORE_DISCIPLINES,
    EXCLUDED_MARKET_TYPES,
    base_universe,
    prepare_bets,
)


INK = "#172026"
MUTED = "#68747D"
GRID = "#D9DEE2"
NEGATIVE = "#C54A3D"
POSITIVE = "#087E8B"
ACCENT = "#E5A323"
SECONDARY = "#4979A5"
LIGHT = "#F4F6F7"
DISPLAY_LAGS = (0, 1, 2, 5, 10, 15, 30, 60, 120, 300)
DISPLAY_COSTS = (0, 0.5, 1, 2, 3, 5, 7.5, 10, 20, 30)
SERIES_COLORS = (POSITIVE, SECONDARY, ACCENT, NEGATIVE, "#6E5A8A", "#657A54", INK)


def configure_style() -> None:
    plt.rcParams.update({
        "figure.facecolor": "white",
        "axes.facecolor": "white",
        "axes.edgecolor": GRID,
        "axes.labelcolor": INK,
        "axes.titlecolor": INK,
        "axes.titlesize": 16,
        "axes.titleweight": "bold",
        "font.family": "DejaVu Sans",
        "font.size": 11,
        "text.color": INK,
        "xtick.color": MUTED,
        "ytick.color": MUTED,
        "grid.color": GRID,
        "grid.linewidth": 0.8,
        "legend.frameon": False,
        "savefig.facecolor": "white",
        "svg.hashsalt": "polymarket-trader-research",
    })


def save_figure(fig: plt.Figure, output_dir: Path, name: str) -> list[str]:
    output_dir.mkdir(parents=True, exist_ok=True)
    files = []
    for extension in ("png", "svg"):
        path = output_dir / f"{name}.{extension}"
        metadata = {"Software": "polymarket-trader-research"} if extension == "png" else {"Date": None}
        fig.savefig(
            path,
            dpi=190 if extension == "png" else None,
            bbox_inches="tight",
            metadata=metadata,
        )
        files.append(str(path))
    plt.close(fig)
    return files


def annotate_bars(axis, bars, values, suffix="%") -> None:
    for bar, value in zip(bars, values):
        offset = 0.7 if value >= 0 else -0.7
        alignment = "left" if value >= 0 else "right"
        axis.text(
            value + offset,
            bar.get_y() + bar.get_height() / 2,
            f"{value:+.1f}{suffix}",
            va="center",
            ha=alignment,
            color=INK,
            fontsize=10,
            fontweight="bold",
        )


def combined_held_out_roi(row: dict) -> float:
    profit = row["validation"]["profitUsdc"] + row["finalTest"]["profitUsdc"]
    stake = row["validation"]["stakeUsdc"] + row["finalTest"]["stakeUsdc"]
    return profit / stake * 100


def blind_copy_funnel(edge: dict, output_dir: Path) -> list[str]:
    step_order = [
        ("allCanonicalSignals", "Blind copy"),
        ("rapidBurst", "+ rapid burst"),
        ("rapidBurstAndFormatGuard", "+ format guard"),
        ("rapidBurstFormatAndCoreDisciplines", "+ core disciplines*"),
        ("fullRuleWithPriceGuard", "+ price guard*"),
    ]
    steps = edge["universeSensitivity"]["steps"]
    labels = [label for _, label in step_order]
    all_values = [steps[key]["all"]["roiPct"] for key, _ in step_order]
    later_values = [steps[key]["afterFixedSplit"]["roiPct"] for key, _ in step_order]
    all_counts = [steps[key]["all"]["bets"] for key, _ in step_order]
    later_counts = [steps[key]["afterFixedSplit"]["bets"] for key, _ in step_order]

    fig, axis = plt.subplots(figsize=(12, 7.2))
    positions = np.arange(len(labels))
    height = 0.34
    bars_all = axis.barh(
        positions + height / 2, all_values, height,
        color=SECONDARY, alpha=0.92, label="All history"
    )
    bars_later = axis.barh(
        positions - height / 2, later_values, height,
        color=ACCENT, alpha=0.78, label="After fixed split"
    )
    annotate_bars(axis, bars_all, all_values)
    annotate_bars(axis, bars_later, later_values)
    axis.axvline(0, color=INK, linewidth=1.1)
    axis.set_yticks(positions, [
        f"{label}\n{all_counts[index]} all / {later_counts[index]} later bets"
        for index, label in enumerate(labels)
    ])
    axis.invert_yaxis()
    axis.set_xlim(-12, 50)
    axis.set_xlabel("Equal-stake ROI after 60s lag, 5c stress, and fees")
    axis.set_title("Blind copying loses; urgency is the first filter that flips the sign", loc="left")
    axis.grid(axis="x")
    axis.spines[["top", "right", "left"]].set_visible(False)
    axis.legend(loc="lower right")
    fig.text(
        0.01, 0.01,
        "* Discipline and price guards were informed by this sample. Rows are nested attribution, not independent trials.",
        color=MUTED, fontsize=9
    )
    return save_figure(fig, output_dir, "blind_copy_funnel")


def urgency_calibration(edge: dict, output_dir: Path) -> list[str]:
    calibration = edge["mechanismAudit"]["calibration"]
    groups = [
        ("All rapid", calibration["burst60"]),
        ("All slow", calibration["slower"]),
        ("Earlier rapid", calibration["earlier"]["burst60"]),
        ("Earlier slow", calibration["earlier"]["slower"]),
        ("Later rapid", calibration["later"]["burst60"]),
        ("Later slow", calibration["later"]["slower"]),
    ]
    labels = [f"{name}\nn={row['bets']}" for name, row in groups]
    implied = [row["meanImpliedProbabilityPct"] for _, row in groups]
    actual = [row["actualWinRatePct"] for _, row in groups]
    gaps = [row["calibrationGapPctPoints"] for _, row in groups]

    fig, axis = plt.subplots(figsize=(13, 7.2))
    positions = np.arange(len(groups))
    width = 0.35
    axis.bar(positions - width / 2, implied, width, color=SECONDARY, label="Execution-proxy implied")
    axis.bar(positions + width / 2, actual, width, color=POSITIVE, label="Realized win rate")
    for index, gap in enumerate(gaps):
        axis.text(
            index, max(implied[index], actual[index]) + 2.2,
            f"gap {gap:+.1f} pp", ha="center", va="bottom",
            fontsize=9.5, color=INK, fontweight="bold"
        )
    axis.set_xticks(positions, labels)
    axis.set_ylim(0, 96)
    axis.set_ylabel("Probability / realized win rate")
    axis.set_title("Urgent signals beat the public probability proxy; slow signals do not", loc="left")
    axis.grid(axis="y")
    axis.spines[["top", "right", "left"]].set_visible(False)
    axis.legend(loc="upper left", ncols=2)
    fig.text(
        0.01, 0.01,
        "Implied probability uses the forced execution proxy before slippage and fees. Three no-print events retain trigger-price fallbacks.",
        color=MUTED, fontsize=9
    )
    return save_figure(fig, output_dir, "urgency_calibration")


def prepare_universe(features: pd.DataFrame, mask: pd.Series) -> pd.DataFrame:
    rows = features[mask].sort_values("signalTimestamp").drop_duplicates(
        "eventKey", keep="first"
    ).reset_index(drop=True)
    return prepare_bets(rows, 60, 5).sort_values("signalTimestamp")


def strategy_equity(features: pd.DataFrame, output_dir: Path) -> list[str]:
    concentrated = features["concentration"] >= 0.70
    burst = features["takerBurst60Share"] >= 0.80
    format_guard = ~features["marketType"].isin(EXCLUDED_MARKET_TYPES)
    core = features["discipline"].isin(CORE_DISCIPLINES)
    price = features["triggerPrice"].between(0.30, 0.85)
    definitions = [
        ("Blind copy", concentrated, NEGATIVE),
        ("Rapid + format", concentrated & burst & format_guard, SECONDARY),
        ("Rapid + format + core + price*", concentrated & burst & format_guard & core & price, POSITIVE),
    ]

    fig, axis = plt.subplots(figsize=(13, 7.2))
    for label, mask, color in definitions:
        bets = prepare_universe(features, mask)
        dates = pd.to_datetime(bets["signalTime"], utc=True)
        equity = bets["profitUsdc"].cumsum()
        axis.step(dates, equity, where="post", color=color, linewidth=2.2, label=f"{label} ({len(bets)} bets)")
        axis.scatter(dates.iloc[-1], equity.iloc[-1], color=color, s=35, zorder=3)
        axis.annotate(
            f"${equity.iloc[-1]:+,.0f}",
            (dates.iloc[-1], equity.iloc[-1]), xytext=(8, 0),
            textcoords="offset points", va="center", color=color,
            fontsize=10, fontweight="bold"
        )
    axis.axhline(0, color=INK, linewidth=1.0)
    axis.set_ylabel("Cumulative paper P&L ($100 per eligible signal)")
    axis.set_title("Chronological equity: indiscriminate copying remains underwater", loc="left")
    axis.grid(axis="y")
    axis.spines[["top", "right", "left"]].set_visible(False)
    axis.xaxis.set_major_locator(mdates.WeekdayLocator(interval=2))
    axis.xaxis.set_major_formatter(mdates.DateFormatter("%b %d"))
    axis.legend(loc="upper left")
    fig.autofmt_xdate(rotation=0, ha="center")
    fig.text(
        0.01, 0.01,
        "* Core-discipline and price filters are exploratory. Curves use each rule's own chronological event set.",
        color=MUTED, fontsize=9
    )
    return save_figure(fig, output_dir, "strategy_equity")


def execution_sensitivity(edge: dict, output_dir: Path) -> list[str]:
    scenarios = sorted(
        [row for row in edge["executionSensitivity"] if row["lagSeconds"] == 60],
        key=lambda row: row["slippageCents"]
    )
    slippage = [row["slippageCents"] for row in scenarios]
    series = [
        ("All history", [row["all"]["roiPct"] for row in scenarios], POSITIVE),
        ("Earlier 70%", [row["train"]["roiPct"] for row in scenarios], SECONDARY),
        ("Final 30%", [row["test"]["roiPct"] for row in scenarios], ACCENT),
    ]
    fig, axis = plt.subplots(figsize=(11.5, 6.8))
    for label, values, color in series:
        axis.plot(slippage, values, marker="o", linewidth=2.2, markersize=6, color=color, label=label)
        for x_value, y_value in zip(slippage, values):
            if x_value not in {0, 5, 10, 20, 30}:
                continue
            axis.text(x_value, y_value + (1.4 if y_value >= 0 else -2.2), f"{y_value:+.1f}%", ha="center", color=color, fontsize=9)
    axis.axhline(0, color=INK, linewidth=1.0)
    shown_ticks = [0, 1, 2, 3, 5, 7.5, 10, 15, 20, 30]
    axis.set_xticks(shown_ticks, [f"{value:g}c" for value in shown_ticks])
    axis.set_xlabel("Adverse execution stress after the 60-second lag")
    axis.set_ylabel("Equal-stake ROI")
    axis.set_title("Execution cost can consume the aggregate edge", loc="left")
    axis.grid(axis="y")
    axis.spines[["top", "right", "left"]].set_visible(False)
    axis.legend(loc="upper right")
    return save_figure(fig, output_dir, "execution_sensitivity")


def burst_threshold_sensitivity(edge: dict, output_dir: Path) -> list[str]:
    rows = edge["mechanismAudit"]["thresholdSensitivity"]
    thresholds = [row["minimumBurstShare"] * 100 for row in rows]
    roi = [row["roiPct"] for row in rows]
    bets = [row["bets"] for row in rows]
    gaps = [row["calibration"]["calibrationGapPctPoints"] for row in rows]

    fig, axis = plt.subplots(figsize=(11.5, 6.8))
    second = axis.twinx()
    axis.plot(thresholds, roi, marker="o", linewidth=2.2, color=POSITIVE, label="ROI")
    axis.plot(thresholds, gaps, marker="s", linewidth=2.0, color=SECONDARY, label="Calibration gap")
    second.bar(thresholds, bets, width=3.2, color=GRID, alpha=0.55, label="Bets")
    for x_value, y_value in zip(thresholds, roi):
        axis.text(x_value, y_value + 1.1, f"{y_value:.1f}%", ha="center", fontsize=9, color=POSITIVE)
    axis.axvline(80, color=ACCENT, linewidth=1.4, linestyle="--", label="Paper threshold")
    axis.axhline(0, color=INK, linewidth=1.0)
    axis.set_xticks(thresholds, [f"{value:.0f}%\nn={count}" for value, count in zip(thresholds, bets)])
    axis.set_xlabel("Minimum share of target taker buying in final 60 seconds")
    axis.set_ylabel("ROI / calibration gap (percentage points)")
    second.set_ylabel("Eligible bets")
    axis.set_title("The urgency result is not an exact 80% knife edge", loc="left")
    axis.grid(axis="y")
    axis.spines[["top", "right", "left"]].set_visible(False)
    second.spines[["top", "left"]].set_visible(False)
    handles, labels = axis.get_legend_handles_labels()
    second_handles, second_labels = second.get_legend_handles_labels()
    axis.legend(handles + second_handles, labels + second_labels, loc="upper left", ncols=4)
    fig.subplots_adjust(bottom=0.20)
    fig.text(
        0.01, 0.01,
        "Threshold sweep is descriptive and correlated; it is not seven independent validations.",
        color=MUTED, fontsize=9
    )
    return save_figure(fig, output_dir, "burst_threshold_sensitivity")


def atomic_breadth_calibration(edge: dict, output_dir: Path) -> list[str]:
    atomic = edge["atomicBreadthEdge"]
    groups = [
        ("Narrow trigger", atomic["belowThresholdCalibration"], atomic["belowThreshold"]),
        ("Broad trigger", atomic["allCalibration"], atomic["all"]),
        ("Broad, held out", atomic["chronology"]["heldOutCalibration"],
         atomic["chronology"]["heldOutAfterDevelopment"]),
    ]
    labels = [f"{name}\nn={calibration['bets']}" for name, calibration, _ in groups]
    implied = [calibration["meanImpliedProbabilityPct"] for _, calibration, _ in groups]
    actual = [calibration["actualWinRatePct"] for _, calibration, _ in groups]
    roi = [summary["roiPct"] for _, _, summary in groups]

    fig, axis = plt.subplots(figsize=(11.8, 7.0))
    positions = np.arange(len(groups))
    width = 0.34
    axis.bar(positions - width / 2, implied, width, color=SECONDARY, label="Public-price implied")
    axis.bar(positions + width / 2, actual, width, color=POSITIVE, label="Actual win rate")
    for index, (_, calibration, _) in enumerate(groups):
        axis.text(
            index, max(implied[index], actual[index]) + 2.5,
            f"gap {calibration['calibrationGapPctPoints']:+.1f} pp\nROI {roi[index]:+.1f}%",
            ha="center", va="bottom", fontsize=10, color=INK, fontweight="bold"
        )
    axis.set_xticks(positions, labels)
    axis.set_ylim(0, 96)
    axis.set_ylabel("Probability / realized win rate")
    axis.set_title("The edge appears when one trigger reaches many maker accounts", loc="left")
    axis.grid(axis="y")
    axis.spines[["top", "right", "left"]].set_visible(False)
    axis.legend(loc="upper left", ncols=2)
    fig.text(
        0.01, 0.01,
        "Broad means at least 18 distinct maker addresses in the mined trigger transaction. Held out combines validation and final test after development-only threshold selection.",
        color=MUTED, fontsize=9
    )
    return save_figure(fig, output_dir, "atomic_breadth_calibration")


def breadth_chronology(features: pd.DataFrame, output_dir: Path) -> list[str]:
    bets = prepare_bets(base_universe(features), 60, 5).sort_values(
        "signalTimestamp"
    ).reset_index(drop=True)
    first = int(len(bets) * 0.50)
    second = int(len(bets) * 0.70)
    segments = [
        ("Development", bets.iloc[:first]),
        ("Validation", bets.iloc[first:second]),
        ("Final test", bets.iloc[second:]),
    ]
    definitions = [
        ("Old rapid proxy", lambda rows: rows["takerBurst60Share"] >= 0.80, SECONDARY),
        ("Atomic breadth >=18", lambda rows: rows["onchainUniqueMakers"] >= 18, POSITIVE),
    ]
    fig, axis = plt.subplots(figsize=(12.2, 7.0))
    positions = np.arange(len(segments))
    width = 0.34
    for offset, (name, mask, color) in zip((-width / 2, width / 2), definitions):
        values = []
        counts = []
        for _, segment in segments:
            selected = segment[mask(segment)]
            values.append(selected["return"].mean() * 100)
            counts.append(len(selected))
        bars = axis.bar(positions + offset, values, width, color=color, label=name)
        for bar, value, count in zip(bars, values, counts):
            axis.text(
                bar.get_x() + bar.get_width() / 2,
                value + (2.2 if value >= 0 else -3.3),
                f"{value:+.1f}%\nn={count}", ha="center",
                va="bottom" if value >= 0 else "top", fontsize=9.5,
                color=INK, fontweight="bold"
            )
    axis.axhline(0, color=INK, linewidth=1.0)
    axis.set_xticks(positions, [name for name, _ in segments])
    axis.set_ylim(-42, 92)
    axis.set_ylabel("Equal-stake ROI after lag, price stress, and fees")
    axis.set_title("Transaction breadth fixes the rapid proxy's middle-period failure", loc="left")
    axis.grid(axis="y")
    axis.spines[["top", "right", "left"]].set_visible(False)
    axis.legend(loc="upper right")
    fig.text(
        0.01, 0.01,
        "The breadth cutoff was selected only from development. Validation and final outcomes were not used to choose 18.",
        color=MUTED, fontsize=9
    )
    return save_figure(fig, output_dir, "breadth_chronology")


def breadth_threshold_lock(edge: dict, output_dir: Path) -> list[str]:
    candidates = edge["atomicBreadthEdge"]["thresholdSelection"]["candidates"]
    rows = [row for row in candidates if row["minimumUniqueMakers"] <= 23]
    thresholds = [row["minimumUniqueMakers"] for row in rows]
    development = [
        row["developmentCalibration"].get("calibrationGapPctPoints", np.nan)
        for row in rows
    ]
    held_out = []
    counts = []
    for row in rows:
        validation = row["validationCalibration"]
        final = row["finalTestCalibration"]
        bets = validation.get("bets", 0) + final.get("bets", 0)
        excess = (
            validation.get("excessWins", 0) + final.get("excessWins", 0)
        )
        held_out.append(excess / bets * 100 if bets else np.nan)
        counts.append(bets)

    fig, axis = plt.subplots(figsize=(12.4, 7.0))
    second = axis.twinx()
    axis.plot(thresholds, development, marker="o", linewidth=2.0, color=SECONDARY, label="Development")
    axis.plot(thresholds, held_out, marker="s", linewidth=2.2, color=POSITIVE, label="Held out")
    second.bar(thresholds, counts, width=0.72, color=GRID, alpha=0.52, label="Held-out bets")
    axis.axvline(18, color=ACCENT, linewidth=1.8, linestyle="--", label="Locked at 18")
    axis.axhline(0, color=INK, linewidth=1.0)
    axis.set_xticks(thresholds)
    axis.set_xlabel("Minimum distinct maker accounts in trigger")
    axis.set_ylabel("Win rate minus public-price probability (points)")
    second.set_ylabel("Held-out bets")
    axis.set_title("The first half selected 18; nearby breadth cutoffs tell the same story", loc="left")
    axis.grid(axis="y")
    axis.spines[["top", "right", "left"]].set_visible(False)
    second.spines[["top", "left"]].set_visible(False)
    handles, labels = axis.get_legend_handles_labels()
    second_handles, second_labels = second.get_legend_handles_labels()
    axis.legend(handles + second_handles, labels + second_labels, loc="upper left", ncols=4)
    fig.text(
        0.01, 0.01,
        "The gray bars shrink as the rule becomes stricter. The formal market-null simulation repeats the threshold search rather than treating every cutoff as an independent test.",
        color=MUTED, fontsize=9
    )
    return save_figure(fig, output_dir, "breadth_threshold_lock")


def atomic_sweep_anatomy(
    trigger_data: dict, features: pd.DataFrame, output_dir: Path
) -> list[str]:
    example_feature = features[
        features["title"].str.contains("FURIA vs FUT Esports", case=False, na=False)
    ].iloc[0]
    example = next(
        row for row in trigger_data["transactions"]
        if row["conditionId"] == example_feature["conditionId"]
    )
    fills = pd.DataFrame(example["sweep"]["fills"])
    fills["priceLevel"] = fills["targetPrice"].round(4)
    levels = fills.groupby("priceLevel", sort=True).agg(
        notional=("targetNotionalUsdc", "sum"),
        orders=("maker", "size"),
        makers=("maker", "nunique"),
    ).reset_index()
    labels = [f"{price * 100:.0f}c" for price in levels["priceLevel"]]

    fig, axis = plt.subplots(figsize=(12.0, 7.0))
    bars = axis.barh(labels, levels["notional"] / 1000, color=POSITIVE)
    for bar, row in zip(bars, levels.itertuples()):
        axis.text(
            bar.get_width() + max(levels["notional"] / 1000) * 0.015,
            bar.get_y() + bar.get_height() / 2,
            f"${row.notional / 1000:,.1f}k | {row.orders} orders | {row.makers} accounts",
            va="center", fontsize=9.5, color=INK
        )
    sweep = example["sweep"]
    axis.set_xlabel("Target-side notional matched at each price level ($ thousands)")
    axis.set_ylabel("FUT Esports contract price")
    axis.set_title("One public trade was actually a 35-order atomic book sweep", loc="left")
    axis.grid(axis="x")
    axis.spines[["top", "right", "left"]].set_visible(False)
    axis.set_xlim(0, max(levels["notional"] / 1000) * 1.42)
    fig.text(
        0.01, 0.01,
        f"Illustrative winning trigger: {sweep['makerOrderCount']} maker orders, {sweep['uniqueMakers']} distinct maker accounts, {sweep['uniquePriceLevels']} price levels, ${sweep['targetNotionalUsdc'] / 1_000_000:.2f}m target notional, median resting-order age {sweep['restingAgeMedianSeconds']:.0f}s. Example only; the statistical result uses all eligible events.",
        color=MUTED, fontsize=9
    )
    return save_figure(fig, output_dir, "atomic_sweep_anatomy")


def breadth_execution_sensitivity(edge: dict, output_dir: Path) -> list[str]:
    rows = sorted(
        [row for row in edge["atomicBreadthEdge"]["executionSensitivity"]
         if row["lagSeconds"] == 60],
        key=lambda row: row["slippageCents"]
    )
    slippage = [row["slippageCents"] for row in rows]
    all_values = [row["all"]["roiPct"] for row in rows]
    final_values = [row["finalTest"]["roiPct"] for row in rows]
    held_out_values = []
    for row in rows:
        held_out_values.append(combined_held_out_roi(row))

    fig, axis = plt.subplots(figsize=(11.6, 6.8))
    for label, values, color, text_offset, alignment in [
        ("All breadth signals", all_values, POSITIVE, -1.8, "top"),
        ("Held-out half", held_out_values, SECONDARY, 1.5, "bottom"),
        ("Final test", final_values, ACCENT, 1.5, "bottom"),
    ]:
        axis.plot(slippage, values, marker="o", linewidth=2.2, markersize=6, color=color, label=label)
        for x_value, y_value in zip(slippage, values):
            if x_value not in {0, 5, 10, 20, 30}:
                continue
            axis.text(
                x_value, y_value + text_offset, f"{y_value:+.1f}%",
                ha="center", va=alignment, fontsize=9, color=color
            )
    axis.axhline(0, color=INK, linewidth=1.0)
    shown_ticks = [0, 1, 2, 3, 5, 7.5, 10, 15, 20, 30]
    axis.set_xticks(shown_ticks, [f"{value:g}c" for value in shown_ticks])
    all_plotted = all_values + held_out_values + final_values
    axis.set_ylim(min(all_plotted) - 6, max(all_plotted) + 12)
    axis.set_xlabel("Adverse price movement after the 60-second wait")
    axis.set_ylabel("Equal-stake ROI")
    axis.set_title("The breadth rule remains positive under severe execution stress", loc="left")
    axis.grid(axis="y")
    axis.spines[["top", "right", "left"]].set_visible(False)
    axis.legend(loc="upper right")
    return save_figure(fig, output_dir, "breadth_execution_sensitivity")


def copy_execution_surface(edge: dict, output_dir: Path) -> list[str]:
    blind_rows = edge["blindCopyCounterfactual"]["executionSensitivity"]
    breadth_rows = edge["atomicBreadthEdge"]["executionSensitivity"]
    available_lags = {row["lagSeconds"] for row in blind_rows}
    available_costs = {row["slippageCents"] for row in blind_rows}
    lags = [value for value in DISPLAY_LAGS if value in available_lags]
    slippage = [value for value in DISPLAY_COSTS if value in available_costs]

    def matrix(rows: list[dict], held_out: bool = False) -> np.ndarray:
        lookup = {(row["lagSeconds"], row["slippageCents"]): row for row in rows}
        values = []
        for lag in lags:
            line = []
            for cost in slippage:
                row = lookup[(lag, cost)]
                if held_out:
                    line.append(combined_held_out_roi(row))
                else:
                    line.append(row["all"]["roiPct"])
            values.append(line)
        return np.asarray(values)

    panels = [
        ("Blind copy: all 139 signals", matrix(blind_rows), "No selection edge"),
        ("Atomic breadth: held-out 21", matrix(breadth_rows, held_out=True), "18+ maker accounts"),
    ]
    fig, axes = plt.subplots(1, 2, figsize=(15.2, 7.8), constrained_layout=True)
    normalization = TwoSlopeNorm(vmin=-26, vcenter=0, vmax=42)
    image = None
    for axis, (title, values, subtitle) in zip(axes, panels):
        image = axis.imshow(values, cmap="RdYlGn", norm=normalization, aspect="auto")
        for row_index in range(len(lags)):
            for column_index in range(len(slippage)):
                value = values[row_index, column_index]
                color = "white" if value <= -13 or value >= 27 else INK
                axis.text(
                    column_index, row_index, f"{value:+.0f}",
                    ha="center", va="center", fontsize=7.4,
                    color=color, fontweight="bold"
                )
        axis.set_xticks(range(len(slippage)), [f"{value:g}c" for value in slippage], rotation=45, ha="right")
        axis.set_yticks(range(len(lags)), ["same sec" if value == 0 else f"{value}s" for value in lags])
        axis.set_xlabel("Extra adverse price paid")
        axis.set_title(f"{title}\n{subtitle}", loc="left", fontsize=14)
        axis.tick_params(length=0)
        axis.spines[:].set_visible(False)
    axes[0].set_ylabel("Delay after the trigger's block timestamp")
    colorbar = fig.colorbar(image, ax=axes, shrink=0.86, pad=0.02)
    colorbar.set_label("Equal-stake ROI (%)")
    fig.suptitle("Speed is not the cliff; paying more than the edge is", x=0.01, ha="left", fontsize=18, fontweight="bold")
    fig.text(
        0.01, -0.025,
        "Selected anchors from the full 15-delay x 17-cost atlas. Same-second is optimistic because ordering inside a one-second timestamp is unknown. A 0.1s or 0.5s bot lies between same-second and 1s. Every cell includes the observed fee curve.",
        color=MUTED, fontsize=9
    )
    return save_figure(fig, output_dir, "copy_execution_surface")


def copy_break_even_frontier(edge: dict, output_dir: Path) -> list[str]:
    blind = edge["blindCopyCounterfactual"]["executionBreakEven"]
    breadth = edge["atomicBreadthEdge"]["executionBreakEven"]
    lags = [row["lagSeconds"] for row in blind]
    positions = np.arange(len(lags))
    labels = ["same\nsecond" if value == 0 else f"{value}s" for value in lags]

    fig, axes = plt.subplots(1, 2, figsize=(14.4, 6.8), sharex=True)
    panels = [
        (axes[0], [
            ("All history", [row["allMaxAdverseCents"] for row in blind], NEGATIVE),
            ("Later period", [row["laterMaxAdverseCents"] for row in blind], SECONDARY),
        ], 6, "Blind copy"),
        (axes[1], [
            ("All breadth signals", [row["allMaxAdverseCents"] for row in breadth], POSITIVE),
            ("Held-out half", [row["heldOutMaxAdverseCents"] for row in breadth], SECONDARY),
        ], 32, "18-maker breadth rule"),
    ]
    for axis, series, upper, title in panels:
        for label, values, color in series:
            axis.plot(positions, values, marker="o", linewidth=2.2, markersize=5, color=color, label=label)
        axis.set_xticks(positions, labels)
        axis.set_ylim(0, upper)
        axis.set_xlabel("Delay after trigger block timestamp")
        axis.set_title(title, loc="left")
        axis.grid(axis="y")
        axis.spines[["top", "right", "left"]].set_visible(False)
        axis.legend(loc="upper left")
    axes[0].set_ylabel("Maximum adverse price before modeled ROI falls below zero (cents)")
    fig.suptitle("Blind copying has about two cents of room; breadth has about twenty", x=0.01, ha="left", fontsize=18, fontweight="bold")
    fig.subplots_adjust(bottom=0.19, top=0.82, wspace=0.18)
    fig.text(
        0.01, 0.02,
        "Break-even values are solved from the same equal-stake replay and include fees. The near-flat lines show no measured sub-minute latency cliff; exact historical order-book depth remains unavailable.",
        color=MUTED, fontsize=9
    )
    return save_figure(fig, output_dir, "copy_break_even_frontier")


def copy_latency_curves(edge: dict, output_dir: Path) -> list[str]:
    blind_rows = edge["blindCopyCounterfactual"]["executionSensitivity"]
    breadth_rows = edge["atomicBreadthEdge"]["executionSensitivity"]
    lags = sorted({row["lagSeconds"] for row in blind_rows})
    costs = [0, 1, 2, 5, 10, 20, 30]
    positions = np.arange(len(lags))
    labels = ["same\nsec" if lag == 0 else f"{lag}s" for lag in lags]

    def values(rows: list[dict], cost: float, held_out: bool) -> list[float]:
        lookup = {(row["lagSeconds"], row["slippageCents"]): row for row in rows}
        return [
            combined_held_out_roi(lookup[(lag, cost)])
            if held_out else lookup[(lag, cost)]["all"]["roiPct"]
            for lag in lags
        ]

    fig, axes = plt.subplots(1, 2, figsize=(15.4, 7.4), sharex=True)
    panels = [
        (axes[0], blind_rows, False, "Blind copy: all 139 signals"),
        (axes[1], breadth_rows, True, "Atomic breadth: held-out 21"),
    ]
    for axis, rows, held_out, title in panels:
        for cost, color in zip(costs, SERIES_COLORS):
            axis.plot(
                positions, values(rows, cost, held_out), color=color,
                linewidth=2.0, marker="o", markersize=4, label=f"+{cost:g}c"
            )
        axis.axhline(0, color=INK, linewidth=1.0)
        axis.set_xticks(positions, labels)
        axis.set_xlabel("Delay after trigger block timestamp")
        axis.set_title(title, loc="left")
        axis.grid(axis="y")
        axis.spines[["top", "right", "left"]].set_visible(False)
    axes[0].set_ylabel("Equal-stake ROI")
    axes[1].legend(loc="upper right", ncols=2, title="Extra adverse price")
    fig.suptitle(
        "Latency barely moves the result; execution price decides it",
        x=0.01, ha="left", fontsize=18, fontweight="bold"
    )
    fig.subplots_adjust(bottom=0.19, top=0.82, wspace=0.16)
    fig.text(
        0.01, 0.02,
        "All 15 measured delays are shown. Lines are nearly horizontal below one minute. The historical data cannot rank 0.1s against 0.5s inside the same timestamped second.",
        color=MUTED, fontsize=9
    )
    return save_figure(fig, output_dir, "copy_latency_curves")


def copy_cost_curves(edge: dict, output_dir: Path) -> list[str]:
    blind_rows = edge["blindCopyCounterfactual"]["executionSensitivity"]
    breadth_rows = edge["atomicBreadthEdge"]["executionSensitivity"]
    costs = sorted({row["slippageCents"] for row in blind_rows})
    lags = [0, 1, 5, 30, 60, 300]

    def values(rows: list[dict], lag: int, held_out: bool) -> list[float]:
        lookup = {(row["lagSeconds"], row["slippageCents"]): row for row in rows}
        return [
            combined_held_out_roi(lookup[(lag, cost)])
            if held_out else lookup[(lag, cost)]["all"]["roiPct"]
            for cost in costs
        ]

    fig, axes = plt.subplots(1, 2, figsize=(15.4, 7.2), sharex=True)
    panels = [
        (axes[0], blind_rows, False, "Blind copy: all 139 signals"),
        (axes[1], breadth_rows, True, "Atomic breadth: held-out 21"),
    ]
    for axis, rows, held_out, title in panels:
        for lag, color in zip(lags, SERIES_COLORS):
            label = "same second" if lag == 0 else f"{lag}s"
            axis.plot(
                costs, values(rows, lag, held_out), color=color,
                linewidth=2.0, marker="o", markersize=3.5, label=label
            )
        axis.axhline(0, color=INK, linewidth=1.0)
        axis.set_xticks([0, 1, 2, 5, 10, 15, 20, 25, 30],
                        ["0", "1", "2", "5", "10", "15", "20", "25", "30"])
        axis.set_xlabel("Extra adverse price paid (cents)")
        axis.set_title(title, loc="left")
        axis.grid(axis="y")
        axis.spines[["top", "right", "left"]].set_visible(False)
    axes[0].set_ylabel("Equal-stake ROI")
    axes[1].legend(loc="upper right", ncols=2, title="Copy delay")
    fig.suptitle(
        "The whole cost curve: blind copying dies near 2c, breadth near 20c",
        x=0.01, ha="left", fontsize=18, fontweight="bold"
    )
    fig.subplots_adjust(bottom=0.18, top=0.82, wspace=0.16)
    fig.text(
        0.01, 0.02,
        "Seventeen explicit adverse-price assumptions from 0c to 30c are shown. These are stress scenarios around public prints, not reconstructed historical order-book fills.",
        color=MUTED, fontsize=9
    )
    return save_figure(fig, output_dir, "copy_cost_curves")


def fee_cost_surface(edge: dict, output_dir: Path) -> list[str]:
    rows = edge["copyParameterAtlas"]["feeCostGrid"]
    fees = sorted({row["feeRatePct"] for row in rows})
    costs = sorted({row["slippageCents"] for row in rows})
    lookup = {(row["feeRatePct"], row["slippageCents"]): row for row in rows}

    def matrix(key: str) -> np.ndarray:
        return np.asarray([
            [lookup[(fee, cost)][key]["roiPct"] for cost in costs]
            for fee in fees
        ])

    fig, axes = plt.subplots(1, 2, figsize=(15.8, 6.7), constrained_layout=True)
    normalization = TwoSlopeNorm(vmin=-36, vcenter=0, vmax=45)
    panels = [
        (axes[0], matrix("blindAll"), "Blind copy: all signals"),
        (axes[1], matrix("breadthHeldOut"), "Atomic breadth: held-out"),
    ]
    image = None
    for axis, values, title in panels:
        image = axis.imshow(values, cmap="RdYlGn", norm=normalization, aspect="auto")
        for row_index in range(len(fees)):
            for column_index in range(len(costs)):
                value = values[row_index, column_index]
                color = "white" if value <= -22 or value >= 33 else INK
                axis.text(
                    column_index, row_index, f"{value:+.0f}",
                    ha="center", va="center", fontsize=6.3,
                    color=color, fontweight="bold"
                )
        axis.set_xticks(range(len(costs)), [f"{value:g}c" for value in costs], rotation=45, ha="right")
        axis.set_yticks(range(len(fees)), [f"{value:g}%" for value in fees])
        axis.set_xlabel("Extra adverse price")
        axis.set_title(title, loc="left")
        axis.tick_params(length=0)
        axis.spines[:].set_visible(False)
    axes[0].set_ylabel("Fee-curve rate")
    colorbar = fig.colorbar(image, ax=axes, shrink=0.88, pad=0.02)
    colorbar.set_label("Equal-stake ROI (%)")
    fig.suptitle(
        "Fees matter, but price selection remains the dominant execution variable",
        x=0.01, ha="left", fontsize=18, fontweight="bold"
    )
    fig.text(
        0.01, -0.035,
        "One-second replay. Each all-in price adds fee_rate x price x (1-price). The observed account curve uses 3%; other rows are explicit counterfactuals.",
        color=MUTED, fontsize=9
    )
    return save_figure(fig, output_dir, "fee_cost_surface")


def breadth_threshold_cost_surface(edge: dict, output_dir: Path) -> list[str]:
    rows = edge["copyParameterAtlas"]["thresholdCostGrid"]
    thresholds = sorted({row["minimumUniqueMakers"] for row in rows})
    costs = sorted({row["slippageCents"] for row in rows})
    lookup = {
        (row["minimumUniqueMakers"], row["slippageCents"]): row
        for row in rows
    }
    values = np.asarray([
        [lookup[(threshold, cost)]["heldOut"].get("roiPct", np.nan) for cost in costs]
        for threshold in thresholds
    ])

    fig, axis = plt.subplots(figsize=(14.5, 8.8))
    image = axis.imshow(
        values, cmap="RdYlGn", norm=TwoSlopeNorm(vmin=-65, vcenter=0, vmax=85),
        aspect="auto"
    )
    locked_index = thresholds.index(18)
    axis.axhline(locked_index - 0.5, color=INK, linewidth=2.0)
    axis.axhline(locked_index + 0.5, color=INK, linewidth=2.0)
    axis.text(
        len(costs) - 0.2, locked_index, " locked 18 ",
        ha="right", va="center", color="white", fontsize=9, fontweight="bold",
        bbox={"facecolor": INK, "edgecolor": "none", "pad": 2.5}
    )
    axis.set_xticks(range(len(costs)), [f"{value:g}c" for value in costs], rotation=45, ha="right")
    axis.set_yticks(range(0, len(thresholds), 2), thresholds[::2])
    axis.set_xlabel("Extra adverse price at one-second delay")
    axis.set_ylabel("Minimum distinct maker accounts")
    axis.set_title("Held-out ROI across every breadth cutoff and execution-cost assumption", loc="left")
    axis.tick_params(length=0)
    axis.spines[:].set_visible(False)
    colorbar = fig.colorbar(image, ax=axis, shrink=0.9, pad=0.02)
    colorbar.set_label("Held-out equal-stake ROI (%)")
    fig.text(
        0.01, 0.01,
        "Thresholds 5-30 are descriptive sensitivity checks. High cutoffs contain very few bets and can show extreme returns. The formal rule remains the development-selected cutoff of 18.",
        color=MUTED, fontsize=9
    )
    fig.subplots_adjust(bottom=0.18)
    return save_figure(fig, output_dir, "breadth_threshold_cost_surface")


def breadth_threshold_latency_surface(edge: dict, output_dir: Path) -> list[str]:
    rows = edge["copyParameterAtlas"]["thresholdLatencyGrid"]
    thresholds = sorted({row["minimumUniqueMakers"] for row in rows})
    lags = sorted({row["lagSeconds"] for row in rows})
    lookup = {
        (row["minimumUniqueMakers"], row["lagSeconds"]): row
        for row in rows
    }
    values = np.asarray([
        [lookup[(threshold, lag)]["heldOut"].get("roiPct", np.nan) for lag in lags]
        for threshold in thresholds
    ])

    fig, axis = plt.subplots(figsize=(14.5, 8.8))
    image = axis.imshow(
        values, cmap="RdYlGn", norm=TwoSlopeNorm(vmin=-35, vcenter=0, vmax=70),
        aspect="auto"
    )
    locked_index = thresholds.index(18)
    axis.axhline(locked_index - 0.5, color=INK, linewidth=2.0)
    axis.axhline(locked_index + 0.5, color=INK, linewidth=2.0)
    axis.set_xticks(
        range(len(lags)), ["same\nsec" if value == 0 else f"{value}s" for value in lags]
    )
    axis.set_yticks(range(0, len(thresholds), 2), thresholds[::2])
    axis.set_xlabel("Delay after trigger block timestamp at +1c adverse price")
    axis.set_ylabel("Minimum distinct maker accounts")
    axis.set_title("Breadth selection dominates latency throughout the measured five minutes", loc="left")
    axis.tick_params(length=0)
    axis.spines[:].set_visible(False)
    colorbar = fig.colorbar(image, ax=axis, shrink=0.9, pad=0.02)
    colorbar.set_label("Held-out equal-stake ROI (%)")
    fig.text(
        0.01, 0.01,
        "The horizontal color bands are the key result: changing the maker cutoff moves returns much more than moving from 1s to 60s. Same-second remains an optimistic bound.",
        color=MUTED, fontsize=9
    )
    fig.subplots_adjust(bottom=0.18)
    return save_figure(fig, output_dir, "breadth_threshold_latency_surface")


def maker_breadth_distribution(features: pd.DataFrame, output_dir: Path) -> list[str]:
    bets = prepare_bets(base_universe(features), 60, 5)
    bins = [0, 5, 10, 14, 17, 21, 25, 100]
    labels = ["1-5", "6-10", "11-14", "15-17", "18-21", "22-25", "26+"]
    bets["breadthBand"] = pd.cut(
        bets["onchainUniqueMakers"], bins=bins, labels=labels, include_lowest=True
    )
    grouped = bets.groupby("breadthBand", observed=True).agg(
        bets=("won", "size"),
        wins=("won", "sum"),
        actual=("won", "mean"),
        implied=("observedExecutionPrice", "mean"),
    ).reindex(labels)
    grouped["losses"] = grouped["bets"] - grouped["wins"]

    fig, axes = plt.subplots(1, 2, figsize=(15.2, 6.8))
    positions = np.arange(len(labels))
    axes[0].bar(positions, grouped["wins"], color=POSITIVE, label="Wins")
    axes[0].bar(
        positions, grouped["losses"], bottom=grouped["wins"],
        color=NEGATIVE, alpha=0.82, label="Losses"
    )
    axes[0].axvline(3.5, color=ACCENT, linewidth=2, linestyle="--")
    axes[0].text(3.55, grouped["bets"].max() * 0.94, "18-maker line", color="#8A5B00", fontsize=9)
    axes[0].set_xticks(positions, labels)
    axes[0].set_xlabel("Distinct makers in trigger")
    axes[0].set_ylabel("Eligible events")
    axes[0].set_title("Where wins and losses occur", loc="left")
    axes[0].grid(axis="y")
    axes[0].spines[["top", "right", "left"]].set_visible(False)
    axes[0].legend(loc="upper right")

    actual = grouped["actual"].to_numpy(dtype=float) * 100
    implied = grouped["implied"].to_numpy(dtype=float) * 100
    axes[1].plot(positions, implied, marker="s", linewidth=2.0, color=SECONDARY, label="Public-price implied")
    axes[1].plot(positions, actual, marker="o", linewidth=2.2, color=POSITIVE, label="Actual win rate")
    axes[1].axvline(3.5, color=ACCENT, linewidth=2, linestyle="--")
    for position, count, value in zip(positions, grouped["bets"], actual):
        axes[1].text(position, value + 3, f"n={int(count)}", ha="center", fontsize=8.5, color=INK)
    axes[1].set_xticks(positions, labels)
    axes[1].set_ylim(0, 108)
    axes[1].set_xlabel("Distinct makers in trigger")
    axes[1].set_ylabel("Probability / actual win rate")
    axes[1].set_title("Realized outcomes pull away above the cutoff", loc="left")
    axes[1].grid(axis="y")
    axes[1].spines[["top", "right", "left"]].set_visible(False)
    axes[1].legend(loc="lower right")
    fig.suptitle(
        "Maker breadth is a graded transaction feature, not a wallet-size label",
        x=0.01, ha="left", fontsize=18, fontweight="bold"
    )
    fig.subplots_adjust(bottom=0.16, top=0.82, wspace=0.20)
    fig.text(
        0.01, 0.02,
        "Bands are descriptive. The exact cutoff of 18 was selected on the first half only; the right panel uses the original 60s + 5c execution reference.",
        color=MUTED, fontsize=9
    )
    return save_figure(fig, output_dir, "maker_breadth_distribution")


def breadth_notional_scatter(
    edge: dict, features: pd.DataFrame, output_dir: Path
) -> list[str]:
    bets = prepare_bets(base_universe(features), 60, 5)
    winners = bets[bets["won"] == 1]
    losers = bets[bets["won"] == 0]
    controlled = edge["atomicBreadthEdge"]["probabilityOffsetModels"][
        "sizeAndPeriodControlled"
    ]["coefficients"]
    notional = next(row for row in controlled if row["name"] == "logNotionalCentered")
    breadth = next(row for row in controlled if row["name"] == "broadSweep")

    fig, axis = plt.subplots(figsize=(12.6, 7.4))
    axis.scatter(
        winners["onchainTargetNotionalUsdc"], winners["onchainUniqueMakers"],
        s=60, color=POSITIVE, alpha=0.78, edgecolor="white", linewidth=0.7,
        label=f"Won ({len(winners)})"
    )
    axis.scatter(
        losers["onchainTargetNotionalUsdc"], losers["onchainUniqueMakers"],
        s=62, marker="X", color=NEGATIVE, alpha=0.82, edgecolor="white", linewidth=0.5,
        label=f"Lost ({len(losers)})"
    )
    axis.axhline(18, color=ACCENT, linewidth=2.0, linestyle="--", label="Locked breadth cutoff")
    axis.set_xscale("log")
    axis.set_xlabel("Target notional reconstructed inside trigger transaction (log scale)")
    axis.set_ylabel("Distinct maker accounts matched")
    axis.set_title("A bigger dollar trade is not the same thing as a broader sweep", loc="left")
    axis.grid(which="major", axis="both")
    axis.spines[["top", "right", "left"]].set_visible(False)
    axis.legend(loc="upper left", ncols=2)
    fig.text(
        0.01, 0.01,
        f"Probability-offset model after urgency and period controls: breadth OR {breadth['oddsRatio']:.2f}, p={breadth['robustPValue']:.3f}; log notional OR {notional['oddsRatio']:.2f}, p={notional['robustPValue']:.3f}. Retrospective explanatory model.",
        color=MUTED, fontsize=9
    )
    fig.subplots_adjust(bottom=0.16)
    return save_figure(fig, output_dir, "breadth_notional_scatter")


def alpha_equity_drawdown(features: pd.DataFrame, output_dir: Path) -> list[str]:
    bets = prepare_bets(base_universe(features), 60, 5).sort_values(
        "signalTimestamp"
    ).reset_index(drop=True)
    first = int(len(bets) * 0.50)
    second = int(len(bets) * 0.70)
    development_end = pd.to_datetime(bets.iloc[first]["signalTime"], utc=True)
    validation_end = pd.to_datetime(bets.iloc[second]["signalTime"], utc=True)
    definitions = [
        ("18+ makers", bets[bets["onchainUniqueMakers"] >= 18], POSITIVE),
        ("Below 18", bets[bets["onchainUniqueMakers"] < 18], NEGATIVE),
    ]

    fig, axes = plt.subplots(
        2, 1, figsize=(13.2, 8.7), sharex=True,
        gridspec_kw={"height_ratios": [2.1, 1], "hspace": 0.08}
    )
    for label, rows, color in definitions:
        dates = pd.to_datetime(rows["signalTime"], utc=True)
        equity = rows["profitUsdc"].cumsum()
        peak = np.maximum.accumulate(np.r_[0, equity.to_numpy()])[1:]
        drawdown = peak - equity.to_numpy()
        axes[0].step(dates, equity, where="post", color=color, linewidth=2.3, label=f"{label} ({len(rows)} bets)")
        axes[1].step(dates, drawdown, where="post", color=color, linewidth=1.9, label=label)
    for axis in axes:
        axis.axvline(development_end, color=SECONDARY, linestyle="--", linewidth=1.2)
        axis.axvline(validation_end, color=ACCENT, linestyle="--", linewidth=1.2)
        axis.grid(axis="y")
        axis.spines[["top", "right", "left"]].set_visible(False)
    axes[0].axhline(0, color=INK, linewidth=1.0)
    axes[0].set_ylabel("Cumulative paper P&L ($100 stakes)")
    axes[0].set_title("The broad-sweep equity curve separates and stays above water", loc="left")
    axes[0].legend(loc="upper left")
    axes[1].set_ylabel("Drawdown ($)")
    axes[1].set_xlabel("Signal date")
    axes[1].invert_yaxis()
    axes[1].xaxis.set_major_locator(mdates.WeekdayLocator(interval=2))
    axes[1].xaxis.set_major_formatter(mdates.DateFormatter("%b %d"))
    fig.text(
        0.01, 0.01,
        "Vertical lines mark the 50% development boundary and 70% validation boundary. Returns use the original 60s + 5c stressed reference and include fees.",
        color=MUTED, fontsize=9
    )
    fig.subplots_adjust(bottom=0.12, top=0.94)
    return save_figure(fig, output_dir, "alpha_equity_drawdown")


def alpha_subgroup_robustness(edge: dict, output_dir: Path) -> list[str]:
    subgroups = edge["copyParameterAtlas"]["subgroups"]
    family_names = {
        "discipline": "Discipline",
        "priceBand": "Entry price",
        "notionalBand": "Trigger size",
        "timing": "Timing",
        "urgency": "Flow speed",
    }
    rows = []
    for family, display in family_names.items():
        for row in subgroups[family]:
            broad_count = row["broad"].get("bets", 0)
            narrow_count = row["narrow"].get("bets", 0)
            effect = row.get("broadMinusNarrowCalibrationPctPoints")
            if effect is None or broad_count < 2 or narrow_count < 2:
                continue
            rows.append({
                "label": f"{display}: {row['group']}\n{broad_count} broad / {narrow_count} narrow",
                "effect": effect,
            })
    rows = list(reversed(rows))
    labels = [row["label"] for row in rows]
    values = [row["effect"] for row in rows]
    colors = [POSITIVE if value >= 0 else NEGATIVE for value in values]

    fig, axis = plt.subplots(figsize=(12.8, max(7.2, len(rows) * 0.52)))
    positions = np.arange(len(rows))
    bars = axis.barh(positions, values, color=colors, alpha=0.88)
    for bar, value in zip(bars, values):
        axis.text(
            value + (0.8 if value >= 0 else -0.8),
            bar.get_y() + bar.get_height() / 2,
            f"{value:+.1f} pp", va="center",
            ha="left" if value >= 0 else "right", fontsize=9, color=INK
        )
    axis.axvline(0, color=INK, linewidth=1.0)
    axis.set_yticks(positions, labels)
    axis.set_xlabel("Broad-minus-narrow calibration advantage (percentage points)")
    axis.set_title("Where the breadth fingerprint persists, and where the sample is weak", loc="left")
    axis.grid(axis="x")
    axis.spines[["top", "right", "left"]].set_visible(False)
    fig.text(
        0.01, 0.01,
        "Descriptive subgroups with at least two broad and two narrow bets. These are not independent tests; small cells can swing sharply and should be treated as failure probes, not extra discoveries.",
        color=MUTED, fontsize=9
    )
    fig.subplots_adjust(left=0.31, bottom=0.11)
    return save_figure(fig, output_dir, "alpha_subgroup_robustness")


def alpha_daily_pnl(edge: dict, output_dir: Path) -> list[str]:
    rows = edge["copyParameterAtlas"]["risk"]["breadthAll"]["daily"]
    frame = pd.DataFrame(rows)
    dates = pd.to_datetime(frame["day"], utc=True)
    cumulative = frame["profitUsdc"].cumsum()
    colors = np.where(frame["profitUsdc"] >= 0, POSITIVE, NEGATIVE)

    fig, axis = plt.subplots(figsize=(13.0, 7.0))
    bars = axis.bar(dates, frame["profitUsdc"], color=colors, width=0.75, alpha=0.88)
    second = axis.twinx()
    second.plot(dates, cumulative, color=INK, linewidth=2.2, marker="o", markersize=3.5, label="Cumulative P&L")
    for bar, row in zip(bars, frame.itertuples(index=False)):
        if abs(row.profitUsdc) < 120:
            continue
        axis.text(
            bar.get_x() + bar.get_width() / 2,
            row.profitUsdc + (16 if row.profitUsdc >= 0 else -20),
            f"${row.profitUsdc:+,.0f}\n{row.bets} bets",
            ha="center", va="bottom" if row.profitUsdc >= 0 else "top",
            fontsize=8.2, color=INK
        )
    axis.axhline(0, color=INK, linewidth=1.0)
    axis.set_ylabel("Daily paper P&L")
    second.set_ylabel("Cumulative paper P&L")
    axis.set_title("Returns arrive in clusters; the edge is not a smooth daily paycheck", loc="left")
    axis.grid(axis="y")
    axis.spines[["top", "right", "left"]].set_visible(False)
    second.spines[["top", "left"]].set_visible(False)
    axis.xaxis.set_major_locator(mdates.WeekdayLocator(interval=1))
    axis.xaxis.set_major_formatter(mdates.DateFormatter("%b %d"))
    second.legend(loc="upper left")
    fig.text(
        0.01, 0.01,
        "All 30 breadth signals under the 60s + 5c reference. Day-cluster resampling is used elsewhere because multiple bets on one day are not independent evidence.",
        color=MUTED, fontsize=9
    )
    fig.subplots_adjust(bottom=0.14)
    return save_figure(fig, output_dir, "alpha_daily_pnl")


def execution_print_coverage(edge: dict, output_dir: Path) -> list[str]:
    blind_rows = [
        row for row in edge["blindCopyCounterfactual"]["executionSensitivity"]
        if row["slippageCents"] == 0
    ]
    breadth_rows = [
        row for row in edge["atomicBreadthEdge"]["executionSensitivity"]
        if row["slippageCents"] == 0
    ]
    lags = [row["lagSeconds"] for row in blind_rows]
    positions = np.arange(len(lags))
    labels = ["same\nsec" if lag == 0 else f"{lag}s" for lag in lags]
    blind_coverage = [row["publicPrintCoveragePct"] for row in blind_rows]
    breadth_coverage = [row["publicPrintCoveragePct"] for row in breadth_rows]

    fig, axis = plt.subplots(figsize=(12.8, 6.5))
    axis.plot(positions, blind_coverage, marker="o", linewidth=2.2, color=SECONDARY, label="Blind universe")
    axis.plot(positions, breadth_coverage, marker="s", linewidth=2.2, color=POSITIVE, label="18+ maker signals")
    axis.set_xticks(positions, labels)
    axis.set_ylim(min(blind_coverage + breadth_coverage) - 3, 101)
    axis.set_xlabel("Delay after trigger block timestamp")
    axis.set_ylabel("Signals with a non-target public print in the next minute")
    axis.set_title("The execution proxy covers almost every fast-copy scenario", loc="left")
    axis.grid(axis="y")
    axis.spines[["top", "right", "left"]].set_visible(False)
    axis.legend(loc="lower left")
    fig.text(
        0.01, 0.01,
        "Missing-print events are retained at the trigger price rather than dropped, preventing an easy upward selection bias. Coverage is not proof that $100 of ask depth was executable.",
        color=MUTED, fontsize=9
    )
    fig.subplots_adjust(bottom=0.17)
    return save_figure(fig, output_dir, "execution_print_coverage")


def alpha_leave_one_discipline_out(edge: dict, output_dir: Path) -> list[str]:
    rows = edge["copyParameterAtlas"]["risk"]["leaveOneDisciplineOut"]
    labels = [f"Without\n{row['excludedDiscipline']}" for row in rows]
    all_values = [row["all"]["roiPct"] for row in rows]
    held_out_values = [row["heldOut"]["roiPct"] for row in rows]
    positions = np.arange(len(rows))
    width = 0.36

    fig, axis = plt.subplots(figsize=(12.8, 6.8))
    all_bars = axis.bar(
        positions - width / 2, all_values, width, color=POSITIVE,
        label="All breadth signals"
    )
    held_bars = axis.bar(
        positions + width / 2, held_out_values, width, color=SECONDARY,
        label="Held-out half"
    )
    for bars, values in ((all_bars, all_values), (held_bars, held_out_values)):
        for bar, value in zip(bars, values):
            axis.text(
                bar.get_x() + bar.get_width() / 2, value + 1.2,
                f"{value:+.1f}%", ha="center", va="bottom",
                fontsize=8.8, color=INK, fontweight="bold"
            )
    axis.axhline(0, color=INK, linewidth=1.0)
    axis.set_xticks(positions, labels)
    axis.set_ylim(0, max(all_values) + 10)
    axis.set_ylabel("Equal-stake ROI after 60s + 5c and fees")
    axis.set_title("No single sport or esport discipline creates the breadth result", loc="left")
    axis.grid(axis="y")
    axis.spines[["top", "right", "left"]].set_visible(False)
    axis.legend(loc="upper left", ncols=2)
    fig.text(
        0.01, 0.01,
        "Each pair removes every breadth signal from the named discipline and reruns the same fixed rule. This guards against one category carrying the result; it does not create six independent tests.",
        color=MUTED, fontsize=9
    )
    fig.subplots_adjust(bottom=0.18)
    return save_figure(fig, output_dir, "alpha_leave_one_discipline_out")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--edge", default="research/djdjdjekekek/edge_analysis.json")
    parser.add_argument("--features", default="research/djdjdjekekek/edge_features.csv")
    parser.add_argument("--triggers", default="research/djdjdjekekek/trigger_transactions.json")
    parser.add_argument("--output", default="research/djdjdjekekek/figures")
    args = parser.parse_args()

    with Path(args.edge).open(encoding="utf-8") as handle:
        edge = json.load(handle)
    features = pd.read_csv(args.features)
    with Path(args.triggers).open(encoding="utf-8") as handle:
        trigger_data = json.load(handle)
    output_dir = Path(args.output)
    configure_style()
    files = []
    files.extend(blind_copy_funnel(edge, output_dir))
    files.extend(urgency_calibration(edge, output_dir))
    files.extend(strategy_equity(features, output_dir))
    files.extend(execution_sensitivity(edge, output_dir))
    files.extend(burst_threshold_sensitivity(edge, output_dir))
    files.extend(atomic_breadth_calibration(edge, output_dir))
    files.extend(breadth_chronology(features, output_dir))
    files.extend(breadth_threshold_lock(edge, output_dir))
    files.extend(atomic_sweep_anatomy(trigger_data, features, output_dir))
    files.extend(breadth_execution_sensitivity(edge, output_dir))
    files.extend(copy_execution_surface(edge, output_dir))
    files.extend(copy_break_even_frontier(edge, output_dir))
    files.extend(copy_latency_curves(edge, output_dir))
    files.extend(copy_cost_curves(edge, output_dir))
    files.extend(fee_cost_surface(edge, output_dir))
    files.extend(execution_print_coverage(edge, output_dir))
    files.extend(breadth_threshold_cost_surface(edge, output_dir))
    files.extend(breadth_threshold_latency_surface(edge, output_dir))
    files.extend(maker_breadth_distribution(features, output_dir))
    files.extend(breadth_notional_scatter(edge, features, output_dir))
    files.extend(alpha_equity_drawdown(features, output_dir))
    files.extend(alpha_subgroup_robustness(edge, output_dir))
    files.extend(alpha_daily_pnl(edge, output_dir))
    files.extend(alpha_leave_one_discipline_out(edge, output_dir))
    manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": {
            "edge": args.edge,
            "features": args.features,
            "triggers": args.triggers,
        },
        "files": [str(Path(path).relative_to(output_dir.parent)) for path in files],
        "note": "Every figure is generated from committed research artifacts; SVG and PNG carry identical content.",
    }
    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Report graphics: {len(files) // 2} figures -> {output_dir}")


if __name__ == "__main__":
    main()
