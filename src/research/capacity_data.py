#!/usr/bin/env python3
"""Collect closing-line marks and a point-in-time sports order-book capacity sample."""

from __future__ import annotations

import argparse
import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import numpy as np
import pandas as pd


DATA_API = "https://data-api.polymarket.com"
GAMMA_API = "https://gamma-api.polymarket.com"
CLOB_API = "https://clob.polymarket.com"
CORE_DISCIPLINES = {
    "Tennis", "Soccer", "Dota 2", "Counter-Strike", "League of Legends", "Valorant"
}
EXCLUDED_MARKET_TYPES = {"single-game/map", "short-horizon binary"}
PRICE_BUFFERS_CENTS = (0, 1, 2, 5, 10)
STAKE_SIZES_USDC = (25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 25_000)


def request_json(
    url: str,
    params: dict | None = None,
    payload: object | None = None,
    attempts: int = 5,
):
    target = f"{url}?{urlencode(params)}" if params else url
    body = json.dumps(payload).encode() if payload is not None else None
    headers = {
        "accept": "application/json",
        "user-agent": "polymarket-capacity-research/1.0",
    }
    if body is not None:
        headers["content-type"] = "application/json"
    for attempt in range(1, attempts + 1):
        try:
            request = Request(target, data=body, headers=headers, method="POST" if body else "GET")
            with urlopen(request, timeout=45) as response:
                return json.load(response)
        except Exception:
            if attempt == attempts:
                raise
            time.sleep(0.4 * attempt * attempt)


def finite(value):
    if value is None:
        return None
    numeric = float(value)
    return numeric if np.isfinite(numeric) else None


def quantiles(values: list[float]) -> dict:
    finite_values = np.asarray([value for value in values if np.isfinite(value)], dtype=float)
    if not len(finite_values):
        return {"p10": None, "p25": None, "median": None, "p75": None, "p90": None}
    return {
        "p10": finite(np.quantile(finite_values, 0.10)),
        "p25": finite(np.quantile(finite_values, 0.25)),
        "median": finite(np.median(finite_values)),
        "p75": finite(np.quantile(finite_values, 0.75)),
        "p90": finite(np.quantile(finite_values, 0.90)),
    }


def parse_array(value) -> list:
    if isinstance(value, list):
        return value
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return []
    return parsed if isinstance(parsed, list) else []


def eligible_features(frame: pd.DataFrame) -> pd.DataFrame:
    eligible = frame[
        frame["discipline"].isin(CORE_DISCIPLINES)
        & ~frame["marketType"].isin(EXCLUDED_MARKET_TYPES)
        & frame["triggerPrice"].between(0.30, 0.85)
        & (frame["concentration"] >= 0.70)
    ].sort_values("signalTimestamp")
    return eligible.drop_duplicates("eventKey", keep="first").reset_index(drop=True)


def closing_mark_for_row(row: dict, target_wallet: str) -> dict:
    end = int(row["gameStartTimestamp"]) - 1
    public_rows = []
    selected_lookback = None
    for lookback in (600, 3_600, 21_600):
        rows = request_json(f"{DATA_API}/trades", {
            "market": row["conditionId"],
            "takerOnly": "true",
            "start": end - lookback,
            "end": end,
            "limit": 10_000,
            "offset": 0,
            "sortDirection": "DESC",
            "filterType": "CASH",
            "filterAmount": 1,
        })
        public_rows = [
            trade for trade in rows
            if str(trade.get("proxyWallet") or "").lower() != target_wallet
        ]
        selected_lookback = lookback
        if public_rows:
            break

    if not public_rows:
        return {
            "conditionId": row["conditionId"],
            "eventKey": row["eventKey"],
            "title": row["title"],
            "discipline": row["discipline"],
            "outcome": row["outcome"],
            "signalTimestamp": int(row["signalTimestamp"]),
            "gameStartTimestamp": int(row["gameStartTimestamp"]),
            "triggerPrice": float(row["triggerPrice"]),
            "won": int(row["won"]),
            "onchainUniqueMakers": int(row["onchainUniqueMakers"]),
            "closingPrice": None,
            "closingPrintTimestamp": None,
            "closingPrintStalenessSeconds": None,
            "closingLineValueCents": None,
            "lookbackSeconds": selected_lookback,
            "publicRows": 0,
        }

    latest_timestamp = max(int(trade["timestamp"]) for trade in public_rows)
    latest = [trade for trade in public_rows if int(trade["timestamp"]) == latest_timestamp]
    aligned_prices = [
        float(trade["price"])
        if trade.get("outcome") == row["outcome"]
        else 1 - float(trade["price"])
        for trade in latest
    ]
    closing_price = float(np.median(aligned_prices))
    return {
        "conditionId": row["conditionId"],
        "eventKey": row["eventKey"],
        "title": row["title"],
        "discipline": row["discipline"],
        "outcome": row["outcome"],
        "signalTimestamp": int(row["signalTimestamp"]),
        "gameStartTimestamp": int(row["gameStartTimestamp"]),
        "triggerPrice": float(row["triggerPrice"]),
        "won": int(row["won"]),
        "onchainUniqueMakers": int(row["onchainUniqueMakers"]),
        "closingPrice": closing_price,
        "closingPrintTimestamp": latest_timestamp,
        "closingPrintStalenessSeconds": end - latest_timestamp,
        "closingLineValueCents": (closing_price - float(row["triggerPrice"])) * 100,
        "lookbackSeconds": selected_lookback,
        "publicRows": len(public_rows),
        "sameSecondPrints": len(latest),
    }


