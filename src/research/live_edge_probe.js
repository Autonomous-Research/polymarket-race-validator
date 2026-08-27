'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const zlib = require('node:zlib');
const WebSocket = require('ws');

const { GAMMA_API, getJson } = require('./common');

const SPORTS_WS = 'wss://sports-api.polymarket.com/ws';
const MARKET_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const DEFAULT_CONFIG = {
    mode: 'PAPER_ONLY',
    bankrollUsdc: 10_000,
    maximumOrderUsdc: 100,
    maximumOrderBankrollPct: 0.5,
    maximumPortfolioBankrollPct: 5,
    maximumDisplayedDepthParticipationPct: 10,
    minimumOrderUsdc: 25,
    minimumProbabilityEdge: 0.05,
    feeRate: 0.03,
    decisionLatencyMs: 1_000,
    maximumFairValueAgeMs: 2_000,
    absoluteMaximumPrice: 0.90
};

function numeric(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function parseJsonArray(value) {
    if (Array.isArray(value)) return value;
    if (!value) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function normalizeSportsMessage(payload, receivedAtMs = Date.now()) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const state = payload.eventState && typeof payload.eventState === 'object'
        ? payload.eventState
        : {};
    const gameId = payload.gameId ?? payload.metadataGameId ?? state.gameId ?? null;
    if (gameId === null && !payload.slug) return null;
    return {
        type: 'sports_state',
        receivedAtMs,
        sourceTimestampMs: numeric(payload.timestamp ?? state.timestamp ?? payload.last_update),
        gameId: gameId === null ? null : String(gameId),
        metadataGameId: payload.metadataGameId ? String(payload.metadataGameId) : null,
        slug: payload.slug || null,
        league: payload.leagueAbbreviation || payload.league || null,
        homeTeam: payload.homeTeam || state.homeTeam || null,
        awayTeam: payload.awayTeam || state.awayTeam || null,
        status: payload.status || state.status || null,
        live: Boolean(payload.live ?? state.live ?? /progress|live/i.test(payload.status || '')),
        ended: Boolean(payload.ended ?? state.ended),
        score: payload.score ?? state.score ?? null,
        period: payload.period ?? state.period ?? null,
        elapsed: payload.elapsed ?? state.elapsed ?? null,
        lastUpdate: payload.last_update ?? state.last_update ?? null,
        rawShape: payload.eventState ? 'nested_event_state' : 'flat'
    };
}

function normalizeMarketMessages(payload, receivedAtMs = Date.now()) {
    const events = Array.isArray(payload) ? payload : [payload];
    return events.filter((event) => event && typeof event === 'object').map((event) => ({
        ...event,
        type: event.event_type || event.type,
        receivedAtMs,
        timestampMs: numeric(event.timestamp) ?? receivedAtMs
    }));
}

class BookStore {
    constructor() {
        this.books = new Map();
    }

    ensure(assetId) {
        const key = String(assetId);
        if (!this.books.has(key)) {
            this.books.set(key, { assetId: key, bids: new Map(), asks: new Map(), timestampMs: 0 });
        }
        return this.books.get(key);
    }

    replaceLevels(target, levels) {
        target.clear();
        for (const level of levels || []) {
            const price = numeric(level.price);
            const size = numeric(level.size);
            if (price !== null && size !== null && size > 0) target.set(price, size);
        }
    }

    apply(event) {
        if (event.type === 'book') {
            const assetId = event.asset_id || event.assetId;
            if (!assetId) return [];
            const book = this.ensure(assetId);
            this.replaceLevels(book.bids, event.bids);
            this.replaceLevels(book.asks, event.asks);
            book.timestampMs = numeric(event.timestampMs ?? event.timestamp) ?? Date.now();
            return [book];
        }
        if (event.type !== 'price_change') return [];
        const changed = [];
        for (const change of event.price_changes || event.changes || []) {
            const assetId = change.asset_id || change.assetId || event.asset_id;
            const price = numeric(change.price);
            const size = numeric(change.size);
            if (!assetId || price === null || size === null) continue;
            const book = this.ensure(assetId);
            const levels = String(change.side || '').toUpperCase() === 'BUY' ? book.bids : book.asks;
            if (size <= 0) levels.delete(price);
            else levels.set(price, size);
            book.timestampMs = numeric(event.timestampMs ?? event.timestamp) ?? Date.now();
            changed.push(book);
        }
        return changed;
    }

    get(assetId) {
        return this.books.get(String(assetId)) || null;
    }
}

function maximumRawPrice(fairProbability, minimumEdge, feeRate) {
    const target = fairProbability - minimumEdge;
    let low = 0.01;
    let high = Math.min(0.99, target);
    for (let index = 0; index < 60; index += 1) {
        const middle = (low + high) / 2;
        const allIn = middle + feeRate * middle * (1 - middle);
        if (allIn <= target) low = middle;
        else high = middle;
    }
    return low;
}

function walkAsks(book, notionalUsdc, maximumPrice) {
    const asks = [...book.asks.entries()]
        .map(([price, size]) => ({ price: Number(price), size: Number(size) }))
        .filter((level) => level.price <= maximumPrice + 1e-12 && level.size > 0)
        .sort((left, right) => left.price - right.price);
    let remaining = notionalUsdc;
    let shares = 0;
    let worstPrice = null;
    for (const level of asks) {
        if (remaining <= 1e-9) break;
        const available = level.price * level.size;
        const taken = Math.min(remaining, available);
        shares += taken / level.price;
        remaining -= taken;
        worstPrice = level.price;
    }
    const availableNotionalUsdc = asks.reduce(
        (total, level) => total + level.price * level.size, 0
    );
    return {
        filled: remaining <= 1e-9,
        fillFraction: notionalUsdc ? (notionalUsdc - remaining) / notionalUsdc : 0,
        shares,
        vwap: remaining <= 1e-9 && shares ? notionalUsdc / shares : null,
        worstPrice,
        eligibleAskLevels: asks.length,
        availableNotionalUsdc
    };
}

function paperQuote(book, fairProbability, config = DEFAULT_CONFIG, portfolioNotionalUsdc = 0) {
    if (!book || !book.asks.size) return { eligible: false, reason: 'NO_ASK_BOOK' };
    const fair = numeric(fairProbability);
    if (fair === null || fair <= 0 || fair >= 1) {
        return { eligible: false, reason: 'INVALID_FAIR_PROBABILITY' };
    }
    const maximumPrice = Math.min(
        config.absoluteMaximumPrice,
        maximumRawPrice(fair, config.minimumProbabilityEdge, config.feeRate)
    );
    const eligibleDepth = walkAsks(book, Number.MAX_SAFE_INTEGER, maximumPrice).availableNotionalUsdc;
    const riskCap = Math.min(
        config.maximumOrderUsdc,
        config.bankrollUsdc * config.maximumOrderBankrollPct / 100,
        Math.max(0, config.bankrollUsdc * config.maximumPortfolioBankrollPct / 100 - portfolioNotionalUsdc)
    );
    const depthCap = eligibleDepth * config.maximumDisplayedDepthParticipationPct / 100;
    const notionalUsdc = Math.floor(Math.min(riskCap, depthCap) * 100) / 100;
    if (notionalUsdc < config.minimumOrderUsdc) {
        return {
            eligible: false,
            reason: 'CAPACITY_BELOW_MINIMUM',
            maximumPrice,
            eligibleDepthUsdc: eligibleDepth,
            proposedNotionalUsdc: notionalUsdc
        };
    }
    const fill = walkAsks(book, notionalUsdc, maximumPrice);
    if (!fill.filled) return { eligible: false, reason: 'FOK_DEPTH_FAILURE', ...fill };
    const allInPrice = fill.vwap + config.feeRate * fill.vwap * (1 - fill.vwap);
    const edge = fair - allInPrice;
    if (edge < config.minimumProbabilityEdge - 1e-12) {
        return { eligible: false, reason: 'EDGE_BELOW_THRESHOLD_AFTER_VWAP', edge, ...fill };
    }
    return {
        eligible: true,
        executionMode: 'PAPER_FOK_DEPTH_WALK',
        fairProbability: fair,
        maximumPrice,
        notionalUsdc,
        allInPrice,
        probabilityEdge: edge,
        expectedRoiPct: (fair / allInPrice - 1) * 100,
        ...fill
    };
}

function scoreDeployedStateModel(modelAudit, state) {
    const deployment = modelAudit.deployment;
    const minute = Math.max(1, Number(state.gameMinute));
    const gold = Number(state.targetGoldAdvantage) / 1_000;
    const xp = Number(state.targetXpAdvantage) / 1_000;
    const scaleTime = Math.sqrt(minute / 30);
    const values = [
        gold,
        xp,
        gold * scaleTime,
        xp * scaleTime,
        gold ? Math.sign(gold) * Math.log1p(Math.abs(gold)) : 0,
        xp ? Math.sign(xp) * Math.log1p(Math.abs(xp)) : 0
    ];
    let logit = Number(deployment.intercept);
    for (let index = 0; index < values.length; index += 1) {
        const standardized = (values[index] - Number(deployment.featureMean[index]))
            / Number(deployment.featureScale[index]);
        logit += standardized * Number(deployment.coefficients[index]);
    }
    return 1 / (1 + Math.exp(-logit));
}

class PaperEngine {
    constructor(config = {}, stateModel = null) {
        this.config = { ...DEFAULT_CONFIG, ...config, mode: 'PAPER_ONLY' };
        this.stateModel = stateModel;
        this.books = new BookStore();
        this.pending = [];
        this.intents = [];
        this.settlements = new Map();
        this.usedExposureKeys = new Set();
    }

    fairEvent(event) {
        if (!event.assetId || !Number.isFinite(Number(event.probability))) return;
        this.pending.push({
            ...event,
            type: 'fair_probability',
            probability: Number(event.probability),
            timestampMs: Number(event.timestampMs),
            dueTimestampMs: Number(event.timestampMs) + this.config.decisionLatencyMs
        });
        this.pending.sort((left, right) => left.dueTimestampMs - right.dueTimestampMs);
    }

    dotaStateEvent(event) {
        if (!this.stateModel) return;
        const probability = scoreDeployedStateModel(this.stateModel, event);
        this.fairEvent({
            ...event,
            type: 'fair_probability',
            probability,
            source: event.source || 'dota_state_model'
        });
    }

    processDue(timestampMs) {
        const ready = this.pending.filter((event) => event.dueTimestampMs <= timestampMs);
        this.pending = this.pending.filter((event) => event.dueTimestampMs > timestampMs);
        for (const event of ready) {
            const exposureKey = event.exposureKey || event.gameId || event.assetId;
            if (this.usedExposureKeys.has(exposureKey)) continue;
            if (timestampMs - event.timestampMs > this.config.maximumFairValueAgeMs) continue;
            const book = this.books.get(event.assetId);
            const portfolio = this.intents.reduce((total, intent) => total + intent.notionalUsdc, 0);
            const quote = paperQuote(book, event.probability, this.config, portfolio);
            if (!quote.eligible) continue;
            const intent = {
                type: 'paper_intent',
                mode: 'PAPER_ONLY',
                assetId: String(event.assetId),
                gameId: event.gameId || null,
                exposureKey,
                source: event.source || 'external_fair_probability',
                fairTimestampMs: event.timestampMs,
                decisionDueTimestampMs: event.dueTimestampMs,
                executionTimestampMs: timestampMs,
                actualLatencyMs: timestampMs - event.timestampMs,
                ...quote
            };
            this.intents.push(intent);
            this.usedExposureKeys.add(exposureKey);
        }
    }

    handle(event) {
        const timestampMs = Number(event.timestampMs ?? event.receivedAtMs ?? Date.now());
        this.processDue(timestampMs);
        if (event.type === 'book' || event.type === 'price_change') this.books.apply(event);
        else if (event.type === 'fair_probability') this.fairEvent(event);
        else if (event.type === 'dota_state') this.dotaStateEvent(event);
        else if (event.type === 'settlement') {
            this.settlements.set(String(event.assetId), Boolean(event.won));
        }
    }

    summary() {
        const settled = this.intents.filter((intent) => this.settlements.has(intent.assetId));
        const returns = settled.map((intent) => {
            const won = this.settlements.get(intent.assetId);
            return won ? intent.notionalUsdc / intent.allInPrice - intent.notionalUsdc
                : -intent.notionalUsdc;
        });
        const stake = settled.reduce((total, intent) => total + intent.notionalUsdc, 0);
        const profit = returns.reduce((total, value) => total + value, 0);
        return {
            mode: 'PAPER_ONLY',
            intents: this.intents.length,
            settledIntents: settled.length,
            stakeUsdc: stake,
            profitUsdc: profit,
            roiPct: stake ? profit / stake * 100 : null,
            pendingFairValues: this.pending.length,
            paperIntents: this.intents
        };
    }
}

function marketAssets(markets) {
    const assets = [];
    for (const market of markets || []) {
        if (!market.acceptingOrders || !market.enableOrderBook
                || !['moneyline', 'child_moneyline'].includes(market.sportsMarketType)) continue;
        const event = (market.events || [])[0] || {};
        const tokenIds = parseJsonArray(market.clobTokenIds);
        const outcomes = parseJsonArray(market.outcomes);
        for (let index = 0; index < Math.min(tokenIds.length, outcomes.length); index += 1) {
            assets.push({
                assetId: String(tokenIds[index]),
                outcome: outcomes[index],
                conditionId: market.conditionId,
                question: market.question,
                gameId: String(market.gameId ?? event.gameId ?? event.metadataGameId ?? ''),
                eventSlug: event.slug || market.eventSlug || null,
                volume24hr: Number(market.volume24hr || 0)
            });
        }
    }
    return [...new Map(assets.map((asset) => [asset.assetId, asset])).values()]
        .sort((left, right) => right.volume24hr - left.volume24hr);
}

async function discoverActiveSportsMarkets(maxPages = 10, maximumAssets = 200) {
    const markets = [];
    for (let page = 0; page < maxPages; page += 1) {
        const rows = await getJson(`${GAMMA_API}/markets`, {
            active: true,
            closed: false,
            limit: 100,
            offset: page * 100,
            order: 'volume24hr',
            ascending: false
        });
        if (!Array.isArray(rows) || !rows.length) break;
        markets.push(...rows);
        if (rows.length < 100) break;
    }
    return marketAssets(markets).slice(0, maximumAssets);
}

async function discoverMarketsForGameId(gameId, fetchJson = getJson) {
    const rows = await fetchJson(`${GAMMA_API}/markets`, {
        game_id: String(gameId),
        active: true,
        closed: false,
        limit: 100
    });
    return marketAssets(Array.isArray(rows) ? rows : []);
}

function readNdjson(file) {
    const source = fs.readFileSync(file);
    const decoded = file.endsWith('.gz') ? zlib.gunzipSync(source) : source;
    return decoded.toString('utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
        try {
            return JSON.parse(line);
        } catch (error) {
            throw new Error(`Invalid NDJSON at line ${index + 1}: ${error.message}`);
        }
    });
}

