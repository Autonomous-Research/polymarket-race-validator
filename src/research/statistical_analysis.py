#!/usr/bin/env python3
"""Statistical robustness checks for the generated market-level research dataset."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
import statsmodels.formula.api as smf
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from statsmodels.genmod.families import Binomial


SEED = 20260825
BOOTSTRAP_DRAWS = 10_000


def load_analysis(path: Path) -> dict:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def dominant_average_price(market: dict) -> float:
    dominant = market.get("dominantOutcome")
    outcome = next((row for row in market.get("outcomes", []) if row.get("outcome") == dominant), None)
    if not outcome or not outcome.get("buyShares"):
        return np.nan
    return float(outcome.get("buyCashUsdc", 0)) / float(outcome["buyShares"])


def build_frame(analysis: dict) -> pd.DataFrame:
    rows = []
    for market in analysis["markets"]:
        cost = float(market.get("closedCostBasisUsdc") or 0)
        won = market.get("dominantOutcomeWon")
        if cost <= 0 or won is None:
            continue
        discipline = market.get("discipline") or "Other"
        rows.append({
            "condition_id": market["conditionId"],
            "event_key": market.get("eventKey") or market["conditionId"],
            "timestamp": int(market["firstTradeTimestamp"]),
            "discipline_raw": discipline,
            "market_type": market.get("marketType") or "match winner",
            "cost_usdc": cost,
            "log_cost": np.log1p(cost),
            "pnl_usdc": float(market.get("realizedPnlUsdc") or 0),
            "roi": float(market.get("realizedPnlUsdc") or 0) / cost,
            "won": int(bool(won)),
            "taker_share": float(market.get("takerNotionalPct") or 0) / 100,
            "started_pregame": int(bool(
                market.get("gameStartTimestamp")
                and market["firstTradeTimestamp"] < market["gameStartTimestamp"]
            )),
            "majority_pregame": int(float(market.get("pregameQuoteUsdc") or 0)
                                    >= float(market.get("inPlayQuoteUsdc") or 0)
                                    and bool(market.get("gameStartTimestamp"))),
            "dominant_concentration": float(market.get("dominantOutcomeBuySharePct") or 0) / 100,
            "dominant_average_price": dominant_average_price(market),
            "correlated_event": int(bool(market.get("eventKey"))),
        })
    frame = pd.DataFrame(rows).sort_values("timestamp").reset_index(drop=True)
    common = set(frame["discipline_raw"].value_counts().loc[lambda counts: counts >= 10].index)
    # Crypto 5m is perfectly collinear with the short-horizon market-type flag.
    common.discard("Crypto 5m")
    frame["discipline"] = frame["discipline_raw"].where(frame["discipline_raw"].isin(common), "Other")
    return frame


def finite(value):
    if value is None:
        return None
    value = float(value)
    return value if np.isfinite(value) else None


def robust_logit(frame: pd.DataFrame) -> dict:
    model_frame = frame.dropna(subset=["dominant_average_price"]).copy()
    formula = (
        "won ~ log_cost + taker_share + started_pregame + majority_pregame "
        "+ dominant_concentration + dominant_average_price "
        "+ C(market_type, Treatment(reference='match winner')) "
        "+ C(discipline, Treatment(reference='Tennis'))"
    )
    fitted = smf.glm(formula, data=model_frame, family=Binomial()).fit(cov_type="HC3")
    coefficients = []
    confidence = fitted.conf_int()
    for name, coefficient in fitted.params.items():
        coefficients.append({
            "term": name,
            "coefficient": finite(coefficient),
            "oddsRatio": finite(np.exp(coefficient)),
            "robustStdError": finite(fitted.bse[name]),
            "pValue": finite(fitted.pvalues[name]),
            "oddsRatioCi95Low": finite(np.exp(confidence.loc[name, 0])),
            "oddsRatioCi95High": finite(np.exp(confidence.loc[name, 1])),
        })
    return {
        "method": "Binomial GLM with HC3 heteroskedasticity-robust covariance",
        "formula": formula,
        "observations": int(fitted.nobs),
        "pseudoR2CoxSnell": finite(fitted.pseudo_rsquared(kind="cs")),
        "aic": finite(fitted.aic),
        "coefficients": coefficients,
        "warning": "This is attribution, not a causal model. Total cost and majority-pregame status are known only after position construction."
    }


def chronological_validation(frame: pd.DataFrame) -> dict:
    split = int(len(frame) * 0.7)
    train = frame.iloc[:split].copy()
    test = frame.iloc[split:].copy()
    numeric = [
        "log_cost", "taker_share", "started_pregame", "dominant_concentration",
        "dominant_average_price", "correlated_event"
    ]
    categorical = ["discipline", "market_type"]
    transform = ColumnTransformer([
        ("numeric", Pipeline([
            ("impute", SimpleImputer(strategy="median")),
            ("scale", StandardScaler())
        ]), numeric),
        ("categorical", OneHotEncoder(handle_unknown="ignore"), categorical)
    ])
    pipeline = Pipeline([
        ("features", transform),
        ("model", LogisticRegression(C=0.5, max_iter=5_000, random_state=SEED))
    ])
    pipeline.fit(train[numeric + categorical], train["won"])
    predicted = pipeline.predict_proba(test[numeric + categorical])[:, 1]
    market_price = test["dominant_average_price"].fillna(train["won"].mean()).clip(0.001, 0.999)
    prevalence = np.repeat(train["won"].mean(), len(test))

    def metrics(probabilities: np.ndarray | pd.Series) -> dict:
        return {
            "brier": finite(brier_score_loss(test["won"], probabilities)),
            "logLoss": finite(log_loss(test["won"], probabilities, labels=[0, 1])),
            "rocAuc": finite(roc_auc_score(test["won"], probabilities)),
        }

    return {
        "method": "Chronological 70/30 split; L2-regularized logistic regression",
        "splitTimestamp": int(test.iloc[0]["timestamp"]),
        "trainMarkets": len(train),
        "testMarkets": len(test),
        "trainWinRate": finite(train["won"].mean()),
        "testWinRate": finite(test["won"].mean()),
        "model": metrics(predicted),
        "targetAverageEntryPriceBaseline": metrics(market_price),
        "trainingPrevalenceBaseline": metrics(prevalence),
        "warning": "The model evaluates descriptive stability, not a deployable signal; several features summarize the target's completed position."
    }


def cluster_bootstrap_roi(frame: pd.DataFrame, draws: int = BOOTSTRAP_DRAWS) -> dict:
    cluster_totals = frame.groupby("event_key", sort=False).agg(
        pnl_usdc=("pnl_usdc", "sum"),
        cost_usdc=("cost_usdc", "sum")
    )
    if cluster_totals.empty:
        return {}
    pnl_by_cluster = cluster_totals["pnl_usdc"].to_numpy(dtype=float)
    cost_by_cluster = cluster_totals["cost_usdc"].to_numpy(dtype=float)
    cluster_count = len(cluster_totals)
    rng = np.random.default_rng(SEED)
    sampled = rng.integers(0, cluster_count, size=(draws, cluster_count))
    sampled_pnl = pnl_by_cluster[sampled].sum(axis=1)
    sampled_cost = cost_by_cluster[sampled].sum(axis=1)
    roi_draws = np.divide(sampled_pnl, sampled_cost, out=np.full(draws, np.nan), where=sampled_cost != 0)
    roi_draws = roi_draws[np.isfinite(roi_draws)]
    actual = frame["pnl_usdc"].sum() / frame["cost_usdc"].sum()
    return {
        "markets": len(frame),
        "eventClusters": cluster_count,
        "costBasisUsdc": finite(frame["cost_usdc"].sum()),
        "realizedPnlUsdc": finite(frame["pnl_usdc"].sum()),
        "roiPct": finite(actual * 100),
        "bootstrapMedianRoiPct": finite(np.quantile(roi_draws, 0.5) * 100),
        "ci95LowPct": finite(np.quantile(roi_draws, 0.025) * 100),
        "ci95HighPct": finite(np.quantile(roi_draws, 0.975) * 100),
        "probabilityPositivePct": finite(np.mean(roi_draws > 0) * 100),
    }


def bootstrap_subgroups(frame: pd.DataFrame) -> dict:
    groups = {
        "all": frame,
        "takerShareAtLeast50Pct": frame[frame["taker_share"] >= 0.5],
        "takerShareBelow50Pct": frame[frame["taker_share"] < 0.5],
        "startedPregame": frame[frame["started_pregame"] == 1],
        "startedInPlayOrUntimed": frame[frame["started_pregame"] == 0],
        "singleGameOrMap": frame[frame["market_type"] == "single-game/map"],
        "notSingleGameOrMap": frame[frame["market_type"] != "single-game/map"],
    }
    for discipline, rows in frame.groupby("discipline_raw"):
        if len(rows) >= 7:
            groups[f"discipline:{discipline}"] = rows
    return {name: cluster_bootstrap_roi(rows) for name, rows in groups.items() if len(rows)}


def bootstrap_strategy(results: list[dict], draws: int = BOOTSTRAP_DRAWS) -> dict:
    if not results:
        return {"bets": 0}
    profits = np.array([float(row["profitUsdc"]) for row in results])
    stakes = np.array([float(row["stakeUsdc"]) for row in results])
    rng = np.random.default_rng(SEED + 1)
    indexes = rng.integers(0, len(results), size=(draws, len(results)))
    sampled_roi = profits[indexes].sum(axis=1) / stakes[indexes].sum(axis=1)
    return {
        "bets": len(results),
        "roiPct": finite(profits.sum() / stakes.sum() * 100),
        "ci95LowPct": finite(np.quantile(sampled_roi, 0.025) * 100),
        "ci95HighPct": finite(np.quantile(sampled_roi, 0.975) * 100),
        "probabilityPositivePct": finite(np.mean(sampled_roi > 0) * 100),
        "warning": "IID bet bootstrap; the small sample and strategy-selection process are not fully represented."
    }


def concentration_robustness(frame: pd.DataFrame) -> dict:
    ordered = frame.sort_values("pnl_usdc", ascending=False)
    output = {}
    for removed in [0, 1, 5, 10]:
        rows = ordered.iloc[removed:]
        output[f"withoutTop{removed}" if removed else "all"] = {
            "markets": len(rows),
            "pnlUsdc": finite(rows["pnl_usdc"].sum()),
            "roiPct": finite(rows["pnl_usdc"].sum() / rows["cost_usdc"].sum() * 100)
        }
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="research/djdjdjekekek/deep_analysis.json")
    parser.add_argument("--output", default="research/djdjdjekekek/statistical_analysis.json")
    parser.add_argument("--features", default="research/djdjdjekekek/market_features.csv")
    args = parser.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)
    features_path = Path(args.features)
    analysis = load_analysis(input_path)
    frame = build_frame(analysis)

    proposed = analysis["backtest"]["proposed"]["taker"]
    split_timestamp = analysis["backtest"]["methodology"]["splitTimestamp"]
    strategy_results = proposed["results"]
    output = {
        "generatedAt": pd.Timestamp.now(tz="UTC").isoformat(),
        "source": str(input_path),
        "markets": len(frame),
        "methods": {
            "bootstrapDraws": BOOTSTRAP_DRAWS,
            "bootstrapUnit": "Canonical match/event where available; otherwise condition ID",
            "randomSeed": SEED
        },
        "robustLogit": robust_logit(frame),
        "chronologicalValidation": chronological_validation(frame),
        "bootstrapRoi": bootstrap_subgroups(frame),
        "pnlConcentration": {
            "allMarkets": concentration_robustness(frame),
            "takerShareAtLeast50Pct": concentration_robustness(frame[frame["taker_share"] >= 0.5]),
            "takerShareBelow50Pct": concentration_robustness(frame[frame["taker_share"] < 0.5])
        },
        "proposedStrategyBootstrap": {
            "train": bootstrap_strategy([row for row in strategy_results if row["executionTimestamp"] <= split_timestamp]),
            "test": bootstrap_strategy([row for row in strategy_results if row["executionTimestamp"] > split_timestamp]),
            "all": bootstrap_strategy(strategy_results)
        },
        "interpretationLimits": [
            "The trader and strategy were selected after observing exceptional performance, so selection bias remains.",
            "Market outcomes within an event are correlated; event-cluster bootstrap reduces but cannot eliminate dependence.",
            "P-values are descriptive and are not corrected for every exploratory comparison in the report.",
            "Backtest fills use target trades as a price proxy, not a full historical order book."
        ]
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    features_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    frame.to_csv(features_path, index=False)
    print(f"Statistical analysis: {len(frame)} markets -> {output_path}")


if __name__ == "__main__":
    main()