def collect_closing_lines(
    features: pd.DataFrame,
    target_wallet: str,
    concurrency: int,
) -> dict:
    rows = eligible_features(features)
    rows = rows[
        rows["pregame"].eq(1)
        & rows["gameStartTimestamp"].notna()
    ].to_dict("records")
    output = []
    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = {
            executor.submit(closing_mark_for_row, row, target_wallet): row
            for row in rows
        }
        for completed, future in enumerate(as_completed(futures), start=1):
            output.append(future.result())
            if completed == len(rows) or completed % 10 == 0:
                print(f"Closing lines: {completed}/{len(rows)}")
    output.sort(key=lambda row: row["signalTimestamp"])
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": f"{DATA_API}/trades?takerOnly=true",
        "targetWallet": target_wallet,
        "definition": "Last non-target public print before the recorded game start, aligned to the target outcome.",
        "coverage": {
            "eligiblePregameEvents": len(output),
            "eventsWithClosingPrint": sum(row["closingPrice"] is not None for row in output),
        },
        "warnings": [
            "This is a public-print closing mark, not a guaranteed executable closing quote.",
            "Game-start metadata can be imperfect, and esports start times can move.",
            "Closing-line value is meaningful only for signals placed before the recorded start.",
        ],
        "events": output,
    }


def gamma_sports_markets(max_pages: int) -> list[dict]:
    output = []
    for page in range(max_pages):
        rows = request_json(f"{GAMMA_API}/markets", {
            "active": "true",
            "closed": "false",
            "limit": 100,
            "offset": page * 100,
            "order": "volume24hr",
            "ascending": "false",
        })
        if not isinstance(rows, list) or not rows:
            break
        output.extend(rows)
        if len(rows) < 100:
            break
    return output


def token_candidates(markets: list[dict]) -> list[dict]:
    output = []
    for market in markets:
        if not (
            market.get("active")
            and not market.get("closed")
            and market.get("acceptingOrders")
            and market.get("enableOrderBook")
            and market.get("sportsMarketType") == "moneyline"
        ):
            continue
        token_ids = parse_array(market.get("clobTokenIds"))
        outcomes = parse_array(market.get("outcomes"))
        event = (market.get("events") or [{}])[0]
        for token_id, outcome in zip(token_ids, outcomes):
            output.append({
                "tokenId": str(token_id),
                "conditionId": market.get("conditionId"),
                "marketId": market.get("id"),
                "question": market.get("question"),
                "eventTitle": event.get("title") or market.get("question"),
                "outcome": outcome,
                "sportsMarketType": market.get("sportsMarketType"),
                "live": bool(event.get("live")),
                "gameStartTime": market.get("gameStartTime") or event.get("startTime"),
                "gammaLiquidityUsdc": finite(market.get("liquidityNum") or market.get("liquidity")),
                "gammaVolume24hrUsdc": finite(market.get("volume24hr") or 0),
                "gammaBestBid": finite(market.get("bestBid")),
                "gammaBestAsk": finite(market.get("bestAsk")),
            })
    return output


