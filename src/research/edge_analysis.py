#!/usr/bin/env python3
"""Observable-signal reconstruction and leakage-controlled replication tests."""

from __future__ import annotations

import argparse
import json
from bisect import bisect_right
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import statsmodels.api as sm
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.metrics import mean_absolute_error, r2_score, roc_auc_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from scipy.stats import binomtest, fisher_exact, mannwhitneyu
from statsmodels.stats.contingency_tables import StratifiedTable


SEED = 20260825
BOOTSTRAP_DRAWS = 20_000
TARGET_FEE_RATE = 0.03
ONCHAIN_BREADTH_THRESHOLD = 18
ONCHAIN_BREADTH_CANDIDATES = tuple(range(5, 31))
CORE_DISCIPLINES = {
    "Tennis", "Soccer", "Dota 2", "Counter-Strike", "League of Legends", "Valorant"
}
EXCLUDED_MARKET_TYPES = {"single-game/map", "short-horizon binary"}
LAGS = (0, 1, 2, 3, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 300)
EXECUTION_SLIPPAGE_CENTS = (
    0, 0.5, 1, 1.5, 2, 3, 4, 5, 6, 7.5, 10, 12.5, 15, 17.5, 20, 25, 30
)
FEE_RATES = (0, 0.01, 0.02, 0.03, 0.04, 0.05)
CAPACITY_WINDOWS_SECONDS = (1, 5, 15, 30, 60)
CAPACITY_PRICE_BUFFERS_CENTS = (1, 2, 5, 10)
CAPACITY_PARTICIPATION_RATES = (0.05, 0.10, 0.25, 1.0)
CAPACITY_STAKES_USDC = (25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 25_000)
COMPACT_LEVEL_CANDIDATES = tuple(range(1, 7))
FRESH_AGE_CANDIDATES_SECONDS = (30, 60, 120, 300, 600, 1_800, 1_000_000_000)
MODEL_NUMERIC = [
    "triggerPrice", "concentration", "triggerFillShare", "takerBurst60Share",
    "makerShareBeforeSignal", "signalAgeSeconds", "preMomentum300",
    "externalFlow300", "pregame", "depositLagSeconds",
]
MODEL_CATEGORICAL = ["discipline", "marketType"]


def load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def finite(value):
    if value is None:
        return None
    value = float(value)
    return value if np.isfinite(value) else None


def parse_timestamp(value) -> int | None:
    if not value:
        return None
    try:
        return int(pd.Timestamp(value).timestamp())
    except (TypeError, ValueError):
        return None


def safe_div(numerator: float, denominator: float, default=np.nan) -> float:
    return numerator / denominator if denominator else default


def quantiles(values: list[float]) -> dict:
    values = np.asarray([value for value in values if np.isfinite(value)], dtype=float)
    if not len(values):
        return {"count": 0}
    return {
        "count": int(len(values)),
        "mean": finite(values.mean()),
        "median": finite(np.median(values)),
        "p10": finite(np.quantile(values, 0.10)),
        "p25": finite(np.quantile(values, 0.25)),
        "p75": finite(np.quantile(values, 0.75)),
        "p90": finite(np.quantile(values, 0.90)),
    }


def reconstruct_target_trades(snapshot: dict, enrichment: dict) -> dict[str, list[dict]]:
    activity = {
        row["transactionHash"]: row
        for row in snapshot.get("activity", [])
        if row.get("type") == "TRADE" and row.get("transactionHash")
    }
    taker_hashes = {
        row["transactionHash"] for row in enrichment.get("takerTrades", [])
        if row.get("transactionHash")
    }
    grouped: dict[str, list[dict]] = defaultdict(list)
    for raw in snapshot.get("trades", []):
        joined = activity.get(raw.get("transactionHash"), {})
        size = float(joined.get("size", raw.get("size", 0)) or 0)
        price = float(joined.get("price", raw.get("price", 0)) or 0)
        grouped[raw["conditionId"]].append({
            "timestamp": int(raw["timestamp"]),
            "transactionHash": raw.get("transactionHash"),
            "side": joined.get("side") or raw.get("side"),
            "outcome": joined.get("outcome") or raw.get("outcome"),
            "asset": str(joined.get("asset") or raw.get("asset") or ""),
            "size": size,
            "price": price,
            "quoteUsdc": size * price,
            "cashUsdc": float(joined.get("usdcSize", size * price) or 0),
            "role": "TAKER" if raw.get("transactionHash") in taker_hashes else "MAKER",
        })
    for rows in grouped.values():
        rows.sort(key=lambda row: (row["timestamp"], row["transactionHash"] or ""))
    return grouped


def last_deposit_features(deposits: list[dict], deposit_times: list[int], timestamp: int) -> tuple[float, float]:
    index = bisect_right(deposit_times, timestamp) - 1
    if index < 0:
        return np.nan, np.nan
    row = deposits[index]
    return timestamp - int(row["timestamp"]), float(row.get("usdcSize") or row.get("size") or 0)


def normalized_tape_rows(tape: dict, signal_outcome: str, target_wallet: str) -> list[dict]:
    outcome_index = next(
        (index for index, token in enumerate(tape["tokens"]) if token["outcome"] == signal_outcome),
        None,
    )
    if outcome_index is None:
        return []
    rows = []
    for timestamp, row_outcome, side_sign, price, shares, wallet_index in tape["rows"]:
        wallet = tape["wallets"][wallet_index]
        aligned = 1 if row_outcome == outcome_index else -1
        rows.append({
            "timestamp": int(timestamp),
            "price": float(price) if aligned == 1 else 1 - float(price),
            "direction": int(side_sign) * aligned,
            "shares": float(shares),
            "wallet": wallet,
            "isTarget": wallet == target_wallet,
        })
    return rows


def first_mark(
    rows: list[dict], timestamp: int, wait_seconds: int = 60, direction: int | None = None
) -> tuple[float, float]:
    eligible = [row for row in rows
                if not row["isTarget"]
                and timestamp <= row["timestamp"] <= timestamp + wait_seconds
                and (direction is None or row["direction"] == direction)]
    if not eligible:
        return np.nan, np.nan
    first_time = min(row["timestamp"] for row in eligible)
    prices = [row["price"] for row in eligible if row["timestamp"] == first_time]
    return float(np.median(prices)), first_time - timestamp


def last_mark(rows: list[dict], timestamp: int, lookback_seconds: int = 3_600) -> tuple[float, float]:
    eligible = [row for row in rows
                if not row["isTarget"] and timestamp - lookback_seconds <= row["timestamp"] <= timestamp]
    if not eligible:
        return np.nan, np.nan
    last_time = max(row["timestamp"] for row in eligible)
    prices = [row["price"] for row in eligible if row["timestamp"] == last_time]
    return float(np.median(prices)), timestamp - last_time


def flow_imbalance(rows: list[dict], start: int, end: int) -> float:
    eligible = [row for row in rows
                if not row["isTarget"] and start <= row["timestamp"] < end]
    gross = sum(row["shares"] for row in eligible)
    net = sum(row["direction"] * row["shares"] for row in eligible)
    return safe_div(net, gross)


def aligned_leaders(rows: list[dict], signal_timestamp: int, trigger_price: float) -> list[dict]:
    by_wallet: dict[str, dict] = defaultdict(lambda: {
        "netShares": 0.0, "grossShares": 0.0, "lastTimestamp": 0, "firstTimestamp": 2**63
    })
    for row in rows:
        if row["isTarget"] or not signal_timestamp - 900 <= row["timestamp"] < signal_timestamp:
            continue
        current = by_wallet[row["wallet"]]
        current["netShares"] += row["direction"] * row["shares"]
        current["grossShares"] += row["shares"]
        current["lastTimestamp"] = max(current["lastTimestamp"], row["timestamp"])
        current["firstTimestamp"] = min(current["firstTimestamp"], row["timestamp"])
    output = []
    for wallet, values in by_wallet.items():
        alignment = safe_div(values["netShares"], values["grossShares"], 0)
        aligned_usdc = values["netShares"] * trigger_price
        if alignment < 0.75 or aligned_usdc < 1_000:
            continue
        output.append({
            "wallet": wallet,
            "alignment": alignment,
            "alignedUsdc": aligned_usdc,
            "leadSeconds": signal_timestamp - values["lastTimestamp"],
            "firstLeadSeconds": signal_timestamp - values["firstTimestamp"],
        })
    return sorted(output, key=lambda row: row["alignedUsdc"], reverse=True)


def target_flow_features(trades: list[dict], signal: dict) -> dict:
    timestamp = int(signal["timestamp"])
    outcome = signal["outcome"]
    observed = [trade for trade in trades if trade["timestamp"] <= timestamp]
    same_buys = [trade for trade in observed if trade["outcome"] == outcome and trade["side"] == "BUY"]
    taker_buys = [trade for trade in same_buys if trade["role"] == "TAKER"]
    maker_buys = [trade for trade in same_buys if trade["role"] == "MAKER"]
    trigger = [
        trade for trade in observed
        if trade["transactionHash"] == signal.get("triggerHash")
        and trade["outcome"] == outcome
    ]
    taker_gross = sum(trade["quoteUsdc"] for trade in taker_buys)
    maker_gross = sum(trade["quoteUsdc"] for trade in maker_buys)
    all_gross = taker_gross + maker_gross

    def taker_window(seconds: int) -> float:
        return sum(trade["quoteUsdc"] for trade in taker_buys
                   if timestamp - seconds <= trade["timestamp"] <= timestamp)

    weighted_price = safe_div(
        sum(trade["size"] * trade["price"] for trade in taker_buys),
        sum(trade["size"] for trade in taker_buys),
    )
    first_market_time = min((trade["timestamp"] for trade in trades), default=timestamp)
    first_taker_time = min((trade["timestamp"] for trade in taker_buys), default=timestamp)
    first_maker_time = min((trade["timestamp"] for trade in maker_buys), default=timestamp)
    trigger_fill = sum(trade["quoteUsdc"] for trade in trigger if trade["side"] == "BUY")
    prior_sells = sum(trade["quoteUsdc"] for trade in observed
                      if trade["outcome"] == outcome and trade["side"] == "SELL")
    return {
        "signalOutcomeTakerBuyUsdc": taker_gross,
        "signalOutcomeMakerBuyUsdc": maker_gross,
        "makerShareBeforeSignal": safe_div(maker_gross, all_gross, 0),
        "triggerFillUsdc": trigger_fill,
        "triggerFillShare": safe_div(trigger_fill, taker_gross, 0),
        "takerBurst60Usdc": taker_window(60),
        "takerBurst300Usdc": taker_window(300),
        "takerBurst900Usdc": taker_window(900),
        "takerBurst60Share": safe_div(taker_window(60), taker_gross, 0),
        "takerBurst300Share": safe_div(taker_window(300), taker_gross, 0),
        "signalAgeSeconds": timestamp - first_market_time,
        "takerRampSeconds": timestamp - first_taker_time,
        "makerProbeSeconds": timestamp - first_maker_time if maker_buys else np.nan,
        "takerBuyFills": len(taker_buys),
        "makerBuyFills": len(maker_buys),
        "priorSellUsdc": prior_sells,
        "takerWeightedPrice": weighted_price,
        "takerPriceDrift": float(signal["triggerPrice"]) - weighted_price if np.isfinite(weighted_price) else np.nan,
    }


def onchain_trigger_features(transaction: dict | None) -> dict:
    if not transaction or transaction.get("error"):
        return {
            "onchainDecoded": 0,
            "onchainMakerOrders": np.nan,
            "onchainUniqueMakers": np.nan,
            "onchainUniqueSigners": np.nan,
            "onchainPriceLevels": np.nan,
            "onchainPriceRangeCents": np.nan,
            "onchainWeightedPrice": np.nan,
            "onchainTargetNotionalUsdc": np.nan,
            "onchainLargestMakerShare": np.nan,
            "onchainMakerHhi": np.nan,
            "onchainRestingAgeMedianSeconds": np.nan,
            "onchainTakerOrderAgeSeconds": np.nan,
            "onchainMintMakerOrders": np.nan,
            "onchainComplementaryMakerOrders": np.nan,
            "onchainMixedSettlement": np.nan,
            "onchainNotionalReconciliationPct": np.nan,
        }
    sweep = transaction["sweep"]
    fills = sweep.get("fills", [])
    match_types = {fill.get("matchType") for fill in fills if fill.get("matchType")}
    return {
        "onchainDecoded": 1,
        "onchainMakerOrders": int(sweep["makerOrderCount"]),
        "onchainUniqueMakers": int(sweep["uniqueMakers"]),
        "onchainUniqueSigners": int(sweep["uniqueSigners"]),
        "onchainPriceLevels": int(sweep["uniquePriceLevels"]),
        "onchainPriceRangeCents": float(sweep["priceRangeCents"]),
        "onchainWeightedPrice": float(sweep["weightedTargetPrice"]),
        "onchainTargetNotionalUsdc": float(sweep["targetNotionalUsdc"]),
        "onchainLargestMakerShare": float(sweep["largestMakerNotionalShare"]),
        "onchainMakerHhi": float(sweep["makerNotionalHhi"]),
        "onchainRestingAgeMedianSeconds": float(sweep["restingAgeMedianSeconds"]),
        "onchainTakerOrderAgeSeconds": float(transaction["taker"]["orderAgeSeconds"]),
        "onchainMintMakerOrders": sum(fill.get("matchType") == "MINT" for fill in fills),
        "onchainComplementaryMakerOrders": sum(
            fill.get("matchType") == "COMPLEMENTARY" for fill in fills
        ),
        "onchainMixedSettlement": int(len(match_types) > 1),
        "onchainNotionalReconciliationPct": float(sweep["notionalReconciliationPct"]),
    }