function quantile(values, probability) {
    const sorted = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
    if (!sorted.length) return null;
    const position = (sorted.length - 1) * probability;
    const lower = Math.floor(position);
    const fraction = position - lower;
    return sorted[lower + 1] === undefined
        ? sorted[lower]
        : sorted[lower] + fraction * (sorted[lower + 1] - sorted[lower]);
}

function marketEventAssetIds(event) {
    const ids = [];
    if (event.asset_id || event.assetId) ids.push(String(event.asset_id || event.assetId));
    for (const change of event.price_changes || event.changes || []) {
        if (change.asset_id || change.assetId) ids.push(String(change.asset_id || change.assetId));
    }
    return [...new Set(ids)];
}

function bestBookQuote(book) {
    if (!book) return null;
    const bids = [...book.bids.keys()].map(Number).filter(Number.isFinite);
    const asks = [...book.asks.keys()].map(Number).filter(Number.isFinite);
    const bestBid = bids.length ? Math.max(...bids) : null;
    const bestAsk = asks.length ? Math.min(...asks) : null;
    const midpoint = bestBid !== null && bestAsk !== null && bestBid <= bestAsk
        ? (bestBid + bestAsk) / 2
        : null;
    return { bestBid, bestAsk, midpoint };
}

function parseCs2Score(score) {
    const match = String(score || '').match(
        /^(\d+)-(\d+)\|(\d+)-(\d+)\|Bo(\d+)$/i
    );
    if (!match) return null;
    return {
        homeRounds: Number(match[1]),
        awayRounds: Number(match[2]),
        homeMaps: Number(match[3]),
        awayMaps: Number(match[4]),
        bestOf: Number(match[5])
    };
}