def book_batches(candidates: list[dict], batch_size: int = 50) -> tuple[list[dict], list[dict]]:
    books = []
    failures = []
    for index in range(0, len(candidates), batch_size):
        batch = candidates[index:index + batch_size]
        try:
            response = request_json(
                f"{CLOB_API}/books",
                payload=[{"token_id": row["tokenId"]} for row in batch],
            )
            if not isinstance(response, list):
                raise RuntimeError("CLOB books endpoint returned a non-array response")
            books.extend(response)
        except Exception as error:
            failures.append({
                "firstTokenId": batch[0]["tokenId"],
                "tokens": len(batch),
                "error": str(error),
            })
        print(f"Live books: {min(index + len(batch), len(candidates))}/{len(candidates)}")
    return books, failures


def walk_book(levels: list[tuple[float, float]], stake: float, maximum_price: float) -> dict:
    remaining = float(stake)
    shares = 0.0
    worst_price = None
    for price, available_shares in levels:
        if price > maximum_price + 1e-12:
            continue
        available_quote = price * available_shares
        take_quote = min(remaining, available_quote)
        if take_quote <= 0:
            continue
        shares += take_quote / price
        remaining -= take_quote
        worst_price = price
        if remaining <= 1e-8:
            break
    filled = remaining <= 1e-8
    return {
        "filled": filled,
        "filledFractionPct": (stake - remaining) / stake * 100,
        "vwap": stake / shares if filled and shares else None,
        "worstPrice": worst_price if filled else None,
    }


def summarize_live_books(rows: list[dict]) -> list[dict]:
    output = []
    segments = {
        "all": rows,
        "pregame": [row for row in rows if not row["live"]],
        "live": [row for row in rows if row["live"]],
    }
    for segment, segment_rows in segments.items():
        for buffer_cents in PRICE_BUFFERS_CENTS:
            for stake in STAKE_SIZES_USDC:
                evaluations = []
                for row in segment_rows:
                    result = row["stakeWalks"][str(buffer_cents)][str(stake)]
                    evaluations.append((row, result))
                filled = [(row, result) for row, result in evaluations if result["filled"]]
                output.append({
                    "segment": segment,
                    "bufferCents": buffer_cents,
                    "stakeUsdc": stake,
                    "tokenSides": len(evaluations),
                    "uniqueMarkets": len({row["conditionId"] for row, _ in evaluations}),
                    "fills": len(filled),
                    "fillRatePct": len(filled) / len(evaluations) * 100 if evaluations else None,
                    "medianVwapAdverseCents": finite(np.median([
                        (result["vwap"] - row["bestAsk"]) * 100
                        for row, result in filled
                    ])) if filled else None,
                    "p90VwapAdverseCents": finite(np.quantile([
                        (result["vwap"] - row["bestAsk"]) * 100
                        for row, result in filled
                    ], 0.90)) if filled else None,
                    "availableNotionalUsdc": quantiles([
                        row["depthByBufferCents"][str(buffer_cents)]["quoteNotionalUsdc"]
                        for row, _ in evaluations
                    ]),
                })
    return output


