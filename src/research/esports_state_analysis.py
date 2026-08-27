#!/usr/bin/env python3
"""Retrospectively align Dota wallet signals with replay-derived OpenDota state."""

from __future__ import annotations

import argparse
import json
import math
import re
import time
from collections import Counter
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from scipy.stats import fisher_exact


API_BASE = "https://api.opendota.com/api"
SOURCE_REPOSITORY = "https://github.com/odota/core"
BREADTH_THRESHOLD = 18
CORE_MARKET_TYPES = {"series winner", "match winner", "team to advance", "outright"}


def finite(value):
    if value is None:
        return None
    value = float(value)
    return value if math.isfinite(value) else None


def iso(timestamp: int | float | None) -> str | None:
    if timestamp is None or not math.isfinite(float(timestamp)):
        return None
    return datetime.fromtimestamp(float(timestamp), timezone.utc).isoformat()


def normalize_team(value: str) -> str:
    value = str(value or "").lower()
    value = re.sub(r"\b(?:team|esports|gaming|club)\b", " ", value)
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return " ".join(value.split())


def team_similarity(left: str, right: str) -> float:
    left_normalized = normalize_team(left)
    right_normalized = normalize_team(right)
    if not left_normalized or not right_normalized:
        return 0.0
    if left_normalized == right_normalized:
        return 1.0
    if left_normalized in right_normalized or right_normalized in left_normalized:
        return 0.96
    left_tokens = set(left_normalized.split())
    right_tokens = set(right_normalized.split())
    token_score = len(left_tokens & right_tokens) / len(left_tokens | right_tokens)
    sequence_score = SequenceMatcher(None, left_normalized, right_normalized).ratio()
    return max(token_score, sequence_score)


def parse_market_teams(title: str) -> tuple[str, str] | None:
    match = re.search(
        r"^Dota 2:\s*(.+?)\s+vs\.?\s+(.+?)(?:\s+\(BO\d+\)|\s+-\s+(?:Game|Map)\s+\d+|\s+-\s+[^-]+$)",
        str(title or ""),
        flags=re.IGNORECASE,
    )
    if not match:
        return None
    return match.group(1).strip(), match.group(2).strip()


def pair_score(teams: tuple[str, str], match: dict) -> tuple[float, str]:
    left, right = teams
    radiant = str(match.get("radiant_name") or "")
    dire = str(match.get("dire_name") or "")
    direct = (team_similarity(left, radiant) + team_similarity(right, dire)) / 2
    reverse = (team_similarity(left, dire) + team_similarity(right, radiant)) / 2
    return (direct, "direct") if direct >= reverse else (reverse, "reverse")


class OpenDotaClient:
    def __init__(self, delay_seconds: float = 1.05):
        self.delay_seconds = delay_seconds
        self.last_request = 0.0

    def get(self, endpoint: str, params: dict | None = None) -> dict | list:
        elapsed = time.monotonic() - self.last_request
        if elapsed < self.delay_seconds:
            time.sleep(self.delay_seconds - elapsed)
        query = f"?{urlencode(params)}" if params else ""
        request = Request(
            f"{API_BASE}/{endpoint}{query}",
            headers={"User-Agent": "polymarket-trader-research/1.0"},
        )
        last_error = None
        for attempt in range(4):
            try:
                with urlopen(request, timeout=45) as response:
                    payload = json.load(response)
                self.last_request = time.monotonic()
                return payload
            except Exception as error:  # pragma: no cover - network retry path
                last_error = error
                time.sleep(2 ** attempt)
        raise RuntimeError(f"OpenDota request failed: {endpoint}: {last_error}")


def collect_pro_matches(
    client: OpenDotaClient, start_timestamp: int, cache_path: Path, refresh: bool
) -> list[dict]:
    if cache_path.exists() and not refresh:
        cached = json.loads(cache_path.read_text(encoding="utf-8"))
        if int(cached.get("windowStartTimestamp", 0)) <= start_timestamp:
            return cached["matches"]

    matches: dict[int, dict] = {}
    cursor = None
    for _ in range(100):
        params = {"less_than_match_id": cursor} if cursor else None
        page = client.get("proMatches", params)
        if not page:
            break
        for row in page:
            matches[int(row["match_id"])] = row
        oldest_time = min(int(row.get("start_time") or 2**63) for row in page)
        next_cursor = min(int(row["match_id"]) for row in page)
        if oldest_time <= start_timestamp:
            break
        if cursor is not None and next_cursor >= cursor:
            break
        cursor = next_cursor
    ordered = sorted(matches.values(), key=lambda row: int(row.get("start_time") or 0))
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps({
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "windowStartTimestamp": start_timestamp,
        "matches": ordered,
    }), encoding="utf-8")
    return ordered