function teamNameSimilarity(left, right) {
    const normalize = (value) => String(value || '')
        .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const a = normalize(left);
    const b = normalize(right);
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.startsWith(b) || b.startsWith(a)) {
        return Math.min(a.length, b.length) / Math.max(a.length, b.length);
    }
    const leftTokens = new Set(a.split(/\s+/));
    const rightTokens = new Set(b.split(/\s+/));
    const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;
    return overlap / Math.max(leftTokens.size, rightTokens.size);
}

function quoteAt(timeline, timestampMs) {
    let low = 0;
    let high = timeline.length - 1;
    let selected = null;
    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (timeline[middle].receivedAtMs <= timestampMs) {
            selected = timeline[middle];
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }
    if (!selected) return null;
    return {
        ...selected,
        requestedAtMs: timestampMs,
        quoteAgeMs: timestampMs - selected.receivedAtMs
    };
}

function rounded(value, digits = 6) {
    return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function mean(values) {
    return values.length
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : null;
}

function gameClusterBootstrap(transitions, measure, iterations = 20_000) {
    const grouped = new Map();
    for (const transition of transitions) {
        const value = measure(transition);
        if (!Number.isFinite(value)) continue;
        if (!grouped.has(transition.gameId)) grouped.set(transition.gameId, []);
        grouped.get(transition.gameId).push(value);
    }
    const clusters = [...grouped.values()];
    if (!clusters.length) return null;
    let state = 20260827;
    const random = () => {
        state = (1664525 * state + 1013904223) >>> 0;
        return state / 2 ** 32;
    };
    const estimates = [];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
        const sample = [];
        for (let index = 0; index < clusters.length; index += 1) {
            sample.push(...clusters[Math.floor(random() * clusters.length)]);
        }
        estimates.push(mean(sample));
    }
    const values = clusters.flat();
    return {
        estimateCents: rounded(mean(values), 3),
        gameClusters: clusters.length,
        observations: values.length,
        iterations,
        ci95LowCents: rounded(quantile(estimates, 0.025), 3),
        ci95HighCents: rounded(quantile(estimates, 0.975), 3),
        probabilityPositivePct: rounded(
            estimates.filter((value) => value > 0).length / estimates.length * 100, 1
        )
    };
}