def build_features(
    snapshot: dict,
    enrichment: dict,
    analysis: dict,
    tape_data: dict,
    trigger_data: dict | None = None,
):
    markets = {market["conditionId"]: market for market in analysis["markets"]}
    trigger_transactions = {
        row["conditionId"]: row
        for row in (trigger_data or {}).get("transactions", [])
        if row.get("conditionId")
    }
    target_trades = reconstruct_target_trades(snapshot, enrichment)
    target_wallet = snapshot["wallet"].lower()
    deposits = sorted(
        [row for row in snapshot.get("activity", []) if row.get("type") == "DEPOSIT"],
        key=lambda row: row["timestamp"],
    )
    deposit_times = [int(row["timestamp"]) for row in deposits]
    resolution_times: dict[str, int] = defaultdict(int)
    for position in snapshot.get("closedPositions", []):
        condition_id = position.get("conditionId")
        if condition_id and position.get("timestamp"):
            resolution_times[condition_id] = max(
                resolution_times[condition_id], int(position["timestamp"])
            )
    features = []
    leader_events: dict[str, list[dict]] = defaultdict(list)

    for tape in tape_data["tapes"]:
        market = markets.get(tape["conditionId"])
        signal = tape.get("seedSignal")
        if not market or not signal or not market.get("resolvedWinner"):
            continue
        timestamp = int(signal["timestamp"])
        trigger_price = float(signal["triggerPrice"])
        gamma_closed_timestamp = parse_timestamp((tape.get("resolution") or {}).get("closedTime"))
        fallback_resolution = max(
            resolution_times.get(tape["conditionId"], 0),
            int(market.get("lastTradeTimestamp") or 0),
            int(market.get("gameStartTimestamp") or 0),
            parse_timestamp((tape.get("resolution") or {}).get("endDate")) or 0,
        )
        normalized = normalized_tape_rows(tape, signal["outcome"], target_wallet)
        flow = target_flow_features(target_trades.get(tape["conditionId"], []), signal)
        deposit_lag, deposit_usdc = last_deposit_features(deposits, deposit_times, timestamp)
        pre_mark, pre_staleness = last_mark(normalized, timestamp - 1)
        pre_60, _ = last_mark(normalized, timestamp - 60)
        pre_300, _ = last_mark(normalized, timestamp - 300)
        pre_900, _ = last_mark(normalized, timestamp - 900)
        leaders = aligned_leaders(normalized, timestamp, trigger_price)
        won = signal["outcome"] == market["resolvedWinner"]
        for leader in leaders:
            leader_events[leader["wallet"]].append({
                **leader,
                "conditionId": tape["conditionId"],
                "eventKey": market.get("eventKey") or tape["conditionId"],
                "timestamp": timestamp,
                "won": won,
            })

        row = {
            "conditionId": tape["conditionId"],
            "eventKey": market.get("eventKey") or tape["conditionId"],
            "title": market["title"],
            "discipline": market["discipline"],
            "marketType": market["marketType"],
            "triggerHash": signal.get("triggerHash"),
            "signalTimestamp": timestamp,
            "signalTime": datetime.fromtimestamp(timestamp, timezone.utc).isoformat(),
            "resolutionTimestamp": gamma_closed_timestamp or fallback_resolution,
            "resolutionSource": "gammaClosedTime" if gamma_closed_timestamp else "conservativeFallback",
            "gameStartTimestamp": market.get("gameStartTimestamp"),
            "minutesToStart": ((market["gameStartTimestamp"] - timestamp) / 60
                               if market.get("gameStartTimestamp") else np.nan),
            "pregame": int(bool(market.get("gameStartTimestamp") and timestamp < market["gameStartTimestamp"])),
            "outcome": signal["outcome"],
            "winner": market["resolvedWinner"],
            "won": int(won),
            "triggerPrice": trigger_price,
            "concentration": float(signal["concentration"]),
            "signalGrossBuyUsdc": float(signal["targetGrossBuyUsdc"]),
            "signalOutcomeGrossBuyUsdc": float(signal["targetOutcomeGrossBuyUsdc"]),
            "signalOutcomeNetBuyUsdc": float(signal["targetOutcomeNetBuyUsdc"]),
            "closedCostBasisUsdc": float(market.get("closedCostBasisUsdc") or 0),
            "realizedPnlUsdc": float(market.get("realizedPnlUsdc") or 0),
            "depositLagSeconds": deposit_lag,
            "depositUsdc": deposit_usdc,
            "preSignalMark": pre_mark,
            "preSignalMarkStalenessSeconds": pre_staleness,
            "preMomentum60": pre_mark - pre_60 if np.isfinite(pre_mark) and np.isfinite(pre_60) else np.nan,
            "preMomentum300": pre_mark - pre_300 if np.isfinite(pre_mark) and np.isfinite(pre_300) else np.nan,
            "preMomentum900": pre_mark - pre_900 if np.isfinite(pre_mark) and np.isfinite(pre_900) else np.nan,
            "externalFlow60": flow_imbalance(normalized, timestamp - 60, timestamp),
            "externalFlow300": flow_imbalance(normalized, timestamp - 300, timestamp),
            "externalFlow900": flow_imbalance(normalized, timestamp - 900, timestamp),
            "alignedLeaderCount": len(leaders),
            "largestLeaderUsdc": leaders[0]["alignedUsdc"] if leaders else 0,
            "largestLeaderLeadSeconds": leaders[0]["leadSeconds"] if leaders else np.nan,
            **onchain_trigger_features(trigger_transactions.get(tape["conditionId"])),
            **flow,
        }
        for lag in LAGS:
            mark, wait = first_mark(normalized, timestamp + lag)
            row[f"executionMark{lag}"] = mark
            row[f"executionWait{lag}"] = wait
            row[f"markout{lag}"] = mark - trigger_price if np.isfinite(mark) else np.nan
            aligned_mark, aligned_wait = first_mark(normalized, timestamp + lag, direction=1)
            row[f"alignedExecutionMark{lag}"] = aligned_mark
            row[f"alignedExecutionWait{lag}"] = aligned_wait
        mark_900, _ = first_mark(normalized, timestamp + 900, 120)
        row["markout900"] = mark_900 - trigger_price if np.isfinite(mark_900) else np.nan
        features.append(row)

    return pd.DataFrame(features).sort_values("signalTimestamp").reset_index(drop=True), leader_events


def all_in_price(
    observed_price: float,
    slippage_cents: float,
    fee_rate: float = TARGET_FEE_RATE,
) -> float:
    execution = min(0.99, max(0.01, observed_price + slippage_cents / 100))
    return execution + fee_rate * execution * (1 - execution)


def prepare_bets(
    frame: pd.DataFrame,
    lag: int = 60,
    slippage_cents: float = 5,
    price_source: str = "any",
    force_fallback: bool = True,
    fee_rate: float = TARGET_FEE_RATE,
) -> pd.DataFrame:
    mark_column = f"alignedExecutionMark{lag}" if price_source == "aligned" else f"executionMark{lag}"
    bets = frame.copy()
    bets["usedFallbackPrice"] = ~np.isfinite(bets[mark_column])
    if force_fallback:
        bets["observedExecutionPrice"] = bets[mark_column].fillna(bets["triggerPrice"])
    else:
        bets = bets[np.isfinite(bets[mark_column])].copy()
        bets["observedExecutionPrice"] = bets[mark_column]
    bets["executionPrice"] = (bets["observedExecutionPrice"] + slippage_cents / 100).clip(0.01, 0.99)
    bets["allInPrice"] = (
        bets["executionPrice"]
        + fee_rate * bets["executionPrice"] * (1 - bets["executionPrice"])
    )
    if not np.isfinite(bets["allInPrice"]).all():
        raise ValueError("Every forced simulation must have a finite all-in execution price")
    bets["return"] = np.where(bets["won"] == 1, 1 / bets["allInPrice"] - 1, -1)
    bets["profitUsdc"] = bets["return"] * 100
    bets["stakeUsdc"] = 100.0
    bets["lagSeconds"] = lag
    bets["slippageCents"] = slippage_cents
    bets["feeRate"] = fee_rate
    return bets


def summarize_bets(bets: pd.DataFrame) -> dict:
    if bets.empty:
        return {"bets": 0}
    ordered = bets.sort_values("signalTimestamp")
    curve = ordered["profitUsdc"].cumsum()
    drawdown = curve.cummax().clip(lower=0) - curve
    gross_win = ordered.loc[ordered["profitUsdc"] > 0, "profitUsdc"].sum()
    gross_loss = -ordered.loc[ordered["profitUsdc"] < 0, "profitUsdc"].sum()
    ranked = ordered.sort_values("profitUsdc", ascending=False)
    without_top = {}
    for count in (1, 3, 5):
        reduced = ranked.iloc[count:]
        without_top[str(count)] = finite(reduced["profitUsdc"].sum() / reduced["stakeUsdc"].sum() * 100) if len(reduced) else None
    return {
        "bets": int(len(ordered)),
        "wins": int(ordered["won"].sum()),
        "winRatePct": finite(ordered["won"].mean() * 100),
        "stakeUsdc": finite(ordered["stakeUsdc"].sum()),
        "profitUsdc": finite(ordered["profitUsdc"].sum()),
        "roiPct": finite(ordered["profitUsdc"].sum() / ordered["stakeUsdc"].sum() * 100),
        "profitFactor": finite(safe_div(gross_win, gross_loss, np.inf)),
        "maxDrawdownUsdc": finite(drawdown.max()),
        "medianObservedPrice": finite(ordered["observedExecutionPrice"].median()),
        "medianAllInPrice": finite(ordered["allInPrice"].median()),
        "fallbackPrices": int(ordered["usedFallbackPrice"].sum()),
        "roiWithoutTopWinnersPct": without_top,
    }


def bootstrap_bets(bets: pd.DataFrame, draws: int = BOOTSTRAP_DRAWS) -> dict:
    if bets.empty:
        return {"bets": 0}
    returns = bets["return"].to_numpy(dtype=float)
    rng = np.random.default_rng(SEED + len(bets))
    indexes = rng.integers(0, len(returns), size=(draws, len(returns)))
    sampled = returns[indexes].mean(axis=1) * 100
    return {
        "bets": int(len(returns)),
        "roiPct": finite(returns.mean() * 100),
        "ci95LowPct": finite(np.quantile(sampled, 0.025)),
        "ci95HighPct": finite(np.quantile(sampled, 0.975)),
        "probabilityPositivePct": finite(np.mean(sampled > 0) * 100),
    }


def day_cluster_bootstrap(bets: pd.DataFrame, draws: int = BOOTSTRAP_DRAWS) -> dict:
    if bets.empty:
        return {"bets": 0}
    clustered = bets.assign(day=pd.to_datetime(bets["signalTime"], utc=True).dt.date).groupby("day").agg(
        profit=("profitUsdc", "sum"), stake=("stakeUsdc", "sum")
    )
    rng = np.random.default_rng(SEED + 211)
    indexes = rng.integers(0, len(clustered), size=(draws, len(clustered)))
    profit = clustered["profit"].to_numpy(dtype=float)[indexes].sum(axis=1)
    stake = clustered["stake"].to_numpy(dtype=float)[indexes].sum(axis=1)
    roi = profit / stake * 100
    return {
        "bets": int(len(bets)),
        "dayClusters": int(len(clustered)),
        "roiPct": finite(bets["profitUsdc"].sum() / bets["stakeUsdc"].sum() * 100),
        "ci95LowPct": finite(np.quantile(roi, 0.025)),
        "ci95HighPct": finite(np.quantile(roi, 0.975)),
        "probabilityPositivePct": finite(np.mean(roi > 0) * 100),
    }


def base_universe(features: pd.DataFrame) -> pd.DataFrame:
    eligible = features[
        features["discipline"].isin(CORE_DISCIPLINES)
        & ~features["marketType"].isin(EXCLUDED_MARKET_TYPES)
        & features["triggerPrice"].between(0.30, 0.85)
        & (features["concentration"] >= 0.70)
    ].copy()
    eligible = eligible.sort_values("signalTimestamp")
    return eligible.drop_duplicates("eventKey", keep="first").reset_index(drop=True)


def bo1_classification_sensitivity(features: pd.DataFrame, fixed_split_timestamp: int) -> dict:
    bo1 = features["title"].str.contains(r"\(BO1\)", case=False, regex=True, na=False)
    eligible = features[
        features["discipline"].isin(CORE_DISCIPLINES)
        & (~features["marketType"].isin(EXCLUDED_MARKET_TYPES) | bo1)
        & features["triggerPrice"].between(0.30, 0.85)
        & (features["concentration"] >= 0.70)
    ].sort_values("signalTimestamp").drop_duplicates("eventKey", keep="first").reset_index(drop=True)
    bets = prepare_bets(eligible, 60, 5)
    earlier, final, split_timestamp = chronological_split(bets, 0.70)
    return {
        "method": "Counterfactual keeps BO1 eligible as in the original classifier, while retaining the same 60-second/five-cent execution assumptions.",
        "splitTimestamp": split_timestamp,
        "splitDate": datetime.fromtimestamp(split_timestamp, timezone.utc).isoformat(),
        "bo1Signals": int(eligible["title"].str.contains(
            r"\(BO1\)", case=False, regex=True, na=False
        ).sum()),
        "earlier70Pct": summarize_bets(earlier),
        "final30Pct": summarize_bets(final),
        "afterFixedSplit": summarize_bets(
            bets[bets["signalTimestamp"] >= fixed_split_timestamp]
        ),
        "all": summarize_bets(bets),
    }


def universe_sensitivity(features: pd.DataFrame, split_timestamp: int) -> dict:
    concentrated = features["concentration"] >= 0.70
    burst = features["takerBurst60Share"] >= 0.80
    format_guard = ~features["marketType"].isin(EXCLUDED_MARKET_TYPES)
    core = features["discipline"].isin(CORE_DISCIPLINES)
    price = features["triggerPrice"].between(0.30, 0.85)
    definitions = {
        "allCanonicalSignals": concentrated,
        "rapidBurst": concentrated & burst,
        "rapidBurstAndFormatGuard": concentrated & burst & format_guard,
        "rapidBurstFormatAndCoreDisciplines": concentrated & burst & format_guard & core,
        "fullRuleWithPriceGuard": concentrated & burst & format_guard & core & price,
    }
    output = {}
    for name, mask in definitions.items():
        universe = features[mask].sort_values("signalTimestamp").drop_duplicates(
            "eventKey", keep="first"
        ).reset_index(drop=True)
        bets = prepare_bets(universe, 60, 5)
        output[name] = {
            "all": summarize_bets(bets),
            "afterFixedSplit": summarize_bets(
                bets[bets["signalTimestamp"] >= split_timestamp]
            ),
        }
    return {
        "splitTimestamp": split_timestamp,
        "splitDate": datetime.fromtimestamp(split_timestamp, timezone.utc).isoformat(),
        "warning": "Nested attribution ladder, not independent strategy trials; discipline and price guards were informed by the investigated sample.",
        "steps": output,
    }


def chronological_split(frame: pd.DataFrame, share: float) -> tuple[pd.DataFrame, pd.DataFrame, int]:
    index = max(1, min(len(frame) - 1, int(len(frame) * share)))
    timestamp = int(frame.iloc[index]["signalTimestamp"])
    return frame.iloc[:index].copy(), frame.iloc[index:].copy(), timestamp


def scenario_backtests(base: pd.DataFrame) -> list[dict]:
    output = []
    for lag in LAGS:
        for slippage in EXECUTION_SLIPPAGE_CENTS:
            bets = prepare_bets(base, lag, slippage, price_source="any", force_fallback=True)
            train, test, split = chronological_split(bets, 0.70)
            output.append({
                "lagSeconds": lag,
                "slippageCents": slippage,
                "splitTimestamp": split,
                "splitDate": datetime.fromtimestamp(split, timezone.utc).isoformat(),
                "publicPrintCoveragePct": finite((~bets["usedFallbackPrice"]).mean() * 100),
                "train": summarize_bets(train),
                "test": summarize_bets(test),
                "all": summarize_bets(bets),
            })
    return output


def break_even_slippage_cents(frame: pd.DataFrame, lag: int, upper_bound: float = 50) -> float | None:
    """Largest modeled adverse price move that keeps equal-stake ROI nonnegative."""
    def roi(slippage: float) -> float:
        summary = summarize_bets(prepare_bets(frame, lag, slippage))
        return float(summary.get("roiPct", np.nan))

    if frame.empty or not np.isfinite(roi(0)) or roi(0) < 0:
        return None
    if roi(upper_bound) >= 0:
        return upper_bound
    low, high = 0.0, upper_bound
    for _ in range(40):
        midpoint = (low + high) / 2
        if roi(midpoint) >= 0:
            low = midpoint
        else:
            high = midpoint
    return finite(low)