def collect_live_capacity(max_pages: int, max_books: int) -> dict:
    gamma_markets = gamma_sports_markets(max_pages)
    candidates = token_candidates(gamma_markets)
    candidates.sort(key=lambda row: row["gammaVolume24hrUsdc"] or 0, reverse=True)
    candidates = candidates[:max_books]
    books, failures = book_batches(candidates)
    candidate_by_token = {row["tokenId"]: row for row in candidates}
    rows = []
    for book in books:
        token_id = str(book.get("asset_id") or "")
        candidate = candidate_by_token.get(token_id)
        if not candidate:
            continue
        bids = sorted([
            (float(level["price"]), float(level["size"]))
            for level in book.get("bids", [])
            if float(level.get("size") or 0) > 0
        ], reverse=True)
        asks = sorted([
            (float(level["price"]), float(level["size"]))
            for level in book.get("asks", [])
            if float(level.get("size") or 0) > 0
        ])
        if not asks:
            continue
        best_ask = asks[0][0]
        if not 0.30 <= best_ask <= 0.85:
            continue
        best_bid = bids[0][0] if bids else None
        depth = {}
        walks = {}
        for buffer_cents in PRICE_BUFFERS_CENTS:
            maximum_price = min(0.90, best_ask + buffer_cents / 100)
            eligible_levels = [level for level in asks if level[0] <= maximum_price + 1e-12]
            depth[str(buffer_cents)] = {
                "maximumPrice": maximum_price,
                "shares": sum(size for _, size in eligible_levels),
                "quoteNotionalUsdc": sum(price * size for price, size in eligible_levels),
                "priceLevels": len(eligible_levels),
            }
            walks[str(buffer_cents)] = {
                str(stake): walk_book(asks, stake, maximum_price)
                for stake in STAKE_SIZES_USDC
            }
        rows.append({
            **candidate,
            "bookTimestampMs": int(book.get("timestamp") or 0),
            "tickSize": float(book.get("tick_size") or 0.01),
            "minimumOrderShares": float(book.get("min_order_size") or 0),
            "bestBid": best_bid,
            "bestAsk": best_ask,
            "spreadCents": (best_ask - best_bid) * 100 if best_bid is not None else None,
            "depthByBufferCents": depth,
            "stakeWalks": walks,
            "recordedAskLevels": [
                {"price": price, "shares": size}
                for price, size in asks
                if price <= min(0.90, best_ask + 0.10) + 1e-12
            ],
        })
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": {
            "markets": f"{GAMMA_API}/markets?active=true&closed=false",
            "books": f"{CLOB_API}/books",
        },
        "definition": "Point-in-time displayed ask depth for active moneyline token sides whose best ask was 0.30 through 0.85.",
        "parameters": {
            "gammaPages": max_pages,
            "requestedTokenBooks": max_books,
            "priceBuffersCents": list(PRICE_BUFFERS_CENTS),
            "stakeSizesUsdc": list(STAKE_SIZES_USDC),
            "maximumLimitPrice": 0.90,
        },
        "coverage": {
            "gammaMarketsScanned": len(gamma_markets),
            "moneylineTokenCandidates": len(token_candidates(gamma_markets)),
            "requestedTokenBooks": len(candidates),
            "returnedBooks": len(books),
            "eligibleTokenSides": len(rows),
            "eligibleUniqueMarkets": len({row["conditionId"] for row in rows}),
            "liveTokenSides": sum(row["live"] for row in rows),
            "failedBatches": len(failures),
        },
        "warnings": [
            "This is a point-in-time cross-section, not the historical depth behind target signals.",
            "The requested books are the highest-24-hour-volume moneyline token candidates found first, so this is a liquidity-favorable reference rather than an all-market average.",
            "Displayed orders can cancel before a follower arrives; calculated fills are capacity quotes, not fills.",
            "Token sides from the same binary market are not independent observations.",
            "A FOK order must be fully satisfiable at submission or the exchange rejects the whole order.",
        ],
        "failures": failures,
        "summary": summarize_live_books(rows),
        "books": rows,
    }


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--features", default="research/djdjdjekekek/edge_features.csv")
    parser.add_argument("--tape", default="research/djdjdjekekek/market_tape.json")
    parser.add_argument("--closing-output", default="research/djdjdjekekek/closing_lines.json")
    parser.add_argument("--liquidity-output", default="research/djdjdjekekek/liquidity_capacity.json")
    parser.add_argument("--concurrency", type=int, default=6)
    parser.add_argument("--max-gamma-pages", type=int, default=20)
    parser.add_argument("--max-token-books", type=int, default=400)
    args = parser.parse_args()

    features = pd.read_csv(args.features)
    tape = json.loads(Path(args.tape).read_text(encoding="utf-8"))
    target_wallet = str(tape["targetWallet"]).lower()
    closing = collect_closing_lines(features, target_wallet, args.concurrency)
    write_json(Path(args.closing_output), closing)
    print(f"Closing-line evidence -> {args.closing_output}")

    liquidity = collect_live_capacity(args.max_gamma_pages, args.max_token_books)
    write_json(Path(args.liquidity_output), liquidity)
    print(
        f"Live capacity: {liquidity['coverage']['eligibleTokenSides']} token sides "
        f"-> {args.liquidity_output}"
    )


if __name__ == "__main__":
    main()
