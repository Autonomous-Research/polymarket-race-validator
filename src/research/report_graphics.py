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
import numpy as np
import pandas as pd

from edge_analysis import (
    CORE_DISCIPLINES,
    EXCLUDED_MARKET_TYPES,
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
            axis.text(x_value, y_value + (1.4 if y_value >= 0 else -2.2), f"{y_value:+.1f}%", ha="center", color=color, fontsize=9)
    axis.axhline(0, color=INK, linewidth=1.0)
    axis.set_xticks(slippage, [f"{value}c" for value in slippage])
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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--edge", default="research/djdjdjekekek/edge_analysis.json")
    parser.add_argument("--features", default="research/djdjdjekekek/edge_features.csv")
    parser.add_argument("--output", default="research/djdjdjekekek/figures")
    args = parser.parse_args()

    with Path(args.edge).open(encoding="utf-8") as handle:
        edge = json.load(handle)
    features = pd.read_csv(args.features)
    output_dir = Path(args.output)
    configure_style()
    files = []
    files.extend(blind_copy_funnel(edge, output_dir))
    files.extend(urgency_calibration(edge, output_dir))
    files.extend(strategy_equity(features, output_dir))
    files.extend(execution_sensitivity(edge, output_dir))
    files.extend(burst_threshold_sensitivity(edge, output_dir))
    manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": {
            "edge": args.edge,
            "features": args.features,
        },
        "files": [str(Path(path).relative_to(output_dir.parent)) for path in files],
        "note": "Every figure is generated from committed research artifacts; SVG and PNG carry identical content.",
    }
    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Report graphics: {len(files) // 2} figures -> {output_dir}")


if __name__ == "__main__":
    main()