def candidate_gates() -> dict[str, callable]:
    return {
        "base": lambda row: True,
        "one-shot-sweep": lambda row: row["triggerFillShare"] >= 0.80,
        "burst-60": lambda row: row["takerBurst60Share"] >= 0.80,
        "fresh-signal": lambda row: row["signalAgeSeconds"] <= 300,
        "pregame": lambda row: row["pregame"] == 1,
        "outside-flow-confirms": lambda row: row["externalFlow300"] >= 0.10,
        "outside-flow-not-opposed": lambda row: row["externalFlow300"] >= 0,
        "maker-then-sweep": lambda row: row["makerShareBeforeSignal"] >= 0.10
        and row["takerBurst60Share"] >= 0.80,
        "just-in-time-funded": lambda row: row["depositLagSeconds"] <= 300,
        "no-pre-signal-chase": lambda row: not np.isfinite(row["preMomentum300"])
        or row["preMomentum300"] <= 0.02,
        "one-shot-and-not-opposed": lambda row: row["triggerFillShare"] >= 0.80
        and row["externalFlow300"] >= 0,
        "burst-and-pregame": lambda row: row["takerBurst60Share"] >= 0.80 and row["pregame"] == 1,
    }


def locked_gate_test(base: pd.DataFrame) -> dict:
    bets = prepare_bets(base, 60, 5).sort_values("signalTimestamp").reset_index(drop=True)
    first = int(len(bets) * 0.50)
    second = int(len(bets) * 0.70)
    development = bets.iloc[:first]
    validation = bets.iloc[first:second]
    final_test = bets.iloc[second:]
    candidates = []
    for name, gate in candidate_gates().items():
        dev = development[development.apply(gate, axis=1)]
        val = validation[validation.apply(gate, axis=1)]
        candidates.append({
            "name": name,
            "development": summarize_bets(dev),
            "validation": summarize_bets(val),
            "gate": gate,
        })
    eligible = [row for row in candidates
                if row["development"].get("bets", 0) >= 8
                and row["validation"].get("bets", 0) >= 3]
    ranked_development = sorted(
        eligible,
        key=lambda row: row["development"].get("roiPct", -np.inf),
        reverse=True,
    )[:5]
    selected = max(
        ranked_development or candidates[:1],
        key=lambda row: row["validation"].get("roiPct", -np.inf),
    )
    selected_test = final_test[final_test.apply(selected["gate"], axis=1)]
    return {
        "method": "Twelve predeclared observable gates; shortlist on first 50%, select on next 20%, evaluate once on final 30%.",
        "developmentEnd": development.iloc[-1]["signalTime"] if len(development) else None,
        "validationEnd": validation.iloc[-1]["signalTime"] if len(validation) else None,
        "selected": {
            "name": selected["name"],
            "development": selected["development"],
            "validation": selected["validation"],
            "finalTest": summarize_bets(selected_test),
            "finalTestBootstrap": bootstrap_bets(selected_test),
        },
        "baseFinalTest": summarize_bets(final_test),
        "candidates": [{key: value for key, value in row.items() if key != "gate"} for row in candidates],
    }


def random_side_test(bets: pd.DataFrame, draws: int = BOOTSTRAP_DRAWS) -> dict:
    if bets.empty:
        return {}
    target_return = bets["return"].to_numpy(dtype=float)
    opposite_mark = 1 - bets["observedExecutionPrice"].to_numpy(dtype=float)
    slippage_cents = float(bets["slippageCents"].iloc[0])
    opposite_all_in = np.array([all_in_price(price, slippage_cents) for price in opposite_mark])
    opposite_won = 1 - bets["won"].to_numpy(dtype=int)
    opposite_return = np.where(opposite_won == 1, 1 / opposite_all_in - 1, -1)
    rng = np.random.default_rng(SEED + 91)
    choose_target = rng.integers(0, 2, size=(draws, len(bets))).astype(bool)
    randomized = np.where(choose_target, target_return, opposite_return).mean(axis=1) * 100
    actual = target_return.mean() * 100
    return {
        "actualTargetRoiPct": finite(actual),
        "oppositeSideRoiPct": finite(opposite_return.mean() * 100),
        "randomSideMedianRoiPct": finite(np.median(randomized)),
        "randomSideCi95LowPct": finite(np.quantile(randomized, 0.025)),
        "randomSideCi95HighPct": finite(np.quantile(randomized, 0.975)),
        "randomizationPValue": finite((np.sum(randomized >= actual) + 1) / (draws + 1)),
        "alternative": "One-sided: randomized-side ROI is at least the observed target-direction ROI.",
    }


def walk_forward_predictions(
    bets: pd.DataFrame,
    regularization: float,
    warmup: int,
    numeric_features: list[str] | None = None,
    categorical_features: list[str] | None = None,
) -> pd.DataFrame:
    numeric_features = numeric_features or MODEL_NUMERIC
    categorical_features = categorical_features or MODEL_CATEGORICAL
    model_features = numeric_features + categorical_features
    predictions = []
    for index in range(warmup, len(bets)):
        current = bets.iloc[[index]]
        train = bets.iloc[:index]
        train = train[
            (train["resolutionSource"] == "gammaClosedTime")
            & (train["resolutionTimestamp"] < current.iloc[0]["signalTimestamp"])
        ]
        if len(train) < 20 or train["won"].nunique() < 2:
            continue
        transform = ColumnTransformer([
            ("numeric", Pipeline([
                ("impute", SimpleImputer(strategy="median")),
                ("scale", StandardScaler()),
            ]), numeric_features),
            ("categorical", OneHotEncoder(handle_unknown="ignore"), categorical_features),
        ])
        model = Pipeline([
            ("features", transform),
            ("model", LogisticRegression(C=regularization, max_iter=5_000, random_state=SEED)),
        ])
        model.fit(train[model_features], train["won"])
        probability = float(model.predict_proba(current[model_features])[0, 1])
        row = current.iloc[0].copy()
        row["predictedWinProbability"] = probability
        row["predictedEdge"] = probability - row["allInPrice"]
        predictions.append(row)
    return pd.DataFrame(predictions)


def walk_forward_model(base: pd.DataFrame) -> dict:
    bets = prepare_bets(base, 60, 5).sort_values("signalTimestamp").reset_index(drop=True)
    warmup = min(40, max(20, len(bets) - 1))
    predicted = walk_forward_predictions(bets, 0.25, warmup)
    if predicted.empty:
        return {"bets": 0}
    selected = predicted[predicted["predictedEdge"] >= 0.05]
    auc = roc_auc_score(predicted["won"], predicted["predictedWinProbability"]) if predicted["won"].nunique() > 1 else np.nan
    ablation_definitions = {
        "withoutTakerBurst60": (
            [name for name in MODEL_NUMERIC if name != "takerBurst60Share"],
            MODEL_CATEGORICAL,
        ),
        "withoutPublicTape": (
            [name for name in MODEL_NUMERIC if name not in {"preMomentum300", "externalFlow300"}],
            MODEL_CATEGORICAL,
        ),
        "priceAndCategoryBaseline": (["triggerPrice"], MODEL_CATEGORICAL),
    }
    ablations = {}
    for name, (numeric_features, categorical_features) in ablation_definitions.items():
        candidate = walk_forward_predictions(
            bets, 0.25, warmup, numeric_features, categorical_features
        )
        candidate_selected = candidate[candidate["predictedEdge"] >= 0.05]
        candidate_auc = (
            roc_auc_score(candidate["won"], candidate["predictedWinProbability"])
            if candidate["won"].nunique() > 1 else np.nan
        )
        ablations[name] = {
            "predictions": int(len(candidate)),
            "rocAuc": finite(candidate_auc),
            "selected": summarize_bets(candidate_selected),
        }
    sensitivity = []
    for regularization in (0.10, 0.25, 0.50, 1.00):
        candidate_predictions = walk_forward_predictions(bets, regularization, warmup)
        for edge_threshold in (0, 0.025, 0.05, 0.075, 0.10):
            candidate = candidate_predictions[candidate_predictions["predictedEdge"] >= edge_threshold]
            sensitivity.append({
                "regularizationC": regularization,
                "edgeThreshold": edge_threshold,
                **summarize_bets(candidate),
            })
    selected_rows = selected.sort_values("signalTimestamp")
    same_period_burst = predicted[predicted["takerBurst60Share"] >= 0.80]
    return {
        "method": "Expanding-window L2 logistic model; 40-signal warmup; only markets with Gamma close time before each prediction; fixed 5-point predicted edge gate.",
        "features": MODEL_NUMERIC + MODEL_CATEGORICAL,
        "predictions": int(len(predicted)),
        "rocAuc": finite(auc),
        "selected": summarize_bets(selected),
        "selectedBootstrap": bootstrap_bets(selected),
        "selectedDayClusterBootstrap": day_cluster_bootstrap(selected),
        "samePeriodAlwaysCopy": summarize_bets(predicted),
        "samePeriodBurstGate": summarize_bets(same_period_burst),
        "ablations": ablations,
        "sensitivity": sensitivity,
        "positiveSensitivityConfigurations": sum(row.get("roiPct", -np.inf) > 0 for row in sensitivity),
        "selectedBets": selected_rows[[
            "signalTime", "conditionId", "title", "discipline", "outcome", "winner", "won",
            "observedExecutionPrice", "allInPrice", "predictedWinProbability", "predictedEdge", "return"
        ]].to_dict("records"),
    }


def fit_deployment_model(base: pd.DataFrame) -> dict:
    bets = prepare_bets(base, 60, 5).sort_values("signalTimestamp").reset_index(drop=True)
    transform = ColumnTransformer([
        ("numeric", Pipeline([
            ("impute", SimpleImputer(strategy="median")),
            ("scale", StandardScaler()),
        ]), MODEL_NUMERIC),
        ("categorical", OneHotEncoder(handle_unknown="ignore"), MODEL_CATEGORICAL),
    ])
    pipeline = Pipeline([
        ("features", transform),
        ("model", LogisticRegression(C=0.25, max_iter=5_000, random_state=SEED)),
    ])
    pipeline.fit(bets[MODEL_NUMERIC + MODEL_CATEGORICAL], bets["won"])
    coefficients = pipeline.named_steps["model"].coef_[0]
    fitted = pipeline.named_steps["features"]
    numeric_pipeline = fitted.named_transformers_["numeric"]
    imputer = numeric_pipeline.named_steps["impute"]
    scaler = numeric_pipeline.named_steps["scale"]
    numeric = []
    for index, name in enumerate(MODEL_NUMERIC):
        numeric.append({
            "name": name,
            "imputeMedian": finite(imputer.statistics_[index]),
            "mean": finite(scaler.mean_[index]),
            "scale": finite(scaler.scale_[index]),
            "coefficient": finite(coefficients[index]),
        })
    encoder = fitted.named_transformers_["categorical"]
    offset = len(MODEL_NUMERIC)
    categorical = []
    for name, categories in zip(MODEL_CATEGORICAL, encoder.categories_):
        values = []
        for value in categories:
            values.append({
                "value": str(value),
                "coefficient": finite(coefficients[offset]),
            })
            offset += 1
        categorical.append({"name": name, "values": values, "unknownCoefficient": 0})
    probabilities = pipeline.predict_proba(bets[MODEL_NUMERIC + MODEL_CATEGORICAL])[:, 1]
    return {
        "version": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "modelType": "standardized L2 logistic regression",
        "intercept": finite(pipeline.named_steps["model"].intercept_[0]),
        "numeric": numeric,
        "categorical": categorical,
        "decision": {
            "minimumPredictedEdge": 0.05,
            "minimumTakerBurst60Share": 0.80,
            "minimumOnchainUniqueMakers": ONCHAIN_BREADTH_THRESHOLD,
            "compactFreshShadowMaximumPriceLevels": 3,
            "compactFreshShadowMaximumMedianMakerAgeSeconds": 300,
            "feeRate": TARGET_FEE_RATE,
            "modeledSlippageCents": 5,
            "copyLagSeconds": 60,
            "prospectivePaperMinimumLagSeconds": 1,
            "warning": "The 60-second lag belongs to the historical model fit. Prospective paper intents use current decoded calldata and live FOK depth; compact-fresh is recorded as a shadow tag, not a live-money gate.",
        },
        "training": {
            "bets": int(len(bets)),
            "firstSignal": bets.iloc[0]["signalTime"],
            "lastSignal": bets.iloc[-1]["signalTime"],
            "inSampleRocAuc": finite(roc_auc_score(bets["won"], probabilities)),
            "warning": "Deployment fit uses all historical outcomes. Evidence quality comes from the separate expanding-window test, not this in-sample metric.",
        },
    }


def robustness_tables(base: pd.DataFrame) -> dict:
    bets = prepare_bets(base, 60, 5).copy()
    bets["week"] = pd.to_datetime(bets["signalTime"], utc=True).dt.strftime("%G-W%V")
    bets["priceBand"] = pd.cut(
        bets["observedExecutionPrice"], [0, 0.4, 0.5, 0.6, 0.7, 1.01], include_lowest=True
    ).astype(str)

    def groups(column: str) -> list[dict]:
        return [{"key": str(key), **summarize_bets(rows)} for key, rows in bets.groupby(column, sort=True)]

    return {
        "byDiscipline": groups("discipline"),
        "byWeek": groups("week"),
        "byPriceBand": groups("priceBand"),
        "all": summarize_bets(bets),
        "allDayClusterBootstrap": day_cluster_bootstrap(bets),
    }


def leader_analysis(leader_events: dict[str, list[dict]], base: pd.DataFrame) -> dict:
    rows = []
    for wallet, events in leader_events.items():
        unique = {}
        for event in events:
            unique.setdefault(event["eventKey"], event)
        values = list(unique.values())
        rows.append({
            "wallet": wallet,
            "events": len(values),
            "wins": sum(event["won"] for event in values),
            "winRatePct": safe_div(sum(event["won"] for event in values), len(values), 0) * 100,
            "medianLeadSeconds": float(np.median([event["leadSeconds"] for event in values])),
            "medianAlignedUsdc": float(np.median([event["alignedUsdc"] for event in values])),
            "firstSeen": min(event["timestamp"] for event in values),
            "lastSeen": max(event["timestamp"] for event in values),
            "eventKeys": [event["eventKey"] for event in values],
        })
    rows.sort(key=lambda row: (row["events"], row["medianAlignedUsdc"]), reverse=True)

    split_index = int(len(base) * 0.60)
    split_timestamp = int(base.iloc[split_index]["signalTimestamp"]) if len(base) > split_index else 0
    development_wallets = []
    for wallet, events in leader_events.items():
        event_keys = {event["eventKey"] for event in events if event["timestamp"] < split_timestamp}
        if len(event_keys) >= 3:
            development_wallets.append(wallet)
    later = base[base["signalTimestamp"] >= split_timestamp].copy()
    later["knownLeader"] = later["eventKey"].map(lambda event_key: any(
        event["eventKey"] == event_key and wallet in development_wallets
        for wallet in development_wallets for event in leader_events[wallet]
    ))
    later_bets = prepare_bets(later, 60, 5)
    return {
        "definition": "Wallet bought the target outcome in the prior 15 minutes with >=75% directional imbalance and >=$1,000 aligned notional.",
        "recurringWallets": sum(row["events"] >= 2 for row in rows),
        "top": rows[:25],
        "outOfSample": {
            "splitTimestamp": split_timestamp,
            "leaderWalletsSelectedWithoutLaterOutcomes": len(development_wallets),
            "knownLeaderPresent": summarize_bets(later_bets[later_bets["knownLeader"]]),
            "knownLeaderAbsent": summarize_bets(later_bets[~later_bets["knownLeader"]]),
        },
    }


