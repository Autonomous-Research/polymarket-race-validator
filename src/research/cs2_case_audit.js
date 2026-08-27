'use strict';

const fs = require('fs');
const path = require('path');
const { buildMarketRecords } = require('./analyze');
const { collectTapeWindow } = require('./tape');
const { iso, pct, sum, writeJson } = require('./common');

const ROOT = path.resolve(__dirname, '../..');
const RESEARCH_DIR = path.join(ROOT, 'research/djdjdjekekek');
const PROSPECTIVE_DIR = path.join(RESEARCH_DIR, 'prospective');
const OUTPUT = path.join(PROSPECTIVE_DIR, 'cs2_case_audit.json');
const M80_CONDITION = '0xcd278aec06fc0ff8630e422241930ac55998964502921570f46f2a04b6b5b91b';
const G2_M80_CONDITION = '0x9e6290492aa30bc84767b40642e558812da877359a0ef6e251f79308f38ceca1';
const NEMESIS_CONDITION = '0x5f9c6ccf1d7be2e6e0904cde22a0d886c4a7aae94c676123f8fadb95b0138ed0';
const TARGET = '0x6d20c35f65d9899b6d6b74f8466e824580f9a165';
const PASSIVE_RULE = Object.freeze({
    maximumClusterGapSeconds: 5,
    maximumClusterDurationSeconds: 5,
    minimumMakerBuyQuoteUsdc: 25_000,
    minimumMakerFills: 18,
    minimumUniqueTakerCounterparties: 18
});

function readJson(file) {
    return JSON.parse(fs.readFileSync(path.join(RESEARCH_DIR, file), 'utf8'));
}

function unique(items, keyFn) {
    const rows = new Map();
    for (const item of items) rows.set(keyFn(item), item);
    return [...rows.values()];
}

function mergeEvidence() {
    const baseSnapshot = readJson('snapshot.json');
    const freshSnapshot = readJson('prospective/snapshot.json');
    const baseEnrichment = readJson('enrichment.json');
    const freshEnrichment = readJson('prospective/enrichment.json');
    const snapshot = {
        ...freshSnapshot,
        trades: unique(
            [...baseSnapshot.trades, ...freshSnapshot.trades],
            (row) => `${row.transactionHash}|${row.asset}|${row.side}`
        ),
        activity: unique(
            [...baseSnapshot.activity, ...freshSnapshot.activity],
            (row) => `${row.transactionHash}|${row.type}|${row.asset || ''}`
        ),
        closedPositions: freshSnapshot.closedPositions,
        positions: freshSnapshot.positions
    };
    const enrichment = {
        marketMetadata: unique(
            [...baseEnrichment.marketMetadata, ...freshEnrichment.marketMetadata],
            (row) => row.conditionId
        ),
        takerTrades: unique(
            [...baseEnrichment.takerTrades, ...freshEnrichment.takerTrades],
            (row) => row.transactionHash
        ),
        makerRebates: unique(
            [...baseEnrichment.makerRebates, ...freshEnrichment.makerRebates],
            (row) => `${row.condition_id}|${row.date || ''}|${row.rebated_fees_usdc}`
        )
    };
    return { snapshot, enrichment };
}

function clusterMakerBuys(market, maximumGapSeconds = PASSIVE_RULE.maximumClusterGapSeconds) {
    const byOutcome = new Map();
    for (const trade of market._trades) {
        if (trade.liquidityRole !== 'MAKER' || trade.side !== 'BUY') continue;
        if (!byOutcome.has(trade.outcome)) byOutcome.set(trade.outcome, []);
        byOutcome.get(trade.outcome).push(trade);
    }
    const clusters = [];
    for (const [outcome, fills] of byOutcome) {
        fills.sort((a, b) => a.timestamp - b.timestamp || a.transactionHash.localeCompare(b.transactionHash));
        let current = [];
        function close() {
            if (!current.length) return;
            clusters.push({
                conditionId: market.conditionId,
                eventKey: market.eventKey,
                title: market.title,
                discipline: market.discipline,
                marketType: market.marketType,
                outcome,
                resolvedWinner: market.resolvedWinner,
                startTimestamp: current[0].timestamp,
                endTimestamp: current.at(-1).timestamp,
                durationSeconds: current.at(-1).timestamp - current[0].timestamp,
                fills: current,
                makerFills: current.length,
                makerBuyQuoteUsdc: sum(current, (row) => row.quoteNotional),
                makerBuyShares: sum(current, (row) => row.size),
                makerVwap: sum(current, (row) => row.quoteNotional) / sum(current, (row) => row.size),
                won: market.resolvedWinner ? outcome === market.resolvedWinner : null
            });
            current = [];
        }
        for (const fill of fills) {
            if (current.length && fill.timestamp - current.at(-1).timestamp > maximumGapSeconds) close();
            current.push(fill);
        }
        close();
    }
    return clusters.sort((a, b) => a.startTimestamp - b.startTimestamp);
}

