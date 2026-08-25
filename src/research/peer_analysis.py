#!/usr/bin/env python3
"""Test whether recurring public wallets systematically lead the target's signals."""

from __future__ import annotations

import argparse
import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import numpy as np
import pandas as pd


DATA_API = "https://data-api.polymarket.com"
GAMMA_API = "https://gamma-api.polymarket.com"
CORE_DISCIPLINES = {
    "Tennis", "Soccer", "Dota 2", "Counter-Strike", "League of Legends", "Valorant"
}
EXCLUDED_MARKET_TYPES = {"single-game/map", "short-horizon binary"}


def get_json(url: str, params: dict, attempts: int = 5):
    target = f"{url}?{urlencode(params)}"
    for attempt in range(1, attempts + 1):
        try:
            request = Request(target, headers={"accept": "application/json", "user-agent": "research/1.0"})
            with urlopen(request, timeout=30) as response:
                return json.load(response)
        except Exception:
            if attempt == attempts:
                raise
            time.sleep(0.4 * attempt * attempt)


def chunks(values: list[str], size: int):
    for index in range(0, len(values), size):
        yield values[index:index + size]


def collect_peer_batch(peer: str, condition_ids: list[str]) -> list[dict]:
    limit = 10_000
    params = {
        "user": peer,
        "market": ",".join(condition_ids),
        "takerOnly": True,
        "limit": limit,
        "offset": 0,
        "sortDirection": "DESC",
    }
    rows = get_json(f"{DATA_API}/trades", params)
    if not isinstance(rows, list):
        raise RuntimeError(f"Non-array peer trade response for {peer}")
    if len(rows) < limit:
        return rows
    if len(condition_ids) == 1:
        collected = list(rows)
        oldest = min(int(row["timestamp"]) for row in rows)
        while len(rows) == limit:
            rows = get_json(f"{DATA_API}/trades", {**params, "end": oldest})
            if not isinstance(rows, list):
                raise RuntimeError(f"Non-array peer trade response for {peer}")
            collected.extend(rows)
            if len(rows) < limit:
                break
            next_oldest = min(int(row["timestamp"]) for row in rows)
            if next_oldest >= oldest:
                raise RuntimeError(
                    f"Peer pagination could not advance beyond timestamp {oldest} for "
                    f"{peer} in {condition_ids[0]}"
                )
            oldest = next_oldest
        return collected
    midpoint = len(condition_ids) // 2
    return (
        collect_peer_batch(peer, condition_ids[:midpoint])
        + collect_peer_batch(peer, condition_ids[midpoint:])
    )


def collect_peer(peer: str, condition_ids: list[str]) -> dict:
    try:
        profile = get_json(f"{GAMMA_API}/public-profile", {"address": peer})
    except Exception:
        profile = {}
    trades = []
    for market_batch in chunks(condition_ids, 15):
        trades.extend(collect_peer_batch(peer, market_batch))
    unique = {}
    for row in trades:
        key = (
            row.get("transactionHash"),
            row.get("proxyWallet"),
            row.get("asset"),
            row.get("side"),
            row.get("timestamp"),
            row.get("price"),
            row.get("size"),
        )
        unique[key] = row
    return {
        "wallet": peer,
        "profile": {
            "name": profile.get("name"),
            "pseudonym": profile.get("pseudonym"),
            "xUsername": profile.get("xUsername"),
            "createdAt": profile.get("createdAt"),
            "verifiedBadge": profile.get("verifiedBadge"),
        },
        "trades": sorted(unique.values(), key=lambda row: (row["timestamp"], row.get("transactionHash", ""))),
    }


def trade_direction(row: dict, target_outcome: str) -> int:
    aligned_outcome = 1 if row.get("outcome") == target_outcome else -1
    side = -1 if row.get("side") == "SELL" else 1
    return aligned_outcome * side