def sizing_analysis(base: pd.DataFrame) -> dict:
    rows = base[base["closedCostBasisUsdc"] > 0].copy()
    rows["logCost"] = np.log1p(rows["closedCostBasisUsdc"])
    rows["logTriggerFill"] = np.log1p(rows["triggerFillUsdc"])
    rows["logDeposit"] = np.log1p(rows["depositUsdc"])
    rows["logSignalAge"] = np.log1p(rows["signalAgeSeconds"])
    split = int(len(rows) * 0.70)
    train, test = rows.iloc[:split], rows.iloc[split:]
    numeric = ["logTriggerFill", "triggerPrice", "concentration", "logDeposit", "logSignalAge", "pregame"]
    categorical = ["discipline", "marketType"]
    transform = ColumnTransformer([
        ("numeric", Pipeline([
            ("impute", SimpleImputer(strategy="median")),
            ("scale", StandardScaler()),
        ]), numeric),
        ("categorical", OneHotEncoder(handle_unknown="ignore"), categorical),
    ])
    model = Pipeline([("features", transform), ("model", Ridge(alpha=10))])
    model.fit(train[numeric + categorical], train["logCost"])
    predicted = np.expm1(model.predict(test[numeric + categorical])).clip(min=0)
    return {
        "markets": int(len(rows)),
        "triggerFillToFinalCostCorrelation": finite(rows["triggerFillUsdc"].corr(rows["closedCostBasisUsdc"])),
        "depositToFinalCostCorrelation": finite(rows["depositUsdc"].corr(rows["closedCostBasisUsdc"])),
        "medianTriggerShareOfFinalCostPct": finite((rows["triggerFillUsdc"] / rows["closedCostBasisUsdc"]).median() * 100),
        "oneShotSignalsPct": finite((rows["triggerFillShare"] >= 0.80).mean() * 100),
        "chronologicalTest": {
            "trainMarkets": int(len(train)),
            "testMarkets": int(len(test)),
            "r2LogCost": finite(r2_score(test["logCost"], np.log1p(predicted))),
            "medianAbsoluteErrorUsdc": finite(np.median(np.abs(test["closedCostBasisUsdc"] - predicted))),
            "meanAbsoluteErrorUsdc": finite(mean_absolute_error(test["closedCostBasisUsdc"], predicted)),
        },
    }


def markout_analysis(base: pd.DataFrame) -> dict:
    output = {}
    for lag in (*LAGS, 900):
        values = base[f"markout{lag}"].dropna().to_numpy(dtype=float)
        output[str(lag)] = {
            **quantiles(values.tolist()),
            "positivePct": finite(np.mean(values > 0) * 100) if len(values) else None,
            "atMostOneCentAdversePct": finite(np.mean(values <= 0.01) * 100) if len(values) else None,
        }
    return output


def subgroup_table(base: pd.DataFrame) -> dict:
    bets = prepare_bets(base, 60, 5)
    definitions = {
        "oneShotSweep": bets["triggerFillShare"] >= 0.80,
        "gradualAccumulation": bets["triggerFillShare"] < 0.80,
        "burst60": bets["takerBurst60Share"] >= 0.80,
        "notBurst60": bets["takerBurst60Share"] < 0.80,
        "pregame": bets["pregame"] == 1,
        "inPlay": bets["pregame"] == 0,
        "outsideFlowConfirms": bets["externalFlow300"] >= 0.10,
        "outsideFlowOpposes": bets["externalFlow300"] < 0,
        "makerBeforeSignal": bets["makerShareBeforeSignal"] >= 0.10,
        "pureTakerBeforeSignal": bets["makerShareBeforeSignal"] < 0.10,
    }
    return {name: summarize_bets(bets[mask]) for name, mask in definitions.items()}


def subgroup_chronology(base: pd.DataFrame) -> dict:
    bets = prepare_bets(base, 60, 5).sort_values("signalTimestamp").reset_index(drop=True)
    earlier, final, split_timestamp = chronological_split(bets, 0.70)

    def burst_split(rows: pd.DataFrame) -> dict:
        return {
            "burst60": summarize_bets(rows[rows["takerBurst60Share"] >= 0.80]),
            "slower": summarize_bets(rows[rows["takerBurst60Share"] < 0.80]),
        }

    burst = bets[bets["takerBurst60Share"] >= 0.80]
    slower = bets[bets["takerBurst60Share"] < 0.80]
    odds_ratio, p_value = fisher_exact([
        [int(burst["won"].sum()), int(len(burst) - burst["won"].sum())],
        [int(slower["won"].sum()), int(len(slower) - slower["won"].sum())],
    ])
    return {
        "definition": "At least 80% of target taker BUY notional observed by the trigger arrived in the final 60 seconds.",
        "splitTimestamp": split_timestamp,
        "splitDate": datetime.fromtimestamp(split_timestamp, timezone.utc).isoformat(),
        "earlier70Pct": burst_split(earlier),
        "final30Pct": burst_split(final),
        "all": burst_split(bets),
        "winRateFisherExact": {
            "oddsRatio": finite(odds_ratio),
            "twoSidedPValue": finite(p_value),
            "warning": "Descriptive post-discovery test; it is not adjusted for feature search or wallet selection.",
        },
    }


def calibration_summary(bets: pd.DataFrame) -> dict:
    if bets.empty:
        return {"bets": 0}
    probabilities = bets["observedExecutionPrice"].clip(0.01, 0.99).to_numpy(dtype=float)
    outcomes = bets["won"].to_numpy(dtype=int)
    distribution = np.array([1.0])
    for probability in probabilities:
        distribution = np.convolve(distribution, [1 - probability, probability])
    wins = int(outcomes.sum())
    return {
        "bets": int(len(bets)),
        "wins": wins,
        "expectedWinsFromExecutionProxy": finite(probabilities.sum()),
        "excessWins": finite(wins - probabilities.sum()),
        "actualWinRatePct": finite(outcomes.mean() * 100),
        "meanImpliedProbabilityPct": finite(probabilities.mean() * 100),
        "calibrationGapPctPoints": finite((outcomes - probabilities).mean() * 100),
        "brierScore": finite(np.mean((outcomes - probabilities) ** 2)),
        "poissonBinomialUpperTailPValue": finite(distribution[wins:].sum()),
        "fallbackPrices": int(bets["usedFallbackPrice"].sum()),
    }


def day_cluster_calibration(bets: pd.DataFrame) -> dict:
    rows = bets.copy()
    rows["burst60"] = rows["takerBurst60Share"] >= 0.80
    rows["calibrationResidual"] = rows["won"] - rows["observedExecutionPrice"]
    rows["day"] = pd.to_datetime(rows["signalTime"], utc=True).dt.date
    days = list(rows["day"].drop_duplicates())
    clusters = []
    for day in days:
        group = rows[rows["day"] == day]
        burst = group[group["burst60"]]["calibrationResidual"]
        slower = group[~group["burst60"]]["calibrationResidual"]
        clusters.append([
            burst.sum(), len(burst), slower.sum(), len(slower)
        ])
    clusters = np.asarray(clusters, dtype=float)
    rng = np.random.default_rng(SEED + 307)
    indexes = rng.integers(0, len(clusters), size=(BOOTSTRAP_DRAWS, len(clusters)))
    sampled = clusters[indexes].sum(axis=1)
    valid = (sampled[:, 1] > 0) & (sampled[:, 3] > 0)
    burst_values = sampled[valid, 0] / sampled[valid, 1]
    slower_values = sampled[valid, 2] / sampled[valid, 3]
    difference_values = burst_values - slower_values
    burst_actual = rows.loc[rows["burst60"], "calibrationResidual"].mean()
    slower_actual = rows.loc[~rows["burst60"], "calibrationResidual"].mean()

    def interval(values: np.ndarray, actual: float) -> dict:
        return {
            "estimatePctPoints": finite(actual * 100),
            "ci95LowPctPoints": finite(np.quantile(values, 0.025) * 100),
            "ci95HighPctPoints": finite(np.quantile(values, 0.975) * 100),
            "probabilityPositivePct": finite(np.mean(values > 0) * 100),
        }

    return {
        "dayClusters": len(days),
        "burst60": interval(burst_values, burst_actual),
        "slower": interval(slower_values, slower_actual),
        "burstMinusSlower": interval(
            difference_values, burst_actual - slower_actual
        ),
    }


def composition_controlled_burst_test(bets: pd.DataFrame) -> dict:
    rows = bets.copy()
    rows["burst60"] = rows["takerBurst60Share"] >= 0.80
    rows["broadPriceBand"] = np.where(
        rows["observedExecutionPrice"] <= 0.60, "<=0.60", ">0.60"
    )
    tables = []
    comparable_bets = 0
    strata = []
    for key, group in rows.groupby(["discipline", "broadPriceBand"]):
        if group["burst60"].nunique() < 2:
            continue
        table = np.array([
            [
                int((group["burst60"] & (group["won"] == 1)).sum()),
                int((group["burst60"] & (group["won"] == 0)).sum()),
            ],
            [
                int((~group["burst60"] & (group["won"] == 1)).sum()),
                int((~group["burst60"] & (group["won"] == 0)).sum()),
            ],
        ], dtype=float)
        tables.append(table)
        comparable_bets += len(group)
        strata.append({
            "discipline": key[0],
            "priceBand": key[1],
            "bets": int(len(group)),
            "table": table.astype(int).tolist(),
        })
    stratified = StratifiedTable(np.stack(tables, axis=2), shift_zeros=True)
    confidence_low, confidence_high = stratified.oddsratio_pooled_confint()
    return {
        "method": "Cochran-Mantel-Haenszel burst-versus-slow win odds, stratified by discipline and public execution-proxy price <=0.60 or >0.60; zero cells receive the library's 0.5 correction.",
        "strata": len(tables),
        "comparableBets": comparable_bets,
        "commonOddsRatio": finite(stratified.oddsratio_pooled),
        "ci95Low": finite(confidence_low),
        "ci95High": finite(confidence_high),
        "twoSidedPValue": finite(stratified.test_null_odds().pvalue),
        "details": strata,
        "warning": "Descriptive post-discovery control with sparse cells; the price boundary and burst threshold were not prospectively locked.",
    }


def fine_stratified_permutation(bets: pd.DataFrame, split_timestamp: int) -> dict:
    rows = bets.copy()
    rows["burst60"] = rows["takerBurst60Share"] >= 0.80
    rows["calibrationResidual"] = rows["won"] - rows["observedExecutionPrice"]
    rows["priceBand"] = pd.cut(
        rows["observedExecutionPrice"], [0, 0.45, 0.60, 1.0],
        labels=["low", "middle", "high"], include_lowest=True
    ).astype(str)
    rows["period"] = np.where(
        rows["signalTimestamp"] < split_timestamp, "earlier", "later"
    )
    groups = [
        group for _, group in rows.groupby(["discipline", "priceBand", "period"])
        if group["burst60"].nunique() == 2
    ]
    rng = np.random.default_rng(SEED + 401)
    simulated_numerator = np.zeros(BOOTSTRAP_DRAWS)
    actual_numerator = 0.0
    total_weight = 0.0
    comparable_bets = 0
    for group in groups:
        residuals = group["calibrationResidual"].to_numpy(dtype=float)
        labels = group["burst60"].to_numpy(dtype=bool)
        burst_count = int(labels.sum())
        slower_count = len(labels) - burst_count
        weight = burst_count * slower_count / len(labels)
        actual_difference = residuals[labels].mean() - residuals[~labels].mean()
        random_order = np.argpartition(
            rng.random((BOOTSTRAP_DRAWS, len(labels))), burst_count - 1, axis=1
        )[:, :burst_count]
        burst_sum = residuals[random_order].sum(axis=1)
        simulated_difference = (
            burst_sum / burst_count
            - (residuals.sum() - burst_sum) / slower_count
        )
        actual_numerator += weight * actual_difference
        simulated_numerator += weight * simulated_difference
        total_weight += weight
        comparable_bets += len(group)
    actual = actual_numerator / total_weight
    simulated = simulated_numerator / total_weight
    return {
        "method": "Shuffle burst labels within discipline x three public-price bands x fixed chronological period, preserving each stratum's burst count; statistic is the overlap-weighted calibration-gap difference.",
        "strata": len(groups),
        "comparableBets": comparable_bets,
        "effectPctPoints": finite(actual * 100),
        "oneSidedPValue": finite(
            (np.sum(simulated >= actual) + 1) / (BOOTSTRAP_DRAWS + 1)
        ),
        "nullCi95LowPctPoints": finite(np.quantile(simulated, 0.025) * 100),
        "nullCi95HighPctPoints": finite(np.quantile(simulated, 0.975) * 100),
        "warning": "Only strata containing both burst and slow bets contribute. This tighter control is low-powered but materially weakens the raw difference.",
    }


def breadth_day_cluster_calibration(bets: pd.DataFrame, threshold: int) -> dict:
    rows = bets.copy()
    rows["broadSweep"] = rows["onchainUniqueMakers"] >= threshold
    rows["calibrationResidual"] = rows["won"] - rows["observedExecutionPrice"]
    rows["day"] = pd.to_datetime(rows["signalTime"], utc=True).dt.date
    clusters = []
    for _, group in rows.groupby("day"):
        broad = group[group["broadSweep"]]["calibrationResidual"]
        narrow = group[~group["broadSweep"]]["calibrationResidual"]
        clusters.append([broad.sum(), len(broad), narrow.sum(), len(narrow)])
    clusters = np.asarray(clusters, dtype=float)
    rng = np.random.default_rng(SEED + 503)
    indexes = rng.integers(0, len(clusters), size=(BOOTSTRAP_DRAWS, len(clusters)))
    sampled = clusters[indexes].sum(axis=1)
    valid = (sampled[:, 1] > 0) & (sampled[:, 3] > 0)
    broad_values = sampled[valid, 0] / sampled[valid, 1]
    narrow_values = sampled[valid, 2] / sampled[valid, 3]
    difference = broad_values - narrow_values
    broad_actual = rows.loc[rows["broadSweep"], "calibrationResidual"].mean()
    narrow_actual = rows.loc[~rows["broadSweep"], "calibrationResidual"].mean()

    def interval(values: np.ndarray, actual: float) -> dict:
        return {
            "estimatePctPoints": finite(actual * 100),
            "ci95LowPctPoints": finite(np.quantile(values, 0.025) * 100),
            "ci95HighPctPoints": finite(np.quantile(values, 0.975) * 100),
            "probabilityPositivePct": finite(np.mean(values > 0) * 100),
        }

    return {
        "dayClusters": int(len(clusters)),
        "validDraws": int(valid.sum()),
        "broad": interval(broad_values, broad_actual),
        "narrow": interval(narrow_values, narrow_actual),
        "broadMinusNarrow": interval(difference, broad_actual - narrow_actual),
    }