function filterSportsReactionEvents(events, source = {}) {
    const cs2GameIds = new Set(events.filter((event) =>
        event.type === 'sports_state'
        && String(event.league || '').toLowerCase() === 'cs2'
        && event.gameId
    ).map((event) => String(event.gameId)));
    const assetIds = new Set();
    for (const event of events) {
        if (event.type !== 'sports_market_join' || !cs2GameIds.has(String(event.gameId))) {
            continue;
        }
        for (const row of event.marketMetadata || []) assetIds.add(String(row.assetId));
    }
    const selected = events.filter((event) => {
        if (['capture_start', 'capture_end'].includes(event.type)) return true;
        if (['sports_market_join', 'sports_market_join_miss', 'sports_market_join_error']
            .includes(event.type)) return cs2GameIds.has(String(event.gameId));
        if (event.type === 'sports_state') return cs2GameIds.has(String(event.gameId));
        if (event.type === 'market_subscription') {
            return (event.assetIds || []).some((assetId) => assetIds.has(String(assetId)));
        }
        if (['book', 'price_change', 'best_bid_ask', 'last_trade_price']
            .includes(event.type)) {
            return marketEventAssetIds(event).some((assetId) => assetIds.has(assetId));
        }
        return false;
    });
    return [{
        type: 'reaction_filter_manifest',
        generatedAt: new Date().toISOString(),
        source,
        originalEvents: events.length,
        selectedEvents: selected.length,
        cs2Games: cs2GameIds.size,
        cs2Assets: assetIds.size
    }, ...selected];
}

