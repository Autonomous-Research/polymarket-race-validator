'use strict';

require('dotenv').config();

const path = require('path');
const { buildDeepAnalysis, buildMarketRecords, classifyDiscipline } = require('./research/analyze');
const {
    collectMakerRebates,
    collectMarketMetadata,
    collectSnapshot,
    collectTrades,
    resolveProfile
} = require('./research/collect');
const { readJson, writeJson } = require('./research/common');
const { collectOnchainEvidence } = require('./research/onchain');
const { collectMarketTapes } = require('./research/tape');
const {
    buildHistoricalAudit,
    generatePaperIntents
} = require('./research/replicator');
const { writeReports } = require('./research/report');

const TARGET = process.env.TARGET_WALLET || process.env.TARGET_USERNAME || 'djdjdjekekek';
const OUTPUT_NAME = process.env.TARGET_USERNAME || (/^0x/.test(TARGET) ? TARGET.toLowerCase() : TARGET);
const OUT_DIR = process.env.OUT_DIR || path.join(process.cwd(), 'research', OUTPUT_NAME);

function outputPath(name) {
    return path.join(OUT_DIR, name);
}

async function saveSnapshot(snapshot) {
    await writeJson(outputPath('snapshot.json'), snapshot);
    console.log(`Snapshot: ${snapshot.trades.length.toLocaleString()} fills, ${snapshot.closedPositions.length.toLocaleString()} closed positions, ${snapshot.activity.length.toLocaleString()} activity rows.`);
}

async function collectAndSaveSnapshot() {
    const snapshot = await collectSnapshot(TARGET);
    await saveSnapshot(snapshot);
    return snapshot;
}

async function cachedComponent(name, collector, force = false) {
    const filePath = outputPath(name);
    if (!force) {
        try {
            return await readJson(filePath);
        } catch (_error) {
            // First collection or an intentionally removed cache.
        }
    }
    const value = await collector();
    await writeJson(filePath, value);
    return value;
}

async function collectEnrichment(snapshot, force = process.env.REFRESH_ENRICHMENT === '1') {
    const timestamps = snapshot.trades.map((trade) => Number(trade.timestamp)).filter(Number.isFinite);
    const conditionIds = [
        ...snapshot.trades.map((trade) => trade.conditionId),
        ...snapshot.closedPositions.map((position) => position.conditionId),
        ...snapshot.positions.map((position) => position.conditionId)
    ].filter(Boolean);
    const firstTimestamp = Math.min(...timestamps);
    const lastTimestamp = Math.max(...timestamps, Math.floor(Date.now() / 1000));

    const [marketMetadata, takerTrades, makerRebates, onchain] = await Promise.all([
        cachedComponent('market_metadata.json', () => collectMarketMetadata(conditionIds), force),
        cachedComponent('taker_trades.json', () => collectTrades(snapshot.wallet, true), force),
        cachedComponent('maker_rebates.json', () => collectMakerRebates(snapshot.wallet, firstTimestamp, lastTimestamp), force),
        cachedComponent('onchain_evidence.json', () => collectOnchainEvidence(
            snapshot,
            console.log,
            outputPath('flow_transactions.json')
        ), force)
    ]);
    const enrichment = {
        generatedAt: new Date().toISOString(),
        wallet: snapshot.wallet,
        marketMetadata,
        takerTrades,
        makerRebates,
        onchain
    };
    await Promise.all([
        writeJson(outputPath('enrichment.json'), enrichment),
        writeJson(outputPath('onchain_evidence.json'), onchain)
    ]);
    console.log(`Enrichment: ${marketMetadata.length.toLocaleString()} markets, ${takerTrades.length.toLocaleString()} taker fills, ${makerRebates.length.toLocaleString()} maker-rebate rows.`);
    return enrichment;
}

async function enrichSavedSnapshot() {
    const snapshot = await readJson(outputPath('snapshot.json'));
    const enrichment = await collectEnrichment(snapshot);
    return { snapshot, enrichment };
}

async function analyze(snapshot, enrichment) {
    const { analysis } = buildDeepAnalysis(snapshot, enrichment);
    await Promise.all([
        writeJson(outputPath('deep_analysis.json'), analysis),
        writeJson(outputPath('backtest.json'), analysis.backtest)
    ]);
    console.log(`Analysis: ${analysis.coverage.markets} markets; maker ${analysis.execution.makerFillPct.toFixed(1)}% of fills / ${analysis.execution.makerNotionalPct.toFixed(1)}% of quote notional.`);
    console.log(`Deep analysis: ${outputPath('deep_analysis.json')}`);
    return analysis;
}

async function analyzeSaved() {
    const [snapshot, enrichment] = await Promise.all([
        readJson(outputPath('snapshot.json')),
        readJson(outputPath('enrichment.json'))
    ]);
    return analyze(snapshot, enrichment);
}

async function collectTapeSaved() {
    const [snapshot, enrichment] = await Promise.all([
        readJson(outputPath('snapshot.json')),
        readJson(outputPath('enrichment.json'))
    ]);
    const markets = buildMarketRecords(snapshot, enrichment);
    const tape = await collectMarketTapes(markets, snapshot.wallet, console.log);
    await writeJson(outputPath('market_tape.json'), tape, 0);
    console.log(`Public tape: ${tape.rows.toLocaleString()} taker prints across ${tape.successfulMarkets.toLocaleString()} markets.`);
    return tape;
}

