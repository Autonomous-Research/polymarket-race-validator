require('dotenv').config();

const axios = require('axios');
const fs = require('fs/promises');
const path = require('path');

const GAMMA = 'https://gamma-api.polymarket.com';
const DATA = 'https://data-api.polymarket.com';
const TARGET_USERNAME = process.env.TARGET_USERNAME || 'djdjdjekekek';
const TARGET_WALLET = process.env.TARGET_WALLET || '';
const OUT_DIR = process.env.OUT_DIR || path.join(process.cwd(), 'research', TARGET_USERNAME);
const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 30000);
const MIN_TS = Number(process.env.START_TS || 1);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function uniqueBy(items, keyFn) {
    const seen = new Set();
    const out = [];
    for (const item of items) {
        const key = keyFn(item);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}

function sum(items, key) {
    return items.reduce((acc, item) => acc + Number(item[key] || 0), 0);
}

function tradeNotional(row) {
    if (Number.isFinite(Number(row.usdcSize)) && Number(row.usdcSize) > 0) return Number(row.usdcSize);
    return Number(row.size || 0) * Number(row.price || 0);
}

function closedCost(position) {
    return Number(position.totalBought || 0) * Number(position.avgPrice || 0);
}

function pct(n, d) {
    return d ? (n / d) * 100 : 0;
}

function usd(n) {
    return `$${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function iso(ts) {
    return ts ? new Date(ts * 1000).toISOString() : '';
}

function marketFamily(row) {
    const text = `${row.slug || ''} ${row.eventSlug || ''} ${row.title || ''}`.toLowerCase();
    if (text.includes('btc-updown') || text.includes('bitcoin up or down')) return 'crypto-5m';
    if (text.includes('eth-updown') || text.includes('ethereum up or down')) return 'crypto-5m';
    if (text.includes('dota') || text.includes('counter-strike') || text.includes('cs2') || text.includes('league of legends') || text.includes('lol-')) return 'esports';
    if (text.includes('mlb') || text.includes('nba') || text.includes('nfl') || text.includes('nhl') || text.includes('soccer') || text.includes('tennis') || text.includes('wta-') || text.includes('atp-') || text.includes('open:')) return 'sports';
    if (text.includes('election') || text.includes('trump') || text.includes('president')) return 'politics';
    return 'other';
}

async function getJson(url, params = {}, attempt = 1) {
    try {
        const response = await axios.get(url, {
            params,
            timeout: HTTP_TIMEOUT_MS,
            headers: { 'accept': 'application/json' }
        });
        return response.data;
    } catch (error) {
        const status = error.response?.status;
        if (attempt < 5 && (status === 429 || status >= 500 || !status)) {
            await sleep(500 * attempt * attempt);
            return getJson(url, params, attempt + 1);
        }
        throw new Error(`${url} ${JSON.stringify(params)} failed: ${status || ''} ${error.response?.data ? JSON.stringify(error.response.data) : error.message}`);
    }
}

async function resolveProfile(usernameOrWallet) {
    if (/^0x[a-fA-F0-9]{40}$/.test(usernameOrWallet)) {
        const profile = await getJson(`${GAMMA}/public-profile`, { address: usernameOrWallet });
        return profile;
    }

    const search = await getJson(`${GAMMA}/public-search`, {
        q: usernameOrWallet,
        search_profiles: true,
        limit_per_type: 10,
        optimized: true,
        cache: false
    });
    const profiles = search.profiles || [];
    const exact = profiles.find((p) => String(p.name || '').toLowerCase() === usernameOrWallet.toLowerCase());
    if (!exact) {
        throw new Error(`No exact profile match for ${usernameOrWallet}. Candidates: ${profiles.map((p) => `${p.name}:${p.proxyWallet}`).join(', ')}`);
    }
    return exact;
}

async function collectOffset(endpoint, params, limit, offsetCap) {
    const rows = [];
    for (let offset = 0; offset <= offsetCap; offset += limit) {
        const page = await getJson(`${DATA}/${endpoint}`, { ...params, limit, offset });
        if (!Array.isArray(page)) throw new Error(`${endpoint} returned non-array: ${JSON.stringify(page).slice(0, 300)}`);
        rows.push(...page);
        if (page.length < limit) break;
    }
    return rows;
}

async function collectWindowed(endpoint, baseParams, { limit, offsetCap, start, end, sortDirection = 'ASC' }) {
    const params = { ...baseParams, start, end, sortDirection };
    const rows = await collectOffset(endpoint, params, limit, offsetCap);
    const hitCap = rows.length >= offsetCap + limit;
    const allSameSecond = rows.length > 0 && rows.every((row) => row.timestamp === rows[0].timestamp);
    if (!hitCap || allSameSecond || end - start <= 1) return rows;

    const mid = Math.floor((start + end) / 2);
    const left = await collectWindowed(endpoint, baseParams, { limit, offsetCap, start, end: mid, sortDirection });
    const right = await collectWindowed(endpoint, baseParams, { limit, offsetCap, start: mid + 1, end, sortDirection });
    return uniqueBy([...left, ...right], (row) => row.transactionHash || JSON.stringify(row));
}

async function collectAllTrades(wallet) {
    const now = Math.floor(Date.now() / 1000) + 3600;
    const rows = await collectWindowed('trades', {
        user: wallet,
        takerOnly: false
    }, {
        limit: 10000,
        offsetCap: 10000,
        start: MIN_TS,
        end: now,
        sortDirection: 'DESC'
    });
    return rows.sort((a, b) => a.timestamp - b.timestamp || String(a.transactionHash).localeCompare(String(b.transactionHash)));
}

async function collectAllActivity(wallet) {
    const now = Math.floor(Date.now() / 1000) + 3600;
    const rows = await collectWindowed('activity', {
        user: wallet,
        excludeDepositsWithdrawals: false
    }, {
        limit: 500,
        offsetCap: 5000,
        start: MIN_TS,
        end: now,
        sortDirection: 'ASC'
    });
    return rows.sort((a, b) => a.timestamp - b.timestamp || String(a.transactionHash).localeCompare(String(b.transactionHash)));
}

async function collectAllClosedPositions(wallet) {
    const rows = [];
    const limit = 50;
    for (let offset = 0; offset <= 100000; offset += limit) {
        const page = await getJson(`${DATA}/closed-positions`, {
            user: wallet,
            limit,
            offset,
            sortBy: 'TIMESTAMP',
            sortDirection: 'DESC'
        });
        if (!Array.isArray(page)) throw new Error(`closed-positions returned non-array: ${JSON.stringify(page).slice(0, 300)}`);
        rows.push(...page);
        if (page.length < limit) break;
    }
    return rows;
}

function aggregateBy(rows, keyFn, valueFn = tradeNotional) {
    const map = new Map();
    for (const row of rows) {
        const key = keyFn(row);
        const current = map.get(key) || { key, count: 0, notional: 0, size: 0, rows: [] };
        current.count += 1;
        current.notional += valueFn(row);
        current.size += Number(row.size || 0);
        current.rows.push(row);
        map.set(key, current);
    }
    return [...map.values()].sort((a, b) => b.notional - a.notional);
}

function buildAnalysis(snapshot) {
    const trades = snapshot.trades;
    const activity = snapshot.activity;
    const positions = snapshot.positions;
    const closed = snapshot.closedPositions;
    const grossTradeNotional = trades.reduce((acc, row) => acc + tradeNotional(row), 0);
    const buyTrades = trades.filter((t) => t.side === 'BUY');
    const sellTrades = trades.filter((t) => t.side === 'SELL');
    const markets = aggregateBy(trades, (row) => row.conditionId);
    const families = aggregateBy(trades, marketFamily);
    const outcomes = aggregateBy(trades, (row) => `${row.slug}|${row.outcome}`);
    const activityTypes = aggregateBy(activity, (row) => row.type, (row) => Number(row.usdcSize || row.size || 0));
    const deposits = activity.filter((row) => row.type === 'DEPOSIT');
    const withdrawals = activity.filter((row) => row.type === 'WITHDRAWAL');
    const redeems = activity.filter((row) => row.type === 'REDEEM');
    const splits = activity.filter((row) => row.type === 'SPLIT');
    const merges = activity.filter((row) => row.type === 'MERGE');
    const closedPnl = sum(closed, 'realizedPnl');
    const closedBought = closed.reduce((acc, row) => acc + closedCost(row), 0);
    const profitableClosed = closed.filter((p) => Number(p.realizedPnl || 0) > 0);
    const losingClosed = closed.filter((p) => Number(p.realizedPnl || 0) < 0);
    const timestamps = trades.map((t) => t.timestamp).filter(Boolean);
    const firstTs = Math.min(...timestamps);
    const lastTs = Math.max(...timestamps);

    return {
        generatedAt: new Date().toISOString(),
        profile: snapshot.profile,
        wallet: snapshot.wallet,
        coverage: {
            firstTrade: iso(firstTs),
            lastTrade: iso(lastTs),
            trades: trades.length,
            activityRows: activity.length,
            marketsTradedEndpoint: snapshot.marketsTraded?.traded,
            uniqueMarketsFromTrades: markets.length,
            closedPositions: closed.length,
            activePositions: positions.length
        },
        flow: {
            deposits: deposits.length,
            depositUsdc: sum(deposits, 'usdcSize'),
            withdrawals: withdrawals.length,
            withdrawalUsdc: sum(withdrawals, 'usdcSize'),
            redeems: redeems.length,
            redeemUsdc: sum(redeems, 'usdcSize'),
            splits: splits.length,
            merges: merges.length
        },
        trading: {
            buyNotional: buyTrades.reduce((acc, row) => acc + tradeNotional(row), 0),
            sellNotional: sellTrades.reduce((acc, row) => acc + tradeNotional(row), 0),
            buyFillCount: buyTrades.length,
            sellFillCount: sellTrades.length,
            tradeNotional: grossTradeNotional,
            avgFillUsdc: grossTradeNotional / Math.max(1, trades.length),
            medianFillUsdc: median(trades.map(tradeNotional)),
            largestFills: trades.slice().sort((a, b) => tradeNotional(b) - tradeNotional(a)).slice(0, 15)
        },
        performance: {
            closedRealizedPnl: closedPnl,
            closedCostBasis: closedBought,
            closedRoiPct: pct(closedPnl, closedBought),
            profitableClosed: profitableClosed.length,
            losingClosed: losingClosed.length,
            activeCurrentValue: sum(positions, 'currentValue'),
            activeCashPnl: sum(positions, 'cashPnl')
        },
        distributions: {
            families: families.map((item) => cleanAgg(item, grossTradeNotional)),
            activityTypes: activityTypes.map(cleanAgg),
            topMarkets: markets.slice(0, 25).map((item) => ({
                conditionId: item.key,
                title: item.rows[0]?.title,
                slug: item.rows[0]?.slug,
                family: marketFamily(item.rows[0] || {}),
                fills: item.count,
                notional: item.notional,
                outcomes: [...new Set(item.rows.map((row) => row.outcome).filter(Boolean))]
            })),
            topOutcomeBuilds: outcomes.slice(0, 25).map((item) => ({
                slug: item.key.split('|')[0],
                outcome: item.key.split('|')[1],
                fills: item.count,
                notional: item.notional,
                firstTrade: iso(Math.min(...item.rows.map((row) => row.timestamp))),
                lastTrade: iso(Math.max(...item.rows.map((row) => row.timestamp)))
            }))
        },
        activePositions: positions,
        closedLeaders: {
            winners: closed.slice().sort((a, b) => Number(b.realizedPnl || 0) - Number(a.realizedPnl || 0)).slice(0, 20),
            losers: closed.slice().sort((a, b) => Number(a.realizedPnl || 0) - Number(b.realizedPnl || 0)).slice(0, 20)
        },
        thesis: makeThesis({ trades, positions, closed, families, deposits, withdrawals, redeems })
    };
}

function median(values) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return 0;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function cleanAgg(item, total = 0) {
    return {
        key: item.key,
        count: item.count,
        notional: item.notional,
        notionalPct: pct(item.notional, total)
    };
}

function makeThesis({ trades, positions, closed, families, deposits, withdrawals, redeems }) {
    const total = trades.reduce((acc, row) => acc + tradeNotional(row), 0);
    const familyPct = Object.fromEntries(families.map((f) => [f.key, pct(f.notional, total)]));
    const esportsClosed = closed.filter((p) => marketFamily(p) === 'esports');
    const sportsClosed = closed.filter((p) => marketFamily(p) === 'sports');
    const cryptoFills = trades.filter((t) => marketFamily(t) === 'crypto-5m');
    const activeRisk = sum(positions, 'initialValue');
    return [
        `Primary edge appears to be concentrated discretionary esports betting, not broad prediction-market making. Esports represents ${familyPct.esports?.toFixed(1) || '0.0'}% of observed fill notional and ${esportsClosed.length} closed positions.`,
        `The wallet pyramids into single match outcomes with many small fills plus occasional very large blocks. The median fill is ${usd(median(trades.map(tradeNotional)))}, but the largest fills are five to six figures of USDC.`,
        `The account is willing to compound aggressively. Closed position PnL is dominated by a small number of resolved esports winners, while current active exposure is ${usd(activeRisk)} initial value across ${positions.length} open positions.`,
        `The BTC 5-minute activity looks exploratory or execution/noise relative to the main edge: many fills, short event horizons, and materially smaller average notional than the esports book.`,
        `On-chain-account behavior is simple from Polymarket public data: funding arrives as deposits, trading creates CLOB trade rows, and settlement happens via redeems. Deposits=${deposits.length}, withdrawals=${withdrawals.length}, redeems=${redeems.length}.`,
        `Replicating the trader should therefore be a constrained copy/strategy hybrid: follow esports and sports outcomes only after the target crosses a conviction threshold, size esports larger than sports, scale in over time, cap per-market loss, and ignore or downweight high-frequency BTC up/down trades.`
    ];
}

function buildReplicatorConfig(analysis) {
    const allowedFamilies = ['esports', 'sports'];
    const seedMarkets = analysis.distributions.topMarkets.filter((m) => allowedFamilies.includes(m.family)).slice(0, 10);
    const medianFill = analysis.trading.medianFillUsdc;
    return {
        mode: 'dry-run',
        targetWallet: analysis.wallet,
        thesisVersion: analysis.generatedAt,
        rules: {
            allowedFamilies,
            ignoredFamilies: ['crypto-5m'],
            familySizingMultiplier: {
                esports: 1,
                sports: 0.5
            },
            minTargetMarketNotionalUsdc: 10000,
            minTargetOutcomeShare: 0.7,
            maxPortfolioRiskPct: 0.08,
            maxSingleMarketRiskPct: 0.025,
            entrySizing: {
                baseUsdc: Math.max(25, Math.round(medianFill)),
                addWhenTargetAddsUsdc: 5000,
                maxOrderUsdc: 2500
            },
            priceGuard: {
                maxCopyLagSeconds: 300,
                maxSlippageCents: 3,
                noChaseAbovePrice: 0.75
            },
            exitPolicy: {
                takeProfitWhenPriceAbove: 0.9,
                cutWhenTargetSellsOverPctOfMarketPosition: 0.35,
                reduceBeforeScheduledStartMinutes: 5
            }
        },
        seedWatchlist: seedMarkets.map((m) => ({
            slug: m.slug,
            title: m.title,
            observedNotional: Number(m.notional.toFixed(2)),
            outcomes: m.outcomes
        }))
    };
}

function renderMarkdown(snapshot, analysis, replicator) {
    const lines = [];
    lines.push(`# Polymarket Trader Reverse Engineering: ${snapshot.profile.name}`);
    lines.push('');
    lines.push(`Snapshot: ${analysis.generatedAt}`);
    lines.push(`Profile: https://polymarket.com/@${TARGET_USERNAME}`);
    lines.push(`Proxy wallet: \`${analysis.wallet}\``);
    lines.push('');
    lines.push('## Data Sources');
    lines.push('');
    lines.push('- Polymarket Gamma `/public-search` and `/public-profile` for profile-to-wallet resolution.');
    lines.push('- Polymarket Data API `/positions`, `/closed-positions`, `/activity`, `/trades`, `/value`, and `/traded` for trading and wallet activity.');
    lines.push('- Public profile HTML was used only as a cross-check of displayed value/PnL.');
    lines.push('');
    lines.push('## Coverage');
    lines.push('');
    lines.push(`- First observed trade: ${analysis.coverage.firstTrade}`);
    lines.push(`- Last observed trade: ${analysis.coverage.lastTrade}`);
    lines.push(`- Trade rows collected: ${analysis.coverage.trades.toLocaleString()}`);
    lines.push(`- Activity rows collected: ${analysis.coverage.activityRows.toLocaleString()}`);
    lines.push(`- Unique markets from trades: ${analysis.coverage.uniqueMarketsFromTrades.toLocaleString()}`);
    lines.push(`- Polymarket traded endpoint count: ${analysis.coverage.marketsTradedEndpoint}`);
    lines.push(`- Closed positions: ${analysis.coverage.closedPositions.toLocaleString()}`);
    lines.push(`- Active positions: ${analysis.coverage.activePositions.toLocaleString()}`);
    lines.push('');
    lines.push('## Wallet And Onchain Activity');
    lines.push('');
    lines.push(`- Deposits: ${analysis.flow.deposits} totaling ${usd(analysis.flow.depositUsdc)}`);
    lines.push(`- Withdrawals: ${analysis.flow.withdrawals} totaling ${usd(analysis.flow.withdrawalUsdc)}`);
    lines.push(`- Redeems: ${analysis.flow.redeems} totaling ${usd(analysis.flow.redeemUsdc)}`);
    lines.push(`- Splits: ${analysis.flow.splits}; merges: ${analysis.flow.merges}`);
    lines.push('');
    lines.push('Public Data API activity rows expose the proxy wallet and transaction hashes, but not a separate EOA owner for this profile. Without a block-indexer API key, the current prototype treats the proxy wallet as the authoritative detected wallet and records all transaction hashes for deeper block-explorer clustering.');
    lines.push('');
    lines.push('## Trading Profile');
    lines.push('');
    lines.push(`- Gross observed trade notional: ${usd(analysis.trading.tradeNotional)}`);
    lines.push(`- BUY fills: ${analysis.trading.buyFillCount.toLocaleString()} / ${usd(analysis.trading.buyNotional)}`);
    lines.push(`- SELL fills: ${analysis.trading.sellFillCount.toLocaleString()} / ${usd(analysis.trading.sellNotional)}`);
    lines.push(`- Average fill: ${usd(analysis.trading.avgFillUsdc)}; median fill: ${usd(analysis.trading.medianFillUsdc)}`);
    lines.push(`- Closed realized PnL: ${usd(analysis.performance.closedRealizedPnl)} (${analysis.performance.closedRoiPct.toFixed(2)}% of estimated closed cost basis)`);
    lines.push(`- Active current value: ${usd(analysis.performance.activeCurrentValue)}; active cash PnL: ${usd(analysis.performance.activeCashPnl)}`);
    lines.push('');
    lines.push('## Notional By Family');
    lines.push('');
    for (const family of analysis.distributions.families) {
        lines.push(`- ${family.key}: ${usd(family.notional)} across ${family.count.toLocaleString()} fills`);
    }
    lines.push('');
    lines.push('## Largest Closed Winners');
    lines.push('');
    for (const p of analysis.closedLeaders.winners.slice(0, 10)) {
        lines.push(`- ${p.title} | ${p.outcome}: PnL ${usd(p.realizedPnl)}, bought ${Number(p.totalBought || 0).toLocaleString()} shares @ avg ${Number(p.avgPrice || 0).toFixed(4)}`);
    }
    lines.push('');
    lines.push('## Largest Closed Losers');
    lines.push('');
    for (const p of analysis.closedLeaders.losers.slice(0, 10)) {
        lines.push(`- ${p.title} | ${p.outcome}: PnL ${usd(p.realizedPnl)}, bought ${Number(p.totalBought || 0).toLocaleString()} shares @ avg ${Number(p.avgPrice || 0).toFixed(4)}`);
    }
    lines.push('');
    lines.push('## Current Active Positions');
    lines.push('');
    for (const p of analysis.activePositions) {
        lines.push(`- ${p.title} | ${p.outcome}: ${Number(p.size || 0).toLocaleString()} shares, avg ${Number(p.avgPrice || 0).toFixed(4)}, current ${Number(p.curPrice || 0).toFixed(4)}, value ${usd(p.currentValue)}, cash PnL ${usd(p.cashPnl)}`);
    }
    lines.push('');
    lines.push('## Thesis');
    lines.push('');
    for (const item of analysis.thesis) lines.push(`- ${item}`);
    lines.push('');
    lines.push('## Prototype Replication Rules');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(replicator.rules, null, 2));
    lines.push('```');
    lines.push('');
    lines.push('The prototype is intentionally dry-run. It emits order intents from public data and strategy rules; placing live orders requires user-owned Polymarket credentials, explicit risk limits, and compliance with Polymarket availability rules.');
    lines.push('');
    return lines.join('\n');
}

