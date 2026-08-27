'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { buildMarketRecords } = require('./analyze');
const { baseStrategy, findSignal } = require('./backtest');
const { iso } = require('./common');

const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_RESEARCH_DIR = path.join(ROOT, 'research/djdjdjekekek');
const BREADTH_THRESHOLD = 18;
const COMPACT_MAX_PRICE_LEVELS = 3;
const FRESH_MAX_MEDIAN_AGE_SECONDS = 300;

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function frozenCutoff(snapshot) {
    const timestamps = [
        ...(snapshot.trades || []).map((row) => Number(row.timestamp)),
        ...(snapshot.activity || []).map((row) => Number(row.timestamp))
    ].filter(Number.isFinite);
    if (!timestamps.length) throw new Error('Frozen snapshot has no timestamps');
    return Math.max(...timestamps);
}

function signalRejections(market, signal, strategy) {
    const reasons = [];
    if (!strategy.disciplines.includes(market.discipline)) {
        reasons.push(`DISCIPLINE_EXCLUDED:${market.discipline}`);
    }
    if ((strategy.excludedMarketTypes || []).includes(market.marketType)) {
        reasons.push(`MARKET_TYPE_EXCLUDED:${market.marketType}`);
    }
    if (!Number.isFinite(Number(signal.triggerPrice))) {
        reasons.push('TRIGGER_PRICE_MISSING');
    } else if (Number(signal.triggerPrice) < strategy.minPrice) {
        reasons.push(`TRIGGER_PRICE_BELOW_${strategy.minPrice}`);
    } else if (Number(signal.triggerPrice) > strategy.maxPrice) {
        reasons.push(`TRIGGER_PRICE_ABOVE_${strategy.maxPrice}`);
    }
    return reasons;
}

function onchainRejections(decoded) {
    const reasons = [];
    if (!decoded) return ['TRIGGER_TRANSACTION_NOT_DECODED'];
    if (!decoded.takerIsTarget) reasons.push('TARGET_NOT_DECODED_TAKER');
    if (decoded.taker?.side !== 'BUY') reasons.push('TARGET_NOT_BUY_TAKER');
    if (!decoded.taker?.tokenMatchesSignal) reasons.push('DECODED_TOKEN_MISMATCH');
    if (Number(decoded.sweep?.uniqueMakers || 0) < BREADTH_THRESHOLD) {
        reasons.push(`MAKER_BREADTH_BELOW_${BREADTH_THRESHOLD}`);
    }
    return reasons;
}