function localPassiveCandidates(markets) {
    return markets.flatMap((market) => clusterMakerBuys(market)).filter((cluster) =>
        cluster.durationSeconds <= PASSIVE_RULE.maximumClusterDurationSeconds
        && cluster.makerBuyQuoteUsdc >= PASSIVE_RULE.minimumMakerBuyQuoteUsdc
        && cluster.makerFills >= PASSIVE_RULE.minimumMakerFills
    );
}

function equivalentOutcomePrice(row, targetOutcome) {
    return row.outcome === targetOutcome ? Number(row.price) : 1 - Number(row.price);
}

function publicTapeBySecond(rows, targetOutcome) {
    const seconds = new Map();
    for (const row of rows) {
        const timestamp = Number(row.timestamp);
        const price = equivalentOutcomePrice(row, targetOutcome);
        const quote = Number(row.price) * Number(row.size);
        const current = seconds.get(timestamp) || {
            timestamp,
            time: iso(timestamp),
            prints: 0,
            quoteNotionalUsdc: 0,
            equivalentPriceLow: price,
            equivalentPriceHigh: price,
            weightedPriceNumerator: 0,
            weightedPriceDenominator: 0
        };
        current.prints += 1;
        current.quoteNotionalUsdc += quote;
        current.equivalentPriceLow = Math.min(current.equivalentPriceLow, price);
        current.equivalentPriceHigh = Math.max(current.equivalentPriceHigh, price);
        current.weightedPriceNumerator += price * Number(row.size);
        current.weightedPriceDenominator += Number(row.size);
        seconds.set(timestamp, current);
    }
    return [...seconds.values()].sort((a, b) => a.timestamp - b.timestamp).map((row) => ({
        timestamp: row.timestamp,
        time: row.time,
        prints: row.prints,
        quoteNotionalUsdc: row.quoteNotionalUsdc,
        equivalentPriceLow: row.equivalentPriceLow,
        equivalentPriceHigh: row.equivalentPriceHigh,
        equivalentPriceVwap: row.weightedPriceNumerator / row.weightedPriceDenominator
    }));
}

function exactCounterparties(cluster, tapeRows) {
    const makerHashes = new Set(cluster.fills.map((row) => row.transactionHash));
    const matchingRows = tapeRows.filter((row) => makerHashes.has(row.transactionHash));
    const wallets = new Set(matchingRows.map((row) => String(row.proxyWallet).toLowerCase()));
    return {
        matchedMakerFills: matchingRows.length,
        expectedMakerFills: cluster.fills.length,
        uniqueTakerCounterparties: wallets.size,
        allMatched: matchingRows.length === cluster.fills.length,
        oppositeOutcomeRows: matchingRows.filter((row) => row.outcome !== cluster.outcome).length,
        counterpartyQuoteNotionalUsdc: sum(matchingRows, (row) => Number(row.price) * Number(row.size)),
        targetEquivalentQuoteNotionalUsdc: sum(
            matchingRows,
            (row) => equivalentOutcomePrice(row, cluster.outcome) * Number(row.size)
        ),
        rows: matchingRows.map((row) => ({
            timestamp: Number(row.timestamp),
            time: iso(row.timestamp),
            wallet: String(row.proxyWallet).toLowerCase(),
            outcome: row.outcome,
            side: row.side,
            price: Number(row.price),
            shares: Number(row.size),
            transactionHash: row.transactionHash
        }))
    };
}

function compactFill(fill, firstTimestamp, roundWinTimestamp = null) {
    return {
        timestamp: fill.timestamp,
        time: iso(fill.timestamp),
        secondsFromFirstFill: fill.timestamp - firstTimestamp,
        secondsFromRoundWinObservation: roundWinTimestamp === null
            ? null
            : fill.timestamp - roundWinTimestamp,
        role: fill.liquidityRole,
        side: fill.side,
        outcome: fill.outcome,
        price: fill.price,
        shares: fill.size,
        quoteNotionalUsdc: fill.quoteNotional,
        transactionHash: fill.transactionHash
    };
}