def fine_stratified_breadth_permutation(
    bets: pd.DataFrame, threshold: int, split_timestamp: int
) -> dict:
    rows = bets.copy()
    rows["broadSweep"] = rows["onchainUniqueMakers"] >= threshold
    rows["calibrationResidual"] = rows["won"] - rows["observedExecutionPrice"]
    rows["priceBand"] = pd.cut(
        rows["observedExecutionPrice"], [0, 0.45, 0.60, 1.0],
        labels=["low", "middle", "high"], include_lowest=True
    ).astype(str)
    rows["period"] = np.where(
        rows["signalTimestamp"] < split_timestamp, "earlier", "later"
    )
    groups = [
        group for _, group in rows.groupby(["discipline", "priceBand", "period"])
        if group["broadSweep"].nunique() == 2
    ]
    rng = np.random.default_rng(SEED + 509)
    simulated_numerator = np.zeros(BOOTSTRAP_DRAWS)
    actual_numerator = 0.0
    total_weight = 0.0
    comparable_bets = 0
    for group in groups:
        residuals = group["calibrationResidual"].to_numpy(dtype=float)
        labels = group["broadSweep"].to_numpy(dtype=bool)
        broad_count = int(labels.sum())
        narrow_count = len(labels) - broad_count
        weight = broad_count * narrow_count / len(labels)
        actual_difference = residuals[labels].mean() - residuals[~labels].mean()
        random_order = np.argpartition(
            rng.random((BOOTSTRAP_DRAWS, len(labels))), broad_count - 1, axis=1
        )[:, :broad_count]
        broad_sum = residuals[random_order].sum(axis=1)
        simulated_difference = (
            broad_sum / broad_count
            - (residuals.sum() - broad_sum) / narrow_count
        )
        actual_numerator += weight * actual_difference
        simulated_numerator += weight * simulated_difference
        total_weight += weight
        comparable_bets += len(group)
    actual = actual_numerator / total_weight
    simulated = simulated_numerator / total_weight
    return {
        "method": "Shuffle broad-sweep labels within discipline x three public-price bands x fixed chronological period, preserving each stratum's broad-sweep count; statistic is the overlap-weighted calibration-gap difference.",
        "strata": len(groups),
        "comparableBets": comparable_bets,
        "effectPctPoints": finite(actual * 100),
        "oneSidedPValue": finite(
            (np.sum(simulated >= actual) + 1) / (BOOTSTRAP_DRAWS + 1)
        ),
        "nullCi95LowPctPoints": finite(np.quantile(simulated, 0.025) * 100),
        "nullCi95HighPctPoints": finite(np.quantile(simulated, 0.975) * 100),
        "warning": "Post-discovery composition control. It preserves discipline, price band, period, and the number of broad signals, but it does not remove wallet-selection bias.",
    }


def breadth_threshold_selection_null(
    bets: pd.DataFrame,
    development_end: int,
    threshold_candidates: list[int],
    selected_threshold: int,
) -> dict:
    probabilities = bets["observedExecutionPrice"].clip(0.01, 0.99).to_numpy(dtype=float)
    outcomes = bets["won"].to_numpy(dtype=int)
    breadth = bets["onchainUniqueMakers"].to_numpy(dtype=float)
    development = np.arange(development_end)
    held_out = np.arange(development_end, len(bets))
    eligible = [
        threshold for threshold in threshold_candidates
        if int((breadth[development] >= threshold).sum()) >= 8
    ]
    selected_mask = breadth[held_out] >= selected_threshold
    actual = (outcomes[held_out][selected_mask] - probabilities[held_out][selected_mask]).mean()

    rng = np.random.default_rng(SEED + 521)
    simulated_outcomes = (
        rng.random((BOOTSTRAP_DRAWS, len(bets))) < probabilities
    ).astype(np.int8)
    development_scores = np.empty((BOOTSTRAP_DRAWS, len(eligible)))
    for index, threshold in enumerate(eligible):
        mask = breadth[development] >= threshold
        development_scores[:, index] = (
            simulated_outcomes[:, development][:, mask] - probabilities[development][mask]
        ).mean(axis=1)
    selected_indexes = development_scores.argmax(axis=1)
    simulated_held_out = np.empty(BOOTSTRAP_DRAWS)
    selection_counts = {}
    for index, threshold in enumerate(eligible):
        selected = selected_indexes == index
        selection_counts[str(threshold)] = int(selected.sum())
        mask = breadth[held_out] >= threshold
        simulated_held_out[selected] = (
            simulated_outcomes[selected][:, held_out][:, mask] - probabilities[held_out][mask]
        ).mean(axis=1)
    return {
        "method": "Simulate each outcome from its public execution-proxy probability, repeat development-only threshold selection, then score the selected threshold on the untouched validation-plus-final half.",
        "draws": BOOTSTRAP_DRAWS,
        "eligibleThresholds": eligible,
        "minimumDevelopmentBets": 8,
        "selectedThreshold": selected_threshold,
        "heldOutBets": int(selected_mask.sum()),
        "heldOutEffectPctPoints": finite(actual * 100),
        "oneSidedPValue": finite(
            (np.sum(simulated_held_out >= actual) + 1) / (BOOTSTRAP_DRAWS + 1)
        ),
        "nullMedianPctPoints": finite(np.median(simulated_held_out) * 100),
        "nullCi95LowPctPoints": finite(np.quantile(simulated_held_out, 0.025) * 100),
        "nullCi95HighPctPoints": finite(np.quantile(simulated_held_out, 0.975) * 100),
        "selectionCounts": selection_counts,
        "warning": "This corrects the declared breadth-threshold search under a calibrated-market null. It does not correct the prior choice of wallet, base universe, or feature family.",
    }


def probability_offset_models(bets: pd.DataFrame, threshold: int) -> dict:
    rows = bets.copy()
    rows["broadSweep"] = (rows["onchainUniqueMakers"] >= threshold).astype(float)
    rows["rapid"] = (rows["takerBurst60Share"] >= 0.80).astype(float)
    log_notional = np.log(rows["onchainTargetNotionalUsdc"].clip(lower=1))
    rows["logNotionalCentered"] = log_notional - log_notional.mean()
    first = int(len(rows) * 0.50)
    second = int(len(rows) * 0.70)
    rows["validationPeriod"] = 0.0
    rows.loc[first:second - 1, "validationPeriod"] = 1.0
    rows["finalPeriod"] = 0.0
    rows.loc[second:, "finalPeriod"] = 1.0
    offset = np.log(
        rows["observedExecutionPrice"].clip(0.01, 0.99)
        / (1 - rows["observedExecutionPrice"].clip(0.01, 0.99))
    )

    def fit(name: str, columns: list[str]) -> dict:
        design = sm.add_constant(rows[columns].astype(float), has_constant="add")
        model = sm.GLM(
            rows["won"], design, family=sm.families.Binomial(), offset=offset
        ).fit(cov_type="HC1")
        confidence = model.conf_int()
        return {
            "name": name,
            "features": columns,
            "aic": finite(model.aic),
            "deviance": finite(model.deviance),
            "coefficients": [{
                "name": column,
                "coefficient": finite(model.params[column]),
                "oddsRatio": finite(np.exp(model.params[column])),
                "robustPValue": finite(model.pvalues[column]),
                "oddsRatioCi95Low": finite(np.exp(confidence.loc[column, 0])),
                "oddsRatioCi95High": finite(np.exp(confidence.loc[column, 1])),
            } for column in design.columns],
        }

    return {
        "method": "Binomial GLM with logit(public execution-proxy price) as a fixed offset. HC1 robust standard errors test whether observable features add odds beyond the market price.",
        "breadthOnly": fit("breadthOnly", ["broadSweep"]),
        "breadthAndUrgency": fit("breadthAndUrgency", ["broadSweep", "rapid"]),
        "sizeAndPeriodControlled": fit(
            "sizeAndPeriodControlled",
            [
                "broadSweep", "rapid", "logNotionalCentered",
                "validationPeriod", "finalPeriod",
            ],
        ),
        "warning": "Retrospective explanatory models, not prospective probability forecasts. Sparse categories are handled separately by the stratified permutation rather than unstable discipline dummy coefficients.",
    }


def breadth_edge_audit(base: pd.DataFrame, final_split_timestamp: int) -> dict:
    bets = prepare_bets(base, 60, 5).sort_values("signalTimestamp").reset_index(drop=True)
    if bets["onchainUniqueMakers"].isna().any():
        raise ValueError("Atomic breadth analysis requires decoded trigger transactions for every base event")
    first = int(len(bets) * 0.50)
    second = int(len(bets) * 0.70)
    development = bets.iloc[:first]
    validation = bets.iloc[first:second]
    final_test = bets.iloc[second:]
    held_out = bets.iloc[first:]
    threshold_rows = []
    for threshold in ONCHAIN_BREADTH_CANDIDATES:
        dev = development[development["onchainUniqueMakers"] >= threshold]
        val = validation[validation["onchainUniqueMakers"] >= threshold]
        final = final_test[final_test["onchainUniqueMakers"] >= threshold]
        threshold_rows.append({
            "minimumUniqueMakers": threshold,
            "development": summarize_bets(dev),
            "developmentCalibration": calibration_summary(dev),
            "validation": summarize_bets(val),
            "validationCalibration": calibration_summary(val),
            "finalTest": summarize_bets(final),
            "finalTestCalibration": calibration_summary(final),
        })
    eligible = [
        row for row in threshold_rows
        if row["development"].get("bets", 0) >= 8
    ]
    selected = max(
        eligible,
        key=lambda row: row["developmentCalibration"].get(
            "calibrationGapPctPoints", -np.inf
        ),
    )
    threshold = ONCHAIN_BREADTH_THRESHOLD
    broad = bets[bets["onchainUniqueMakers"] >= threshold]
    narrow = bets[bets["onchainUniqueMakers"] < threshold]
    broad_development = development[development["onchainUniqueMakers"] >= threshold]
    broad_validation = validation[validation["onchainUniqueMakers"] >= threshold]
    broad_final = final_test[final_test["onchainUniqueMakers"] >= threshold]
    broad_held_out = held_out[held_out["onchainUniqueMakers"] >= threshold]
    broad_rapid = broad[broad["takerBurst60Share"] >= 0.80]
    broad_slow = broad[broad["takerBurst60Share"] < 0.80]

    execution_sensitivity = []
    selected_base = base[base["onchainUniqueMakers"] >= threshold]
    development_end_timestamp = int(bets.iloc[first]["signalTimestamp"])
    validation_end_timestamp = int(bets.iloc[second]["signalTimestamp"])
    for lag in LAGS:
        for slippage in EXECUTION_SLIPPAGE_CENTS:
            scenario = prepare_bets(selected_base, lag, slippage)
            execution_sensitivity.append({
                "lagSeconds": lag,
                "slippageCents": slippage,
                "publicPrintCoveragePct": finite((~scenario["usedFallbackPrice"]).mean() * 100),
                "all": summarize_bets(scenario),
                "development": summarize_bets(
                    scenario[scenario["signalTimestamp"] < development_end_timestamp]
                ),
                "validation": summarize_bets(scenario[
                    (scenario["signalTimestamp"] >= development_end_timestamp)
                    & (scenario["signalTimestamp"] < validation_end_timestamp)
                ]),
                "finalTest": summarize_bets(
                    scenario[scenario["signalTimestamp"] >= validation_end_timestamp]
                ),
            })
    execution_break_even = [{
        "lagSeconds": lag,
        "allMaxAdverseCents": break_even_slippage_cents(selected_base, lag),
        "heldOutMaxAdverseCents": break_even_slippage_cents(
            selected_base[selected_base["signalTimestamp"] >= development_end_timestamp], lag
        ),
        "finalTestMaxAdverseCents": break_even_slippage_cents(
            selected_base[selected_base["signalTimestamp"] >= validation_end_timestamp], lag
        ),
    } for lag in LAGS]

    return {
        "candidateMechanism": "Atomic breadth: the signal transaction consumes liquidity from many distinct signed maker accounts, revealing a stronger commitment than one large public trade print alone.",
        "featureAvailability": "The maker array is part of the mined matchOrders calldata and is observable once the trigger transaction is mined. The execution audit spans same-second through five-minute entry.",
        "executionTimingLimits": {
            "timeOrigin": "The decoded trigger transaction's integer-second Polygon block timestamp.",
            "detectionMode": "On-chain breadth cannot be known until matchOrders calldata is available from the mined transaction. Polymarket's earlier off-chain CLOB MATCHED state is a different, untested clock.",
            "timestampResolutionSeconds": 1,
            "sameSecondScenario": "Optimistic lower bound using the first unrelated public print stamped in the trigger second; ordering within that second is unavailable.",
            "subsecondScenario": "A 0.1-second and 0.5-second bot cannot be distinguished in this historical tape. Both lie between the same-second optimistic bound and the first full-second scenario.",
            "priceProxy": "Median price of unrelated public prints at the first observed second within the next 60 seconds, then an explicit adverse-price penalty and the observed fee curve.",
            "unobserved": "Historical order-book depth, websocket/indexer publication delay, queue position, partial fills, and rejected orders are unavailable.",
        },
        "algorithm": {
            "name": "atomic-breadth-18",
            "baseGuards": [
                "first canonical event signal only",
                "core Tennis/Soccer/esports disciplines",
                "exclude single-game/map and short-horizon contracts",
                "trigger price from 0.30 through 0.85",
                "target concentration at least 0.70",
            ],
            "trigger": "Decode the target's mined CTF Exchange V2 matchOrders transaction and count distinct maker addresses in its makerOrders array.",
            "entry": f"Paper entry only when at least {threshold} distinct maker accounts were matched. Add no artificial delay: after the mined transaction is decoded, snapshot the live best ask and displayed depth, then create a $100 paper-only marketable FOK limit capped one cent above that first ask and never above 0.90. Record block-to-detection and detection-to-order latency, insufficient depth, rejections, partial fills, and fees. The historical registered reference remains 60 seconds plus five cents, with the full same-second-to-five-minute execution surface reported.",
            "confidenceTag": "Mark signals with at least 80% of prior target taker buying in the final minute as high confidence, but do not discard slower broad sweeps until prospective data supports that extra gate.",
            "stake": "Equal $100 paper stake per eligible canonical event; no martingale or outcome-dependent sizing.",
        },
        "thresholdSelection": {
            "method": "Search integer breadth thresholds 5 through 30 on the first 50% only; require at least eight development bets; maximize development calibration residual; do not use validation or final outcomes for selection.",
            "selectedFromDevelopment": selected["minimumUniqueMakers"],
            "frozenAlgorithmThreshold": threshold,
            "developmentEnd": development.iloc[-1]["signalTime"],
            "validationEnd": validation.iloc[-1]["signalTime"],
            "candidates": threshold_rows,
            "marketNullSimulation": breadth_threshold_selection_null(
                bets,
                first,
                list(ONCHAIN_BREADTH_CANDIDATES),
                threshold,
            ),
        },
        "chronology": {
            "development": summarize_bets(broad_development),
            "developmentCalibration": calibration_summary(broad_development),
            "validation": summarize_bets(broad_validation),
            "validationCalibration": calibration_summary(broad_validation),
            "finalTest": summarize_bets(broad_final),
            "finalTestCalibration": calibration_summary(broad_final),
            "heldOutAfterDevelopment": summarize_bets(broad_held_out),
            "heldOutCalibration": calibration_summary(broad_held_out),
            "heldOutDayClusterBootstrap": day_cluster_bootstrap(broad_held_out),
        },
        "all": summarize_bets(broad),
        "allCalibration": calibration_summary(broad),
        "allDayClusterBootstrap": day_cluster_bootstrap(broad),
        "belowThreshold": summarize_bets(narrow),
        "belowThresholdCalibration": calibration_summary(narrow),
        "dayClusterCalibrationContrast": breadth_day_cluster_calibration(
            bets, threshold
        ),
        "compositionControlledPermutation": fine_stratified_breadth_permutation(
            bets, threshold, final_split_timestamp
        ),
        "probabilityOffsetModels": probability_offset_models(bets, threshold),
        "urgencyInteraction": {
            "broadAndRapid": summarize_bets(broad_rapid),
            "broadAndRapidCalibration": calibration_summary(broad_rapid),
            "broadButSlower": summarize_bets(broad_slow),
            "broadButSlowerCalibration": calibration_summary(broad_slow),
            "warning": "The rapid subset is stronger over all history but was negative after costs in the middle validation block, so urgency remains a confidence tag rather than a second hard gate.",
        },
        "executionSensitivity": execution_sensitivity,
        "executionBreakEven": execution_break_even,
        "warning": "This is the strongest observable fingerprint found in this two-month wallet sample, not proof of private information or future profitability. Distinct maker addresses are distinct signed accounts, not proven distinct humans.",
    }