function auditProspective({ frozenSnapshot, snapshot, enrichment, triggerData }) {
    const cutoff = frozenCutoff(frozenSnapshot);
    const strategy = baseStrategy();
    const decodedByHash = new Map((triggerData.transactions || []).map((row) => [
        String(row.transactionHash || '').toLowerCase(), row
    ]));
    const decodedByCondition = new Map((triggerData.transactions || []).map((row) => [
        row.conditionId, row
    ]));
    const markets = buildMarketRecords(snapshot, enrichment);
    const raw = [];

    for (const market of markets) {
        const signal = findSignal(market, strategy);
        if (!signal || Number(signal.timestamp) <= cutoff) continue;
        const decoded = decodedByHash.get(String(signal.triggerHash || '').toLowerCase())
            || decodedByCondition.get(market.conditionId)
            || null;
        const baseReasons = signalRejections(market, signal, strategy);
        const chainReasons = onchainRejections(decoded);
        const baseEligible = baseReasons.length === 0;
        const decodedEligible = chainReasons.filter((reason) =>
            !reason.startsWith('MAKER_BREADTH_BELOW_')).length === 0;
        const breadthEligible = baseEligible && chainReasons.length === 0;
        const compactFresh = breadthEligible
            && Number(decoded?.sweep?.uniquePriceLevels) <= COMPACT_MAX_PRICE_LEVELS
            && Number(decoded?.sweep?.restingAgeMedianSeconds) <= FRESH_MAX_MEDIAN_AGE_SECONDS;
        raw.push({
            conditionId: market.conditionId,
            eventKey: market.eventKey,
            title: market.title,
            discipline: market.discipline,
            marketType: market.marketType,
            signalTimestamp: Number(signal.timestamp),
            signalTime: iso(signal.timestamp),
            outcome: signal.outcome,
            concentration: signal.concentration,
            triggerPrice: signal.triggerPrice,
            triggerHash: signal.triggerHash,
            resolvedWinner: market.resolvedWinner || null,
            resolutionStatus: market.resolvedWinner ? 'resolved' : 'active_or_unresolved',
            won: market.resolvedWinner ? signal.outcome === market.resolvedWinner : null,
            decoded: Boolean(decoded),
            decodedTargetTakerBuy: decodedEligible,
            uniqueMakers: decoded?.sweep?.uniqueMakers ?? null,
            uniquePriceLevels: decoded?.sweep?.uniquePriceLevels ?? null,
            medianMakerAgeSeconds: decoded?.sweep?.restingAgeMedianSeconds ?? null,
            baseEligible,
            breadthEligible,
            compactFreshShadow: compactFresh,
            rejectionReasons: [...baseReasons, ...chainReasons]
        });
    }

    raw.sort((left, right) => left.signalTimestamp - right.signalTimestamp);
    const seenEvents = new Set();
    for (const row of raw) {
        const key = row.eventKey || row.conditionId;
        row.firstCanonicalEventSignal = !seenEvents.has(key);
        if (row.firstCanonicalEventSignal) seenEvents.add(key);
        if (!row.firstCanonicalEventSignal) {
            row.breadthEligible = false;
            row.compactFreshShadow = false;
            row.rejectionReasons.push('DUPLICATE_CANONICAL_EVENT');
        }
    }

    const baseEligible = raw.filter((row) => row.baseEligible && row.firstCanonicalEventSignal);
    const breadthEligible = raw.filter((row) => row.breadthEligible);
    const compactFresh = raw.filter((row) => row.compactFreshShadow);
    const rawBroad = raw.filter((row) => Number(row.uniqueMakers) >= BREADTH_THRESHOLD);
    const evidenceStatus = breadthEligible.length ? 'new_frozen_signals_observed' : 'insufficient_new_evidence';

    return {
        generatedAt: new Date().toISOString(),
        status: evidenceStatus,
        conclusion: breadthEligible.length
            ? 'One or more signals passed the previously frozen rule; outcomes and executable paper fills must be evaluated without changing the rule.'
            : 'No post-cutoff signal passed the previously frozen atomic-breadth rule. This window neither validates nor falsifies profitability.',
        frozenBoundary: {
            cutoffTimestamp: cutoff,
            cutoffTime: iso(cutoff),
            ruleWasFrozenBeforeProspectiveWindow: true
        },
        frozenRule: {
            signalSource: strategy.signalSource,
            thresholdUsdc: strategy.thresholdUsdc,
            minimumConcentration: strategy.concentration,
            allowedDisciplines: strategy.disciplines,
            excludedMarketTypes: strategy.excludedMarketTypes,
            minimumTriggerPrice: strategy.minPrice,
            maximumTriggerPrice: strategy.maxPrice,
            firstCanonicalEventSignalOnly: true,
            minimumUniqueMakers: BREADTH_THRESHOLD,
            compactFreshShadow: {
                maximumPriceLevels: COMPACT_MAX_PRICE_LEVELS,
                maximumMedianMakerAgeSeconds: FRESH_MAX_MEDIAN_AGE_SECONDS,
                productionGate: false
            }
        },
        coverage: {
            snapshotGeneratedAt: snapshot.generatedAt,
            postCutoffTrades: (snapshot.trades || []).filter((row) => Number(row.timestamp) > cutoff).length,
            markets: markets.length,
            rawThresholdSignals: raw.length,
            decodedRawThresholdSignals: raw.filter((row) => row.decoded).length,
            frozenBaseEligibleSignals: baseEligible.length,
            rawBroadSweepsBeforeUniverseGuards: rawBroad.length,
            frozenBreadthEligibleSignals: breadthEligible.length,
            compactFreshShadowSignals: compactFresh.length,
            resolvedFrozenBreadthSignals: breadthEligible.filter((row) => row.won !== null).length
        },
        observedBroadOutsideFrozenUniverse: rawBroad.map((row) => ({
            signalTime: row.signalTime,
            title: row.title,
            discipline: row.discipline,
            uniqueMakers: row.uniqueMakers,
            uniquePriceLevels: row.uniquePriceLevels,
            medianMakerAgeSeconds: row.medianMakerAgeSeconds,
            rejectionReasons: row.rejectionReasons
        })),
        candidates: raw,
        warnings: [
            'Zero qualifying signals is an exposure problem, not a zero-return observation.',
            'Active or unresolved outcomes are retained as null and are never scored as losses.',
            'The compact-fresh rule remains a retrospective shadow tag and is not promoted by this audit.',
            'A broad sweep in an excluded discipline does not validate a core-universe strategy.'
        ]
    };
}