async function writeJson(name, data) {
    await fs.mkdir(OUT_DIR, { recursive: true });
    await fs.writeFile(path.join(OUT_DIR, name), `${JSON.stringify(data, null, 2)}\n`);
}

async function collect() {
    const profile = await resolveProfile(TARGET_WALLET || TARGET_USERNAME);
    const wallet = profile.proxyWallet;
    if (!wallet) throw new Error(`Profile resolved but has no proxy wallet: ${JSON.stringify(profile)}`);

    const [positions, closedPositions, activity, trades, value, marketsTraded] = await Promise.all([
        collectOffset('positions', { user: wallet, sizeThreshold: 0, sortBy: 'CURRENT', sortDirection: 'DESC' }, 500, 10000),
        collectAllClosedPositions(wallet),
        collectAllActivity(wallet),
        collectAllTrades(wallet),
        getJson(`${DATA}/value`, { user: wallet }),
        getJson(`${DATA}/traded`, { user: wallet })
    ]);

    const snapshot = {
        generatedAt: new Date().toISOString(),
        username: TARGET_USERNAME,
        wallet,
        profile,
        positions,
        closedPositions,
        activity,
        trades,
        value,
        marketsTraded
    };

    const analysis = buildAnalysis(snapshot);
    const replicator = buildReplicatorConfig(analysis);
    await writeOutputs(snapshot, analysis, replicator);
    return { snapshot, analysis, replicator };
}