def mechanism_audit(base: pd.DataFrame, split_timestamp: int) -> dict:
    bets = prepare_bets(base, 60, 5).sort_values("signalTimestamp").reset_index(drop=True)
    bets["burst60"] = bets["takerBurst60Share"] >= 0.80
    bets["oneShot"] = bets["triggerFillShare"] >= 0.80

    def grouped(column: str, labels: dict | None = None) -> list[dict]:
        output = []
        for key, group in bets.groupby(column, sort=True):
            label = labels.get(key, str(key)) if labels else str(key)
            output.append({
                "key": label,
                **summarize_bets(group),
                "calibration": calibration_summary(group),
            })
        return output

    def crossed(column: str, labels: dict | None = None) -> list[dict]:
        output = []
        for (key, is_burst), group in bets.groupby([column, "burst60"], sort=True):
            label = labels.get(key, str(key)) if labels else str(key)
            output.append({
                "key": label,
                "urgency": "rapid" if is_burst else "slower",
                **summarize_bets(group),
                "calibration": calibration_summary(group),
            })
        return output

    thresholds = []
    for threshold in (0.50, 0.60, 0.70, 0.80, 0.90, 0.95, 0.99):
        selected = bets[bets["takerBurst60Share"] >= threshold]
        thresholds.append({
            "minimumBurstShare": threshold,
            **summarize_bets(selected),
            "calibration": calibration_summary(selected),
        })

    earlier = bets[bets["signalTimestamp"] < split_timestamp]
    later = bets[bets["signalTimestamp"] >= split_timestamp]
    burst = bets[bets["burst60"]]
    slower = bets[~bets["burst60"]]
    return {
        "candidateMechanism": "Conviction compression: most aggressive target buying arrives in one minute, while the public execution proxy has not yet incorporated the target side's later realized win frequency.",
        "calibration": {
            "all": calibration_summary(bets),
            "burst60": calibration_summary(burst),
            "slower": calibration_summary(slower),
            "earlier": {
                "burst60": calibration_summary(earlier[earlier["burst60"]]),
                "slower": calibration_summary(earlier[~earlier["burst60"]]),
            },
            "later": {
                "burst60": calibration_summary(later[later["burst60"]]),
                "slower": calibration_summary(later[~later["burst60"]]),
            },
            "dayClusterBootstrap": day_cluster_calibration(bets),
        },
        "compositionControls": {
            "broadCmh": composition_controlled_burst_test(bets),
            "finePermutation": fine_stratified_permutation(bets, split_timestamp),
        },
        "thresholdSensitivity": thresholds,
        "transactionShape": {
            "oneShotSignals": int(bets["oneShot"].sum()),
            "oneShotSignalsAlsoBurst": int((bets["oneShot"] & bets["burst60"]).sum()),
            "multiFillBurstSignals": int((~bets["oneShot"] & bets["burst60"]).sum()),
            "groups": [
                {
                    "key": "slower multi-fill",
                    **summarize_bets(bets[~bets["burst60"] & ~bets["oneShot"]]),
                },
                {
                    "key": "rapid multi-fill",
                    **summarize_bets(bets[bets["burst60"] & ~bets["oneShot"]]),
                },
                {
                    "key": "rapid one-shot",
                    **summarize_bets(bets[bets["burst60"] & bets["oneShot"]]),
                },
            ],
            "warning": "At the threshold-crossing timestamp every one-shot signal is mechanically a burst signal, so the two features cannot be interpreted as independent treatments.",
        },
        "byTiming": grouped("pregame", {0: "in-play", 1: "pregame"}),
        "byTimingAndUrgency": crossed("pregame", {0: "in-play", 1: "pregame"}),
        "byDiscipline": grouped("discipline"),
        "byDisciplineAndUrgency": crossed("discipline"),
        "byMarketType": grouped("marketType"),
        "byMarketTypeAndUrgency": crossed("marketType"),
    }


def blind_copy_audit(features: pd.DataFrame, split_timestamp: int) -> dict:
    universe = features[features["concentration"] >= 0.70].sort_values(
        "signalTimestamp"
    ).drop_duplicates("eventKey", keep="first").reset_index(drop=True)
    bets = prepare_bets(universe, 60, 5)
    execution_sensitivity = []
    for lag in LAGS:
        for slippage in EXECUTION_SLIPPAGE_CENTS:
            scenario = prepare_bets(universe, lag, slippage)
            execution_sensitivity.append({
                "lagSeconds": lag,
                "slippageCents": slippage,
                "publicPrintCoveragePct": finite((~scenario["usedFallbackPrice"]).mean() * 100),
                "all": summarize_bets(scenario),
                "later": summarize_bets(
                    scenario[scenario["signalTimestamp"] >= split_timestamp]
                ),
            })
    execution_break_even = [{
        "lagSeconds": lag,
        "allMaxAdverseCents": break_even_slippage_cents(universe, lag),
        "laterMaxAdverseCents": break_even_slippage_cents(
            universe[universe["signalTimestamp"] >= split_timestamp], lag
        ),
    } for lag in LAGS]
    return {
        "definition": "Copy every first canonical-event signal after the target crosses $25,000 at >=70% concentration; no discipline, format, price, or burst filter.",
        "all": summarize_bets(bets),
        "earlier": summarize_bets(bets[bets["signalTimestamp"] < split_timestamp]),
        "later": summarize_bets(bets[bets["signalTimestamp"] >= split_timestamp]),
        "calibration": calibration_summary(bets),
        "executionSensitivity": execution_sensitivity,
        "executionBreakEven": execution_break_even,
        "decision": "Rejected: blind copying is negative both overall and after the fixed chronological split.",
    }


def risk_summary(bets: pd.DataFrame) -> dict:
    if bets.empty:
        return {"bets": 0}
    ordered = bets.sort_values("signalTimestamp").copy()
    losses = ordered["won"].eq(0).astype(int).to_numpy()
    longest_loss_streak = 0
    current_loss_streak = 0
    for loss in losses:
        current_loss_streak = current_loss_streak + 1 if loss else 0
        longest_loss_streak = max(longest_loss_streak, current_loss_streak)
    daily = ordered.assign(
        day=pd.to_datetime(ordered["signalTime"], utc=True).dt.strftime("%Y-%m-%d")
    ).groupby("day", as_index=False).agg(
        profitUsdc=("profitUsdc", "sum"),
        stakeUsdc=("stakeUsdc", "sum"),
        bets=("won", "size"),
        wins=("won", "sum"),
    )
    returns = ordered["return"].to_numpy(dtype=float) * 100
    rolling_five = ordered["return"].rolling(5).mean().dropna() * 100
    return {
        **summarize_bets(ordered),
        "tradingDays": int(len(daily)),
        "profitableDays": int((daily["profitUsdc"] > 0).sum()),
        "longestLossStreak": int(longest_loss_streak),
        "worstFiveBetRoiPct": finite(rolling_five.min()) if len(rolling_five) else None,
        "bestFiveBetRoiPct": finite(rolling_five.max()) if len(rolling_five) else None,
        "perBetReturnPct": {
            "p10": finite(np.quantile(returns, 0.10)),
            "median": finite(np.median(returns)),
            "p90": finite(np.quantile(returns, 0.90)),
        },
        "daily": [{
            "day": row.day,
            "profitUsdc": finite(row.profitUsdc),
            "stakeUsdc": finite(row.stakeUsdc),
            "bets": int(row.bets),
            "wins": int(row.wins),
        } for row in daily.itertuples(index=False)],
    }


def alpha_subgroup_atlas(bets: pd.DataFrame, threshold: int) -> dict:
    rows = bets.copy()
    rows["priceBand"] = pd.cut(
        rows["observedExecutionPrice"],
        [0, 0.45, 0.60, 0.70, 1.0],
        labels=["30-45c", "45-60c", "60-70c", "70-85c"],
        include_lowest=True,
    ).astype(str)
    rows["notionalBand"] = pd.qcut(
        rows["onchainTargetNotionalUsdc"],
        3,
        labels=["lower notional third", "middle notional third", "upper notional third"],
    ).astype(str)
    rows["timing"] = np.where(rows["pregame"] == 1, "pregame", "in-play")
    rows["urgency"] = np.where(
        rows["takerBurst60Share"] >= 0.80, "rapid", "slower"
    )

    def comparison(group: pd.DataFrame) -> dict:
        broad = group[group["onchainUniqueMakers"] >= threshold]
        narrow = group[group["onchainUniqueMakers"] < threshold]
        broad_calibration = calibration_summary(broad)
        narrow_calibration = calibration_summary(narrow)
        broad_gap = broad_calibration.get("calibrationGapPctPoints")
        narrow_gap = narrow_calibration.get("calibrationGapPctPoints")
        return {
            "bets": int(len(group)),
            "broad": summarize_bets(broad),
            "broadCalibration": broad_calibration,
            "narrow": summarize_bets(narrow),
            "narrowCalibration": narrow_calibration,
            "broadMinusNarrowCalibrationPctPoints": finite(
                broad_gap - narrow_gap
            ) if broad_gap is not None and narrow_gap is not None else None,
        }

    output = {}
    for column in ("discipline", "priceBand", "notionalBand", "timing", "urgency"):
        output[column] = [{
            "group": str(name),
            **comparison(group),
        } for name, group in rows.groupby(column, observed=True, sort=False)]
    return output


def copy_parameter_atlas(features: pd.DataFrame, base: pd.DataFrame) -> dict:
    blind_universe = features[features["concentration"] >= 0.70].sort_values(
        "signalTimestamp"
    ).drop_duplicates("eventKey", keep="first").reset_index(drop=True)
    ordered_base = base.sort_values("signalTimestamp").reset_index(drop=True)
    development_end = int(len(ordered_base) * 0.50)
    development_end_timestamp = int(
        ordered_base.iloc[development_end]["signalTimestamp"]
    )
    broad_base = ordered_base[
        ordered_base["onchainUniqueMakers"] >= ONCHAIN_BREADTH_THRESHOLD
    ]
    broad_held_out = broad_base[
        broad_base["signalTimestamp"] >= development_end_timestamp
    ]

    fee_cost_grid = []
    for fee_rate in FEE_RATES:
        for slippage in EXECUTION_SLIPPAGE_CENTS:
            fee_cost_grid.append({
                "lagSeconds": 1,
                "feeRatePct": fee_rate * 100,
                "slippageCents": slippage,
                "blindAll": summarize_bets(prepare_bets(
                    blind_universe, 1, slippage, fee_rate=fee_rate
                )),
                "breadthAll": summarize_bets(prepare_bets(
                    broad_base, 1, slippage, fee_rate=fee_rate
                )),
                "breadthHeldOut": summarize_bets(prepare_bets(
                    broad_held_out, 1, slippage, fee_rate=fee_rate
                )),
            })

    threshold_cost_grid = []
    threshold_latency_grid = []
    for threshold in ONCHAIN_BREADTH_CANDIDATES:
        selected = ordered_base[ordered_base["onchainUniqueMakers"] >= threshold]
        held_out = selected[selected["signalTimestamp"] >= development_end_timestamp]
        for slippage in EXECUTION_SLIPPAGE_CENTS:
            threshold_cost_grid.append({
                "minimumUniqueMakers": threshold,
                "lagSeconds": 1,
                "slippageCents": slippage,
                "all": summarize_bets(prepare_bets(selected, 1, slippage)),
                "heldOut": summarize_bets(prepare_bets(held_out, 1, slippage)),
            })
        for lag in LAGS:
            threshold_latency_grid.append({
                "minimumUniqueMakers": threshold,
                "lagSeconds": lag,
                "slippageCents": 1,
                "all": summarize_bets(prepare_bets(selected, lag, 1)),
                "heldOut": summarize_bets(prepare_bets(held_out, lag, 1)),
            })

    fixed_bets = prepare_bets(ordered_base, 60, 5)
    broad_fixed = fixed_bets[
        fixed_bets["onchainUniqueMakers"] >= ONCHAIN_BREADTH_THRESHOLD
    ]
    broad_fixed_held_out = broad_fixed[
        broad_fixed["signalTimestamp"] >= development_end_timestamp
    ]
    narrow_fixed = fixed_bets[
        fixed_bets["onchainUniqueMakers"] < ONCHAIN_BREADTH_THRESHOLD
    ]
    blind_fixed = prepare_bets(blind_universe, 60, 5)

    disciplines = sorted(broad_fixed["discipline"].unique())
    leave_one_discipline_out = [{
        "excludedDiscipline": discipline,
        "all": summarize_bets(broad_fixed[broad_fixed["discipline"] != discipline]),
        "heldOut": summarize_bets(
            broad_fixed_held_out[broad_fixed_held_out["discipline"] != discipline]
        ),
    } for discipline in disciplines]

    return {
        "definition": "A reproducible descriptive atlas around the frozen atomic-breadth-18 rule. Only the 18-maker result is the declared algorithm; neighboring cells are sensitivity checks, not separately discovered strategies.",
        "latenciesSeconds": list(LAGS),
        "adversePriceCents": list(EXECUTION_SLIPPAGE_CENTS),
        "feeRatesPct": [rate * 100 for rate in FEE_RATES],
        "scenarioCounts": {
            "latencyByAdversePricePerStrategy": len(LAGS) * len(EXECUTION_SLIPPAGE_CENTS),
            "latencyByAdversePriceBothStrategies": 2 * len(LAGS) * len(EXECUTION_SLIPPAGE_CENTS),
            "feeByAdversePricePerStrategy": len(FEE_RATES) * len(EXECUTION_SLIPPAGE_CENTS),
            "breadthByAdversePrice": len(ONCHAIN_BREADTH_CANDIDATES) * len(EXECUTION_SLIPPAGE_CENTS),
            "breadthByLatency": len(ONCHAIN_BREADTH_CANDIDATES) * len(LAGS),
        },
        "feeCostGrid": fee_cost_grid,
        "thresholdCostGrid": threshold_cost_grid,
        "thresholdLatencyGrid": threshold_latency_grid,
        "subgroups": alpha_subgroup_atlas(fixed_bets, ONCHAIN_BREADTH_THRESHOLD),
        "risk": {
            "blindCopy": risk_summary(blind_fixed),
            "breadthAll": risk_summary(broad_fixed),
            "breadthHeldOut": risk_summary(broad_fixed_held_out),
            "belowThreshold": risk_summary(narrow_fixed),
            "leaveOneDisciplineOut": leave_one_discipline_out,
        },
        "warning": "All cells reuse the same short historical sample. Dense parameter sweeps reveal fragility and plateaus; they do not create independent evidence or identify executable historical order-book depth.",
    }