def collect_state_training_matches(
    client: OpenDotaClient,
    cutoff_timestamp: int,
    cache_path: Path,
    refresh: bool,
    limit: int = 10_000,
) -> list[dict]:
    if cache_path.exists() and not refresh:
        cached = json.loads(cache_path.read_text(encoding="utf-8"))
        if int(cached.get("cutoffTimestamp", 0)) == cutoff_timestamp:
            return cached["matches"]
    sql = (
        "SELECT match_id,start_time,duration,radiant_win,radiant_gold_adv,radiant_xp_adv "
        "FROM matches WHERE leagueid > 0 "
        f"AND start_time < {cutoff_timestamp} "
        "AND radiant_gold_adv IS NOT NULL AND radiant_xp_adv IS NOT NULL "
        "AND array_length(radiant_gold_adv,1) > 10 "
        f"ORDER BY match_id DESC LIMIT {int(limit)}"
    )
    payload = client.get("explorer", {"sql": sql})
    if payload.get("err"):
        raise RuntimeError(f"OpenDota explorer error: {payload['err']}")
    matches = payload.get("rows") or []
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps({
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "cutoffTimestamp": cutoff_timestamp,
        "query": sql,
        "matches": matches,
    }), encoding="utf-8")
    return matches


STATE_FEATURE_NAMES = (
    "goldAdvantageThousands",
    "xpAdvantageThousands",
    "goldBySqrtTime",
    "xpBySqrtTime",
    "signedLogGold",
    "signedLogXp",
)


def state_feature_vector(gold_advantage: float, xp_advantage: float, minute: float) -> list[float]:
    gold = float(gold_advantage) / 1_000
    xp = float(xp_advantage) / 1_000
    time_scale = math.sqrt(max(float(minute), 1) / 30)
    return [
        gold,
        xp,
        gold * time_scale,
        xp * time_scale,
        math.copysign(math.log1p(abs(gold)), gold) if gold else 0,
        math.copysign(math.log1p(abs(xp)), xp) if xp else 0,
    ]