def peer_signal_rows(peer_data: dict, features: pd.DataFrame) -> list[dict]:
    by_condition: dict[str, list[dict]] = {}
    for trade in peer_data["trades"]:
        by_condition.setdefault(trade["conditionId"], []).append(trade)
    output = []
    for signal in features.to_dict("records"):
        trades = by_condition.get(signal["conditionId"], [])
        if not trades:
            continue
        prior = [trade for trade in trades if int(trade["timestamp"]) < int(signal["signalTimestamp"])]
        gross_shares = sum(float(trade.get("size") or 0) for trade in prior)
        net_shares = sum(
            trade_direction(trade, signal["outcome"]) * float(trade.get("size") or 0)
            for trade in prior
        )
        first = min((int(trade["timestamp"]) for trade in prior), default=None)
        last = max((int(trade["timestamp"]) for trade in prior), default=None)
        output.append({
            "conditionId": signal["conditionId"],
            "eventKey": signal["eventKey"],
            "title": signal["title"],
            "signalTimestamp": int(signal["signalTimestamp"]),
            "targetOutcome": signal["outcome"],
            "targetWon": int(signal["won"]),
            "peerTrades": len(trades),
            "peerPriorTrades": len(prior),
            "netAlignedSharesBefore": net_shares,
            "directionalAlignment": net_shares / gross_shares if gross_shares else None,
            "alignedBefore": net_shares > 0,
            "opposedBefore": net_shares < 0,
            "firstLeadSeconds": int(signal["signalTimestamp"]) - first if first is not None else None,
            "lastLeadSeconds": int(signal["signalTimestamp"]) - last if last is not None else None,
            "approxAlignedUsdc": net_shares * float(signal["triggerPrice"]),
        })
    return output


def summarize_peer(peer_data: dict, overlaps: list[dict]) -> dict:
    before = [row for row in overlaps if row["peerPriorTrades"] > 0]
    aligned = [row for row in before if row["alignedBefore"]]
    opposed = [row for row in before if row["opposedBefore"]]
    return {
        "wallet": peer_data["wallet"],
        **peer_data["profile"],
        "takerTradesInTargetMarkets": len(peer_data["trades"]),
        "sharedTargetSignals": len(overlaps),
        "enteredBeforeTarget": len(before),
        "alignedBeforeTarget": len(aligned),
        "opposedBeforeTarget": len(opposed),
        "alignedShareOfPriorPct": len(aligned) / len(before) * 100 if before else 0,
        "alignedTargetWinRatePct": sum(row["targetWon"] for row in aligned) / len(aligned) * 100 if aligned else None,
        "medianLastLeadSeconds": float(np.median([row["lastLeadSeconds"] for row in aligned])) if aligned else None,
        "medianAlignedUsdc": float(np.median([row["approxAlignedUsdc"] for row in aligned])) if aligned else None,
        "overlaps": overlaps,
    }


def simulation_summary(rows: pd.DataFrame) -> dict:
    if rows.empty:
        return {"bets": 0}
    observed = rows["executionMark60"].fillna(rows["triggerPrice"])
    execution = (observed + 0.05).clip(0.01, 0.99)
    all_in = execution + 0.03 * execution * (1 - execution)
    returns = np.where(rows["won"] == 1, 1 / all_in - 1, -1)
    return {
        "bets": int(len(rows)),
        "wins": int(rows["won"].sum()),
        "winRatePct": float(rows["won"].mean() * 100),
        "roiPct": float(returns.mean() * 100),
    }