def simulate_tape_capacity_fill(
    rows: list[dict],
    stake_usdc: float,
    participation_rate: float,
    won: int,
) -> dict:
    remaining_quote = float(stake_usdc)
    shares = 0.0
    for row in rows:
        available_shares = float(row["shares"]) * participation_rate
        available_quote = available_shares * float(row["price"])
        take_quote = min(remaining_quote, available_quote)
        if take_quote <= 0:
            continue
        shares += take_quote / float(row["price"])
        remaining_quote -= take_quote
        if remaining_quote <= 1e-8:
            break
    if remaining_quote > 1e-8 or shares <= 0:
        return {"filled": False}
    vwap = stake_usdc / shares
    fee_usdc = shares * TARGET_FEE_RATE * vwap * (1 - vwap)
    deployed_capital = stake_usdc + fee_usdc
    profit = shares - deployed_capital if won else -deployed_capital
    return {
        "filled": True,
        "vwap": vwap,
        "feeUsdc": fee_usdc,
        "deployedCapitalUsdc": deployed_capital,
        "profitUsdc": profit,
    }


def historical_tape_capacity(
    features: pd.DataFrame,
    base: pd.DataFrame,
    tape_data: dict,
) -> dict:
    target_wallet = str(tape_data["targetWallet"]).lower()
    tape_by_condition = {row["conditionId"]: row for row in tape_data["tapes"]}
    capacity_by_condition = {}
    for row in features.itertuples(index=False):
        tape = tape_by_condition.get(row.conditionId)
        if not tape:
            continue
        normalized = normalized_tape_rows(tape, row.outcome, target_wallet)
        start = int(row.signalTimestamp) + 1
        anchor, anchor_wait = first_mark(normalized, start)
        used_fallback = not np.isfinite(anchor)
        if used_fallback:
            anchor = float(row.triggerPrice)
        cells = {}
        for window in CAPACITY_WINDOWS_SECONDS:
            for buffer_cents in CAPACITY_PRICE_BUFFERS_CENTS:
                maximum_price = min(0.90, anchor + buffer_cents / 100)
                all_prints = sorted([
                    trade for trade in normalized
                    if not trade["isTarget"]
                    and start <= trade["timestamp"] <= start + window
                    and trade["price"] <= maximum_price + 1e-12
                ], key=lambda trade: trade["timestamp"])
                cells[(window, buffer_cents, "allPrints")] = all_prints
                cells[(window, buffer_cents, "reportedAlignedBuys")] = [
                    trade for trade in all_prints if trade["direction"] == 1
                ]
        capacity_by_condition[row.conditionId] = {
            "anchor": float(anchor),
            "anchorWaitSeconds": finite(anchor_wait),
            "usedFallback": used_fallback,
            "cells": cells,
        }

    blind = features[features["concentration"] >= 0.70].sort_values(
        "signalTimestamp"
    ).drop_duplicates("eventKey", keep="first").reset_index(drop=True)
    ordered_base = base.sort_values("signalTimestamp").reset_index(drop=True)
    development_timestamp = int(ordered_base.iloc[int(len(ordered_base) * 0.50)]["signalTimestamp"])
    breadth_all = ordered_base[
        ordered_base["onchainUniqueMakers"] >= ONCHAIN_BREADTH_THRESHOLD
    ]
    strategies = {
        "blindAll": blind,
        "breadthAll": breadth_all,
        "breadthHeldOut": breadth_all[
            breadth_all["signalTimestamp"] >= development_timestamp
        ],
    }
    grid = []
    for strategy, strategy_frame in strategies.items():
        for proxy in ("allPrints", "reportedAlignedBuys"):
            for window in CAPACITY_WINDOWS_SECONDS:
                for buffer_cents in CAPACITY_PRICE_BUFFERS_CENTS:
                    event_rows = []
                    for row in strategy_frame.itertuples(index=False):
                        capacity = capacity_by_condition.get(row.conditionId)
                        if not capacity:
                            continue
                        prints = capacity["cells"][(window, buffer_cents, proxy)]
                        event_rows.append({
                            "conditionId": row.conditionId,
                            "won": int(row.won),
                            "anchor": capacity["anchor"],
                            "capacityUsdc": sum(
                                trade["shares"] * trade["price"] for trade in prints
                            ),
                            "prints": prints,
                        })
                    for participation in CAPACITY_PARTICIPATION_RATES:
                        for stake in CAPACITY_STAKES_USDC:
                            fills = []
                            for event in event_rows:
                                fill = simulate_tape_capacity_fill(
                                    event["prints"], stake, participation, event["won"]
                                )
                                if fill["filled"]:
                                    fills.append({**event, **fill})
                            deployed = sum(fill["deployedCapitalUsdc"] for fill in fills)
                            profit = sum(fill["profitUsdc"] for fill in fills)
                            grid.append({
                                "strategy": strategy,
                                "proxy": proxy,
                                "windowSeconds": window,
                                "bufferCents": buffer_cents,
                                "participationRatePct": participation * 100,
                                "stakeUsdc": stake,
                                "opportunities": len(event_rows),
                                "fills": len(fills),
                                "fillRatePct": len(fills) / len(event_rows) * 100 if event_rows else None,
                                "wins": sum(fill["won"] for fill in fills),
                                "deployedCapitalUsdc": finite(deployed),
                                "profitUsdc": finite(profit),
                                "roiOnDeployedCapitalPct": finite(profit / deployed * 100) if deployed else None,
                                "profitPerOpportunityUsdc": finite(profit / len(event_rows)) if event_rows else None,
                                "returnOnRequestedQuotePct": finite(
                                    profit / (len(event_rows) * stake) * 100
                                ) if event_rows else None,
                                "observedCapacityUsdc": quantiles([
                                    event["capacityUsdc"] * participation
                                    for event in event_rows
                                ]),
                                "vwapAdverseCents": quantiles([
                                    (fill["vwap"] - fill["anchor"]) * 100
                                    for fill in fills
                                ]),
                            })

    held_out_events = []
    for row in strategies["breadthHeldOut"].itertuples(index=False):
        capacity = capacity_by_condition[row.conditionId]
        held_out_events.append({
            "conditionId": row.conditionId,
            "title": row.title,
            "signalTime": row.signalTime,
            "won": int(row.won),
            "anchorPrice": capacity["anchor"],
            "usedFallback": bool(capacity["usedFallback"]),
            "capacityAtOneCentUsdc": {
                str(window): {
                    proxy: finite(sum(
                        trade["shares"] * trade["price"]
                        for trade in capacity["cells"][(window, 1, proxy)]
                    ))
                    for proxy in ("allPrints", "reportedAlignedBuys")
                }
                for window in CAPACITY_WINDOWS_SECONDS
            },
        })
    return {
        "definition": "One-second-lag cumulative non-target public turnover at or below a price ceiling, converted into size scenarios. This is a throughput envelope, not reconstructed simultaneous order-book depth.",
        "windowsSeconds": list(CAPACITY_WINDOWS_SECONDS),
        "priceBuffersCents": list(CAPACITY_PRICE_BUFFERS_CENTS),
        "participationRatesPct": [rate * 100 for rate in CAPACITY_PARTICIPATION_RATES],
        "stakeSizesUsdc": list(CAPACITY_STAKES_USDC),
        "scenarioCount": len(grid),
        "proxies": {
            "allPrints": "Optimistic direction-neutral turnover ceiling; assumes the follower could replace a fraction of every observed public print.",
            "reportedAlignedBuys": "Narrower reported-side turnover proxy; public aggressor labels are known to be noisy.",
        },
        "grid": grid,
        "breadthHeldOutEvents": held_out_events,
        "warning": "Neither proxy proves FOK capacity at one instant. Unfilled opportunities remain cash and contribute zero P&L; ROI on deployed capital can therefore be selected by liquidity.",
    }


def closing_group_summary(rows: pd.DataFrame) -> dict:
    if rows.empty:
        return {"events": 0}
    values = rows["closingLineValueCents"].to_numpy(dtype=float)
    return {
        "events": int(len(rows)),
        "wins": int(rows["won"].sum()),
        "winRatePct": finite(rows["won"].mean() * 100),
        "meanClosingLineValueCents": finite(values.mean()),
        "medianClosingLineValueCents": finite(np.median(values)),
        "positiveClosingLineEvents": int((values > 0).sum()),
        "positiveClosingLinePct": finite((values > 0).mean() * 100),
        "meanTriggerProbabilityPct": finite(rows["triggerPrice"].mean() * 100),
        "meanClosingProbabilityPct": finite(rows["closingPrice"].mean() * 100),
        "closingCalibrationGapPctPoints": finite(
            (rows["won"].mean() - rows["closingPrice"].mean()) * 100
        ),
        "closingPrintStalenessSeconds": quantiles(
            rows["closingPrintStalenessSeconds"].tolist()
        ),
    }


def closing_line_audit(base: pd.DataFrame, closing_data: dict) -> dict:
    closing = pd.DataFrame(closing_data.get("events", []))
    if closing.empty:
        return {"events": 0, "warning": "No closing-line artifact was available."}
    columns = [
        "conditionId", "onchainPriceLevels", "onchainRestingAgeMedianSeconds",
    ]
    merged = closing.merge(base[columns], on="conditionId", how="inner")
    merged = merged[np.isfinite(merged["closingPrice"])].copy()
    broad_mask = merged["onchainUniqueMakers"] >= ONCHAIN_BREADTH_THRESHOLD
    compact_fresh = (
        broad_mask
        & (merged["onchainPriceLevels"] <= 3)
        & (merged["onchainRestingAgeMedianSeconds"] <= 300)
    )
    broad = merged[broad_mask]
    narrow = merged[~broad_mask]
    positive = int((broad["closingLineValueCents"] > 0).sum())
    broad_n = len(broad)
    comparison = mannwhitneyu(
        broad["closingLineValueCents"],
        narrow["closingLineValueCents"],
        alternative="two-sided",
    ) if len(broad) and len(narrow) else None
    return {
        "definition": closing_data.get("definition"),
        "sourceGeneratedAt": closing_data.get("generatedAt"),
        "allEligiblePregame": closing_group_summary(merged),
        "breadthPregame": closing_group_summary(broad),
        "belowThresholdPregame": closing_group_summary(narrow),
        "compactFreshBreadthPregame": closing_group_summary(merged[compact_fresh]),
        "tests": {
            "breadthPositiveClvSignTest": {
                "positive": positive,
                "events": broad_n,
                "oneSidedPValueForPositiveClv": finite(
                    binomtest(positive, broad_n, 0.5, alternative="greater").pvalue
                ) if broad_n else None,
            },
            "breadthVsNarrowMannWhitney": {
                "statistic": finite(comparison.statistic) if comparison else None,
                "twoSidedPValue": finite(comparison.pvalue) if comparison else None,
            },
        },
        "events": merged.sort_values("signalTimestamp").to_dict("records"),
        "interpretation": "The breadth sample won often, but its pregame prices did not generally move toward the target before play. Settlement alpha is therefore not independently confirmed by closing-line value.",
        "warning": "Closing prints are a validation benchmark, not executable quotes. The sample is small and excludes in-play signals.",
    }


def mechanism_alternative_audit(base: pd.DataFrame, trigger_data: dict) -> dict:
    eligible = base.sort_values("signalTimestamp").copy()
    broad = eligible[eligible["onchainUniqueMakers"] >= ONCHAIN_BREADTH_THRESHOLD].copy()
    narrow = eligible[eligible["onchainUniqueMakers"] < ONCHAIN_BREADTH_THRESHOLD].copy()

    def age_median(rows: pd.DataFrame) -> float | None:
        values = pd.to_numeric(rows["onchainRestingAgeMedianSeconds"], errors="coerce").dropna()
        return finite(values.median()) if len(values) else None

    transactions = {
        row.get("conditionId"): row
        for row in trigger_data.get("transactions", [])
        if row.get("conditionId") and not row.get("error")
    }
    maker_history = defaultdict(list)
    maker_event_counts = defaultdict(int)
    identity_rows = []
    all_makers = set()
    for _, event in broad.iterrows():
        transaction = transactions.get(event["conditionId"], {})
        makers = {
            fill.get("maker")
            for fill in transaction.get("sweep", {}).get("fills", [])
            if fill.get("maker")
        }
        all_makers.update(makers)
        for maker in makers:
            maker_event_counts[maker] += 1
        prior_makers = [maker for maker in makers if maker_history[maker]]
        prior_outcomes = [
            outcome
            for maker in prior_makers
            for outcome in maker_history[maker]
        ]
        identity_rows.append({
            "conditionId": event["conditionId"],
            "won": int(event["won"]),
            "makers": len(makers),
            "priorSeenMakers": len(prior_makers),
            "priorSeenMakerSharePct": safe_div(len(prior_makers), len(makers), 0) * 100,
            "priorTargetWinRateAcrossMakerHistoryPct": (
                safe_div(sum(prior_outcomes), len(prior_outcomes), 0) * 100
                if prior_outcomes else None
            ),
        })
        for maker in makers:
            maker_history[maker].append(int(event["won"]))

    identity = pd.DataFrame(identity_rows)

    def median_by_outcome(column: str, won: int) -> float | None:
        if identity.empty:
            return None
        values = pd.to_numeric(
            identity.loc[identity["won"] == won, column], errors="coerce"
        ).dropna()
        return finite(values.median()) if len(values) else None

    return {
        "staleLiquidity": {
            "broadMedianMakerAgeSeconds": age_median(broad),
            "narrowMedianMakerAgeSeconds": age_median(narrow),
            "broadWinnerMedianMakerAgeSeconds": age_median(broad[broad["won"] == 1]),
            "broadLossMedianMakerAgeSeconds": age_median(broad[broad["won"] == 0]),
            "interpretation": "Broad winners consumed fresher, not older, maker orders than broad losses. A stale-quote harvesting story is not supported by this sample.",
        },
        "recurringMakerIdentity": {
            "broadSignals": int(len(broad)),
            "uniqueMakersAcrossBroadSignals": len(all_makers),
            "makersSeenInMultipleBroadSignals": sum(
                count >= 2 for count in maker_event_counts.values()
            ),
            "signalsWithAnyPriorMakerHistory": int(sum(
                row["priorSeenMakers"] > 0 for row in identity_rows
            )),
            "winnerMedianPriorSeenMakerSharePct": median_by_outcome(
                "priorSeenMakerSharePct", 1
            ),
            "lossMedianPriorSeenMakerSharePct": median_by_outcome(
                "priorSeenMakerSharePct", 0
            ),
            "winnerMedianPriorTargetWinRateAcrossMakerHistoryPct": median_by_outcome(
                "priorTargetWinRateAcrossMakerHistoryPct", 1
            ),
            "lossMedianPriorTargetWinRateAcrossMakerHistoryPct": median_by_outcome(
                "priorTargetWinRateAcrossMakerHistoryPct", 0
            ),
            "interpretation": "Recurring counterparties and their prior target-side outcomes do not cleanly separate broad wins from losses. Maker identity is not a usable replacement for transaction geometry.",
        },
    }