function marketCase(market) {
    return {
        conditionId: market.conditionId,
        title: market.title,
        marketType: market.marketType,
        firstTradeTime: market.firstTradeTime,
        lastTradeTime: market.lastTradeTime,
        fills: market.fills,
        makerFills: market.makerFills,
        takerFills: market.takerFills,
        quoteNotionalUsdc: market.quoteNotionalUsdc,
        makerQuoteUsdc: market.makerQuoteUsdc,
        takerQuoteUsdc: market.takerQuoteUsdc,
        makerNotionalPct: pct(market.makerQuoteUsdc, market.quoteNotionalUsdc),
        outcome: market.dominantOutcome,
        resolvedWinner: market.resolvedWinner,
        realizedPnlUsdc: market.realizedPnlUsdc,
        pnlWithMakerRebatesUsdc: market.pnlWithMakerRebatesUsdc,
        roiPct: market.roiPct
    };
}

function aggregateSignals(signals) {
    const resolved = signals.filter((row) => row.won !== null);
    const stake = sum(resolved, (row) => row.makerBuyQuoteUsdc);
    const profit = sum(resolved, (row) => row.signalProfitUsdc);
    return {
        signals: signals.length,
        resolvedSignals: resolved.length,
        wins: resolved.filter((row) => row.won).length,
        losses: resolved.filter((row) => !row.won).length,
        stakeUsdc: stake,
        profitUsdc: profit,
        roiPct: pct(profit, stake)
    };
}