async function refreshOnchain() {
    const snapshot = await readJson(outputPath('snapshot.json'));
    const onchain = await collectOnchainEvidence(snapshot, console.log, outputPath('flow_transactions.json'));
    const enrichment = await readJson(outputPath('enrichment.json'));
    enrichment.generatedAt = new Date().toISOString();
    enrichment.onchain = onchain;
    await Promise.all([
        writeJson(outputPath('onchain_evidence.json'), onchain),
        writeJson(outputPath('enrichment.json'), enrichment)
    ]);
    console.log(`Onchain evidence: ${onchain.flows.transactionLookupCoveragePct.toFixed(1)}% flow lookup coverage.`);
    return { snapshot, enrichment };
}

async function replicateSaved() {
    const [snapshot, enrichment, analysis, edgeAnalysis, edgeModel] = await Promise.all([
        readJson(outputPath('snapshot.json')),
        readJson(outputPath('enrichment.json')),
        readJson(outputPath('deep_analysis.json')),
        readJson(outputPath('edge_analysis.json')),
        readJson(outputPath('edge_model.json'))
    ]);
    const paper = await generatePaperIntents(snapshot, enrichment, { model: edgeModel });
    const audit = buildHistoricalAudit(analysis, edgeAnalysis, edgeModel);
    await Promise.all([
        writeJson(outputPath('replicator_config.json'), paper.config),
        writeJson(outputPath('replication_intents.json'), paper),
        writeJson(outputPath('replication_backtest.json'), audit)
    ]);
    const historicalBets = audit.fixedExternalTapeBacktest?.all?.bets ?? audit.all?.bets ?? 0;
    console.log(`Paper replicator: ${paper.intents.length} current intents; ${historicalBets} historical simulations.`);
    return { paper, audit };
}

async function monitorOnce() {
    const snapshot = await collectAndSaveSnapshot();
    let existing = {};
    try {
        existing = await readJson(outputPath('enrichment.json'));
    } catch (_error) {
        // First run uses empty caches.
    }
    const knownMetadata = new Map((existing.marketMetadata || []).map((market) => [market.conditionId, market]));
    const conditionIds = [...new Set([
        ...snapshot.trades.map((trade) => trade.conditionId),
        ...snapshot.positions.map((position) => position.conditionId)
    ].filter(Boolean))];
    const nowTimestamp = Math.floor(Date.now() / 1000);
    const recentConditions = new Set(snapshot.trades
        .filter((trade) => Number(trade.timestamp) >= nowTimestamp - 48 * 60 * 60)
        .map((trade) => trade.conditionId));
    const toRefresh = conditionIds.filter((conditionId) =>
        !knownMetadata.has(conditionId) || recentConditions.has(conditionId));
    const firstTimestamp = Math.min(...snapshot.trades.map((trade) => Number(trade.timestamp)));
    const [freshMetadata, takerTrades, makerRebates] = await Promise.all([
        collectMarketMetadata(toRefresh),
        collectTrades(snapshot.wallet, true),
        collectMakerRebates(snapshot.wallet, firstTimestamp, nowTimestamp)
    ]);
    for (const market of freshMetadata) knownMetadata.set(market.conditionId, market);
    const enrichment = {
        ...existing,
        generatedAt: new Date().toISOString(),
        wallet: snapshot.wallet,
        marketMetadata: [...knownMetadata.values()],
        takerTrades,
        makerRebates
    };
    await writeJson(outputPath('enrichment.json'), enrichment);
    await analyze(snapshot, enrichment);
    return replicateSaved();
}

async function reportSaved() {
    const [analysis, stats, onchain, paper, audit, edge, peers] = await Promise.all([
        readJson(outputPath('deep_analysis.json')),
        readJson(outputPath('statistical_analysis.json')),
        readJson(outputPath('onchain_evidence.json')),
        readJson(outputPath('replication_intents.json')),
        readJson(outputPath('replication_backtest.json')),
        readJson(outputPath('edge_analysis.json')),
        readJson(outputPath('peer_evidence.json'))
    ]);
    const names = await writeReports(OUT_DIR, { analysis, stats, onchain, paper, audit, edge, peers });
    console.log(`Reports: ${names.join(', ')}`);
    return names;
}

async function main() {
    const command = process.argv[2] || 'all';
    if (command === 'collect') {
        await collectAndSaveSnapshot();
        return;
    }
    if (command === 'enrich') {
        await enrichSavedSnapshot();
        return;
    }
    if (command === 'analyze') {
        await analyzeSaved();
        return;
    }
    if (command === 'tape') {
        await collectTapeSaved();
        return;
    }
    if (command === 'onchain') {
        await refreshOnchain();
        return;
    }
    if (command === 'replicate') {
        await replicateSaved();
        return;
    }
    if (command === 'monitor') {
        await monitorOnce();
        return;
    }
    if (command === 'report') {
        await reportSaved();
        return;
    }
    if (command === 'all') {
        const snapshot = await collectAndSaveSnapshot();
        const enrichment = await collectEnrichment(snapshot, true);
        await analyze(snapshot, enrichment);
        return;
    }
    if (command === 'profile') {
        console.log(JSON.stringify(await resolveProfile(TARGET), null, 2));
        return;
    }
    throw new Error(`Unknown command: ${command}. Expected collect, enrich, onchain, analyze, tape, replicate, monitor, report, all, or profile.`);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
}

module.exports = {
    OUT_DIR,
    analyze,
    classifyDiscipline,
    collectEnrichment,
    collectTapeSaved,
    collectSnapshot,
    monitorOnce,
    refreshOnchain,
    replicateSaved,
    reportSaved,
    resolveProfile
};