def basket_analysis(features: pd.DataFrame, peer_rows: list[dict]) -> dict:
    base = features[
        features["discipline"].isin(CORE_DISCIPLINES)
        & ~features["marketType"].isin(EXCLUDED_MARKET_TYPES)
        & features["triggerPrice"].between(0.30, 0.85)
        & (features["concentration"] >= 0.70)
    ].sort_values("signalTimestamp").drop_duplicates("eventKey").copy()
    aligned_counts: dict[str, set[str]] = {}
    opposed_counts: dict[str, set[str]] = {}
    for peer in peer_rows:
        wallet = peer["wallet"]
        for overlap in peer["overlaps"]:
            if overlap["alignedBefore"]:
                aligned_counts.setdefault(overlap["conditionId"], set()).add(wallet)
            if overlap["opposedBefore"]:
                opposed_counts.setdefault(overlap["conditionId"], set()).add(wallet)
    base["alignedPeersBefore"] = base["conditionId"].map(lambda value: len(aligned_counts.get(value, set())))
    base["opposedPeersBefore"] = base["conditionId"].map(lambda value: len(opposed_counts.get(value, set())))
    split_index = int(len(base) * 0.60)
    split_timestamp = int(base.iloc[split_index]["signalTimestamp"])
    selected_peers = set()
    for peer in peer_rows:
        early_aligned_events = {
            overlap["eventKey"] for overlap in peer["overlaps"]
            if overlap["alignedBefore"] and overlap["signalTimestamp"] < split_timestamp
        }
        if len(early_aligned_events) >= 3:
            selected_peers.add(peer["wallet"])
    later = base[base["signalTimestamp"] >= split_timestamp].copy()
    later["knownPeerAligned"] = later["conditionId"].map(lambda condition_id: any(
        peer["wallet"] in selected_peers
        and any(overlap["conditionId"] == condition_id and overlap["alignedBefore"]
                for overlap in peer["overlaps"])
        for peer in peer_rows
    ))
    return {
        "anyPeerAlignedBefore": simulation_summary(base[base["alignedPeersBefore"] > 0]),
        "noPeerAlignedBefore": simulation_summary(base[base["alignedPeersBefore"] == 0]),
        "peerConsensusPositive": simulation_summary(base[
            base["alignedPeersBefore"] > base["opposedPeersBefore"]
        ]),
        "peerConsensusNotPositive": simulation_summary(base[
            base["alignedPeersBefore"] <= base["opposedPeersBefore"]
        ]),
        "chronologicalAudit": {
            "splitTimestamp": split_timestamp,
            "peersSelectedByEarlyRecurrenceOnly": len(selected_peers),
            "knownPeerAlignedLater": simulation_summary(later[later["knownPeerAligned"]]),
            "knownPeerNotAlignedLater": simulation_summary(later[~later["knownPeerAligned"]]),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--edge", default="research/djdjdjekekek/edge_analysis.json")
    parser.add_argument("--features", default="research/djdjdjekekek/edge_features.csv")
    parser.add_argument("--output", default="research/djdjdjekekek/peer_evidence.json")
    args = parser.parse_args()

    with Path(args.edge).open(encoding="utf-8") as handle:
        edge = json.load(handle)
    features = pd.read_csv(args.features)
    peer_addresses = [
        row["wallet"] for row in edge["leaders"]["top"] if row["events"] >= 3
    ]
    condition_ids = features["conditionId"].drop_duplicates().tolist()
    collected = []
    with ThreadPoolExecutor(max_workers=6) as executor:
        futures = {executor.submit(collect_peer, peer, condition_ids): peer for peer in peer_addresses}
        for completed, future in enumerate(as_completed(futures), start=1):
            peer = futures[future]
            data = future.result()
            overlaps = peer_signal_rows(data, features)
            collected.append(summarize_peer(data, overlaps))
            print(f"Peer evidence: {completed}/{len(futures)} {peer}")
    collected.sort(key=lambda row: (row["alignedBeforeTarget"], row["sharedTargetSignals"]), reverse=True)
    output = {
        "generatedAt": pd.Timestamp.now(tz="UTC").isoformat(),
        "methodology": {
            "peers": "Wallets recurring in at least three strict 15-minute pre-signal tape screens.",
            "tradeSource": f"{DATA_API}/trades?user=<peer>&takerOnly=true, restricted to the target's signal markets.",
            "alignment": "Net peer token shares before the target signal, converted to the target outcome direction.",
            "warning": "These peers were discovered in the same sample. Recurrence is evidence about mechanism, not an independently validated copy strategy.",
        },
        "peers": collected,
        "basket": basket_analysis(features, collected),
        "conclusion": "A copying hypothesis requires a peer to recur, lead, and align consistently. High overlap without directional or temporal consistency is shared market selection, not evidence of copying.",
    }
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(f"Peer analysis: {len(collected)} recurring wallets -> {output_path}")


if __name__ == "__main__":
    main()
