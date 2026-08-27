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
PNG_DPI = 300


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
        "lines.antialiased": True,
        "patch.antialiased": True,
        "text.antialiased": True,
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
            dpi=PNG_DPI if extension == "png" else None,
            bbox_inches="tight",
            metadata=metadata,
        )
        if extension == "svg":
            normalized = "\n".join(
                line.rstrip() for line in path.read_text(encoding="utf-8").splitlines()
            ) + "\n"
            path.write_text(normalized, encoding="utf-8")
        files.append(str(path))
    plt.close(fig)
    return files


def vector_heatmap(axis, values: np.ndarray, **kwargs):
    """Draw a cell grid that remains vector artwork in SVG and PDF output."""
    rows, columns = values.shape
    image = axis.pcolormesh(
        np.arange(columns + 1) - 0.5,
        np.arange(rows + 1) - 0.5,
        values,
        shading="flat",
        **kwargs,
    )
    axis.set_xlim(-0.5, columns - 0.5)
    axis.set_ylim(rows - 0.5, -0.5)
    return image


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
        image = vector_heatmap(axis, values, cmap="RdYlGn", norm=normalization)
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
        image = vector_heatmap(axis, values, cmap="RdYlGn", norm=normalization)
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
    image = vector_heatmap(
        axis, values, cmap="RdYlGn",
        norm=TwoSlopeNorm(vmin=-65, vcenter=0, vmax=85),
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
    image = vector_heatmap(
        axis, values, cmap="RdYlGn",
        norm=TwoSlopeNorm(vmin=-35, vcenter=0, vmax=70),
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


def money_label(value: float) -> str:
    if value >= 1_000:
        return f"${value / 1_000:g}k"
    return f"${value:g}"


def live_fok_capacity_surface(edge: dict, output_dir: Path) -> list[str]:
    rows = edge["liveLiquidityCapacity"]["summary"]
    stakes = sorted({row["stakeUsdc"] for row in rows})
    buffers = sorted({row["bufferCents"] for row in rows})
    segments = [
        ("all", "All sampled moneylines"),
        ("pregame", "Pregame only"),
        ("live", "Already live"),
    ]

    fig, axes = plt.subplots(1, 3, figsize=(15.4, 8.2), sharey=True)
    image_handle = None
    for axis, (segment, title) in zip(axes, segments):
        lookup = {
            (row["stakeUsdc"], row["bufferCents"]): row
            for row in rows if row["segment"] == segment
        }
        matrix = np.array([
            [lookup.get((stake, buffer), {}).get("fillRatePct", np.nan) for buffer in buffers]
            for stake in stakes
        ])
        image_handle = vector_heatmap(axis, matrix, vmin=0, vmax=100, cmap="YlGnBu")
        for row_index, stake in enumerate(stakes):
            for column_index, buffer in enumerate(buffers):
                value = matrix[row_index, column_index]
                if not np.isnan(value):
                    axis.text(
                        column_index, row_index, f"{value:.0f}%",
                        ha="center", va="center", fontsize=8.2,
                        color="white" if value >= 58 else INK,
                        fontweight="bold" if value >= 80 else "normal",
                    )
        sample = next((row for row in rows if row["segment"] == segment), None)
        count = sample["tokenSides"] if sample else 0
        axis.set_title(f"{title}\n{count} token sides", fontsize=13)
        axis.set_xticks(np.arange(len(buffers)), [f"+{buffer:g}c" for buffer in buffers])
        axis.set_xlabel("Maximum walk above best ask")
        axis.spines[:].set_visible(False)

    axes[0].set_yticks(np.arange(len(stakes)), [money_label(stake) for stake in stakes])
    axes[0].set_ylabel("Requested FOK stake")
    fig.suptitle("Displayed depth falls away as requested copy size rises", x=0.04, ha="left", fontsize=19, fontweight="bold")
    if image_handle is not None:
        colorbar_axis = fig.add_axes([0.938, 0.22, 0.014, 0.54])
        colorbar = fig.colorbar(image_handle, cax=colorbar_axis)
        colorbar.set_label("Books able to fill the entire FOK order")
    fig.text(
        0.04, 0.015,
        "Current cross-section of high-volume sports moneyline books from the official CLOB API. A fill means displayed asks could satisfy the whole order; it is not a post-signal backtest and the sample favors liquid markets.",
        color=MUTED, fontsize=9,
    )
    fig.subplots_adjust(top=0.82, bottom=0.16, left=0.08, right=0.91, wspace=0.12)
    return save_figure(fig, output_dir, "live_fok_capacity_surface")


def live_depth_survival(edge: dict, output_dir: Path) -> list[str]:
    rows = [row for row in edge["liveLiquidityCapacity"]["summary"] if row["segment"] == "all"]
    stakes = sorted({row["stakeUsdc"] for row in rows})
    buffers = sorted({row["bufferCents"] for row in rows})
    lookup = {(row["stakeUsdc"], row["bufferCents"]): row for row in rows}

    fig, axes = plt.subplots(1, 2, figsize=(14.6, 6.4))
    for index, buffer in enumerate(buffers):
        color = SERIES_COLORS[index % len(SERIES_COLORS)]
        fill_rates = [lookup[(stake, buffer)]["fillRatePct"] for stake in stakes]
        adverse = [lookup[(stake, buffer)]["p90VwapAdverseCents"] for stake in stakes]
        axes[0].plot(stakes, fill_rates, marker="o", linewidth=2.2, color=color, label=f"+{buffer:g}c")
        axes[1].plot(stakes, adverse, marker="o", linewidth=2.2, color=color, label=f"+{buffer:g}c")

    for axis in axes:
        axis.set_xscale("log")
        axis.set_xticks(stakes, [money_label(stake) for stake in stakes], rotation=35, ha="right")
        axis.grid(axis="y")
        axis.spines[["top", "right", "left"]].set_visible(False)
        axis.set_xlabel("Requested FOK stake")
    axes[0].set_ylim(0, 103)
    axes[0].set_ylabel("Full-fill rate across sampled books")
    axes[0].set_title("Probability displayed depth is sufficient", loc="left")
    axes[1].set_ylabel("90th percentile VWAP slippage (cents)")
    axes[1].set_title("Price paid when the order does fill", loc="left")
    axes[0].legend(title="Book-walk cap", ncols=2, loc="lower left")
    axes[1].legend(title="Book-walk cap", ncols=2, loc="upper left")
    fig.suptitle("Size creates rejection risk before it creates large measured slippage", x=0.04, ha="left", fontsize=19, fontweight="bold")
    fig.text(
        0.04, 0.015,
        "VWAP percentiles condition on complete fills, so rejected books disappear from the right panel. The apparent slippage ceiling is therefore not evidence that a large order can trade everywhere.",
        color=MUTED, fontsize=9,
    )
    fig.subplots_adjust(top=0.82, bottom=0.22, left=0.08, right=0.98, wspace=0.22)
    return save_figure(fig, output_dir, "live_depth_survival")


def historical_capacity_surface(edge: dict, output_dir: Path) -> list[str]:
    rows = [
        row for row in edge["historicalTapeCapacity"]["grid"]
        if row["strategy"] == "breadthHeldOut" and row["bufferCents"] == 1
    ]
    stakes = sorted({row["stakeUsdc"] for row in rows})
    windows = sorted({row["windowSeconds"] for row in rows})
    panels = [
        ("allPrints", 100, "All prints, 100% share"),
        ("allPrints", 25, "All prints, 25% share"),
        ("reportedAlignedBuys", 100, "Aligned BUYs, 100% share"),
    ]

    fig, axes = plt.subplots(1, 3, figsize=(15.4, 8.2), sharey=True)
    image_handle = None
    for axis, (proxy, participation, title) in zip(axes, panels):
        lookup = {
            (row["stakeUsdc"], row["windowSeconds"]): row["fillRatePct"]
            for row in rows
            if row["proxy"] == proxy and row["participationRatePct"] == participation
        }
        matrix = np.array([
            [lookup.get((stake, window), np.nan) for window in windows]
            for stake in stakes
        ])
        image_handle = vector_heatmap(axis, matrix, vmin=0, vmax=100, cmap="magma_r")
        for row_index in range(len(stakes)):
            for column_index in range(len(windows)):
                value = matrix[row_index, column_index]
                if not np.isnan(value):
                    axis.text(
                        column_index, row_index, f"{value:.0f}%",
                        ha="center", va="center", fontsize=8.2,
                        color="white" if value <= 42 else INK,
                    )
        axis.set_title(title, fontsize=13)
        axis.set_xticks(np.arange(len(windows)), [f"{window}s" for window in windows])
        axis.set_xlabel("Turnover accumulation window")
        axis.spines[:].set_visible(False)

    axes[0].set_yticks(np.arange(len(stakes)), [money_label(stake) for stake in stakes])
    axes[0].set_ylabel("Requested stake")
    fig.suptitle("After a broad sweep, historical public turnover is scarce at copy-bot speed", x=0.04, ha="left", fontsize=19, fontweight="bold")
    if image_handle is not None:
        colorbar_axis = fig.add_axes([0.938, 0.22, 0.014, 0.54])
        colorbar = fig.colorbar(image_handle, cax=colorbar_axis)
        colorbar.set_label("Held-out signals with enough observed turnover")
    fig.text(
        0.04, 0.015,
        "Twenty-one held-out breadth signals, +1c price buffer. Public prints accumulate over each window; they are not a simultaneous ask book. All-prints is an optimistic direction-neutral ceiling, while aligned BUYs is narrower but noisy.",
        color=MUTED, fontsize=9,
    )
    fig.subplots_adjust(top=0.82, bottom=0.16, left=0.08, right=0.91, wspace=0.12)
    return save_figure(fig, output_dir, "historical_capacity_surface")


def historical_size_projection(edge: dict, output_dir: Path) -> list[str]:
    rows = [
        row for row in edge["historicalTapeCapacity"]["grid"]
        if row["strategy"] == "breadthHeldOut"
        and row["proxy"] == "allPrints"
        and row["bufferCents"] == 1
        and row["participationRatePct"] == 25
    ]
    stakes = sorted({row["stakeUsdc"] for row in rows})
    windows = sorted({row["windowSeconds"] for row in rows})
    lookup = {(row["stakeUsdc"], row["windowSeconds"]): row for row in rows}

    fig, axes = plt.subplots(1, 2, figsize=(14.6, 6.4))
    for index, window in enumerate(windows):
        color = SERIES_COLORS[index % len(SERIES_COLORS)]
        fill_rates = [lookup[(stake, window)]["fillRatePct"] for stake in stakes]
        requested_returns = [lookup[(stake, window)]["returnOnRequestedQuotePct"] for stake in stakes]
        axes[0].plot(stakes, fill_rates, marker="o", linewidth=2.2, color=color, label=f"{window}s")
        axes[1].plot(stakes, requested_returns, marker="o", linewidth=2.2, color=color, label=f"{window}s")

    for axis in axes:
        axis.set_xscale("log")
        axis.set_xticks(stakes, [money_label(stake) for stake in stakes], rotation=35, ha="right")
        axis.axhline(0, color=INK, linewidth=1)
        axis.grid(axis="y")
        axis.spines[["top", "right", "left"]].set_visible(False)
        axis.set_xlabel("Requested stake per signal")
    axes[0].set_ylim(0, 103)
    axes[0].set_ylabel("Signals with enough observed turnover")
    axes[0].set_title("Capacity coverage", loc="left")
    axes[1].set_ylabel("Retrospective profit / requested stake (%)")
    axes[1].set_title("Outcome-weighted projection", loc="left")
    axes[0].legend(title="Accumulation window", ncols=2, loc="upper right")
    axes[1].legend(title="Accumulation window", ncols=2, loc="upper right")
    fig.suptitle("Bigger requested stakes turn a strategy into a sparse fill lottery", x=0.04, ha="left", fontsize=19, fontweight="bold")
    fig.text(
        0.04, 0.012,
        "Held-out breadth signals, optimistic all-print turnover, +1c, and only 25% participation. The right panel uses known outcomes after selecting capacity-covered events; it is descriptive and selection-biased, not an investable return forecast.",
        color=MUTED, fontsize=9,
    )
    fig.subplots_adjust(top=0.82, bottom=0.22, left=0.08, right=0.98, wspace=0.22)
    return save_figure(fig, output_dir, "historical_size_projection")


def capacity_reality_gap(edge: dict, output_dir: Path) -> list[str]:
    live_rows = [
        row for row in edge["liveLiquidityCapacity"]["summary"]
        if row["segment"] == "all" and row["bufferCents"] == 1
    ]
    historical_rows = [
        row for row in edge["historicalTapeCapacity"]["grid"]
        if row["strategy"] == "breadthHeldOut"
        and row["proxy"] == "allPrints"
        and row["bufferCents"] == 1
        and row["participationRatePct"] == 100
        and row["windowSeconds"] in (1, 60)
    ]
    stakes = sorted({row["stakeUsdc"] for row in live_rows})
    live_lookup = {row["stakeUsdc"]: row["fillRatePct"] for row in live_rows}
    historical_lookup = {
        (row["stakeUsdc"], row["windowSeconds"]): row["fillRatePct"]
        for row in historical_rows
    }

    fig, axis = plt.subplots(figsize=(12.8, 7.0))
    axis.plot(stakes, [live_lookup[stake] for stake in stakes], color=POSITIVE, marker="o", linewidth=3, label="Current generic book: immediate FOK")
    axis.plot(stakes, [historical_lookup[(stake, 1)] for stake in stakes], color=NEGATIVE, marker="o", linewidth=2.5, label="After target sweep: 1s turnover ceiling")
    axis.plot(stakes, [historical_lookup[(stake, 60)] for stake in stakes], color=SECONDARY, marker="o", linewidth=2.5, label="After target sweep: 60s turnover ceiling")
    axis.set_xscale("log")
    axis.set_xticks(stakes, [money_label(stake) for stake in stakes], rotation=30, ha="right")
    axis.set_ylim(0, 103)
    axis.set_xlabel("Requested stake at +1c")
    axis.set_ylabel("Books/signals with enough measured capacity")
    axis.set_title("A liquid market before the whale trades is not liquid after the whale trades", loc="left", fontsize=18)
    axis.grid(axis="y")
    axis.spines[["top", "right", "left"]].set_visible(False)
    axis.legend(loc="lower left")
    fig.text(
        0.04, 0.012,
        "The green line is current displayed ask depth in a favorable top-volume sample. Historical lines are cumulative prints after 21 held-out broad sweeps and therefore optimistic ceilings, not FOK books. The comparison diagnoses the timing problem; it is not an apples-to-apples estimator.",
        color=MUTED, fontsize=9,
    )
    fig.subplots_adjust(bottom=0.22, left=0.09, right=0.98, top=0.88)
    return save_figure(fig, output_dir, "capacity_reality_gap")


def closing_line_validation(edge: dict, output_dir: Path) -> list[str]:
    audit = edge["closingLineAudit"]
    events = audit["events"]
    broad = [event for event in events if event["onchainUniqueMakers"] >= 18]
    narrow = [event for event in events if event["onchainUniqueMakers"] < 18]

    fig, axes = plt.subplots(1, 2, figsize=(14.6, 6.5), gridspec_kw={"width_ratios": [1.45, 1]})
    ordered = sorted(events, key=lambda event: event["signalTimestamp"])
    dates = [datetime.fromtimestamp(event["signalTimestamp"], tz=timezone.utc) for event in ordered]
    colors = [POSITIVE if event["onchainUniqueMakers"] >= 18 else MUTED for event in ordered]
    markers = ["o" if event["won"] else "X" for event in ordered]
    for date, event, color, marker in zip(dates, ordered, colors, markers):
        axes[0].scatter(date, event["closingLineValueCents"], color=color, marker=marker, s=58, alpha=0.92)
    axes[0].axhline(0, color=INK, linewidth=1)
    axes[0].xaxis.set_major_formatter(mdates.DateFormatter("%b %d"))
    axes[0].tick_params(axis="x", rotation=35)
    axes[0].set_ylabel("Closing line value (cents)")
    axes[0].set_title("Every eligible pregame signal", loc="left")
    axes[0].grid(axis="y")
    axes[0].spines[["top", "right", "left"]].set_visible(False)

    distributions = [
        [event["closingLineValueCents"] for event in narrow],
        [event["closingLineValueCents"] for event in broad],
    ]
    positions = [0, 1]
    parts = axes[1].violinplot(distributions, positions=positions, showextrema=False, widths=0.72)
    for body, color in zip(parts["bodies"], [MUTED, POSITIVE]):
        body.set_facecolor(color)
        body.set_alpha(0.22)
        body.set_edgecolor(color)
    for position, values, color in zip(positions, distributions, [MUTED, POSITIVE]):
        jitter = np.linspace(-0.16, 0.16, len(values)) if values else []
        axes[1].scatter(np.array(jitter) + position, values, color=color, s=42, alpha=0.86)
        median = float(np.median(values))
        axes[1].plot([position - 0.22, position + 0.22], [median, median], color=INK, linewidth=3)
        axes[1].text(position, median + 0.65, f"median {median:+.2f}c", ha="center", fontsize=9, fontweight="bold")
    axes[1].axhline(0, color=INK, linewidth=1)
    axes[1].set_xticks(positions, [f"Narrow\nn={len(narrow)}", f"Broad >=18\nn={len(broad)}"])
    axes[1].set_ylabel("Closing line value (cents)")
    axes[1].set_title("Breadth does not improve CLV", loc="left")
    axes[1].grid(axis="y")
    axes[1].spines[["top", "right", "left"]].set_visible(False)
    fig.suptitle("The market did not validate the wallet's broad sweeps before play", x=0.04, ha="left", fontsize=19, fontweight="bold")
    fig.text(
        0.04, 0.012,
        "Green denotes broad sweeps; circles won and X marks lost. CLV is the final non-target public print before recorded start minus trigger price. Broad median was -0.67c; only 4/12 were positive (one-sided sign p=0.927).",
        color=MUTED, fontsize=9,
    )
    fig.subplots_adjust(top=0.82, bottom=0.19, left=0.08, right=0.98, wspace=0.24)
    return save_figure(fig, output_dir, "closing_line_validation")


def compact_fresh_mechanism(edge: dict, output_dir: Path) -> list[str]:
    mechanism = edge["compactFreshMechanism"]
    broad = edge["atomicBreadthEdge"]
    labels = ["Development", "Held-out", "All history"]
    compact_roi = [mechanism["development"]["roiPct"], mechanism["heldOut"]["roiPct"], mechanism["all"]["roiPct"]]
    broad_roi = [
        broad["chronology"]["development"]["roiPct"],
        broad["chronology"]["heldOutAfterDevelopment"]["roiPct"],
        broad["all"]["roiPct"],
    ]
    positions = np.arange(len(labels))
    width = 0.36

    fig, axes = plt.subplots(1, 2, figsize=(14.6, 6.6), gridspec_kw={"width_ratios": [1.35, 1]})
    broad_bars = axes[0].bar(positions - width / 2, broad_roi, width, color=SECONDARY, label="Breadth >=18")
    compact_bars = axes[0].bar(positions + width / 2, compact_roi, width, color=POSITIVE, label="+ compact and fresh")
    for bars, values in ((broad_bars, broad_roi), (compact_bars, compact_roi)):
        for bar, value in zip(bars, values):
            axes[0].text(bar.get_x() + bar.get_width() / 2, value + 2.2, f"{value:+.1f}%", ha="center", fontsize=9, fontweight="bold")
    axes[0].axhline(0, color=INK, linewidth=1)
    axes[0].set_xticks(positions, labels)
    axes[0].set_ylabel("Equal-stake ROI after 60s + 5c and fees")
    axes[0].set_title("The exploratory geometry concentrates returns", loc="left")
    axes[0].grid(axis="y")
    axes[0].spines[["top", "right", "left"]].set_visible(False)
    axes[0].legend(loc="upper center", ncols=2)

    groups = [mechanism["all"], mechanism["otherBroadSweeps"]]
    group_labels = ["Compact + fresh", "Other broad"]
    wins = [group["wins"] for group in groups]
    losses = [group["bets"] - group["wins"] for group in groups]
    axes[1].bar(group_labels, wins, color=POSITIVE, label="Wins")
    axes[1].bar(group_labels, losses, bottom=wins, color=NEGATIVE, label="Losses")
    for index, group in enumerate(groups):
        axes[1].text(index, group["bets"] + 0.6, f"{group['wins']}/{group['bets']}", ha="center", fontweight="bold")
    axes[1].set_ylabel("Resolved signals")
    axes[1].set_title("11/12 versus 12/18", loc="left")
    axes[1].grid(axis="y")
    axes[1].spines[["top", "right", "left"]].set_visible(False)
    axes[1].legend(loc="lower right")
    fig.suptitle("The closest observed fingerprint: many fresh makers, few price levels", x=0.04, ha="left", fontsize=19, fontweight="bold")
    fig.text(
        0.04, 0.012,
        "Definition selected on development data: >=18 makers, <=3 price levels, median maker age <=300s. Held-out: 6/7 and +63.17%, but day-cluster 95% CI spans -8.69% to +110.42%; this post-hoc mechanism is a lead, not a cracked private signal.",
        color=MUTED, fontsize=9,
    )
    fig.subplots_adjust(top=0.82, bottom=0.18, left=0.08, right=0.98, wspace=0.24)
    return save_figure(fig, output_dir, "compact_fresh_mechanism")


def public_follower_lead_lag(edge: dict, output_dir: Path) -> list[str]:
    audit = edge["publicFollowerLeadLag"]
    selected_lags = [0, 1, 2, 3, 5, 10, 15, 30, 60]
    positions = np.arange(len(selected_lags))
    fig, axis = plt.subplots(figsize=(14.6, 6.8))
    series = [
        ("compactFreshBreadth", "Compact + fresh: aligned BUY", POSITIVE, "alignedBuyMove"),
        ("otherBroad", "Other broad sweeps: aligned BUY", NEGATIVE, "alignedBuyMove"),
        ("compactFreshBreadth", "Compact + fresh: direction-neutral print", SECONDARY, "directionNeutralMove"),
    ]
    for group_key, label, color, measure in series:
        rows = {
            row["lagSeconds"]: row for row in audit["groups"][group_key]["lags"]
        }
        values = np.array([rows[lag][measure]["meanCents"] for lag in selected_lags])
        axis.plot(positions, values, marker="o", linewidth=2.3, color=color, label=label)
        if measure == "alignedBuyMove":
            lower = np.array([rows[lag][measure]["ci95LowCents"] for lag in selected_lags])
            upper = np.array([rows[lag][measure]["ci95HighCents"] for lag in selected_lags])
            axis.fill_between(positions, lower, upper, color=color, alpha=0.12)
    axis.axhline(0, color=INK, linewidth=1)
    axis.axvspan(-0.35, 6.35, color=ACCENT, alpha=0.07)
    axis.text(3.0, axis.get_ylim()[1] * 0.90, "first 15 seconds", ha="center", color=MUTED)
    axis.set_xticks(positions, [str(lag) for lag in selected_lags])
    axis.set_xlabel("Seconds after the target transaction became observable")
    axis.set_ylabel("Mean price move from the pre-signal public mark (cents)")
    axis.set_title("Aligned public buyers follow the compact-fresh footprint", loc="left")
    axis.grid(axis="y")
    axis.spines[["top", "right", "left"]].set_visible(False)
    axis.legend(loc="lower left", ncols=3, fontsize=9)
    fig.suptitle(
        "The target appears before part of the reaction, but that reaction is a copier's cost",
        x=0.04, ha="left", fontsize=19, fontweight="bold",
    )
    fig.text(
        0.04, 0.012,
        "Compact + fresh n=12 across 9 UTC-day clusters; other broad n=18. Shading is the day-cluster 95% bootstrap interval for aligned BUY prints. Same-second ordering is unavailable, and this is mechanism evidence rather than a profitable entry rule.",
        color=MUTED, fontsize=9,
    )
    fig.subplots_adjust(top=0.84, bottom=0.19, left=0.09, right=0.98)
    return save_figure(fig, output_dir, "public_follower_lead_lag")


def esports_moat_audit(edge: dict, output_dir: Path) -> list[str]:
    audit = edge["esportsMoatAudit"]
    deployment = audit["walletDeployment"]
    broad = audit["frozenBreadthSignals"]
    fig, axes = plt.subplots(1, 3, figsize=(15.8, 6.6), gridspec_kw={"width_ratios": [0.9, 1.1, 1.45]})

    shares = [deployment["shareOfWalletCostBasisPct"], deployment["shareOfWalletRealizedPnlPct"]]
    labels = ["Cost basis", "Realized P&L"]
    bars = axes[0].barh(labels, shares, color=[SECONDARY, POSITIVE], height=0.55)
    axes[0].bar_label(bars, labels=[f"{value:.1f}%" for value in shares], padding=4, fontweight="bold")
    axes[0].set_xlim(0, 70)
    axes[0].set_xlabel("Esports share of wallet")
    axes[0].set_title("Large deployment", loc="left")
    axes[0].grid(axis="x")
    axes[0].spines[["top", "right", "left"]].set_visible(False)

    categories = ["Esports", "Traditional sports"]
    category_rows = [broad["esports"], broad["traditionalSports"]]
    positions = np.arange(2)
    width = 0.36
    roi = [row["roiPct"] for row in category_rows]
    calibration = [row["calibration"]["calibrationGapPctPoints"] for row in category_rows]
    roi_bars = axes[1].bar(positions - width / 2, roi, width, color=POSITIVE, label="Copy ROI")
    cal_bars = axes[1].bar(positions + width / 2, calibration, width, color=ACCENT, label="Calibration gap")
    axes[1].bar_label(roi_bars, labels=[f"{value:+.1f}%" for value in roi], padding=3, fontsize=9)
    axes[1].bar_label(cal_bars, labels=[f"{value:+.1f}pp" for value in calibration], padding=3, fontsize=9)
    axes[1].set_xticks(positions, [f"{label}\nn={row['bets']}" for label, row in zip(categories, category_rows)])
    axes[1].set_ylabel("Percent / percentage points")
    axes[1].set_ylim(0, 52)
    axes[1].set_title("Frozen broad sweeps", loc="left")
    axes[1].grid(axis="y")
    axes[1].spines[["top", "right", "left"]].set_visible(False)
    axes[1].legend(loc="upper center", ncols=2, fontsize=9)

    discipline_rows = broad["byDiscipline"]
    short_names = {
        "Counter-Strike": "CS2",
        "Dota 2": "Dota 2",
        "League of Legends": "LoL",
        "Soccer": "Soccer",
        "Tennis": "Tennis",
        "Valorant": "Valorant",
    }
    discipline_labels = [short_names[row["discipline"]] for row in discipline_rows]
    values = [row["roiPct"] for row in discipline_rows]
    colors = [POSITIVE if row["category"] == "esports" else SECONDARY for row in discipline_rows]
    discipline_bars = axes[2].bar(np.arange(len(values)), values, color=colors)
    for bar, row in zip(discipline_bars, discipline_rows):
        offset = 4 if row["roiPct"] >= 0 else -8
        axes[2].text(
            bar.get_x() + bar.get_width() / 2, row["roiPct"] + offset,
            f"{row['roiPct']:+.0f}%\nn={row['bets']}", ha="center",
            va="bottom" if row["roiPct"] >= 0 else "top", fontsize=8.5, fontweight="bold",
        )
    axes[2].axhline(0, color=INK, linewidth=1)
    axes[2].set_xticks(np.arange(len(values)), discipline_labels)
    axes[2].set_ylabel("Frozen broad-sweep ROI")
    axes[2].set_title("Dota leads esports, not all sports", loc="left")
    axes[2].grid(axis="y")
    axes[2].spines[["top", "right", "left"]].set_visible(False)
    axes[2].set_ylim(min(values) - 25, max(values) + 35)

    fig.suptitle("Esports is important; the evidence does not establish it as the unique moat", x=0.03, ha="left", fontsize=19, fontweight="bold")
    fig.text(
        0.03, 0.012,
        f"Wallet esports: USD {deployment['costBasisUsdc'] / 1e6:.1f}M cost basis, USD {deployment['realizedPnlUsdc'] / 1e6:.2f}M P&L, {deployment['roiPct']:.2f}% ROI. Frozen 60s + 5c replay; compact-fresh contains only {broad['esports']['compactFreshSignals']} esports versus {broad['traditionalSports']['compactFreshSignals']} traditional-sports signals. Small discipline samples were inspected retrospectively.",
        color=MUTED, fontsize=9,
    )
    fig.subplots_adjust(top=0.82, bottom=0.22, left=0.06, right=0.99, wspace=0.34)
    return save_figure(fig, output_dir, "esports_moat_audit")


def dota_live_telemetry_case(state_audit: dict, output_dir: Path) -> list[str]:
    spotlight = state_audit["spotlight"]
    timeline = spotlight["timeline"]
    fig, axes = plt.subplots(2, 1, figsize=(14.8, 9.0), gridspec_kw={"height_ratios": [1.15, 0.9]})

    gold = timeline["gold"]
    x_gold = np.array([row["secondsFromSignal"] for row in gold])
    y_gold = np.array([row["targetGoldAdvantage"] / 1_000 for row in gold])
    axes[0].plot(x_gold, y_gold, color=POSITIVE, linewidth=2.7, marker="o", markersize=4)
    axes[0].scatter([0], [spotlight["state"]["targetGoldAdvantage"] / 1_000], color=NEGATIVE, marker="D", s=75, zorder=5, label="Target sweep")
    axes[0].axvline(0, color=NEGATIVE, linewidth=1.2, linestyle="--")
    axes[0].axhline(0, color=INK, linewidth=0.8)
    key_objectives = [
        row for row in timeline["objectives"]
        if row.get("key") in ("npc_dota_goodguys_tower2_top", "npc_dota_goodguys_tower3_top")
    ]
    objective_labels = {
        "npc_dota_goodguys_tower2_top": "Top T2",
        "npc_dota_goodguys_tower3_top": "Top T3",
    }
    for index, objective in enumerate(key_objectives):
        x = objective["secondsFromSignal"]
        label = objective_labels.get(objective.get("key"), "Objective")
        axes[0].axvline(x, color=ACCENT, linewidth=1, alpha=0.65)
        axes[0].text(x - 2.5 + index * 5, 29, f"{label} {x:+.0f}s", rotation=90, va="top", ha="right", fontsize=8.5, color=MUTED)
    axes[0].axvspan(19, 20, color=ACCENT, alpha=0.18)
    axes[0].text(26, 17, "Top barracks\n+19/+20s", fontsize=8.5, color=MUTED, va="center")
    axes[0].set_xlim(-800, 270)
    axes[0].set_ylim(min(-1, y_gold.min() - 2), max(31, y_gold.max() + 3))
    axes[0].set_ylabel("Team Liquid gold advantage (thousands)")
    axes[0].set_title("At the sweep: Liquid +13.4k gold, +10.9k XP, kills 38–32", loc="left")
    axes[0].grid(axis="y")
    axes[0].spines[["top", "right", "left"]].set_visible(False)
    axes[0].legend(loc="upper left")

    marks = timeline["polymarketMarks"]
    public_marks = [row for row in marks if row["source"] != "target trigger"]
    axes[1].scatter(
        [row["secondsFromSignal"] for row in public_marks],
        [row["price"] for row in public_marks],
        color=SECONDARY, s=42, label="First aligned public BUY print",
    )
    axes[1].plot(
        [row["secondsFromSignal"] for row in public_marks],
        [row["price"] for row in public_marks],
        color=SECONDARY, linewidth=1, alpha=0.45,
    )
    axes[1].scatter([0], [spotlight["triggerPrice"]], color=NEGATIVE, marker="D", s=75, zorder=5, label="Target trigger price")
    axes[1].axhline(spotlight["stateModel"]["fairWinProbability"], color=POSITIVE, linewidth=2, label="Independent state-model fair value")
    axes[1].axhline(spotlight["stateModel"]["allInPrice"], color=ACCENT, linewidth=1.5, linestyle="--", label="1s + 1c + fee modeled entry")
    axes[1].axvline(0, color=NEGATIVE, linewidth=1.2, linestyle="--")
    axes[1].set_xlim(-5, 305)
    axes[1].set_ylim(0.20, 0.72)
    axes[1].set_xlabel("Seconds from target sweep")
    axes[1].set_ylabel("Liquid contract price / probability")
    axes[1].set_title("One verified state-aware trade; later BUY prints are not a continuous midprice", loc="left")
    axes[1].grid(axis="y")
    axes[1].spines[["top", "right", "left"]].set_visible(False)
    axes[1].legend(loc="upper right", ncols=2, fontsize=8.8)

    fig.suptitle("Dota case file: Falcons vs Liquid, August 5, 2026", x=0.04, ha="left", fontsize=19, fontweight="bold")
    fig.text(
        0.04, 0.012,
        "OpenDota match 8930940469. Liquid destroyed the top tier-two tower 7 seconds before the target's 30-maker sweep; the top tier-three fell 12 seconds after. Replay-derived OpenDota state verifies history but is not itself a live feed or a general strategy.",
        color=MUTED, fontsize=9,
    )
    fig.subplots_adjust(top=0.89, bottom=0.14, left=0.09, right=0.98, hspace=0.42)
    return save_figure(fig, output_dir, "dota_live_telemetry_case")


def dota_state_model_validation(state_audit: dict, output_dir: Path) -> list[str]:
    model = state_audit["independentStateModel"]
    test = model["chronologicalTest"]
    wallet = state_audit["stateModelWalletAudit"]
    fig, axes = plt.subplots(1, 3, figsize=(15.8, 6.3), gridspec_kw={"width_ratios": [1.3, 0.8, 1.0]})

    calibration = test["calibration"]
    predicted = [row["meanPrediction"] for row in calibration]
    actual = [row["actualWinRate"] for row in calibration]
    sizes = [max(35, row["observations"] / 2.5) for row in calibration]
    axes[0].plot([0, 1], [0, 1], color=MUTED, linestyle="--", linewidth=1.2, label="Perfect calibration")
    axes[0].plot(predicted, actual, color=POSITIVE, linewidth=2.2)
    axes[0].scatter(predicted, actual, s=sizes, color=POSITIVE, alpha=0.75, edgecolor="white", linewidth=0.8)
    axes[0].set_xlim(0, 1)
    axes[0].set_ylim(0, 1)
    axes[0].set_xlabel("Predicted win probability")
    axes[0].set_ylabel("Observed win rate")
    axes[0].set_title("Chronological calibration", loc="left")
    axes[0].grid()
    axes[0].spines[["top", "right"]].set_visible(False)
    axes[0].legend(loc="upper left", fontsize=9)

    brier_values = [test["brierScore"], test["coinFlipBrierScore"]]
    bars = axes[1].bar(["State model", "Coin flip"], brier_values, color=[POSITIVE, MUTED], width=0.62)
    axes[1].bar_label(bars, labels=[f"{value:.3f}" for value in brier_values], padding=4, fontweight="bold")
    axes[1].set_ylim(0, 0.29)
    axes[1].set_ylabel("Brier score (lower is better)")
    axes[1].set_title("Independent test", loc="left")
    axes[1].text(0.5, 0.04, f"ROC-AUC\n{test['rocAuc']:.3f}", ha="center", fontsize=12, fontweight="bold", transform=axes[1].transAxes)
    axes[1].grid(axis="y")
    axes[1].spines[["top", "right", "left"]].set_visible(False)

    sign = wallet["modelEdgeSignSeparation"]
    groups = [sign["nonnegative"], sign["negative"]]
    group_labels = ["Model edge >= 0", "Model edge < 0"]
    wins = [row["wins"] for row in groups]
    losses = [row["bets"] - row["wins"] for row in groups]
    axes[2].bar(group_labels, wins, color=POSITIVE, label="Wins")
    axes[2].bar(group_labels, losses, bottom=wins, color=NEGATIVE, label="Losses")
    for index, row in enumerate(groups):
        axes[2].text(index, row["bets"] + 0.25, f"{row['wins']}/{row['bets']}", ha="center", fontweight="bold")
    axes[2].set_ylim(0, max(row["bets"] for row in groups) + 1.5)
    axes[2].set_ylabel("Wallet-conditioned in-game signals")
    axes[2].set_title("Promising, but inspected later", loc="left")
    axes[2].grid(axis="y")
    axes[2].spines[["top", "right", "left"]].set_visible(False)
    axes[2].legend(loc="upper right")

    training = model["trainingData"]
    fig.suptitle("A real Dota state model was built without wallet outcomes", x=0.03, ha="left", fontsize=19, fontweight="bold")
    fig.text(
        0.03, 0.012,
        f"Training: {training['matches']:,} professional matches strictly before wallet signals. Chronological test: {test['matches']:,} later matches / {test['observations']:,} side observations. The 7-versus-5 wallet split is only 12 correlated, post-outcome-inspected observations (one-sided Fisher p={sign['fisherExactOneSidedPValue']:.3f}).",
        color=MUTED, fontsize=9,
    )
    fig.subplots_adjust(top=0.82, bottom=0.20, left=0.06, right=0.99, wspace=0.34)
    return save_figure(fig, output_dir, "dota_state_model_validation")


def dota_independent_falsification(state_audit: dict, dota: dict, output_dir: Path) -> list[str]:
    wallet_gate = state_audit["stateModelWalletAudit"]["fivePointGateAllFormats"]
    primary = dota["primary"]
    fig, axes = plt.subplots(1, 3, figsize=(16.0, 6.6), gridspec_kw={"width_ratios": [0.9, 1.25, 1.4]})

    labels = ["Wallet-conditioned\nlead", "Predeclared independent\nDota window"]
    values = [wallet_gate["roiPct"], primary["roiPct"]]
    bars = axes[0].bar(labels, values, color=[ACCENT, NEGATIVE], width=0.62)
    for bar, value, bets in zip(bars, values, [wallet_gate["bets"], primary["bets"]]):
        axes[0].text(
            bar.get_x() + bar.get_width() / 2, value + (4 if value >= 0 else -4),
            f"{value:+.1f}%\nn={bets}", ha="center",
            va="bottom" if value >= 0 else "top", fontweight="bold",
        )
    axes[0].axhline(0, color=INK, linewidth=1)
    axes[0].set_ylim(-25, 80)
    axes[0].set_ylabel("Paper ROI")
    axes[0].set_title("The lead did not replicate", loc="left")
    axes[0].grid(axis="y")
    axes[0].spines[["top", "right", "left"]].set_visible(False)

    sensitivity = [row for row in dota["executionSensitivity"] if row["slippageCents"] == 1 and row["lagSeconds"] in (0, 1, 5, 15, 60)]
    sensitivity.sort(key=lambda row: row["lagSeconds"])
    x = np.arange(len(sensitivity))
    fast_rows = [row for row in sensitivity if row["lagSeconds"] <= 15]
    axes[1].plot(
        np.arange(len(fast_rows)), [row["roiPct"] for row in fast_rows],
        color=NEGATIVE, marker="o", linewidth=2.3, label="Same 9-fill cohort",
    )
    sixty_index = next(index for index, row in enumerate(sensitivity) if row["lagSeconds"] == 60)
    sixty = sensitivity[sixty_index]
    axes[1].scatter([sixty_index], [sixty["roiPct"]], color=ACCENT, marker="D", s=72, zorder=4, label="Different 12-fill cohort")
    axes[1].axhline(0, color=INK, linewidth=1)
    for index, row in enumerate(sensitivity):
        axes[1].text(index, row["roiPct"] + (2 if row["roiPct"] >= 0 else -3), f"n={row['bets']}", ha="center", va="bottom" if row["roiPct"] >= 0 else "top", fontsize=8.5)
    axes[1].set_xticks(x, [f"{row['lagSeconds']}s" for row in sensitivity])
    axes[1].set_xlabel("Minimum delay; first later public print")
    axes[1].set_ylabel("ROI at +1 adverse cent and 3% fee")
    axes[1].set_title("The 0–15s cohort stays negative", loc="left")
    axes[1].grid(axis="y")
    axes[1].spines[["top", "right", "left"]].set_visible(False)
    axes[1].legend(loc="lower left", fontsize=8.5)

    bets = dota["primaryBets"]
    for won, color, label in ((True, POSITIVE, "Won"), (False, NEGATIVE, "Lost")):
        rows = [row for row in bets if row["won"] is won]
        axes[2].scatter(
            [row["gameMinute"] for row in rows], [row["returnPct"] for row in rows],
            color=color, s=72, label=label, edgecolor="white", linewidth=0.7, zorder=3,
        )
    axes[2].axhline(0, color=INK, linewidth=1)
    axes[2].axvline(8, color=ACCENT, linestyle="--", linewidth=1.3)
    axes[2].text(8.4, 105, "minute 8\npost-hoc split", color=MUTED, fontsize=8.5)
    axes[2].set_xlabel("Game minute when the model first signaled")
    axes[2].set_ylabel("Modeled return per $100")
    axes[2].set_title("All three losses signaled by minute 6", loc="left")
    axes[2].grid(axis="y")
    axes[2].spines[["top", "right", "left"]].set_visible(False)
    axes[2].legend(loc="upper right")

    fig.suptitle("Independent result: scoreboard state alone is not the target's alpha", x=0.03, ha="left", fontsize=19, fontweight="bold")
    fig.text(
        0.03, 0.012,
        f"Window declared before outcome review, August 25–26: {dota['coverage']['heldOutChildMarkets']} parsed markets, {dota['coverage']['modelSignals']} model signals, {primary['bets']} conservative print-proxy fills, {primary['wins']} wins, {primary['roiPct']:+.2f}% ROI. All fills occurred on one UTC day; no historical ask-depth proof. The minute-8 line was noticed after losses and is not a strategy.",
        color=MUTED, fontsize=9,
    )
    fig.subplots_adjust(top=0.82, bottom=0.21, left=0.06, right=0.99, wspace=0.33)
    return save_figure(fig, output_dir, "dota_independent_falsification")


def prospective_signal_audit(prospective: dict, output_dir: Path) -> list[str]:
    coverage = prospective["coverage"]
    candidates = prospective["candidates"]
    fig, axes = plt.subplots(1, 2, figsize=(14.8, 6.4), gridspec_kw={"width_ratios": [0.9, 1.4]})

    labels = ["Raw $25k / 70%", "Frozen universe", ">=18 makers"]
    values = [coverage["rawThresholdSignals"], coverage["frozenBaseEligibleSignals"], coverage["frozenBreadthEligibleSignals"]]
    bars = axes[0].bar(labels, values, color=[MUTED, SECONDARY, NEGATIVE], width=0.62)
    axes[0].bar_label(bars, labels=[str(value) for value in values], padding=4, fontweight="bold", fontsize=12)
    axes[0].set_ylim(0, max(values) + 2)
    axes[0].set_ylabel("Post-cutoff signals")
    axes[0].set_title("Frozen-rule funnel", loc="left")
    axes[0].text(0.02, 0.93, f"{coverage['postCutoffTrades']:,} new target trades\nacross {coverage['markets']} markets", transform=axes[0].transAxes, va="top", color=MUTED)
    axes[0].grid(axis="y")
    axes[0].spines[["top", "right", "left"]].set_visible(False)

    for candidate in candidates:
        in_universe = candidate["discipline"] != "MLB" and 0.30 <= candidate["triggerPrice"] <= 0.85
        axes[1].scatter(
            candidate["triggerPrice"], candidate["uniqueMakers"],
            s=90 if candidate["uniqueMakers"] >= 18 else 58,
            color=SECONDARY if in_universe else MUTED,
            marker="o" if in_universe else "X", edgecolor="white", linewidth=0.7,
        )
        if candidate["uniqueMakers"] >= 18:
            x_offset = -92 if candidate["triggerPrice"] > 0.45 else 12
            axes[1].annotate(
                f"MLB, {candidate['uniqueMakers']} makers\nexcluded universe",
                (candidate["triggerPrice"], candidate["uniqueMakers"]),
                xytext=(x_offset, -35), textcoords="offset points", fontsize=8.5,
                arrowprops={"arrowstyle": "-", "color": MUTED},
            )
    axes[1].axhline(18, color=NEGATIVE, linestyle="--", linewidth=1.4, label="Frozen breadth threshold")
    axes[1].axvspan(0.30, 0.85, color=POSITIVE, alpha=0.06, label="Frozen price range")
    axes[1].set_xlim(0.25, 1.0)
    axes[1].set_ylim(0, 45)
    axes[1].set_xlabel("Target trigger price")
    axes[1].set_ylabel("Distinct makers in decoded transaction")
    axes[1].set_title("No candidate cleared every frozen guard", loc="left")
    axes[1].grid(axis="y")
    axes[1].spines[["top", "right", "left"]].set_visible(False)
    axes[1].legend(loc="upper left")

    fig.suptitle("Prospective audit: zero qualifying observations, not zero return", x=0.04, ha="left", fontsize=19, fontweight="bold")
    fig.text(
        0.04, 0.012,
        "Frozen cutoff: August 25, 2026. Two post-cutoff sweeps reached 18 makers, both excluded MLB: Dodgers–Braves (40 makers; median age 5,597s) and Twins–Athletics (19 makers; median age 15s). With no qualifying breadth signal, this window can neither validate nor falsify profitability.",
        color=MUTED, fontsize=9,
    )
    fig.subplots_adjust(top=0.82, bottom=0.20, left=0.07, right=0.98, wspace=0.28)
    return save_figure(fig, output_dir, "prospective_signal_audit")


def live_probe_latency(live_probe: dict, output_dir: Path) -> list[str]:
    join = live_probe["dynamicGameJoin"]
    games = sorted(join["games"], key=lambda row: row["sportsToFirstBookMs"])
    labels = [row["gameId"] for row in games]
    query = np.array([row["queryLatencyMs"] for row in games])
    remainder = np.array([row["sportsToFirstBookMs"] - row["queryLatencyMs"] for row in games])
    positions = np.arange(len(games))
    fig, axes = plt.subplots(1, 2, figsize=(14.8, 6.4), gridspec_kw={"width_ratios": [1.45, 0.8]})

    axes[0].barh(positions, query, color=SECONDARY, label="Gamma gameId lookup")
    axes[0].barh(positions, remainder, left=query, color=POSITIVE, label="Subscribe to first book event")
    for index, row in enumerate(games):
        axes[0].text(row["sportsToFirstBookMs"] + 1.5, index, f"{row['sportsToFirstBookMs']} ms", va="center", fontsize=8.5, fontweight="bold")
    axes[0].axvline(100, color=ACCENT, linewidth=1.3, linestyle="--", label="0.1 second")
    axes[0].set_yticks(positions, labels)
    axes[0].set_xlim(0, max(125, max(row["sportsToFirstBookMs"] for row in games) + 18))
    axes[0].set_xlabel("Local receive-to-first-book latency (milliseconds)")
    axes[0].set_ylabel("Polymarket sports gameId")
    axes[0].set_title("Public sports-to-book join", loc="left")
    axes[0].grid(axis="x")
    axes[0].spines[["top", "right", "left"]].set_visible(False)
    axes[0].legend(loc="lower right", fontsize=8.5)

    bars = axes[1].bar(
        ["Join hits", "Join misses", "Dynamic tokens", "Tokens observed"],
        [join["hits"], join["misses"], join["dynamicAssets"], join["dynamicAssetsObserved"]],
        color=[POSITIVE, MUTED, SECONDARY, ACCENT], width=0.62,
    )
    axes[1].bar_label(bars, padding=4, fontweight="bold")
    axes[1].set_ylim(0, max(join["misses"], join["dynamicAssets"]) + 4)
    axes[1].set_ylabel("Count in 30-second capture")
    axes[1].set_title("End-to-end coverage", loc="left")
    axes[1].tick_params(axis="x", labelrotation=20)
    axes[1].grid(axis="y")
    axes[1].spines[["top", "right", "left"]].set_visible(False)

    fig.suptitle("The public plumbing is sub-second; fair value remains the missing input", x=0.04, ha="left", fontsize=19, fontweight="bold")
    fig.text(
        0.04, 0.012,
        f"Paper-only local capture on August 27, 2026: {join['gameIdsQueried']} sports gameIds, {join['hits']} active-market joins, zero errors, {join['observationCoveragePct']:.0f}% observation of newly subscribed tokens. Median sports-to-book latency was {join['sportsToFirstBookMs']['median']:.0f} ms. This measures data arrival, not order fill, signal quality, or parity with a licensed feed.",
        color=MUTED, fontsize=9,
    )
    fig.subplots_adjust(top=0.82, bottom=0.22, left=0.08, right=0.98, wspace=0.32)
    return save_figure(fig, output_dir, "live_probe_latency")


def esports_public_feed_reaction(reaction: dict, output_dir: Path) -> list[str]:
    transitions = [row for row in reaction["transitions"] if row["baselineAtPreviousState"]]
    offsets = [row["offsetSeconds"] for row in reaction["eventAlignedMidpoint"]]
    positions = np.arange(len(offsets))
    fig, axes = plt.subplots(
        1, 3, figsize=(16.2, 6.8), gridspec_kw={"width_ratios": [1.45, 1.2, 0.85]}
    )

    palette = [SECONDARY, POSITIVE, ACCENT, NEGATIVE, "#7C6F64", "#358A8A"]
    for index, transition in enumerate(transitions):
        values = [next(
            observation["moveFromPreviousStateCents"]
            for observation in transition["observations"]
            if observation["offsetSeconds"] == offset
        ) for offset in offsets]
        axes[0].plot(
            positions, values, color=palette[index % len(palette)],
            linewidth=1.35, alpha=0.58, marker="o", markersize=3,
        )
    aggregate = reaction["eventAlignedMidpoint"]
    means = [row["meanMoveFromPreviousStateCents"] for row in aggregate]
    axes[0].plot(
        positions, means, color=INK, linewidth=3, marker="o", markersize=6,
        label=f"Mean, n={len(transitions)}",
    )
    axes[0].axvline(offsets.index(0), color=NEGATIVE, linestyle="--", linewidth=1.3)
    axes[0].axhline(0, color=INK, linewidth=0.8)
    axes[0].set_xticks(positions, [f"{offset:g}s" for offset in offsets])
    axes[0].set_xlabel("Time from public sports score update")
    axes[0].set_ylabel("Beneficiary midpoint move from prior poll (cents)")
    axes[0].set_title("Most repricing was already visible", loc="left")
    axes[0].grid(axis="y")
    axes[0].spines[["top", "right", "left"]].set_visible(False)
    axes[0].legend(loc="upper left", fontsize=9)

    regime_rows = [row for row in transitions
                   if row["finalHalfCentBeneficialRegimeStartedRelativeToFeedMs"] is not None]
    game_ids = list(dict.fromkeys(row["gameId"] for row in regime_rows))
    game_positions = {game_id: index for index, game_id in enumerate(game_ids)}
    game_labels = {}
    for game_id in game_ids:
        row = next(item for item in regime_rows if item["gameId"] == game_id)
        game_labels[game_id] = f"{row['homeTeam']} vs {row['awayTeam']}"
    for index, row in enumerate(regime_rows):
        y = game_positions[row["gameId"]] + (index % 3 - 1) * 0.09
        value = row["finalHalfCentBeneficialRegimeStartedRelativeToFeedMs"] / 1_000
        axes[1].scatter(
            value, y, color=palette[index % len(palette)], s=72,
            edgecolor="white", linewidth=0.7, zorder=3,
        )
        axes[1].text(value + 0.45, y, f"{value:.2f}s", va="center", fontsize=8)
    axes[1].axvline(0, color=NEGATIVE, linestyle="--", linewidth=1.4, label="Public update")
    axes[1].set_yticks(
        np.arange(len(game_ids)), [game_labels[game_id] for game_id in game_ids], fontsize=8.5
    )
    axes[1].set_xlim(-22, 2.5)
    axes[1].set_xlabel("Start of final >=0.5c beneficiary regime")
    axes[1].set_title("Every persistent crossing came first", loc="left")
    axes[1].grid(axis="x")
    axes[1].spines[["top", "right", "left"]].set_visible(False)

    at_minus_one = next(row for row in aggregate if row["offsetSeconds"] == -1)
    at_feed = next(row for row in aggregate if row["offsetSeconds"] == 0)
    at_plus_one = next(row for row in aggregate if row["offsetSeconds"] == 1)
    at_plus_five = next(row for row in aggregate if row["offsetSeconds"] == 5)
    segments = [
        at_minus_one["meanMoveFromPreviousStateCents"],
        at_feed["meanMoveFromPreviousStateCents"] - at_minus_one["meanMoveFromPreviousStateCents"],
        at_plus_one["meanMoveFromPreviousStateCents"] - at_feed["meanMoveFromPreviousStateCents"],
        at_plus_five["meanMoveFromPreviousStateCents"] - at_plus_one["meanMoveFromPreviousStateCents"],
    ]
    labels = ["By -1s", "Last second", "0 to +1s", "+1 to +5s"]
    bars = axes[2].bar(
        labels, segments, color=[POSITIVE, ACCENT, NEGATIVE, SECONDARY], width=0.62
    )
    axes[2].bar_label(
        bars, labels=[f"{value:+.2f}c" for value in segments], padding=4, fontweight="bold"
    )
    axes[2].axhline(0, color=INK, linewidth=0.9)
    axes[2].set_ylabel("Incremental mean midpoint move")
    axes[2].set_title("Little remained after receipt", loc="left")
    axes[2].tick_params(axis="x", labelrotation=18)
    axes[2].grid(axis="y")
    axes[2].spines[["top", "right", "left"]].set_visible(False)

    games = len(set(row["gameId"] for row in transitions))
    fig.suptitle(
        "Live CS2 audit: this public score feed trailed the market in the captured sample",
        x=0.03, ha="left", fontsize=19, fontweight="bold",
    )
    fig.text(
        0.03, 0.012,
        f"Local receive-time event study: {len(transitions)} analyzable one-round updates across {games} games. The public feed exposed no authoritative round timestamp and refreshed about every {reaction['publicSportsCadenceMs']['medianDistinctStateInterval'] / 1_000:.1f}s. Midpoints are not fills. This diagnoses feed staleness; it does not identify the target wallet's vendor or prove a private-data moat.",
        color=MUTED, fontsize=9,
    )
    fig.subplots_adjust(top=0.82, bottom=0.22, left=0.065, right=0.99, wspace=0.33)
    return save_figure(fig, output_dir, "esports_public_feed_reaction")


def cs2_wallet_state_cases(case_audit: dict, output_dir: Path) -> list[str]:
    m80 = case_audit["cases"]["m80"]
    g2_m80 = case_audit["cases"]["g2M80"]
    population = case_audit["populationAudit"]
    first_timestamp = m80["targetFills"][0]["timestamp"]
    round_win_timestamp = datetime.fromisoformat(
        m80["roundWinBroadcastState"]["observedAt"].replace("Z", "+00:00")
    ).timestamp()
    round_win_offset = round_win_timestamp - first_timestamp
    fig, axes = plt.subplots(2, 2, figsize=(16.2, 10.6))

    tape = [row for row in m80["publicTape"]["bySecond"]
            if -42 <= row["timestamp"] - first_timestamp <= 55]
    tape_x = np.array([row["timestamp"] - first_timestamp for row in tape])
    tape_low = np.array([row["equivalentPriceLow"] * 100 for row in tape])
    tape_high = np.array([row["equivalentPriceHigh"] * 100 for row in tape])
    tape_vwap = np.array([row["equivalentPriceVwap"] * 100 for row in tape])
    axes[0, 0].vlines(tape_x, tape_low, tape_high, color=GRID, linewidth=2, alpha=0.8)
    axes[0, 0].scatter(
        tape_x, tape_vwap, s=14, color=MUTED, alpha=0.7, label="Public taker prints"
    )

    fill_groups = {}
    for fill in m80["targetFills"]:
        key = (fill["timestamp"], fill["role"])
        current = fill_groups.setdefault(key, {"quote": 0, "shares": 0, "priceQuote": 0})
        current["quote"] += fill["quoteNotionalUsdc"]
        current["shares"] += fill["shares"]
        current["priceQuote"] += fill["price"] * fill["shares"]
    maximum_fill = max(row["quote"] for row in fill_groups.values())
    for role, color, marker in (("TAKER", NEGATIVE, "^"), ("MAKER", POSITIVE, "o")):
        rows = [(timestamp, row) for (timestamp, row_role), row in fill_groups.items()
                if row_role == role]
        axes[0, 0].scatter(
            [timestamp - first_timestamp for timestamp, _ in rows],
            [row["priceQuote"] / row["shares"] * 100 for _, row in rows],
            s=[70 + 480 * np.sqrt(row["quote"] / maximum_fill) for _, row in rows],
            color=color, marker=marker, edgecolor="white", linewidth=1.1,
            zorder=4, label=f"Target {role.lower()} fills",
        )
    axes[0, 0].axvline(0, color=INK, linestyle="--", linewidth=1.2)
    axes[0, 0].axvline(round_win_offset, color=ACCENT, linestyle="--", linewidth=1.6)
    axes[0, 0].annotate(
        "First target fill: 74c\n9-6, bomb planted, 5v3",
        xy=(0, 74), xytext=(-39, 68.8),
        arrowprops={"arrowstyle": "->", "color": INK}, fontsize=9.5, fontweight="bold",
    )
    axes[0, 0].annotate(
        "10-6 visible\non broadcast",
        xy=(round_win_offset, 75), xytext=(14, 69.7),
        arrowprops={"arrowstyle": "->", "color": ACCENT}, fontsize=9.5,
    )
    axes[0, 0].set_xlim(-42, 55)
    axes[0, 0].set_ylim(67, 83)
    axes[0, 0].set_xlabel("Seconds from first target fill")
    axes[0, 0].set_ylabel("M80-equivalent public price (cents)")
    axes[0, 0].set_title("NAVI-M80: state first, then passive size", loc="left")
    axes[0, 0].grid(axis="y")
    axes[0, 0].spines[["top", "right", "left"]].set_visible(False)
    axes[0, 0].legend(loc="upper left", fontsize=8.5, ncols=2)

    labels = ["G2-M80\nAug 12", "NAVI-M80\nAug 26"]
    entry = [g2_m80["passiveCluster"]["makerVwap"] * 100,
             m80["passiveCluster"]["makerVwap"] * 100]
    payout = [0, 100]
    for index, (start, end) in enumerate(zip(entry, payout)):
        color = NEGATIVE if end < start else POSITIVE
        axes[0, 1].plot([index, index], [start, end], color=color, linewidth=4, alpha=0.72)
        axes[0, 1].scatter(index, start, color=INK, s=100, zorder=3)
        axes[0, 1].scatter(index, end, color=color, s=120, zorder=3)
        axes[0, 1].text(index + 0.05, start, f"quote {start:.0f}c", va="center", fontsize=9)
    axes[0, 1].text(
        0, 57,
        "G2 12-11 M80\nRound 24, 0:19, no plant, 3v3\n18 counterparties; M80 lost",
        ha="center", va="center", fontsize=9.5,
    )
    axes[0, 1].text(
        1, 47,
        "M80 10-6 NAVI\nRound already won before passive burst\n19 counterparties; M80 won",
        ha="center", va="center", fontsize=9.5,
    )
    axes[0, 1].set_xticks([0, 1], labels)
    axes[0, 1].set_xlim(-0.45, 1.55)
    axes[0, 1].set_ylim(-5, 106)
    axes[0, 1].set_ylabel("Cluster quote and settlement value (cents)")
    axes[0, 1].set_title("Same team and mechanism; different live state", loc="left")
    axes[0, 1].grid(axis="y")
    axes[0, 1].spines[["top", "right", "left"]].set_visible(False)

    fill_timestamps = sorted(set(row["timestamp"] for row in m80["targetFills"]))
    running = {"MAKER": 0, "TAKER": 0}
    maker_curve = []
    taker_curve = []
    for timestamp in fill_timestamps:
        for row in m80["targetFills"]:
            if row["timestamp"] == timestamp:
                running[row["role"]] += row["quoteNotionalUsdc"]
        maker_curve.append(running["MAKER"] / 1_000)
        taker_curve.append(running["TAKER"] / 1_000)
    fill_x = [timestamp - first_timestamp for timestamp in fill_timestamps]
    axes[1, 0].step(fill_x, taker_curve, where="post", color=NEGATIVE, linewidth=2.5,
                    label="Aggressive quote")
    axes[1, 0].step(fill_x, maker_curve, where="post", color=POSITIVE, linewidth=2.5,
                    label="Passive quote")
    axes[1, 0].step(
        fill_x, np.array(taker_curve) + np.array(maker_curve), where="post",
        color=INK, linewidth=2.7, label="Total",
    )
    axes[1, 0].axvline(round_win_offset, color=ACCENT, linestyle="--", linewidth=1.5)
    axes[1, 0].text(fill_x[-1] + 0.8, maker_curve[-1], f"${maker_curve[-1]:.1f}k passive",
                    va="center", color=POSITIVE, fontweight="bold")
    axes[1, 0].text(fill_x[-1] + 0.8, taker_curve[-1], f"${taker_curve[-1]:.1f}k aggressive",
                    va="center", color=NEGATIVE, fontweight="bold")
    axes[1, 0].set_xlim(-1, 33)
    axes[1, 0].set_ylim(0, 70)
    axes[1, 0].set_xlabel("Seconds from first target fill")
    axes[1, 0].set_ylabel("Cumulative target quote (thousand USDC)")
    axes[1, 0].set_title("79% of the winning position was passive", loc="left")
    axes[1, 0].grid(axis="y")
    axes[1, 0].spines[["top", "right", "left"]].set_visible(False)
    axes[1, 0].legend(loc="upper left", ncols=3, fontsize=8.5)

    sensitivity = population["thresholdSensitivity"]
    threshold_x = [row["minimumCounterparties"] for row in sensitivity]
    threshold_roi = [row["roiPct"] for row in sensitivity]
    axes[1, 1].plot(threshold_x, threshold_roi, color=NEGATIVE, linewidth=3, marker="o")
    axes[1, 1].axhline(0, color=INK, linewidth=1)
    axes[1, 1].axvline(18, color=ACCENT, linestyle="--", linewidth=1.5)
    selected = next(row for row in sensitivity if row["minimumCounterparties"] == 18)
    axes[1, 1].scatter(18, selected["roiPct"], s=130, color=ACCENT, edgecolor="white", zorder=4)
    axes[1, 1].annotate(
        f"18 counterparties: {selected['wins']}/{selected['resolvedSignals']} wins\n"
        f"{selected['roiPct']:.1f}% ROI",
        xy=(18, selected["roiPct"]), xytext=(12.2, -42),
        arrowprops={"arrowstyle": "->", "color": ACCENT}, fontsize=9.5, fontweight="bold",
    )
    axes[1, 1].set_xlim(9.5, 30.5)
    axes[1, 1].set_ylim(-106, 8)
    axes[1, 1].set_xlabel("Minimum observed taker counterparties")
    axes[1, 1].set_ylabel("Standalone passive-cluster ROI")
    axes[1, 1].set_title("Reverse breadth fails every threshold", loc="left")
    axes[1, 1].grid(axis="y")
    axes[1, 1].spines[["top", "right", "left"]].set_visible(False)

    fig.suptitle(
        "Wallet-linked CS2 audit: the moat is state selection, not copying or breadth",
        x=0.035, ha="left", fontsize=20, fontweight="bold",
    )
    fig.text(
        0.035, 0.012,
        f"Wallet fills and public taker tape are joined by transaction hash. Broadcast frames are aligned to Twitch HLS PROGRAM-DATE-TIME. The generic reverse-breadth scan covered {population['markets']} traded markets: {population['all']['wins']}/{population['all']['resolvedSignals']} signals and {population['all']['roiPct']:.1f}% ROI at the mirrored $25k / 5s / 18-counterparty rule. Post-hoc state reconstruction diagnoses mechanism; it is not a prospective strategy test.",
        color=MUTED, fontsize=9,
    )
    fig.subplots_adjust(top=0.88, bottom=0.13, left=0.07, right=0.97, hspace=0.35, wspace=0.25)
    return save_figure(fig, output_dir, "cs2_wallet_state_cases")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--edge", default="research/djdjdjekekek/edge_analysis.json")
    parser.add_argument("--features", default="research/djdjdjekekek/edge_features.csv")
    parser.add_argument("--triggers", default="research/djdjdjekekek/trigger_transactions.json")
    parser.add_argument("--state", default="research/djdjdjekekek/esports_state_analysis.json")
    parser.add_argument("--dota", default="research/djdjdjekekek/dota_independent_backtest.json")
    parser.add_argument("--prospective", default="research/djdjdjekekek/prospective/prospective_audit.json")
    parser.add_argument("--live-probe", default="research/djdjdjekekek/prospective/live_probe_validation.json")
    parser.add_argument("--sports-reaction", default="research/djdjdjekekek/prospective/esports_reaction_analysis.json")
    parser.add_argument("--cs2-case", default="research/djdjdjekekek/prospective/cs2_case_audit.json")
    parser.add_argument("--output", default="research/djdjdjekekek/figures")
    args = parser.parse_args()

    with Path(args.edge).open(encoding="utf-8") as handle:
        edge = json.load(handle)
    features = pd.read_csv(args.features)
    with Path(args.triggers).open(encoding="utf-8") as handle:
        trigger_data = json.load(handle)
    with Path(args.state).open(encoding="utf-8") as handle:
        state_audit = json.load(handle)
    with Path(args.dota).open(encoding="utf-8") as handle:
        dota = json.load(handle)
    with Path(args.prospective).open(encoding="utf-8") as handle:
        prospective = json.load(handle)
    with Path(args.live_probe).open(encoding="utf-8") as handle:
        live_probe = json.load(handle)
    with Path(args.sports_reaction).open(encoding="utf-8") as handle:
        sports_reaction = json.load(handle)
    with Path(args.cs2_case).open(encoding="utf-8") as handle:
        cs2_case = json.load(handle)
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
    files.extend(live_fok_capacity_surface(edge, output_dir))
    files.extend(live_depth_survival(edge, output_dir))
    files.extend(historical_capacity_surface(edge, output_dir))
    files.extend(historical_size_projection(edge, output_dir))
    files.extend(capacity_reality_gap(edge, output_dir))
    files.extend(closing_line_validation(edge, output_dir))
    files.extend(compact_fresh_mechanism(edge, output_dir))
    files.extend(public_follower_lead_lag(edge, output_dir))
    files.extend(esports_moat_audit(edge, output_dir))
    files.extend(dota_live_telemetry_case(state_audit, output_dir))
    files.extend(dota_state_model_validation(state_audit, output_dir))
    files.extend(dota_independent_falsification(state_audit, dota, output_dir))
    files.extend(prospective_signal_audit(prospective, output_dir))
    files.extend(live_probe_latency(live_probe, output_dir))
    files.extend(esports_public_feed_reaction(sports_reaction, output_dir))
    files.extend(cs2_wallet_state_cases(cs2_case, output_dir))
    manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": {
            "edge": args.edge,
            "features": args.features,
            "triggers": args.triggers,
            "state": args.state,
            "dota": args.dota,
            "prospective": args.prospective,
            "liveProbe": args.live_probe,
            "sportsReaction": args.sports_reaction,
            "cs2Case": args.cs2_case,
        },
        "rendering": {
            "preferredFormat": "svg",
            "pngDpi": PNG_DPI,
        },
        "files": [str(Path(path).relative_to(output_dir.parent)) for path in files],
        "note": "Every figure is generated from committed research artifacts; reports use fully vector SVG, with print-grade PNG fallbacks carrying identical content.",
    }
    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Report graphics: {len(files) // 2} figures -> {output_dir}")


if __name__ == "__main__":
    main()