async function buildAudit(fetchTape = collectTapeWindow) {
    const { snapshot, enrichment } = mergeEvidence();
    const markets = buildMarketRecords(snapshot, enrichment);
    const evidence = readJson('prospective/cs2_external_evidence.json');
    const prospective = readJson('prospective/prospective_audit.json');
    const cutoff = prospective.frozenBoundary.cutoffTimestamp;
    const m80 = markets.find((row) => row.conditionId === M80_CONDITION);
    const g2M80 = markets.find((row) => row.conditionId === G2_M80_CONDITION);
    const nemesis = markets.find((row) => row.conditionId === NEMESIS_CONDITION);
    if (!m80 || !g2M80 || !nemesis) {
        throw new Error('Required CS2 case market is missing from merged evidence');
    }

    const candidates = localPassiveCandidates(markets);
    const auditedCandidates = [];
    for (const candidate of candidates) {
        const tape = await fetchTape(
            candidate.conditionId,
            candidate.startTimestamp - 5,
            candidate.endTimestamp + 5,
            0
        );
        const counterparties = exactCounterparties(candidate, tape);
        const signalProfitUsdc = candidate.won === null
            ? null
            : (candidate.won ? candidate.makerBuyShares : 0) - candidate.makerBuyQuoteUsdc;
        auditedCandidates.push({
            conditionId: candidate.conditionId,
            eventKey: candidate.eventKey,
            title: candidate.title,
            discipline: candidate.discipline,
            marketType: candidate.marketType,
            sample: candidate.startTimestamp > cutoff ? 'post_cutoff' : 'pre_cutoff',
            outcome: candidate.outcome,
            resolvedWinner: candidate.resolvedWinner,
            won: candidate.won,
            startTimestamp: candidate.startTimestamp,
            startTime: iso(candidate.startTimestamp),
            endTimestamp: candidate.endTimestamp,
            endTime: iso(candidate.endTimestamp),
            durationSeconds: candidate.durationSeconds,
            makerFills: candidate.makerFills,
            makerBuyQuoteUsdc: candidate.makerBuyQuoteUsdc,
            makerBuyShares: candidate.makerBuyShares,
            makerVwap: candidate.makerVwap,
            signalProfitUsdc,
            signalRoiPct: signalProfitUsdc === null ? null : pct(signalProfitUsdc, candidate.makerBuyQuoteUsdc),
            counterpartyAudit: {
                matchedMakerFills: counterparties.matchedMakerFills,
                expectedMakerFills: counterparties.expectedMakerFills,
                uniqueTakerCounterparties: counterparties.uniqueTakerCounterparties,
                allMatched: counterparties.allMatched,
                oppositeOutcomeRows: counterparties.oppositeOutcomeRows
            },
            passesReverseBreadthRule:
                counterparties.uniqueTakerCounterparties >= PASSIVE_RULE.minimumUniqueTakerCounterparties
        });
    }
    const reverseSignals = auditedCandidates.filter((row) => row.passesReverseBreadthRule);
    const reverseAggregate = aggregateSignals(reverseSignals);
    const thresholdSensitivity = Array.from({ length: 21 }, (_, index) => index + 10).map(
        (minimumCounterparties) => ({
            minimumCounterparties,
            ...aggregateSignals(auditedCandidates.filter(
                (row) => row.counterpartyAudit.uniqueTakerCounterparties >= minimumCounterparties
            ))
        })
    );
    const byDiscipline = [...new Set(reverseSignals.map((row) => row.discipline))].sort().map(
        (discipline) => ({
            discipline,
            ...aggregateSignals(reverseSignals.filter((row) => row.discipline === discipline))
        })
    );

    const m80Tape = await fetchTape(
        M80_CONDITION,
        m80.firstTradeTimestamp - 90,
        m80.lastTradeTimestamp + 90,
        0
    );
    const m80Cluster = clusterMakerBuys(m80).find((row) =>
        row.startTimestamp === 1787763879 && row.outcome === 'M80'
    );
    if (!m80Cluster) throw new Error('Expected M80 passive cluster is missing');
    const m80Counterparties = exactCounterparties(m80Cluster, m80Tape);
    const roundWin = Date.parse(
        evidence.m80.broadcastAlignment.observations.find(
            (row) => row.label === 'm80_round_win_visible'
        ).observedAt
    ) / 1000;
    const m80Case = {
        ...marketCase(m80),
        officialMatch: evidence.m80,
        secondsBeforeInfernoEnd: {
            firstFill: (Date.parse(evidence.m80.maps[2].endedAt) / 1000) - m80.firstTradeTimestamp,
            lastFill: (Date.parse(evidence.m80.maps[2].endedAt) / 1000) - m80.lastTradeTimestamp
        },
        firstFillBroadcastState: evidence.m80.broadcastAlignment.observations.find(
            (row) => row.label === 'first_wallet_fill'
        ),
        roundWinBroadcastState: evidence.m80.broadcastAlignment.observations.find(
            (row) => row.label === 'm80_round_win_visible'
        ),
        targetFills: m80._trades.map((row) => compactFill(row, m80.firstTradeTimestamp, roundWin)),
        passiveCluster: {
            startTime: iso(m80Cluster.startTimestamp),
            endTime: iso(m80Cluster.endTimestamp),
            durationSeconds: m80Cluster.durationSeconds,
            makerFills: m80Cluster.makerFills,
            makerBuyQuoteUsdc: m80Cluster.makerBuyQuoteUsdc,
            makerVwap: m80Cluster.makerVwap,
            matchedPublicTakerRows: m80Counterparties.matchedMakerFills,
            uniqueTakerCounterparties: m80Counterparties.uniqueTakerCounterparties,
            allCounterpartiesBoughtOppositeOutcome:
                m80Counterparties.oppositeOutcomeRows === m80Counterparties.matchedMakerFills,
            counterpartyQuoteNotionalUsdc: m80Counterparties.counterpartyQuoteNotionalUsdc,
            targetEquivalentQuoteNotionalUsdc: m80Counterparties.targetEquivalentQuoteNotionalUsdc,
            counterpartyRows: m80Counterparties.rows
        },
        publicTape: {
            source: 'https://data-api.polymarket.com/trades?takerOnly=true',
            query: {
                market: M80_CONDITION,
                start: m80.firstTradeTimestamp - 90,
                end: m80.lastTradeTimestamp + 90,
                minimumCashUsdc: 0
            },
            rows: m80Tape.length,
            bySecond: publicTapeBySecond(m80Tape, 'M80')
        }
    };

    const g2M80Tape = await fetchTape(
        G2_M80_CONDITION,
        g2M80.firstTradeTimestamp - 60,
        g2M80.lastTradeTimestamp + 60,
        0
    );
    const g2M80Cluster = clusterMakerBuys(g2M80).find((row) =>
        row.startTimestamp === 1786539469 && row.outcome === 'M80'
    );
    if (!g2M80Cluster) throw new Error('Expected G2-M80 passive cluster is missing');
    const g2M80Counterparties = exactCounterparties(g2M80Cluster, g2M80Tape);
    const g2M80Case = {
        ...marketCase(g2M80),
        officialMatch: evidence.g2M80,
        clusterStartBroadcastState: evidence.g2M80.broadcastAlignment.observation,
        targetFills: g2M80._trades.map((row) => compactFill(row, g2M80.firstTradeTimestamp)),
        passiveCluster: {
            startTime: iso(g2M80Cluster.startTimestamp),
            endTime: iso(g2M80Cluster.endTimestamp),
            durationSeconds: g2M80Cluster.durationSeconds,
            makerFills: g2M80Cluster.makerFills,
            makerBuyQuoteUsdc: g2M80Cluster.makerBuyQuoteUsdc,
            makerVwap: g2M80Cluster.makerVwap,
            matchedPublicTakerRows: g2M80Counterparties.matchedMakerFills,
            uniqueTakerCounterparties: g2M80Counterparties.uniqueTakerCounterparties,
            allCounterpartiesMatched: g2M80Counterparties.allMatched
        },
        publicTape: {
            source: 'https://data-api.polymarket.com/trades?takerOnly=true',
            query: {
                market: G2_M80_CONDITION,
                start: g2M80.firstTradeTimestamp - 60,
                end: g2M80.lastTradeTimestamp + 60,
                minimumCashUsdc: 0
            },
            rows: g2M80Tape.length,
            bySecond: publicTapeBySecond(g2M80Tape, 'M80')
        }
    };

    const nemesisMetadata = nemesis.metadata;
    const nemesisCase = {
        ...marketCase(nemesis),
        officialMatch: evidence.nemesis,
        marketRule: 'If Map 2 is not completed for any reason, this market will resolve 50-50.',
        closedTokenState: (nemesisMetadata.tokens || []).map((row) => ({
            outcome: row.outcome,
            price: Number(row.price),
            winner: Boolean(row.winner)
        })),
        resolvedFiftyFifty: Boolean(nemesisMetadata.closed)
            && (nemesisMetadata.tokens || []).length === 2
            && (nemesisMetadata.tokens || []).every((row) => Number(row.price) === 0.5 && !row.winner),
        targetFills: nemesis._trades.map((row) => compactFill(row, nemesis.firstTradeTimestamp))
    };

    return {
        generatedAt: new Date().toISOString(),
        mode: 'RESEARCH_ONLY',
        targetWallet: TARGET,
        sources: {
            walletSnapshot: 'research/djdjdjekekek/snapshot.json plus prospective/snapshot.json',
            roleClassification: 'target transaction hashes in the public taker endpoint',
            publicTape: 'https://data-api.polymarket.com/trades?takerOnly=true',
            externalEvidence: 'research/djdjdjekekek/prospective/cs2_external_evidence.json'
        },
        passiveRule: PASSIVE_RULE,
        populationAudit: {
            markets: markets.length,
            localCandidatesBeforeCounterpartyJoin: candidates.length,
            candidatesWithCompleteCounterpartyJoin: auditedCandidates.filter(
                (row) => row.counterpartyAudit.allMatched
            ).length,
            reverseBreadthSignals: reverseSignals.length,
            all: reverseAggregate,
            preCutoff: aggregateSignals(reverseSignals.filter((row) => row.sample === 'pre_cutoff')),
            postCutoff: aggregateSignals(reverseSignals.filter((row) => row.sample === 'post_cutoff')),
            byDiscipline,
            thresholdSensitivity,
            signals: reverseSignals,
            rejectedCandidates: auditedCandidates.filter((row) => !row.passesReverseBreadthRule)
        },
        cases: {
            m80: m80Case,
            g2M80: g2M80Case,
            nemesis: nemesisCase
        },
        findings: [
            'The M80 burst began in a publicly visible 9-6, planted-bomb, five-versus-three state; it was not advance knowledge of the round result.',
            'Most M80 notional was passive: the target absorbed opposite-outcome takers after the market repriced.',
            'The 1WIN forfeit case lost money and resolved 50-50, falsifying an always-correct or indiscriminate late-CS2 interpretation.',
            `Reverse breadth is not a standalone edge: ${reverseAggregate.wins}/${reverseAggregate.resolvedSignals} historical clusters produced ${reverseAggregate.roiPct.toFixed(1)}% ROI.`,
            'The remaining CS2 hypothesis is state selection plus liquidity provision, not breadth or speed alone.'
        ],
        limits: evidence.limits
    };
}

async function main() {
    const report = await buildAudit();
    await writeJson(OUTPUT, report);
    console.log(
        `CS2 case audit: ${report.populationAudit.reverseBreadthSignals} reverse-breadth signals; `
        + `${report.cases.m80.passiveCluster.uniqueTakerCounterparties} M80 counterparties -> ${OUTPUT}`
    );
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
}

module.exports = {
    buildAudit,
    clusterMakerBuys,
    exactCounterparties,
    localPassiveCandidates,
    PASSIVE_RULE,
    publicTapeBySecond
};