def compact_fresh_null(
    broad: pd.DataFrame,
    development_mask: np.ndarray,
    candidates: list[dict],
    observed_held_out_gap: float,
    draws: int = BOOTSTRAP_DRAWS,
) -> dict:
    probabilities = broad["observedExecutionPrice"].to_numpy(dtype=float)
    held_out = ~development_mask
    rng = np.random.default_rng(SEED + 733)
    null_effects = []
    for _ in range(draws):
        outcomes = rng.binomial(1, probabilities)
        best = None
        for candidate in candidates:
            mask = candidate["mask"]
            selected_development = mask & development_mask
            gap = float(np.mean(
                outcomes[selected_development] - probabilities[selected_development]
            ))
            key = (
                gap,
                int(selected_development.sum()),
                -candidate["maximumPriceLevels"],
                -candidate["maximumMedianMakerAgeSeconds"],
            )
            if best is None or key > best[0]:
                best = (key, mask)
        selected_held_out = best[1] & held_out
        null_effects.append(float(np.mean(
            outcomes[selected_held_out] - probabilities[selected_held_out]
        )))
    return {
        "draws": draws,
        "oneSidedPValue": finite(
            (1 + sum(effect >= observed_held_out_gap for effect in null_effects))
            / (draws + 1)
        ),
        "nullHeldOutGapPctPoints": {
            "median": finite(np.median(null_effects) * 100),
            "p95": finite(np.quantile(null_effects, 0.95) * 100),
            "p99": finite(np.quantile(null_effects, 0.99) * 100),
        },
    }


def compact_fresh_mechanism(base: pd.DataFrame, trigger_data: dict) -> dict:
    fixed = prepare_bets(base, 60, 5).sort_values("signalTimestamp").reset_index(drop=True)
    development_index = int(len(fixed) * 0.50)
    development_timestamp = int(fixed.iloc[development_index]["signalTimestamp"])
    broad = fixed[
        fixed["onchainUniqueMakers"] >= ONCHAIN_BREADTH_THRESHOLD
    ].reset_index(drop=True)
    development_mask = (
        broad["signalTimestamp"] < development_timestamp
    ).to_numpy()
    candidates = []
    for maximum_levels in COMPACT_LEVEL_CANDIDATES:
        for maximum_age in FRESH_AGE_CANDIDATES_SECONDS:
            mask = (
                (broad["onchainPriceLevels"] <= maximum_levels)
                & (broad["onchainRestingAgeMedianSeconds"] <= maximum_age)
            ).to_numpy()
            selected_development = mask & development_mask
            if selected_development.sum() < 4:
                continue
            calibration = calibration_summary(broad[selected_development])
            candidates.append({
                "maximumPriceLevels": maximum_levels,
                "maximumMedianMakerAgeSeconds": maximum_age,
                "developmentBets": int(selected_development.sum()),
                "developmentCalibrationGapPctPoints": calibration["calibrationGapPctPoints"],
                "mask": mask,
            })
    selected = max(candidates, key=lambda row: (
        row["developmentCalibrationGapPctPoints"],
        row["developmentBets"],
        -row["maximumPriceLevels"],
        -row["maximumMedianMakerAgeSeconds"],
    ))
    selected_mask = selected["mask"]
    held_out_mask = ~development_mask
    development = broad[selected_mask & development_mask]
    held_out = broad[selected_mask & held_out_mask]
    all_selected = broad[selected_mask]
    remainder = broad[~selected_mask]
    held_out_calibration = calibration_summary(held_out)
    observed_gap = held_out_calibration["calibrationGapPctPoints"] / 100
    table = np.asarray([
        [int(all_selected["won"].sum()), int(len(all_selected) - all_selected["won"].sum())],
        [int(remainder["won"].sum()), int(len(remainder) - remainder["won"].sum())],
    ])
    odds_ratio, fisher_p = fisher_exact(table, alternative="greater")
    model_frame = broad.copy()
    model_frame["compactFresh"] = selected_mask.astype(int)
    design = sm.add_constant(model_frame[["compactFresh"]].astype(float))
    fitted = sm.GLM(
        model_frame["won"],
        design,
        family=sm.families.Binomial(),
        offset=np.log(
            model_frame["observedExecutionPrice"]
            / (1 - model_frame["observedExecutionPrice"])
        ),
    ).fit(cov_type="HC1")
    candidate_rows = [{key: value for key, value in row.items() if key != "mask"}
                      for row in candidates]
    return {
        "name": "compact-fresh-breadth",
        "definition": (
            f"At least {ONCHAIN_BREADTH_THRESHOLD} maker accounts, no more than "
            f"{selected['maximumPriceLevels']} execution price levels, and median maker-order "
            f"age no more than {selected['maximumMedianMakerAgeSeconds']} seconds."
        ),
        "selection": {
            "developmentEnd": datetime.fromtimestamp(
                development_timestamp, timezone.utc
            ).isoformat(),
            "minimumDevelopmentBets": 4,
            "priceLevelCandidates": list(COMPACT_LEVEL_CANDIDATES),
            "makerAgeCandidatesSeconds": list(FRESH_AGE_CANDIDATES_SECONDS),
            "selectedMaximumPriceLevels": selected["maximumPriceLevels"],
            "selectedMaximumMedianMakerAgeSeconds": selected["maximumMedianMakerAgeSeconds"],
            "candidates": candidate_rows,
        },
        "development": summarize_bets(development),
        "developmentCalibration": calibration_summary(development),
        "heldOut": summarize_bets(held_out),
        "heldOutCalibration": held_out_calibration,
        "heldOutDayClusterBootstrap": day_cluster_bootstrap(held_out),
        "all": summarize_bets(all_selected),
        "allCalibration": calibration_summary(all_selected),
        "otherBroadSweeps": summarize_bets(remainder),
        "otherBroadCalibration": calibration_summary(remainder),
        "comparisons": {
            "fisherExactVsOtherBroad": {
                "tableWinsLosses": table.tolist(),
                "oddsRatio": finite(odds_ratio),
                "oneSidedPValue": finite(fisher_p),
            },
            "probabilityOffset": {
                "oddsRatio": finite(np.exp(fitted.params["compactFresh"])),
                "robustPValue": finite(fitted.pvalues["compactFresh"]),
            },
            "selectionCorrectedMarketNull": compact_fresh_null(
                broad, development_mask, candidates, observed_gap
            ),
        },
        "mechanismInterpretation": "The strongest broad sweeps consume many recently posted maker orders while staying inside a compact price ladder. They look like decisive acceptance of dense fresh liquidity, not indiscriminate chasing through the book.",
        "alternativeMechanisms": mechanism_alternative_audit(base, trigger_data),
        "warning": "This mechanism family was proposed after inspecting the wallet. The grid null repeats the stated second-stage search, but it does not correct for every hypothesis considered; the held-out sample has only seven bets.",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", default="research/djdjdjekekek/snapshot.json")
    parser.add_argument("--enrichment", default="research/djdjdjekekek/enrichment.json")
    parser.add_argument("--analysis", default="research/djdjdjekekek/deep_analysis.json")
    parser.add_argument("--tape", default="research/djdjdjekekek/market_tape.json")
    parser.add_argument("--triggers", default="research/djdjdjekekek/trigger_transactions.json")
    parser.add_argument("--closing-lines", default="research/djdjdjekekek/closing_lines.json")
    parser.add_argument("--liquidity-capacity", default="research/djdjdjekekek/liquidity_capacity.json")
    parser.add_argument("--output", default="research/djdjdjekekek/edge_analysis.json")
    parser.add_argument("--features", default="research/djdjdjekekek/edge_features.csv")
    parser.add_argument("--model", default="research/djdjdjekekek/edge_model.json")
    args = parser.parse_args()

    snapshot = load_json(Path(args.snapshot))
    enrichment = load_json(Path(args.enrichment))
    analysis = load_json(Path(args.analysis))
    tape_data = load_json(Path(args.tape))
    trigger_data = load_json(Path(args.triggers))
    closing_path = Path(args.closing_lines)
    liquidity_path = Path(args.liquidity_capacity)
    closing_data = load_json(closing_path) if closing_path.exists() else {"events": []}
    liquidity_data = load_json(liquidity_path) if liquidity_path.exists() else {}
    features, leader_events = build_features(
        snapshot, enrichment, analysis, tape_data, trigger_data
    )
    base = base_universe(features)
    scenarios = scenario_backtests(base)
    fixed = next(row for row in scenarios if row["lagSeconds"] == 60 and row["slippageCents"] == 5)
    fixed_bets = prepare_bets(base, 60, 5)
    _, fixed_test, _ = chronological_split(fixed_bets, 0.70)

    output = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "methodology": {
            "signal": "Exact target taker crossing of $25,000 gross BUY flow at >=70% net directional concentration.",
            "atomicBreadth": "Decode the mined CTF Exchange V2 matchOrders calldata at the trigger and count distinct maker addresses in the transaction's makerOrders array.",
            "externalExecution": "First direction-neutral public taker print beginning at the configured lag, with a 60-second observation window, an explicit zero-to-30-cent adverse-price grid, and fee-curve stress from 0% through 5%. A trigger-price fallback forces every eligible signal into the test when no print exists. The original registered comparison remains 60 seconds plus five cents; the prospective paper convention is immediate observation with a one-cent marketable-limit buffer and actual depth recorded.",
            "capacity": "Historical post-trigger public turnover is reported as a non-simultaneous capacity envelope across stake, time, price, and participation assumptions. A separately timestamped active-moneyline snapshot walks actual displayed asks for immediate FOK capacity.",
            "closingLine": "For pregame signals only, use the final non-target public print before the recorded game start as an independent directional validation mark.",
            "eventLeakage": "Eligible conditions are sorted by signal time and only the first condition per canonical event is retained.",
            "labelTiming": "Walk-forward labels become available at Gamma market closedTime, not the ambiguous closed-positions timestamp.",
            "selection": (
                "The $25,000 signal threshold and map-exclusion rule predate this tape analysis. BO1 was corrected from series to single-map "
                "after inspecting final-period losses, so that semantic correction is disclosed rather than presented as a pristine "
                "unseen discovery. Refinements use a declared 50/20/30 development-validation-final split."
            ),
            "limitations": [
                "A public trade print proves market activity, not the exact historical ask depth available to a follower; the adverse-price grid is a scenario surface, not a reconstructed order book.",
                "Tape and block timestamps have one-second resolution. Same-second entry is an optimistic bound, while 0.1-second and 0.5-second bots cannot be distinguished from one another in these historical data.",
                "The account was selected after exceptional performance, so trader-selection bias remains.",
                "The model family and feature set were chosen during this investigation; expanding-window predictions are pseudo-out-of-sample, not a locked prospective trial.",
                "The urgency calibration and stratified mechanism audits were designed after observing this sample; their p-values diagnose compatibility with narrow nulls but do not correct for discovery search.",
                "The atomic-breadth family was discovered retrospectively. Its integer threshold is selected only on the first half, and a separate simulation repeats that search, but wallet and feature-family selection remain uncorrected.",
                "The sample spans only about two months and event returns are highly concentrated.",
                "Current displayed sports-book depth is a favorable cross-sectional reference and cannot be substituted for the unknown depth remaining immediately after the target's sweep.",
            ],
        },
        "coverage": {
            "targetSignals": int(len(features)),
            "baseEligibleEvents": int(len(base)),
            "publicTakerPrints": int(tape_data["rows"]),
            "tapeMarkets": int(tape_data["successfulMarkets"]),
            "fixed60SecondPublicPrintCoveragePct": fixed["publicPrintCoveragePct"],
            "gammaClosedTimeCoveragePct": finite((features["resolutionSource"] == "gammaClosedTime").mean() * 100),
            "gammaClosedAtOrBeforeSignal": int((features["resolutionTimestamp"] <= features["signalTimestamp"]).sum()),
            "medianSignalToGammaCloseSeconds": finite(
                (features["resolutionTimestamp"] - features["signalTimestamp"]).median()
            ),
            "decodedTriggerTransactions": int(features["onchainDecoded"].sum()),
            "targetAsDecodedTaker": int(trigger_data.get("targetAsDecodedTaker", 0)),
            "medianMakerOrdersPerTrigger": finite(features["onchainMakerOrders"].median()),
            "medianUniqueMakersPerTrigger": finite(features["onchainUniqueMakers"].median()),
            "multiPriceLevelTriggers": int((features["onchainPriceLevels"] > 1).sum()),
            "maximumAbsoluteOnchainNotionalReconciliationPct": finite(
                features["onchainNotionalReconciliationPct"].abs().max()
            ),
        },
        "marketResponse": markout_analysis(base),
        "subgroups": subgroup_table(base),
        "subgroupChronology": subgroup_chronology(base),
        "leaders": leader_analysis(leader_events, base),
        "sizing": sizing_analysis(base),
        "fixedExternalTapeBacktest": fixed,
        "blindCopyCounterfactual": blind_copy_audit(
            features, fixed["splitTimestamp"]
        ),
        "universeSensitivity": universe_sensitivity(features, fixed["splitTimestamp"]),
        "bo1ClassificationSensitivity": bo1_classification_sensitivity(
            features, fixed["splitTimestamp"]
        ),
        "executionSelectionAudit": {
            "anyPrintThreeCentNoFallback": summarize_bets(prepare_bets(
                base, 60, 3, price_source="any", force_fallback=False
            )),
            "alignedPrintThreeCentNoFallback": summarize_bets(prepare_bets(
                base, 60, 3, price_source="aligned", force_fallback=False
            )),
            "noAnyPrint": {
                "signals": int(base["executionMark60"].isna().sum()),
                "wins": int(base.loc[base["executionMark60"].isna(), "won"].sum()),
            },
            "noAlignedPrint": {
                "signals": int(base["alignedExecutionMark60"].isna().sum()),
                "wins": int(base.loc[base["alignedExecutionMark60"].isna(), "won"].sum()),
            },
            "warning": "No-print signals underperformed, so no-fallback tests are selection-biased upward. The primary result forces all signals in at a fallback price.",
        },
        "fixedTestBootstrap": bootstrap_bets(fixed_test),
        "fixedTestDayClusterBootstrap": day_cluster_bootstrap(fixed_test),
        "randomSideFalsification": random_side_test(fixed_test),
        "robustness": robustness_tables(base),
        "executionSensitivity": scenarios,
        "lockedRefinement": locked_gate_test(base),
        "walkForwardModel": walk_forward_model(base),
        "mechanismAudit": mechanism_audit(base, fixed["splitTimestamp"]),
        "atomicBreadthEdge": breadth_edge_audit(base, fixed["splitTimestamp"]),
        "copyParameterAtlas": copy_parameter_atlas(features, base),
        "historicalTapeCapacity": historical_tape_capacity(features, base, tape_data),
        "liveLiquidityCapacity": {
            "sourceGeneratedAt": liquidity_data.get("generatedAt"),
            "source": liquidity_data.get("source"),
            "definition": liquidity_data.get("definition"),
            "parameters": liquidity_data.get("parameters"),
            "coverage": liquidity_data.get("coverage"),
            "summary": liquidity_data.get("summary"),
            "warnings": liquidity_data.get("warnings"),
        },
        "closingLineAudit": closing_line_audit(base, closing_data),
        "compactFreshMechanism": compact_fresh_mechanism(base, trigger_data),
    }

    output_path = Path(args.output)
    features_path = Path(args.features)
    model_path = Path(args.model)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    features_path.parent.mkdir(parents=True, exist_ok=True)
    model_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    model_path.write_text(json.dumps(fit_deployment_model(base), indent=2, allow_nan=False) + "\n", encoding="utf-8")
    features.replace({np.nan: None}).to_csv(features_path, index=False)
    print(f"Edge analysis: {len(features)} signals, {len(base)} eligible events -> {output_path}")


if __name__ == "__main__":
    main()