function analyzeSportsReactions(events) {
    const joinsByGame = new Map();
    const assetMetadata = new Map();
    for (const event of events) {
        if (event.type !== 'sports_market_join') continue;
        joinsByGame.set(String(event.gameId), event);
        for (const row of event.marketMetadata || []) {
            assetMetadata.set(String(row.assetId), { ...row, gameId: String(event.gameId) });
        }
    }

    const store = new BookStore();
    const quoteTimelines = new Map();
    const orderedMarketEvents = events.filter((event) =>
        ['book', 'price_change'].includes(event.type)
    ).sort((left, right) =>
        Number(left.receivedAtMs ?? left.timestampMs)
        - Number(right.receivedAtMs ?? right.timestampMs)
    );
    for (const event of orderedMarketEvents) {
        const receivedAtMs = numeric(event.receivedAtMs ?? event.timestampMs);
        if (receivedAtMs === null) continue;
        const changedBooks = store.apply(event);
        for (const assetId of new Set(changedBooks.map((book) => book.assetId))) {
            if (!assetMetadata.has(assetId)) continue;
            const quote = bestBookQuote(store.get(assetId));
            if (!quote || quote.midpoint === null) continue;
            if (!quoteTimelines.has(assetId)) quoteTimelines.set(assetId, []);
            const timeline = quoteTimelines.get(assetId);
            const previous = timeline.at(-1);
            if (previous && previous.bestBid === quote.bestBid
                    && previous.bestAsk === quote.bestAsk) continue;
            timeline.push({
                receivedAtMs,
                serverTimestampMs: numeric(event.timestampMs ?? event.timestamp),
                bestBid: quote.bestBid,
                bestAsk: quote.bestAsk,
                midpoint: quote.midpoint
            });
        }
    }

    const statesByGame = new Map();
    for (const event of events) {
        if (event.type !== 'sports_state'
                || String(event.league || '').toLowerCase() !== 'cs2') continue;
        const gameId = String(event.gameId || '');
        if (!joinsByGame.has(gameId) || !parseCs2Score(event.score)) continue;
        if (!statesByGame.has(gameId)) statesByGame.set(gameId, []);
        const states = statesByGame.get(gameId);
        if (states.at(-1)?.receivedAtMs === event.receivedAtMs
                && states.at(-1)?.score === event.score) continue;
        states.push(event);
    }

    const offsetsSeconds = [-10, -5, -1, 0, 0.1, 0.5, 1, 5];
    const transitions = [];
    for (const [gameId, states] of statesByGame.entries()) {
        const join = joinsByGame.get(gameId);
        for (let index = 1; index < states.length; index += 1) {
            const previous = states[index - 1];
            const current = states[index];
            const before = parseCs2Score(previous.score);
            const after = parseCs2Score(current.score);
            if (!before || !after
                    || current.receivedAtMs - previous.receivedAtMs > 30_000
                    || before.homeMaps !== after.homeMaps
                    || before.awayMaps !== after.awayMaps
                    || before.bestOf !== after.bestOf) continue;
            const homeDelta = after.homeRounds - before.homeRounds;
            const awayDelta = after.awayRounds - before.awayRounds;
            if (!((homeDelta === 1 && awayDelta === 0)
                    || (homeDelta === 0 && awayDelta === 1))) continue;
            const beneficiarySide = homeDelta === 1 ? 'home' : 'away';
            const beneficiaryTeam = beneficiarySide === 'home'
                ? current.homeTeam : current.awayTeam;
            const candidates = (join.marketMetadata || []).map((row) => ({
                ...row,
                matchScore: teamNameSimilarity(beneficiaryTeam, row.outcome)
            })).sort((left, right) => right.matchScore - left.matchScore);
            const target = candidates[0];
            if (!target || target.matchScore < 0.5) continue;
            const timeline = quoteTimelines.get(String(target.assetId)) || [];
            const baseline = quoteAt(timeline, previous.receivedAtMs);
            const observations = offsetsSeconds.map((offsetSeconds) => {
                const quote = quoteAt(
                    timeline, current.receivedAtMs + offsetSeconds * 1_000
                );
                return {
                    offsetSeconds,
                    bestBid: quote?.bestBid ?? null,
                    bestAsk: quote?.bestAsk ?? null,
                    midpoint: quote?.midpoint ?? null,
                    quoteAgeMs: quote?.quoteAgeMs ?? null,
                    moveFromPreviousStateCents: baseline && quote
                        ? rounded((quote.midpoint - baseline.midpoint) * 100, 3) : null
                };
            });
            const firstBeneficialMove = baseline ? timeline.find((quote) =>
                quote.receivedAtMs > previous.receivedAtMs
                && quote.receivedAtMs <= current.receivedAtMs + 5_000
                && quote.midpoint - baseline.midpoint >= 0.005 - 1e-12
            ) : null;
            let finalBeneficialRegimeStart = null;
            if (baseline) {
                let aboveThreshold = false;
                for (const quote of timeline) {
                    if (quote.receivedAtMs <= previous.receivedAtMs) continue;
                    if (quote.receivedAtMs > current.receivedAtMs) break;
                    const nowAbove = quote.midpoint - baseline.midpoint >= 0.005 - 1e-12;
                    if (nowAbove && !aboveThreshold) {
                        finalBeneficialRegimeStart = quote.receivedAtMs;
                    } else if (!nowAbove) {
                        finalBeneficialRegimeStart = null;
                    }
                    aboveThreshold = nowAbove;
                }
                if (!aboveThreshold) finalBeneficialRegimeStart = null;
            }
            transitions.push({
                gameId,
                question: target.question,
                volume24hr: target.volume24hr,
                homeTeam: current.homeTeam,
                awayTeam: current.awayTeam,
                priorScore: previous.score,
                score: current.score,
                beneficiarySide,
                beneficiaryTeam,
                targetOutcome: target.outcome,
                targetAssetId: String(target.assetId),
                outcomeNameMatchScore: rounded(target.matchScore, 4),
                previousSportsReceivedAtMs: previous.receivedAtMs,
                sportsReceivedAtMs: current.receivedAtMs,
                sportsObservationIntervalMs: current.receivedAtMs - previous.receivedAtMs,
                baselineAtPreviousState: baseline,
                observations,
                firstHalfCentBeneficialMoveAtMs: firstBeneficialMove?.receivedAtMs ?? null,
                firstHalfCentBeneficialMoveRelativeToFeedMs: firstBeneficialMove
                    ? firstBeneficialMove.receivedAtMs - current.receivedAtMs : null,
                finalHalfCentBeneficialRegimeStartedAtMs: finalBeneficialRegimeStart,
                finalHalfCentBeneficialRegimeStartedRelativeToFeedMs:
                    finalBeneficialRegimeStart === null
                        ? null : finalBeneficialRegimeStart - current.receivedAtMs
            });
        }
    }

    const aggregateOffsets = offsetsSeconds.map((offsetSeconds) => {
        const values = transitions.map((transition) => transition.observations.find(
            (row) => row.offsetSeconds === offsetSeconds
        )?.moveFromPreviousStateCents).filter(Number.isFinite);
        return {
            offsetSeconds,
            observations: values.length,
            meanMoveFromPreviousStateCents: rounded(
                values.reduce((sum, value) => sum + value, 0) / values.length, 3
            ),
            medianMoveFromPreviousStateCents: rounded(quantile(values, 0.5), 3),
            positiveMovePct: values.length
                ? rounded(values.filter((value) => value > 0).length / values.length * 100, 1)
                : null
        };
    });
    const beforeFeed = aggregateOffsets.find((row) => row.offsetSeconds === -1);
    const afterOneSecond = aggregateOffsets.find((row) => row.offsetSeconds === 1);
    const firstMoves = transitions.map((row) =>
        row.firstHalfCentBeneficialMoveRelativeToFeedMs
    ).filter(Number.isFinite);
    const finalRegimeStarts = transitions.map((row) =>
        row.finalHalfCentBeneficialRegimeStartedRelativeToFeedMs
    ).filter(Number.isFinite);
    const updateIntervals = transitions.map((row) => row.sportsObservationIntervalMs);
    const observationMove = (row, offsetSeconds) => row.observations.find(
        (observation) => observation.offsetSeconds === offsetSeconds
    )?.moveFromPreviousStateCents;
    const atFeedMoves = transitions.map((row) => observationMove(row, 0)).filter(Number.isFinite);
    const postFeedIncrements = transitions.map((row) => {
        const atFeed = observationMove(row, 0);
        const plusOne = observationMove(row, 1);
        return Number.isFinite(atFeed) && Number.isFinite(plusOne) ? plusOne - atFeed : null;
    }).filter(Number.isFinite);
    const clusterBootstrap = {
        moveAtMinusOneSecond: gameClusterBootstrap(
            transitions, (row) => observationMove(row, -1)
        ),
        moveAtPublicUpdate: gameClusterBootstrap(
            transitions, (row) => observationMove(row, 0)
        ),
        incrementalMoveFromFeedToPlusOneSecond: gameClusterBootstrap(
            transitions, (row) => {
                const atFeed = observationMove(row, 0);
                const plusOne = observationMove(row, 1);
                return Number.isFinite(atFeed) && Number.isFinite(plusOne)
                    ? plusOne - atFeed : null;
            }
        )
    };
    return {
        generatedAt: new Date().toISOString(),
        status: transitions.length ? 'observational_event_study' : 'insufficient_events',
        method: {
            clock: 'Local websocket receive time for both sports and CLOB messages.',
            baseline: 'Beneficiary outcome midpoint at the preceding distinct public sports state.',
            transitionFilter: 'CS2 updates where exactly one side gained one round and map-series score was unchanged.',
            timingLimitation: 'The round occurred somewhere between public sports observations; the feed supplies no authoritative round timestamp.'
        },
        coverage: {
            joinedCs2Games: statesByGame.size,
            directionalRoundTransitions: transitions.length,
            transitionsWithBaselineAndOneSecondQuote: transitions.filter((row) =>
                row.baselineAtPreviousState && row.observations.some((observation) =>
                    observation.offsetSeconds === 1 && observation.midpoint !== null
                )).length,
            targetAssetsWithQuotes: new Set(transitions.filter((row) =>
                row.baselineAtPreviousState).map((row) => row.targetAssetId)).size
        },
        publicSportsCadenceMs: {
            medianDistinctStateInterval: rounded(quantile(updateIntervals, 0.5), 1),
            minimumDistinctStateInterval: rounded(quantile(updateIntervals, 0), 1),
            maximumDistinctStateInterval: rounded(quantile(updateIntervals, 1), 1)
        },
        eventAlignedMidpoint: aggregateOffsets,
        firstHalfCentBeneficialMove: {
            observed: firstMoves.length,
            beforePublicUpdate: firstMoves.filter((value) => value < 0).length,
            atOrAfterPublicUpdate: firstMoves.filter((value) => value >= 0).length,
            medianRelativeToPublicUpdateMs: rounded(quantile(firstMoves, 0.5), 1)
        },
        finalHalfCentBeneficialRegime: {
            observedAtPublicUpdate: finalRegimeStarts.length,
            startedBeforePublicUpdate: finalRegimeStarts.filter((value) => value < 0).length,
            medianStartRelativeToPublicUpdateMs: rounded(quantile(finalRegimeStarts, 0.5), 1),
            individualStartRelativeToPublicUpdateMs: finalRegimeStarts
        },
        gameClusterBootstrap: clusterBootstrap,
        headline: {
            meanMoveAlreadyPresentOneSecondBeforeFeedCents:
                beforeFeed?.meanMoveFromPreviousStateCents ?? null,
            meanMoveOneSecondAfterFeedCents:
                afterOneSecond?.meanMoveFromPreviousStateCents ?? null,
            incrementalMeanMoveFromMinusOneToPlusOneCents:
                beforeFeed && afterOneSecond
                    ? rounded(afterOneSecond.meanMoveFromPreviousStateCents
                        - beforeFeed.meanMoveFromPreviousStateCents, 3)
                    : null,
            beneficialAtMinusOneSecond: transitions.filter((row) => {
                const value = row.observations.find((observation) =>
                    observation.offsetSeconds === -1
                )?.moveFromPreviousStateCents;
                return Number.isFinite(value) && value >= 0.5 - 1e-12;
            }).length,
            beneficialAtPublicUpdate: atFeedMoves.filter((value) =>
                value >= 0.5 - 1e-12).length,
            analyzableTransitions: atFeedMoves.length,
            incrementalMeanMoveFromFeedToPlusOneCents:
                rounded(mean(postFeedIncrements), 3)
        },
        transitions,
        interpretation: (
            'This audit measures whether series-winner quotes had repriced before a public CS2 '
            + 'score update reached the same process. Pre-update movement demonstrates that this '
            + 'public feed can be stale relative to the market; it does not identify who moved the '
            + 'market or prove that the target wallet owns a private feed.'
        )
    };
}