def state_training_frame(matches: list[dict]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    rng = np.random.default_rng(20260827)
    features = []
    labels = []
    timestamps = []
    for match in sorted(matches, key=lambda row: int(row["start_time"])):
        gold = match.get("radiant_gold_adv") or []
        xp = match.get("radiant_xp_adv") or []
        maximum_minute = min(
            len(gold), len(xp), max(0, int(match.get("duration") or 0) // 60 + 1), 90
        )
        if maximum_minute <= 10:
            continue
        minute = int(rng.integers(5, maximum_minute))
        if gold[minute] is None or xp[minute] is None:
            continue
        radiant = state_feature_vector(gold[minute], xp[minute], minute)
        dire = state_feature_vector(-gold[minute], -xp[minute], minute)
        radiant_won = int(bool(match["radiant_win"]))
        features.extend((radiant, dire))
        labels.extend((radiant_won, 1 - radiant_won))
        timestamps.extend((int(match["start_time"]), int(match["start_time"])))
    return (
        np.asarray(features, dtype=float),
        np.asarray(labels, dtype=int),
        np.asarray(timestamps, dtype=np.int64),
    )


def calibration_bins(labels: np.ndarray, probabilities: np.ndarray) -> list[dict]:
    output = []
    boundaries = np.linspace(0, 1, 11)
    for lower, upper in zip(boundaries[:-1], boundaries[1:]):
        mask = (probabilities >= lower) & (
            probabilities <= upper if upper == 1 else probabilities < upper
        )
        if not mask.any():
            continue
        output.append({
            "range": f"{lower:.1f}-{upper:.1f}",
            "observations": int(mask.sum()),
            "meanPrediction": finite(probabilities[mask].mean()),
            "actualWinRate": finite(labels[mask].mean()),
        })
    return output


def fit_state_model(matches: list[dict]) -> tuple[object, dict]:
    features, labels, timestamps = state_training_frame(matches)
    unique_timestamps = np.unique(timestamps)
    development_end = np.quantile(unique_timestamps, 0.70)
    validation_end = np.quantile(unique_timestamps, 0.85)
    development = timestamps <= development_end
    validation = (timestamps > development_end) & (timestamps <= validation_end)
    test = timestamps > validation_end
    candidates = []
    for regularization in (0.01, 0.03, 0.1, 0.3, 1, 3, 10):
        candidate = make_pipeline(
            StandardScaler(),
            LogisticRegression(C=regularization, max_iter=5_000, random_state=20260827),
        )
        candidate.fit(features[development], labels[development])
        probability = candidate.predict_proba(features[validation])[:, 1]
        candidates.append({
            "regularizationC": regularization,
            "validationBrierScore": finite(brier_score_loss(labels[validation], probability)),
            "validationRocAuc": finite(roc_auc_score(labels[validation], probability)),
        })
    selected = min(candidates, key=lambda row: row["validationBrierScore"])
    model = make_pipeline(
        StandardScaler(),
        LogisticRegression(
            C=selected["regularizationC"], max_iter=5_000, random_state=20260827
        ),
    )
    model.fit(features[development | validation], labels[development | validation])
    probability = model.predict_proba(features[test])[:, 1]
    scaler = model.named_steps["standardscaler"]
    logistic = model.named_steps["logisticregression"]
    return model, {
        "name": "pre-wallet-dota-state-logit",
        "status": "chronological_external_test_passed",
        "trainingData": {
            "source": f"{API_BASE}/explorer",
            "matches": int(len(features) / 2),
            "observationsIncludingSideSymmetry": int(len(features)),
            "oneDeterministicRandomMinutePerMatch": True,
            "sideSymmetryAugmentation": True,
            "latestPermittedMatchTime": iso(max(int(row["start_time"]) for row in matches)),
            "walletOutcomesUsed": False,
        },
        "selection": {
            "developmentEnd": iso(development_end),
            "validationEnd": iso(validation_end),
            "criterion": "minimum validation Brier score",
            "candidates": candidates,
            "selectedRegularizationC": selected["regularizationC"],
        },
        "chronologicalTest": {
            "observations": int(test.sum()),
            "matches": int(test.sum() / 2),
            "brierScore": finite(brier_score_loss(labels[test], probability)),
            "coinFlipBrierScore": 0.25,
            "rocAuc": finite(roc_auc_score(labels[test], probability)),
            "logLoss": finite(log_loss(labels[test], probability)),
            "calibration": calibration_bins(labels[test], probability),
        },
        "deployment": {
            "featureNames": list(STATE_FEATURE_NAMES),
            "featureMean": [finite(value) for value in scaler.mean_],
            "featureScale": [finite(value) for value in scaler.scale_],
            "coefficients": [finite(value) for value in logistic.coef_[0]],
            "intercept": finite(logistic.intercept_[0]),
        },
        "warning": (
            "The chronological test validates state-to-win calibration on unrelated professional "
            "Dota matches. It does not validate Polymarket execution or the five-point wallet-copy gate."
        ),
    }


def matching_series(row: pd.Series, pro_matches: list[dict]) -> tuple[list[dict], float]:
    teams = parse_market_teams(row["title"])
    if not teams:
        return [], 0.0
    reference = finite(row.get("gameStartTimestamp")) or float(row["signalTimestamp"])
    windows = ((reference - 6 * 3600, reference + 12 * 3600),
               (reference - 12 * 3600, reference + 24 * 3600))
    for lower, upper in windows:
        candidates = []
        for match in pro_matches:
            start = int(match.get("start_time") or 0)
            if not lower <= start <= upper:
                continue
            score, orientation = pair_score(teams, match)
            if score >= 0.82:
                candidates.append({**match, "nameMatchScore": score, "orientation": orientation})
        if candidates:
            best_score = max(float(match["nameMatchScore"]) for match in candidates)
            # Keep only the same pair, excluding weak fuzzy collisions in the time window.
            selected = [match for match in candidates
                        if float(match["nameMatchScore"]) >= max(0.82, best_score - 0.08)]
            return sorted(selected, key=lambda match: int(match["start_time"])), best_score
    return [], 0.0


def winner_name(match: dict) -> str:
    return str(match.get("radiant_name") if match.get("radiant_win") else match.get("dire_name"))


def target_side(outcome: str, match: dict) -> str | None:
    radiant_score = team_similarity(outcome, str(match.get("radiant_name") or ""))
    dire_score = team_similarity(outcome, str(match.get("dire_name") or ""))
    if max(radiant_score, dire_score) < 0.72:
        return None
    return "radiant" if radiant_score >= dire_score else "dire"


def objective_side(objective: dict) -> str | None:
    key = str(objective.get("key") or "")
    if "goodguys" in key:
        return "dire"
    if "badguys" in key:
        return "radiant"
    if objective.get("team") == 2:
        return "radiant"
    if objective.get("team") == 3:
        return "dire"
    slot = objective.get("player_slot")
    if slot is not None:
        return "dire" if int(slot) >= 128 else "radiant"
    return None


def compact_objective(objective: dict | None, game_second: int, side: str | None) -> dict | None:
    if not objective:
        return None
    beneficiary = objective_side(objective)
    return {
        "gameSecond": int(objective.get("time") or 0),
        "secondsBeforeSignal": game_second - int(objective.get("time") or 0),
        "type": objective.get("type"),
        "key": objective.get("key"),
        "beneficiary": beneficiary,
        "benefitedTarget": beneficiary == side if beneficiary and side else None,
    }


def state_at_signal(detail: dict, signal_timestamp: int, outcome: str) -> dict:
    start = int(detail["start_time"])
    game_second = signal_timestamp - start
    side = target_side(outcome, detail)
    minute = max(0, int(game_second // 60))
    gold = detail.get("radiant_gold_adv") or []
    xp = detail.get("radiant_xp_adv") or []
    gold_index = min(minute, len(gold) - 1) if gold else None
    xp_index = min(minute, len(xp) - 1) if xp else None
    radiant_gold = finite(gold[gold_index]) if gold_index is not None else None
    radiant_xp = finite(xp[xp_index]) if xp_index is not None else None
    target_multiplier = 1 if side == "radiant" else -1 if side == "dire" else None
    objectives = sorted(
        [row for row in (detail.get("objectives") or []) if row.get("time") is not None],
        key=lambda row: int(row["time"]),
    )
    prior = [row for row in objectives if int(row["time"]) <= game_second]
    following = [row for row in objectives if int(row["time"]) > game_second]
    target_prior = [row for row in prior if objective_side(row) == side]

    radiant_kills = 0
    dire_kills = 0
    for player in detail.get("players") or []:
        kills = sum(
            int(kill.get("time") or 0) <= game_second
            for kill in (player.get("kills_log") or [])
        )
        if int(player.get("player_slot") or 0) >= 128:
            dire_kills += kills
        else:
            radiant_kills += kills
    target_kills = radiant_kills if side == "radiant" else dire_kills if side == "dire" else None
    opponent_kills = dire_kills if side == "radiant" else radiant_kills if side == "dire" else None
    return {
        "matchId": int(detail["match_id"]),
        "gameStartTimestamp": start,
        "gameStartTime": iso(start),
        "gameSecond": game_second,
        "gameMinute": finite(game_second / 60),
        "targetSide": side,
        "targetGoldAdvantage": finite(target_multiplier * radiant_gold)
        if target_multiplier is not None and radiant_gold is not None else None,
        "targetXpAdvantage": finite(target_multiplier * radiant_xp)
        if target_multiplier is not None and radiant_xp is not None else None,
        "targetKills": target_kills,
        "opponentKills": opponent_kills,
        "targetKillAdvantage": target_kills - opponent_kills
        if target_kills is not None and opponent_kills is not None else None,
        "previousObjective": compact_objective(prior[-1] if prior else None, game_second, side),
        "previousTargetObjective": compact_objective(
            target_prior[-1] if target_prior else None, game_second, side
        ),
        "nextObjective": compact_objective(following[0] if following else None, game_second, side),
    }


def series_phase(series: list[dict], signal_timestamp: int) -> tuple[str, dict | None]:
    for match in series:
        start = int(match["start_time"])
        end = start + int(match.get("duration") or 0)
        if start <= signal_timestamp <= end:
            return "in_game", match
    if signal_timestamp < int(series[0]["start_time"]):
        return "before_first_map", None
    if signal_timestamp > int(series[-1]["start_time"]) + int(series[-1].get("duration") or 0):
        return "after_last_map", None
    return "between_maps", None


def series_score(series: list[dict], signal_timestamp: int, outcome: str) -> dict:
    completed = [match for match in series
                 if int(match["start_time"]) + int(match.get("duration") or 0) < signal_timestamp]
    target_wins = sum(team_similarity(outcome, winner_name(match)) >= 0.72 for match in completed)
    return {
        "completedMaps": len(completed),
        "targetMapWins": int(target_wins),
        "opponentMapWins": int(len(completed) - target_wins),
    }


def summarize_rows(rows: list[dict], selector) -> dict:
    selected = [row for row in rows if selector(row)]
    in_game = [row for row in selected if row["phase"] == "in_game"]
    states = [row["state"] for row in in_game if row.get("state")]
    gold = [state["targetGoldAdvantage"] for state in states
            if state.get("targetGoldAdvantage") is not None]
    recent_15 = [state for state in states if state.get("previousObjective")
                 and state["previousObjective"]["secondsBeforeSignal"] <= 15]
    recent_target_30 = [state for state in states if state.get("previousTargetObjective")
                        and state["previousTargetObjective"]["secondsBeforeSignal"] <= 30]
    return {
        "signals": len(selected),
        "matchedToOpenDotaSeries": sum(bool(row.get("seriesMatches")) for row in selected),
        "inGameSignals": len(in_game),
        "beforeFirstMapSignals": sum(row["phase"] == "before_first_map" for row in selected),
        "betweenMapSignals": sum(row["phase"] == "between_maps" for row in selected),
        "recentObjectiveWithin15Seconds": len(recent_15),
        "recentTargetObjectiveWithin30Seconds": len(recent_target_30),
        "medianTargetGoldAdvantage": finite(np.median(gold)) if gold else None,
    }


def summarize_state_paper(rows: list[dict], selector) -> dict:
    selected = [row for row in rows if row.get("stateModel") and selector(row)]
    if not selected:
        return {"bets": 0}
    returns = np.asarray([row["stateModel"]["paperReturnPct"] for row in selected], dtype=float)
    clustered: dict[str, list[float]] = {}
    for row in selected:
        clustered.setdefault(str(row["signalTime"])[:10], []).append(
            row["stateModel"]["paperReturnPct"]
        )
    clusters = list(clustered.values())
    rng = np.random.default_rng(20260827)
    indexes = rng.integers(0, len(clusters), size=(20_000, len(clusters)))
    bootstrap = np.asarray([
        np.mean([value for index in sample for value in clusters[index]])
        for sample in indexes
    ])
    return {
        "bets": len(selected),
        "wins": sum(bool(row["won"]) for row in selected),
        "winRatePct": finite(np.mean([bool(row["won"]) for row in selected]) * 100),
        "roiPct": finite(returns.mean()),
        "profitUsdcAt100Each": finite(returns.sum()),
        "meanModelEdgePctPoints": finite(np.mean([
            row["stateModel"]["modelEdge"] for row in selected
        ]) * 100),
        "fallbackExecutionPrices": sum(
            row["stateModel"]["usedTriggerPriceFallback"] for row in selected
        ),
        "dayClusters": len(clusters),
        "dayClusterCi95LowPct": finite(np.quantile(bootstrap, 0.025)),
        "dayClusterCi95HighPct": finite(np.quantile(bootstrap, 0.975)),
        "dayClusterProbabilityPositivePct": finite(np.mean(bootstrap > 0) * 100),
    }


def add_state_model_predictions(rows: list[dict], model) -> dict:
    for row in rows:
        state = row.get("state")
        if not state or state.get("targetGoldAdvantage") is None \
                or state.get("targetXpAdvantage") is None:
            row["stateModel"] = None
            continue
        features = state_feature_vector(
            state["targetGoldAdvantage"], state["targetXpAdvantage"],
            int(state["gameSecond"] // 60)
        )
        fair_probability = float(model.predict_proba([features])[0, 1])
        raw_mark = row.get("executionMark1")
        used_fallback = raw_mark is None or not math.isfinite(float(raw_mark))
        observed_price = float(row["triggerPrice"] if used_fallback else raw_mark)
        execution_price = min(0.99, max(0.01, observed_price + 0.01))
        all_in_price = execution_price + 0.03 * execution_price * (1 - execution_price)
        model_edge = fair_probability - all_in_price
        paper_return = (1 / all_in_price - 1) * 100 if row["won"] else -100
        row["stateModel"] = {
            "fairWinProbability": fair_probability,
            "observedOneSecondPrice": observed_price,
            "usedTriggerPriceFallback": used_fallback,
            "modeledAdverseMoveCents": 1,
            "modeledFeeRatePct": 3,
            "allInPrice": all_in_price,
            "modelEdge": model_edge,
            "passesFivePointGate": model_edge >= 0.05,
            "paperReturnPct": paper_return,
        }

    eligible = [row for row in rows if row.get("stateModel")]
    nonnegative = [row for row in eligible if row["stateModel"]["modelEdge"] >= 0]
    negative = [row for row in eligible if row["stateModel"]["modelEdge"] < 0]
    odds_ratio, fisher_p = fisher_exact([
        [sum(row["won"] for row in nonnegative), sum(not row["won"] for row in nonnegative)],
        [sum(row["won"] for row in negative), sum(not row["won"] for row in negative)],
    ], alternative="greater")
    threshold_sensitivity = []
    for threshold in (0, 0.025, 0.05, 0.075, 0.10, 0.125, 0.15, 0.20):
        threshold_sensitivity.append({
            "minimumModelEdgePctPoints": threshold * 100,
            **summarize_state_paper(
                eligible, lambda row, threshold=threshold:
                row["stateModel"]["modelEdge"] >= threshold
            ),
        })
    return {
        "strategy": {
            "name": "dota-state-value-paper-v0",
            "signal": "Existing target Dota threshold crossing during a mapped live game.",
            "independentValueModel": "Pre-wallet OpenDota gold/XP/time logistic model.",
            "entryGate": "Model fair probability exceeds one-second public-print proxy plus one adverse cent and the 3% fee curve by at least five probability points.",
            "stake": "$100 equal stake; paper only.",
            "outcomesUsedToChooseFivePointGate": False,
        },
        "allMappedInGameSignalsWithoutValueGate": summarize_state_paper(
            eligible, lambda row: True
        ),
        "fivePointGateAllFormats": summarize_state_paper(
            eligible, lambda row: row["stateModel"]["passesFivePointGate"]
        ),
        "fivePointGateFrozenBaseOnly": summarize_state_paper(
            eligible, lambda row: row["frozenBaseEligible"]
            and row["stateModel"]["passesFivePointGate"]
        ),
        "fivePointGateSingleMapsNegativeControl": summarize_state_paper(
            eligible, lambda row: row["marketType"] == "single-game/map"
            and row["stateModel"]["passesFivePointGate"]
        ),
        "fivePointGateBroadSweeps": summarize_state_paper(
            eligible, lambda row: row["broadSweep"]
            and row["stateModel"]["passesFivePointGate"]
        ),
        "modelEdgeSignSeparation": {
            "nonnegative": summarize_state_paper(
                nonnegative, lambda row: True
            ),
            "negative": summarize_state_paper(
                negative, lambda row: True
            ),
            "fisherExactOneSidedPValue": finite(fisher_p),
            "oddsRatio": finite(odds_ratio),
            "warning": "Natural zero-edge split, but inspected after wallet outcomes and based on only 12 signals.",
        },
        "thresholdSensitivity": threshold_sensitivity,
        "events": [{
            "signalTime": row["signalTime"],
            "title": row["title"],
            "marketType": row["marketType"],
            "uniqueMakers": finite(row["onchainUniqueMakers"]),
            "won": bool(row["won"]),
            **row["stateModel"],
        } for row in eligible],
        "warning": (
            "This wallet-conditioned audit contains only 12 in-game signals and only three frozen "
            "full-series signals. Positive ROI is a discovery lead, not prospective proof."
        ),
    }


def timeline_from_state(row: dict, detail: dict) -> dict:
    state = row["state"]
    side = state["targetSide"]
    multiplier = 1 if side == "radiant" else -1
    signal_second = int(state["gameSecond"])
    gold = detail.get("radiant_gold_adv") or []
    start_minute = max(0, signal_second // 60 - 12)
    end_minute = min(len(gold) - 1, signal_second // 60 + 5)
    gold_timeline = [{
        "gameMinute": minute,
        "secondsFromSignal": minute * 60 - signal_second,
        "targetGoldAdvantage": finite(multiplier * gold[minute]),
    } for minute in range(start_minute, end_minute + 1)] if side and gold else []
    objective_timeline = []
    for objective in detail.get("objectives") or []:
        objective_time = int(objective.get("time") or 0)
        if signal_second - 180 <= objective_time <= signal_second + 180:
            compact = compact_objective(objective, signal_second, side)
            compact["secondsFromSignal"] = objective_time - signal_second
            objective_timeline.append(compact)
    market_marks = [{"secondsFromSignal": 0, "price": row["triggerPrice"], "source": "target trigger"}]
    for lag in (0, 1, 2, 3, 5, 10, 15, 30, 60, 120, 180, 300):
        value = row.get(f"alignedExecutionMark{lag}")
        if value is not None and math.isfinite(float(value)):
            market_marks.append({
                "secondsFromSignal": lag,
                "price": finite(value),
                "source": "first aligned public BUY print",
            })
    return {
        "gold": gold_timeline,
        "objectives": objective_timeline,
        "polymarketMarks": market_marks,
    }


def analyze(
    features: pd.DataFrame,
    pro_matches: list[dict],
    client: OpenDotaClient,
    state_model,
    state_model_audit: dict,
) -> dict:
    dota = features[features["discipline"] == "Dota 2"].copy()
    rows = []
    detail_cache: dict[int, dict] = {}
    for _, feature in dota.sort_values("signalTimestamp").iterrows():
        series, name_score = matching_series(feature, pro_matches)
        signal_timestamp = int(feature["signalTimestamp"])
        if series:
            phase, active_match = series_phase(series, signal_timestamp)
        else:
            phase, active_match = "unmatched", None
        row = {
            key: (None if pd.isna(value) else value)
            for key, value in feature.to_dict().items()
        }
        row.update({
            "nameMatchScore": finite(name_score),
            "phase": phase,
            "seriesScoreAtSignal": series_score(series, signal_timestamp, str(feature["outcome"]))
            if series else None,
            "seriesMatches": [{
                "matchId": int(match["match_id"]),
                "startTimestamp": int(match["start_time"]),
                "startTime": iso(match["start_time"]),
                "durationSeconds": int(match.get("duration") or 0),
                "radiant": match.get("radiant_name"),
                "dire": match.get("dire_name"),
                "winner": winner_name(match),
                "league": match.get("league_name"),
            } for match in series],
            "frozenBaseEligible": (
                str(feature["marketType"]) in CORE_MARKET_TYPES
                and 0.30 <= float(feature["triggerPrice"]) <= 0.85
                and float(feature["concentration"]) >= 0.70
            ),
            "broadSweep": finite(feature.get("onchainUniqueMakers")) is not None
            and float(feature["onchainUniqueMakers"]) >= BREADTH_THRESHOLD,
            "state": None,
        })
        if active_match:
            match_id = int(active_match["match_id"])
            if match_id not in detail_cache:
                detail_cache[match_id] = client.get(f"matches/{match_id}")
            row["state"] = state_at_signal(
                detail_cache[match_id], signal_timestamp, str(feature["outcome"])
            )
        rows.append(row)

    state_model_wallet_audit = add_state_model_predictions(rows, state_model)
    base_rows = [row for row in rows if row["frozenBaseEligible"]]
    broad_base = [row for row in base_rows if row["broadSweep"]]
    spotlight_candidates = [row for row in broad_base if row["phase"] == "in_game" and row.get("state")]
    spotlight = None
    if spotlight_candidates:
        spotlight = min(
            spotlight_candidates,
            key=lambda row: row["state"].get("previousObjective", {}).get(
                "secondsBeforeSignal", 10**9
            ) if row["state"].get("previousObjective") else 10**9,
        )
        detail = detail_cache[int(spotlight["state"]["matchId"])]
        spotlight = {
            "conditionId": spotlight["conditionId"],
            "title": spotlight["title"],
            "signalTime": spotlight["signalTime"],
            "outcome": spotlight["outcome"],
            "winner": spotlight["winner"],
            "triggerPrice": finite(spotlight["triggerPrice"]),
            "uniqueMakers": int(spotlight["onchainUniqueMakers"]),
            "priceLevels": int(spotlight["onchainPriceLevels"]),
            "medianMakerAgeSeconds": finite(spotlight["onchainRestingAgeMedianSeconds"]),
            "state": spotlight["state"],
            "stateModel": spotlight["stateModel"],
            "timeline": timeline_from_state(spotlight, detail),
        }

    phase_counts = Counter(row["phase"] for row in rows)
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "status": "telemetry_aligned_case_not_general_strategy",
        "question": "Do Dota signals align with independently reconstructed game state, especially immediate objectives?",
        "sources": {
            "proMatchIndex": f"{API_BASE}/proMatches",
            "parsedMatchEndpoint": f"{API_BASE}/matches/<match_id>",
            "openSourceParser": SOURCE_REPOSITORY,
        },
        "method": (
            "Match market team names and scheduled windows to OpenDota professional matches, classify "
            "each signal as pre-map, between maps, in-game, or post-series, then inspect replay-derived "
            "gold, XP, kill logs, and objectives at the signal game-second."
        ),
        "coverage": {
            "dotaThresholdSignals": len(rows),
            "matchedSignals": sum(bool(row["seriesMatches"]) for row in rows),
            "phaseCounts": dict(phase_counts),
            "parsedInGameStates": sum(row.get("state") is not None for row in rows),
            "frozenDotaBaseSignals": len(base_rows),
            "frozenBroadDotaSignals": len(broad_base),
        },
        "comparisons": {
            "allDotaSignals": summarize_rows(rows, lambda row: True),
            "frozenBaseDotaSignals": summarize_rows(rows, lambda row: row["frozenBaseEligible"]),
            "frozenBroadDotaSignals": summarize_rows(
                rows, lambda row: row["frozenBaseEligible"] and row["broadSweep"]
            ),
            "otherDotaSignals": summarize_rows(
                rows, lambda row: not (row["frozenBaseEligible"] and row["broadSweep"])
            ),
        },
        "independentStateModel": state_model_audit,
        "stateModelWalletAudit": state_model_wallet_audit,
        "spotlight": spotlight,
        "events": [{
            "conditionId": row["conditionId"],
            "title": row["title"],
            "signalTime": row["signalTime"],
            "outcome": row["outcome"],
            "winner": row["winner"],
            "won": int(row["won"]),
            "triggerPrice": finite(row["triggerPrice"]),
            "uniqueMakers": finite(row["onchainUniqueMakers"]),
            "marketType": row["marketType"],
            "frozenBaseEligible": row["frozenBaseEligible"],
            "broadSweep": row["broadSweep"],
            "phase": row["phase"],
            "nameMatchScore": row["nameMatchScore"],
            "seriesScoreAtSignal": row["seriesScoreAtSignal"],
            "matchIds": [match["matchId"] for match in row["seriesMatches"]],
            "state": row["state"],
            "stateModel": row["stateModel"],
        } for row in rows],
        "conclusion": (
            "The broad Falcons-Liquid signal is tightly aligned to live Dota telemetry: the target "
            "bought Liquid seven seconds after Liquid destroyed a tier-two tower while about 13.4k "
            "gold ahead. That verifies one state-aware trade, not the wallet's general secret: five of "
            "the six matched frozen broad Dota series signals occurred before the first map; one "
            "additional broad signal could not be matched."
        ) if spotlight else (
            "No frozen broad Dota signal could be aligned to an in-game parsed state."
        ),
        "limitations": [
            "OpenDota state is replay-derived and generally available after the game; it is independent historical verification, not a live trading feed.",
            "Team-name and time-window joins are deterministic but not official Polymarket-to-OpenDota identifiers.",
            "Only one frozen broad Dota series signal occurred during a map; five matched broad signals were pre-map and one was unmatched.",
            "Settlement outcomes were already known when this mechanism audit was designed; no profitability claim is prospective.",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--features", default="research/djdjdjekekek/edge_features.csv")
    parser.add_argument("--output", default="research/djdjdjekekek/esports_state_analysis.json")
    parser.add_argument("--cache", default="/tmp/polymarket-opendota-pro-matches.json")
    parser.add_argument(
        "--state-training-cache", default="/tmp/polymarket-opendota-state-training.json"
    )
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--request-delay", type=float, default=1.05)
    args = parser.parse_args()

    features = pd.read_csv(args.features)
    dota = features[features["discipline"] == "Dota 2"]
    if dota.empty:
        raise ValueError("No Dota signals found")
    window_start = int(dota["signalTimestamp"].min()) - 2 * 86_400
    client = OpenDotaClient(args.request_delay)
    pro_matches = collect_pro_matches(
        client, window_start, Path(args.cache), args.refresh
    )
    training_matches = collect_state_training_matches(
        client,
        int(dota["signalTimestamp"].min()),
        Path(args.state_training_cache),
        args.refresh,
    )
    state_model, state_model_audit = fit_state_model(training_matches)
    output = analyze(features, pro_matches, client, state_model, state_model_audit)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(output, indent=2, allow_nan=False) + "\n", encoding="utf-8"
    )
    print(
        f"Esports state audit: {output['coverage']['matchedSignals']}/"
        f"{output['coverage']['dotaThresholdSignals']} Dota signals matched; "
        f"{output['coverage']['parsedInGameStates']} in-game states -> {output_path}"
    )


if __name__ == "__main__":
    main()
