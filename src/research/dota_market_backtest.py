#!/usr/bin/env python3
"""Independent held-out Polymarket replay for the Dota live-state value model."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import math
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import numpy as np
import pandas as pd

from esports_state_analysis import (
    OpenDotaClient,
    iso,
    matching_series,
    normalize_team,
    state_feature_vector,
    team_similarity,
    winner_name,
)


GAMMA_API = "https://gamma-api.polymarket.com"
DATA_API = "https://data-api.polymarket.com"
DOTA_TAG_ID = "102366"
TARGET_WALLET = "0x6d20c35f65d9899b6d6b74f8466e824580f9a165"
PRIMARY_LAG_SECONDS = 1
PRIMARY_SLIPPAGE_CENTS = 1
FEE_RATE = 0.03
MINIMUM_MODEL_EDGE = 0.05
DEFAULT_MINIMUM_GAME_MINUTE = 5
MAXIMUM_MARK_STALENESS_SECONDS = 120
LAGS = (0, 1, 5, 15, 30, 60)
SLIPPAGE_CENTS = (0, 0.5, 1, 2, 5)


def get_json(url: str, params: dict | None = None) -> dict | list:
    query = f"?{urlencode(params)}" if params else ""
    request = Request(
        f"{url}{query}",
        headers={"User-Agent": "polymarket-trader-research/1.0", "Accept": "application/json"},
    )
    error = None
    for attempt in range(5):
        try:
            with urlopen(request, timeout=60) as response:
                return json.load(response)
        except Exception as caught:  # pragma: no cover - network retry path
            error = caught
            time.sleep(0.5 * (attempt + 1) ** 2)
    raise RuntimeError(f"GET {url} failed: {error}")


def parse_time(value: str) -> int:
    return int(pd.Timestamp(value).timestamp())


def parse_array(value) -> list:
    if isinstance(value, list):
        return value
    if not value:
        return []
    return json.loads(value)


def collect_dota_events(max_pages: int = 4) -> list[dict]:
    output = []
    for page in range(max_pages):
        rows = get_json(f"{GAMMA_API}/events", {
            "tag_id": DOTA_TAG_ID,
            "closed": "true",
            "limit": 100,
            "offset": page * 100,
            "order": "startDate",
            "ascending": "false",
        })
        if not isinstance(rows, list) or not rows:
            break
        output.extend(rows)
        if len(rows) < 100:
            break
    return output


def game_number(question: str) -> int | None:
    match = re.search(r"-\s+Game\s+(\d+)\s+Winner", str(question), re.IGNORECASE)
    return int(match.group(1)) if match else None


def load_pro_matches(cache_path: Path) -> list[dict]:
    payload = json.loads(cache_path.read_text(encoding="utf-8"))
    return payload["matches"]


def match_event(event: dict, pro_matches: list[dict]) -> list[dict]:
    child_markets = [market for market in event.get("markets") or []
                     if market.get("sportsMarketType") == "child_moneyline"]
    if not child_markets:
        return []
    scheduled = child_markets[0].get("gameStartTime")
    if not scheduled:
        return []
    feature = pd.Series({
        "title": event.get("title") or child_markets[0].get("question"),
        "gameStartTimestamp": parse_time(scheduled),
        "signalTimestamp": parse_time(scheduled),
    })
    series, score = matching_series(feature, pro_matches)
    if not series:
        return []
    output = []
    for market in child_markets:
        number = game_number(market.get("question"))
        if number is None or number > len(series):
            continue
        match = series[number - 1]
        output.append({
            "eventId": event.get("id"),
            "eventSlug": event.get("slug"),
            "eventTitle": event.get("title"),
            "conditionId": market.get("conditionId"),
            "question": market.get("question"),
            "gameNumber": number,
            "outcomes": parse_array(market.get("outcomes")),
            "tokenIds": parse_array(market.get("clobTokenIds")),
            "nameMatchScore": score,
            "match": match,
        })
    return output


def cached_match_detail(client: OpenDotaClient, match_id: int, cache_dir: Path) -> dict:
    path = cache_dir / f"{match_id}.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    detail = client.get(f"matches/{match_id}")
    cache_dir.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(detail), encoding="utf-8")
    return detail


def cache_match_details(
    client: OpenDotaClient, match_ids: list[int], cache_dir: Path, batch_size: int = 150
) -> None:
    cache_dir.mkdir(parents=True, exist_ok=True)
    missing = [match_id for match_id in sorted(set(match_ids))
               if not (cache_dir / f"{match_id}.json").exists()]
    for start in range(0, len(missing), batch_size):
        batch = missing[start:start + batch_size]
        identifiers = ",".join(str(match_id) for match_id in batch)
        sql = (
            "SELECT match_id,start_time,duration,radiant_win,radiant_team_name,dire_team_name,"
            "radiant_gold_adv,radiant_xp_adv FROM matches "
            f"WHERE match_id IN ({identifiers})"
        )
        payload = client.get("explorer", {"sql": sql})
        if payload.get("err"):
            raise RuntimeError(f"OpenDota detail batch failed: {payload['err']}")
        for row in payload.get("rows") or []:
            row["radiant_name"] = row.pop("radiant_team_name", None)
            row["dire_name"] = row.pop("dire_team_name", None)
            (cache_dir / f"{row['match_id']}.json").write_text(
                json.dumps(row), encoding="utf-8"
            )


def collect_market_trades(condition_id: str, start: int, end: int) -> list[dict]:
    rows = get_json(f"{DATA_API}/trades", {
        "market": condition_id,
        "takerOnly": "true",
        "start": start,
        "end": end,
        "limit": 10_000,
        "offset": 0,
        "sortDirection": "ASC",
        "filterType": "CASH",
        "filterAmount": 1,
    })
    if not isinstance(rows, list):
        return []
    return sorted(
        [row for row in rows if str(row.get("proxyWallet") or "").lower() != TARGET_WALLET],
        key=lambda row: (int(row["timestamp"]), str(row.get("transactionHash") or "")),
    )


def deployed_probability(state_model: dict, gold: float, xp: float, minute: int) -> float:
    deployment = state_model["deployment"]
    values = np.asarray(state_feature_vector(gold, xp, minute), dtype=float)
    mean = np.asarray(deployment["featureMean"], dtype=float)
    scale = np.asarray(deployment["featureScale"], dtype=float)
    coefficients = np.asarray(deployment["coefficients"], dtype=float)
    logit_value = float(deployment["intercept"] + np.dot((values - mean) / scale, coefficients))
    return 1 / (1 + math.exp(-logit_value))


def aligned_trade_price(trade: dict, desired_outcome: str) -> float | None:
    price = float(trade.get("price") or 0)
    if not 0 < price < 1:
        return None
    return price if normalize_team(trade.get("outcome")) == normalize_team(desired_outcome) else 1 - price


def closest_outcome(team: str, outcomes: list[str]) -> str | None:
    if not outcomes:
        return None
    selected = max(outcomes, key=lambda outcome: team_similarity(team, outcome))
    return selected if team_similarity(team, selected) >= 0.72 else None


def last_mark(trades: list[dict], timestamp: int, outcome: str) -> tuple[float | None, int | None]:
    eligible = [trade for trade in trades
                if timestamp - MAXIMUM_MARK_STALENESS_SECONDS <= int(trade["timestamp"]) <= timestamp]
    if not eligible:
        return None, None
    latest = max(int(trade["timestamp"]) for trade in eligible)
    prices = [aligned_trade_price(trade, outcome) for trade in eligible
              if int(trade["timestamp"]) == latest]
    prices = [price for price in prices if price is not None]
    return (float(np.median(prices)), timestamp - latest) if prices else (None, None)


def first_execution_mark(
    trades: list[dict], timestamp: int, outcome: str, lag_seconds: int
) -> tuple[float | None, int | None]:
    earliest = timestamp + lag_seconds
    eligible = [trade for trade in trades if earliest <= int(trade["timestamp"]) <= earliest + 60]
    if not eligible:
        return None, None
    first_time = min(int(trade["timestamp"]) for trade in eligible)
    prices = [aligned_trade_price(trade, outcome) for trade in eligible
              if int(trade["timestamp"]) == first_time]
    prices = [price for price in prices if price is not None]
    return (float(np.median(prices)), first_time - timestamp) if prices else (None, None)


def fee_adjusted_price(price: float, slippage_cents: float) -> float:
    execution = min(0.99, max(0.01, price + slippage_cents / 100))
    return execution + FEE_RATE * execution * (1 - execution)


def find_model_signal(
    market: dict,
    detail: dict,
    trades: list[dict],
    state_model: dict,
    minimum_game_minute: int = DEFAULT_MINIMUM_GAME_MINUTE,
) -> dict | None:
    gold = detail.get("radiant_gold_adv") or []
    xp = detail.get("radiant_xp_adv") or []
    maximum_minute = min(len(gold), len(xp), int(detail.get("duration") or 0) // 60 + 1)
    radiant_outcome = closest_outcome(str(detail.get("radiant_name") or ""), market["outcomes"])
    dire_outcome = closest_outcome(str(detail.get("dire_name") or ""), market["outcomes"])
    if not radiant_outcome or not dire_outcome:
        return None
    for minute in range(minimum_game_minute, maximum_minute):
        if gold[minute] is None or xp[minute] is None:
            continue
        timestamp = int(detail["start_time"]) + minute * 60
        radiant_probability = deployed_probability(state_model, gold[minute], xp[minute], minute)
        candidates = []
        for outcome, probability in (
            (radiant_outcome, radiant_probability),
            (dire_outcome, 1 - radiant_probability),
        ):
            mark, staleness = last_mark(trades, timestamp, outcome)
            if mark is None or not 0.30 <= mark <= 0.85:
                continue
            decision_all_in = fee_adjusted_price(mark, PRIMARY_SLIPPAGE_CENTS)
            candidates.append({
                "outcome": outcome,
                "fairProbability": probability,
                "decisionMark": mark,
                "decisionMarkStalenessSeconds": staleness,
                "decisionAllInPrice": decision_all_in,
                "modelEdge": probability - decision_all_in,
            })
        if not candidates:
            continue
        selected = max(candidates, key=lambda row: row["modelEdge"])
        if selected["modelEdge"] < MINIMUM_MODEL_EDGE:
            continue
        return {
            **selected,
            "signalTimestamp": timestamp,
            "signalTime": iso(timestamp),
            "gameMinute": minute,
            "radiantGoldAdvantage": gold[minute],
            "radiantXpAdvantage": xp[minute],
        }
    return None


def scenario_result(
    row: dict, lag_seconds: int, slippage_cents: float
) -> dict | None:
    mark, actual_lag = first_execution_mark(
        row["trades"], row["signal"]["signalTimestamp"], row["signal"]["outcome"], lag_seconds
    )
    if mark is None:
        return None
    all_in = fee_adjusted_price(mark, slippage_cents)
    won = team_similarity(row["signal"]["outcome"], row["winner"]) >= 0.72
    return_pct = (1 / all_in - 1) * 100 if won else -100
    return {
        "conditionId": row["conditionId"],
        "eventSlug": row["eventSlug"],
        "question": row["question"],
        "matchId": int(row["match"]["match_id"]),
        "signalTime": row["signal"]["signalTime"],
        "gameMinute": row["signal"]["gameMinute"],
        "outcome": row["signal"]["outcome"],
        "winner": row["winner"],
        "won": won,
        "fairProbability": row["signal"]["fairProbability"],
        "decisionMark": row["signal"]["decisionMark"],
        "modelEdgeAtDecision": row["signal"]["modelEdge"],
        "lagSeconds": lag_seconds,
        "actualLagSeconds": actual_lag,
        "slippageCents": slippage_cents,
        "publicPrintExecutionPrice": mark,
        "allInPrice": all_in,
        "returnPct": return_pct,
    }


def summarize(results: list[dict]) -> dict:
    if not results:
        return {"bets": 0}
    returns = np.asarray([row["returnPct"] for row in results], dtype=float)
    days = {}
    for row in results:
        day = row["signalTime"][:10]
        days.setdefault(day, []).append(row["returnPct"])
    clusters = list(days.values())
    rng = np.random.default_rng(20260827)
    indexes = rng.integers(0, len(clusters), size=(20_000, len(clusters)))
    bootstrap = []
    for sample in indexes:
        values = [value for index in sample for value in clusters[index]]
        bootstrap.append(float(np.mean(values)))
    return {
        "bets": len(results),
        "wins": sum(row["won"] for row in results),
        "winRatePct": float(np.mean([row["won"] for row in results]) * 100),
        "roiPct": float(returns.mean()),
        "profitUsdcAt100Each": float(returns.sum()),
        "dayClusters": len(clusters),
        "dayClusterCi95LowPct": float(np.quantile(bootstrap, 0.025)),
        "dayClusterCi95HighPct": float(np.quantile(bootstrap, 0.975)),
        "dayClusterProbabilityPositivePct": float(np.mean(np.asarray(bootstrap) > 0) * 100),
        "medianActualLagSeconds": float(np.median([row["actualLagSeconds"] for row in results])),
    }


def run_backtest(
    events: list[dict],
    pro_matches: list[dict],
    client: OpenDotaClient,
    cache_dir: Path,
    state_model: dict,
    window_start: int,
    window_end: int,
    window_registered_before_review: bool,
    minimum_game_minute: int = DEFAULT_MINIMUM_GAME_MINUTE,
    hypothesis_label: str = "original_five_point_gate",
) -> dict:
    mapped = []
    for event in events:
        mapped.extend(match_event(event, pro_matches))
    window_markets = [row for row in mapped
                      if window_start <= int(row["match"]["start_time"]) < window_end]
    cache_match_details(
        client,
        [int(row["match"]["match_id"]) for row in window_markets],
        cache_dir,
    )
    analyzed = []
    failures = []

    def analyze_market(market: dict) -> dict:
        match_id = int(market["match"]["match_id"])
        detail = json.loads((cache_dir / f"{match_id}.json").read_text(encoding="utf-8"))
        if not detail.get("radiant_gold_adv") or not detail.get("radiant_xp_adv"):
            raise ValueError("UNPARSED_STATE")
        start = int(detail["start_time"])
        end = start + int(detail.get("duration") or 0) + 300
        trades = collect_market_trades(market["conditionId"], start, end)
        signal = find_model_signal(
            market, detail, trades, state_model, minimum_game_minute
        )
        return {
            **market,
            "trades": trades,
            "signal": signal,
            "winner": winner_name(detail),
        }

    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = {executor.submit(analyze_market, market): market for market in window_markets}
        for index, future in enumerate(as_completed(futures), start=1):
            market = futures[future]
            try:
                analyzed.append(future.result())
            except Exception as error:  # pragma: no cover - network failure audit
                failures.append({
                    "matchId": int(market["match"]["match_id"]), "reason": str(error)
                })
            if index % 25 == 0:
                print(f"Dota held-out replay: {index}/{len(window_markets)}", flush=True)

    grid = []
    primary_results = []
    for lag in LAGS:
        for slippage in SLIPPAGE_CENTS:
            results = [
                scenario_result(row, lag, slippage)
                for row in analyzed if row["signal"]
            ]
            results = [row for row in results if row]
            summary = summarize(results)
            grid.append({"lagSeconds": lag, "slippageCents": slippage, **summary})
            if lag == PRIMARY_LAG_SECONDS and slippage == PRIMARY_SLIPPAGE_CENTS:
                primary_results = results

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "status": "independent_held_out_replay",
        "window": {
            "startTimestamp": window_start,
            "startTime": iso(window_start),
            "endTimestamp": window_end,
            "endTime": iso(window_end),
            "chosenBeforeMarketOutcomesWereInspected": window_registered_before_review,
            "hypothesisLabel": hypothesis_label,
        },
        "strategy": {
            "name": "dota-state-value-independent-v0",
            "targetWalletRequired": False,
            "market": "Dota child moneyline (single-map winner)",
            "signal": (
                f"First minute from minute {minimum_game_minute} onward where the pre-wallet "
                "state model exceeds a non-target public-print mark by five points after one "
                "adverse cent and the 3% fee curve."
            ),
            "minimumGameMinute": minimum_game_minute,
            "minimumMinuteSelection": (
                "original_before_first_independent_window"
                if minimum_game_minute == DEFAULT_MINIMUM_GAME_MINUTE
                else "frozen_after_first_independent_window_before_this_window"
            ),
            "markMaximumStalenessSeconds": MAXIMUM_MARK_STALENESS_SECONDS,
            "primaryExecution": "First non-target public print from one second onward, plus one adverse cent and fees; no fallback when no print appears within 60 seconds.",
            "stake": "$100 equal stake, one signal per map, paper only.",
        },
        "coverage": {
            "gammaEventsScanned": len(events),
            "mappedChildMarketsAllDates": len(mapped),
            "heldOutChildMarkets": len(window_markets),
            "marketsWithParsedStateAndTape": len(analyzed),
            "marketsWithPublicTrades": sum(bool(row["trades"]) for row in analyzed),
            "modelSignals": sum(row["signal"] is not None for row in analyzed),
            "primaryScenarioFills": len(primary_results),
            "failures": failures,
        },
        "primary": summarize(primary_results),
        "primaryBets": primary_results,
        "signalCandidates": [{
            "conditionId": row["conditionId"],
            "eventSlug": row["eventSlug"],
            "question": row["question"],
            "matchId": int(row["match"]["match_id"]),
            "publicTrades": len(row["trades"]),
            **row["signal"],
        } for row in analyzed if row["signal"]],
        "executionSensitivity": grid,
        "warnings": [
            "Replay-derived minute state is used as if a live licensed telemetry feed had delivered it at that minute; OpenDota itself is not a low-latency live source.",
            "Public prints are not historical ask depth. The primary scenario requires a later print and adds one cent, but cannot prove an FOK fill at size.",
            "The five-point gate was proposed from the earlier wallet-conditioned audit; only this later time window is the independent test.",
            "The test window is short and Dota matches on the same day are not independent; day-cluster intervals are reported.",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-analysis", default="research/djdjdjekekek/esports_state_analysis.json")
    parser.add_argument("--pro-cache", default="/tmp/polymarket-opendota-pro-matches.json")
    parser.add_argument("--match-cache", default="/tmp/polymarket-opendota-match-details")
    parser.add_argument("--output", default="research/djdjdjekekek/dota_independent_backtest.json")
    parser.add_argument("--window-start", default="2026-08-25T05:52:46Z")
    parser.add_argument("--window-end", default="2026-08-26T06:00:00Z")
    parser.add_argument("--gamma-pages", type=int, default=4)
    parser.add_argument("--minimum-game-minute", type=int, default=DEFAULT_MINIMUM_GAME_MINUTE)
    parser.add_argument("--hypothesis-label", default="original_five_point_gate")
    parser.add_argument("--request-delay", type=float, default=1.05)
    parser.add_argument("--window-registered-before-review", action="store_true")
    args = parser.parse_args()

    state_analysis = json.loads(Path(args.state_analysis).read_text(encoding="utf-8"))
    state_model = state_analysis["independentStateModel"]
    events = collect_dota_events(args.gamma_pages)
    pro_matches = load_pro_matches(Path(args.pro_cache))
    client = OpenDotaClient(args.request_delay)
    output = run_backtest(
        events,
        pro_matches,
        client,
        Path(args.match_cache),
        state_model,
        parse_time(args.window_start),
        parse_time(args.window_end),
        args.window_registered_before_review,
        args.minimum_game_minute,
        args.hypothesis_label,
    )
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(
        f"Independent Dota replay: {output['coverage']['primaryScenarioFills']} fills, "
        f"{output['primary'].get('roiPct')}% ROI -> {output_path}"
    )


if __name__ == "__main__":
    main()