function summarizeCapture(events) {
    const counts = {};
    for (const event of events) counts[event.type] = (counts[event.type] || 0) + 1;
    const start = events.find((event) => event.type === 'capture_start') || {};
    const end = events.findLast((event) => event.type === 'capture_end') || {};
    const joins = events.filter((event) => event.type === 'sports_market_join');
    const misses = events.filter((event) => event.type === 'sports_market_join_miss');
    const errors = events.filter((event) => event.type === 'sports_market_join_error');
    const dynamicAssets = new Set(joins.flatMap((event) => event.newAssetIds || []));
    const firstMarketObservation = new Map();
    for (const event of events) {
        if (!['book', 'price_change', 'best_bid_ask', 'last_trade_price'].includes(event.type)) continue;
        const timestampMs = numeric(event.receivedAtMs ?? event.timestampMs);
        if (timestampMs === null) continue;
        for (const assetId of marketEventAssetIds(event)) {
            if (!firstMarketObservation.has(assetId)
                    || timestampMs < firstMarketObservation.get(assetId)) {
                firstMarketObservation.set(assetId, timestampMs);
            }
        }
    }
    const games = joins.map((join) => {
        const observedAt = (join.newAssetIds || []).map((assetId) =>
            firstMarketObservation.get(String(assetId))).filter(Number.isFinite);
        const firstBookAtMs = observedAt.length ? Math.min(...observedAt) : null;
        return {
            gameId: join.gameId,
            questions: [...new Set((join.marketMetadata || []).map((row) => row.question).filter(Boolean))],
            queryLatencyMs: join.queryLatencyMs,
            discoveredAssets: join.discoveredAssets,
            newAssets: (join.newAssetIds || []).length,
            observedNewAssets: (join.newAssetIds || []).filter((assetId) =>
                firstMarketObservation.has(String(assetId))).length,
            joinToFirstBookMs: firstBookAtMs === null ? null : firstBookAtMs - join.completedAtMs,
            sportsToFirstBookMs: firstBookAtMs === null ? null : firstBookAtMs - join.sportsReceivedAtMs
        };
    });
    const queryLatencies = games.map((row) => row.queryLatencyMs);
    const sportsToBook = games.map((row) => row.sportsToFirstBookMs);
    const observedDynamicAssets = [...dynamicAssets].filter((assetId) =>
        firstMarketObservation.has(assetId)).length;
    return {
        generatedAt: end.timestampMs ? new Date(end.timestampMs).toISOString() : null,
        mode: 'PAPER_ONLY',
        capture: {
            startedAt: start.timestampMs ? new Date(start.timestampMs).toISOString() : null,
            endedAt: end.timestampMs ? new Date(end.timestampMs).toISOString() : null,
            durationMs: start.timestampMs && end.timestampMs ? end.timestampMs - start.timestampMs : null,
            lines: events.length,
            initialAssets: start.assets ?? null,
            eventCounts: counts
        },
        dynamicGameJoin: {
            gameIdsQueried: joins.length + misses.length + errors.length,
            hits: joins.length,
            misses: misses.length,
            errors: errors.length,
            dynamicAssets: dynamicAssets.size,
            dynamicAssetsObserved: observedDynamicAssets,
            observationCoveragePct: dynamicAssets.size
                ? observedDynamicAssets / dynamicAssets.size * 100 : null,
            queryLatencyMs: {
                minimum: quantile(queryLatencies, 0),
                median: quantile(queryLatencies, 0.5),
                p95: quantile(queryLatencies, 0.95),
                maximum: quantile(queryLatencies, 1)
            },
            sportsToFirstBookMs: {
                minimum: quantile(sportsToBook, 0),
                median: quantile(sportsToBook, 0.5),
                p95: quantile(sportsToBook, 0.95),
                maximum: quantile(sportsToBook, 1)
            },
            games
        },
        interpretation: (
            'The capture verifies a public gameId-to-market-to-book path with measured sub-second '
            + 'local observation. It does not establish fair value, profitable entry, or parity with '
            + 'the target wallet\'s upstream data and execution.'
        )
    };
}