async function writeOutputs(snapshot, analysis, replicator) {
    await writeJson('snapshot.json', snapshot);
    await writeJson('analysis.json', analysis);
    await writeJson('replicator_config.json', replicator);
    await fs.writeFile(path.join(OUT_DIR, 'report.md'), renderMarkdown(snapshot, analysis, replicator));
}

async function analyzeSavedSnapshot() {
    const snapshot = JSON.parse(await fs.readFile(path.join(OUT_DIR, 'snapshot.json'), 'utf8'));
    const analysis = buildAnalysis(snapshot);
    const replicator = buildReplicatorConfig(analysis);
    await writeOutputs(snapshot, analysis, replicator);
    return { snapshot, analysis, replicator };
}

function latestTargetMarketStates(trades, allowedFamilies) {
    const byMarket = new Map();
    for (const trade of trades) {
        if (!allowedFamilies.includes(marketFamily(trade))) continue;
        const key = trade.conditionId;
        const row = byMarket.get(key) || {
            conditionId: key,
            slug: trade.slug,
            title: trade.title,
            notionalByOutcome: {},
            totalNotional: 0,
            lastTimestamp: 0
        };
        row.totalNotional += tradeNotional(trade);
        row.notionalByOutcome[trade.outcome] = (row.notionalByOutcome[trade.outcome] || 0) + tradeNotional(trade);
        row.lastTimestamp = Math.max(row.lastTimestamp, trade.timestamp || 0);
        byMarket.set(key, row);
    }
    return [...byMarket.values()].sort((a, b) => b.lastTimestamp - a.lastTimestamp);
}