function renderMarkdown(audit) {
    const lines = [
        '# Frozen Prospective Audit',
        '',
        `Generated: ${audit.generatedAt}`,
        '',
        `**Status: ${audit.status}.** ${audit.conclusion}`,
        '',
        `The historical cutoff is ${audit.frozenBoundary.cutoffTime}. The rule was not re-fit on this window.`,
        '',
        '## Scoreboard',
        '',
        '| Stage | Signals |',
        '|---|---:|',
        `| Raw $25k / 70% threshold crossings | ${audit.coverage.rawThresholdSignals} |`,
        `| Decoded trigger transactions | ${audit.coverage.decodedRawThresholdSignals} |`,
        `| Frozen base-universe signals | ${audit.coverage.frozenBaseEligibleSignals} |`,
        `| Raw >=18-maker sweeps before universe guards | ${audit.coverage.rawBroadSweepsBeforeUniverseGuards} |`,
        `| Frozen >=18-maker signals | ${audit.coverage.frozenBreadthEligibleSignals} |`,
        `| Compact-fresh shadow signals | ${audit.coverage.compactFreshShadowSignals} |`,
        '',
        '## Every Raw Candidate',
        '',
        '| Time (UTC) | Market | Discipline | Price | Makers | Levels | Median age | Result | Rejection |',
        '|---|---|---|---:|---:|---:|---:|---|---|'
    ];
    for (const row of audit.candidates) {
        lines.push(`| ${row.signalTime} | ${row.title.replace(/\|/g, '\\|')} | ${row.discipline} | ${Number(row.triggerPrice).toFixed(3)} | ${row.uniqueMakers ?? 'n/a'} | ${row.uniquePriceLevels ?? 'n/a'} | ${row.medianMakerAgeSeconds === null ? 'n/a' : Number(row.medianMakerAgeSeconds).toFixed(1) + 's'} | ${row.resolutionStatus} | ${row.rejectionReasons.join(', ') || 'none'} |`);
    }
    lines.push(
        '',
        '## Interpretation',
        '',
        'Every raw sweep reaching 18 makers was outside the frozen discipline universe. Therefore there is no new eligible bet to score. Reporting a win, loss, ROI, or confidence interval for the frozen rule from this window would manufacture evidence.',
        '',
        ...audit.warnings.map((warning) => `- ${warning}`),
        ''
    );
    return lines.join('\n');
}

function main() {
    const researchDir = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_RESEARCH_DIR;
    const prospectiveDir = path.join(researchDir, 'prospective');
    const audit = auditProspective({
        frozenSnapshot: readJson(path.join(researchDir, 'snapshot.json')),
        snapshot: readJson(path.join(prospectiveDir, 'snapshot.json')),
        enrichment: readJson(path.join(prospectiveDir, 'enrichment.json')),
        triggerData: readJson(path.join(prospectiveDir, 'trigger_transactions.json'))
    });
    const jsonPath = path.join(prospectiveDir, 'prospective_audit.json');
    const markdownPath = path.join(prospectiveDir, 'prospective_audit.md');
    fs.writeFileSync(jsonPath, `${JSON.stringify(audit, null, 2)}\n`);
    fs.writeFileSync(markdownPath, renderMarkdown(audit));
    console.log(`Prospective audit: ${audit.status}; ${audit.coverage.frozenBreadthEligibleSignals} frozen breadth signals -> ${jsonPath}`);
}

if (require.main === module) main();

module.exports = {
    auditProspective,
    frozenCutoff,
    onchainRejections,
    renderMarkdown,
    signalRejections
};