function replay(events, config = {}, stateModel = null) {
    const engine = new PaperEngine(config, stateModel);
    const ordered = events.slice().sort((left, right) =>
        Number(left.timestampMs ?? left.receivedAtMs) - Number(right.timestampMs ?? right.receivedAtMs));
    for (const event of ordered) engine.handle(event);
    if (engine.pending.length) {
        engine.processDue(Math.max(...engine.pending.map((event) => event.dueTimestampMs)));
    }
    return engine.summary();
}

async function capture({ durationSeconds, output, maximumAssets }) {
    const assets = await discoverActiveSportsMarkets(10, maximumAssets);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const stream = fs.createWriteStream(output, { flags: 'a' });
    const write = (event) => stream.write(`${JSON.stringify(event)}\n`);
    write({
        type: 'capture_start',
        timestampMs: Date.now(),
        mode: 'PAPER_ONLY',
        assets: assets.length,
        marketMetadata: assets
    });

    const knownAssets = new Map(assets.map((asset) => [asset.assetId, asset]));
    const subscribedAssetIds = new Set();
    const queriedGameIds = new Set();
    const pendingJoins = new Set();
    const joinStats = { hits: 0, misses: 0, errors: 0, discoveredAssets: 0 };
    let market = null;
    let initialSubscriptionSent = false;
    let stopping = false;

    const subscribeKnownAssets = (initial = false) => {
        if (!market || market.readyState !== WebSocket.OPEN) return [];
        const assetIds = [...knownAssets.keys()].filter((assetId) => !subscribedAssetIds.has(assetId));
        if (!assetIds.length) return [];
        market.send(JSON.stringify(initial ? {
            assets_ids: assetIds,
            type: 'market',
            initial_dump: true,
            level: 2,
            custom_feature_enabled: true
        } : {
            operation: 'subscribe',
            assets_ids: assetIds
        }));
        for (const assetId of assetIds) subscribedAssetIds.add(assetId);
        write({
            type: 'market_subscription',
            timestampMs: Date.now(),
            operation: initial ? 'initial' : 'subscribe',
            assetIds
        });
        return assetIds;
    };

    const joinSportsGame = (gameId, sportsReceivedAtMs) => {
        if (!gameId || stopping || queriedGameIds.has(gameId)) return;
        queriedGameIds.add(gameId);
        const queryStartedAtMs = Date.now();
        let task;
        task = discoverMarketsForGameId(gameId).then((discovered) => {
            const completedAtMs = Date.now();
            const newAssetIds = [];
            for (const asset of discovered) {
                if (!knownAssets.has(asset.assetId)) newAssetIds.push(asset.assetId);
                knownAssets.set(asset.assetId, asset);
            }
            const subscriptionAssetIds = initialSubscriptionSent
                ? subscribeKnownAssets(false)
                : [];
            joinStats.discoveredAssets += newAssetIds.length;
            if (discovered.length) joinStats.hits += 1;
            else joinStats.misses += 1;
            write({
                type: discovered.length ? 'sports_market_join' : 'sports_market_join_miss',
                gameId,
                sportsReceivedAtMs,
                queryStartedAtMs,
                completedAtMs,
                queryLatencyMs: completedAtMs - queryStartedAtMs,
                discoveredAssets: discovered.length,
                newAssetIds,
                subscriptionAssetIds,
                marketMetadata: discovered
            });
        }).catch((error) => {
            joinStats.errors += 1;
            write({
                type: 'sports_market_join_error',
                gameId,
                sportsReceivedAtMs,
                queryStartedAtMs,
                completedAtMs: Date.now(),
                message: error.message
            });
        }).finally(() => pendingJoins.delete(task));
        pendingJoins.add(task);
    };

    const sports = new WebSocket(SPORTS_WS);
    sports.on('message', (buffer) => {
        const text = buffer.toString();
        if (text.toLowerCase() === 'ping') {
            sports.send('pong');
            return;
        }
        try {
            const payload = JSON.parse(text);
            const messages = Array.isArray(payload) ? payload : [payload];
            for (const message of messages) {
                const normalized = normalizeSportsMessage(message);
                if (!normalized) continue;
                write(normalized);
                joinSportsGame(normalized.gameId, normalized.receivedAtMs);
            }
        } catch {
            write({ type: 'sports_unparsed', receivedAtMs: Date.now(), text: text.slice(0, 500) });
        }
    });

    market = new WebSocket(MARKET_WS);
    let pingTimer = null;
    market.on('open', () => {
        subscribeKnownAssets(true);
        initialSubscriptionSent = true;
        pingTimer = setInterval(() => {
            if (market.readyState === WebSocket.OPEN) market.send('PING');
        }, 10_000);
    });
    market.on('message', (buffer) => {
        const text = buffer.toString();
        if (text === 'PONG') return;
        try {
            const payload = JSON.parse(text);
            for (const event of normalizeMarketMessages(payload)) write(event);
        } catch {
            write({ type: 'market_unparsed', receivedAtMs: Date.now(), text: text.slice(0, 500) });
        }
    });

    await new Promise((resolve) => setTimeout(resolve, durationSeconds * 1_000));
    stopping = true;
    if (pingTimer) clearInterval(pingTimer);
    sports.close();
    market.close();
    await Promise.allSettled([...pendingJoins]);
    write({ type: 'capture_end', timestampMs: Date.now(), mode: 'PAPER_ONLY' });
    await new Promise((resolve) => stream.end(resolve));
    return {
        mode: 'PAPER_ONLY',
        output,
        initialAssets: assets.length,
        finalAssets: knownAssets.size,
        queriedGameIds: queriedGameIds.size,
        subscribedAssets: subscribedAssetIds.size,
        joins: joinStats,
        durationSeconds
    };
}