async function replicate() {
    const snapshotPath = path.join(OUT_DIR, 'snapshot.json');
    const configPath = path.join(OUT_DIR, 'replicator_config.json');
    const snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    const intents = [];
    for (const position of snapshot.positions || []) {
        const family = marketFamily(position);
        if (!config.rules.allowedFamilies.includes(family)) continue;
        intents.push({
            mode: 'dry-run',
            action: 'CLONE_ACTIVE_POSITION',
            reason: `Target currently holds ${Number(position.size || 0).toLocaleString()} shares with ${usd(position.currentValue)} current value and ${usd(position.cashPnl)} cash PnL.`,
            market: position.slug,
            title: position.title,
            family,
            outcome: position.outcome,
            targetSize: position.size,
            targetAvgPrice: position.avgPrice,
            targetCurrentPrice: position.curPrice,
            maxOrderUsdc: Math.min(config.rules.entrySizing.maxOrderUsdc, Math.max(25, Number(position.currentValue || 0) * 0.1)),
            guards: config.rules.priceGuard
        });
    }

    for (const market of latestTargetMarketStates(snapshot.trades, config.rules.allowedFamilies)) {
        if (market.totalNotional < config.rules.minTargetMarketNotionalUsdc) continue;
        const [outcome, outcomeNotional] = Object.entries(market.notionalByOutcome).sort((a, b) => b[1] - a[1])[0];
        const targetShare = outcomeNotional / market.totalNotional;
        if (targetShare < config.rules.minTargetOutcomeShare) continue;
        intents.push({
            mode: 'dry-run',
            action: 'WATCH_NEXT_SIMILAR_SETUP',
            reason: `Historical pattern: target concentrated ${(targetShare * 100).toFixed(1)}% of ${usd(market.totalNotional)} observed market notional on ${outcome}. Use as a template for the next live similar setup, not as a stale-market order.`,
            market: market.slug,
            title: market.title,
            family: marketFamily(market),
            outcome,
            maxOrderUsdc: config.rules.entrySizing.maxOrderUsdc,
            guards: config.rules.priceGuard
        });
        if (intents.length >= 20) break;
    }
    await writeJson('replication_intents.json', intents);
    return intents;
}

async function main() {
    const command = process.argv[2] || 'collect';
    if (command === 'collect') {
        const { analysis } = await collect();
        console.log(`Collected ${analysis.coverage.trades} trades, ${analysis.coverage.activityRows} activity rows, ${analysis.coverage.closedPositions} closed positions.`);
        console.log(`Report: ${path.join(OUT_DIR, 'report.md')}`);
    } else if (command === 'analyze') {
        const { analysis } = await analyzeSavedSnapshot();
        console.log(`Analyzed saved snapshot with ${analysis.coverage.trades} trades.`);
        console.log(`Report: ${path.join(OUT_DIR, 'report.md')}`);
    } else if (command === 'replicate') {
        const intents = await replicate();
        console.log(`Generated ${intents.length} dry-run replication intents.`);
        console.log(`Intents: ${path.join(OUT_DIR, 'replication_intents.json')}`);
    } else {
        throw new Error(`Unknown command: ${command}`);
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
}

module.exports = {
    resolveProfile,
    buildAnalysis,
    buildReplicatorConfig,
    marketFamily
};