function parseArgs(argv) {
    const options = {
        command: argv[0] || 'capture',
        durationSeconds: 60,
        output: 'research/djdjdjekekek/prospective/live_edge_probe.ndjson',
        maximumAssets: 200,
        replayFile: null,
        summaryOutput: null
    };
    for (let index = 1; index < argv.length; index += 1) {
        const value = argv[index + 1];
        if (argv[index] === '--duration') options.durationSeconds = Number(value), index += 1;
        else if (argv[index] === '--output') options.output = value, index += 1;
        else if (argv[index] === '--assets') options.maximumAssets = Number(value), index += 1;
        else if (argv[index] === '--input') options.replayFile = value, index += 1;
        else if (argv[index] === '--summary') options.summaryOutput = value, index += 1;
    }
    return options;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.command === 'filter-sports-reaction') {
        if (!options.replayFile) {
            throw new Error('filter-sports-reaction requires --input <ndjson-or-gzip>');
        }
        const source = fs.readFileSync(options.replayFile);
        const filtered = filterSportsReactionEvents(readNdjson(options.replayFile), {
            file: options.replayFile,
            bytes: source.length,
            sha256: crypto.createHash('sha256').update(source).digest('hex')
        });
        const encoded = Buffer.from(`${filtered.map((event) => JSON.stringify(event)).join('\n')}\n`);
        const output = options.output.endsWith('.gz') ? zlib.gzipSync(encoded, { level: 9 }) : encoded;
        fs.mkdirSync(path.dirname(options.output), { recursive: true });
        fs.writeFileSync(options.output, output);
        console.log(JSON.stringify(filtered[0], null, 2));
        return;
    }
    if (options.command === 'sports-reaction') {
        if (!options.replayFile) {
            throw new Error('sports-reaction requires --input <ndjson-or-gzip>');
        }
        const source = fs.readFileSync(options.replayFile);
        const summary = analyzeSportsReactions(readNdjson(options.replayFile));
        summary.source = {
            file: options.replayFile,
            bytes: source.length,
            sha256: crypto.createHash('sha256').update(source).digest('hex')
        };
        if (options.summaryOutput) {
            fs.mkdirSync(path.dirname(options.summaryOutput), { recursive: true });
            fs.writeFileSync(options.summaryOutput, `${JSON.stringify(summary, null, 2)}\n`);
        }
        console.log(JSON.stringify(summary, null, 2));
        return;
    }
    if (options.command === 'summarize') {
        if (!options.replayFile) throw new Error('summarize requires --input <ndjson-or-gzip>');
        const source = fs.readFileSync(options.replayFile);
        const summary = summarizeCapture(readNdjson(options.replayFile));
        summary.source = {
            file: options.replayFile,
            bytes: source.length,
            sha256: crypto.createHash('sha256').update(source).digest('hex')
        };
        if (options.summaryOutput) {
            fs.mkdirSync(path.dirname(options.summaryOutput), { recursive: true });
            fs.writeFileSync(options.summaryOutput, `${JSON.stringify(summary, null, 2)}\n`);
        }
        console.log(JSON.stringify(summary, null, 2));
        return;
    }
    if (options.command === 'replay') {
        if (!options.replayFile) throw new Error('replay requires --input <ndjson>');
        const stateAnalysis = JSON.parse(fs.readFileSync(
            'research/djdjdjekekek/esports_state_analysis.json', 'utf8'
        ));
        const summary = replay(
            readNdjson(options.replayFile), {}, stateAnalysis.independentStateModel
        );
        if (options.summaryOutput) {
            fs.mkdirSync(path.dirname(options.summaryOutput), { recursive: true });
            fs.writeFileSync(options.summaryOutput, `${JSON.stringify(summary, null, 2)}\n`);
        }
        console.log(JSON.stringify(summary, null, 2));
        return;
    }
    const result = await capture(options);
    console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
}

module.exports = {
    analyzeSportsReactions,
    bestBookQuote,
    BookStore,
    DEFAULT_CONFIG,
    PaperEngine,
    discoverActiveSportsMarkets,
    discoverMarketsForGameId,
    filterSportsReactionEvents,
    marketAssets,
    maximumRawPrice,
    normalizeMarketMessages,
    normalizeSportsMessage,
    paperQuote,
    replay,
    scoreDeployedStateModel,
    summarizeCapture,
    walkAsks
};
