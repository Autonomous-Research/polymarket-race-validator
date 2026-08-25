'use strict';

const {
    iso,
    mean,
    median,
    pct,
    pearson,
    quantile,
    sum,
    tradeQuoteNotional
} = require('./common');
const { runBacktests } = require('./backtest');

function classifyDiscipline(row, metadata = {}) {
    const tags = (metadata.tags || []).join(' ').toLowerCase();
    const text = `${row.title || row.question || ''} ${row.slug || ''} ${tags}`.toLowerCase();
    if (text.includes('btc-updown') || text.includes('bitcoin up or down') || text.includes('eth-updown')) return 'Crypto 5m';
    if (text.includes('dota')) return 'Dota 2';
    if (text.includes('counter-strike') || text.includes('counter strike') || text.includes('cs2')) return 'Counter-Strike';
    if (text.includes('league of legends') || /(^|\s)lol[-\s]/.test(text)) return 'League of Legends';
    if (text.includes('valorant')) return 'Valorant';
    if (text.includes('tennis') || text.includes('atp-') || text.includes('wta-') || text.includes(' open:')) return 'Tennis';
    if (text.includes('mlb') || text.includes('red sox') || text.includes('dodgers') || text.includes('baseball')) return 'MLB';
    if (text.includes('nba') || text.includes('basketball')) return 'Basketball';
    if (text.includes('nhl') || text.includes('hockey')) return 'Hockey';
    if (text.includes('soccer') || text.includes('football') || text.includes('team to advance') || text.includes('world cup')) return 'Soccer';
    if (text.includes('cricket')) return 'Cricket';
    if (text.includes('politic') || text.includes('election') || text.includes('president')) return 'Politics';
    if (tags.includes('esports')) return 'Other esports';
    if (tags.includes('sports')) return 'Other sports';
    return 'Other';
}

function classifyMarketType(row) {
    const title = String(row.title || '').toLowerCase();
    if (/\b(game|map) \d+ winner/.test(title)) return 'single-game/map';
    if (/\(bo\d+\)/.test(title)) return 'series winner';
    if (title.includes('team to advance')) return 'team to advance';
    if (/will .* win/.test(title)) return 'outright';
    if (title.includes('up or down')) return 'short-horizon binary';
    return 'match winner';
}

function groupBy(items, keyFn) {
    const map = new Map();
    for (const item of items) {
        const key = keyFn(item);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(item);
    }
    return map;
}

function activityTradeMap(activity) {
    return new Map(activity.filter((row) => row.type === 'TRADE').map((row) => [row.transactionHash, row]));
}

function inferObservedFee(trade, activity) {
    if (!activity) return 0;
    const quote = tradeQuoteNotional(trade);
    const cash = Number(activity.usdcSize || quote);
    const fee = trade.side === 'BUY' ? cash - quote : quote - cash;
    return Math.abs(fee) < 0.000005 ? 0 : Math.max(0, fee);
}

function buildOutcomeStats(trades) {
    const outcomes = new Map();
    for (const trade of trades) {
        const current = outcomes.get(trade.outcome) || {
            outcome: trade.outcome,
            buyShares: 0,
            sellShares: 0,
            buyQuoteUsdc: 0,
            sellQuoteUsdc: 0,
            buyCashUsdc: 0,
            sellCashUsdc: 0,
            makerQuoteUsdc: 0,
            takerQuoteUsdc: 0,
            fills: 0,
            firstTimestamp: trade.timestamp,
            lastTimestamp: trade.timestamp,
            lastPrice: Number(trade.price)
        };
        const side = trade.side === 'BUY' ? 'buy' : 'sell';
        current[`${side}Shares`] += Number(trade.size || 0);
        current[`${side}QuoteUsdc`] += trade.quoteNotional;
        current[`${side}CashUsdc`] += trade.cashNotional;
        current[`${trade.liquidityRole.toLowerCase()}QuoteUsdc`] += trade.quoteNotional;
        current.fills += 1;
        current.firstTimestamp = Math.min(current.firstTimestamp, trade.timestamp);
        current.lastTimestamp = Math.max(current.lastTimestamp, trade.timestamp);
        current.lastPrice = Number(trade.price);
        outcomes.set(trade.outcome, current);
    }
    return [...outcomes.values()].map((outcome) => ({
        ...outcome,
        netShares: outcome.buyShares - outcome.sellShares,
        netCashInvestedUsdc: outcome.buyCashUsdc - outcome.sellCashUsdc
    })).sort((a, b) => b.buyCashUsdc - a.buyCashUsdc);
}

function resolvedWinner(metadata, closedPositions) {
    const token = (metadata.tokens || []).find((item) => item.winner === true);
    if (token) return token.outcome;
    const closed = closedPositions.find((position) => Number(position.curPrice || 0) >= 0.99);
    return closed?.outcome || null;
}

function buildMarketRecords(snapshot, enrichment) {
    const metadataMap = new Map((enrichment.marketMetadata || []).map((market) => [market.conditionId, market]));
    const closedMap = groupBy(snapshot.closedPositions || [], (position) => position.conditionId);
    const tradeActivity = activityTradeMap(snapshot.activity || []);
    const takerHashes = new Set((enrichment.takerTrades || []).map((trade) => trade.transactionHash));
    const rebatesMap = groupBy(enrichment.makerRebates || [], (rebate) => rebate.condition_id);
    const tradeMap = groupBy(snapshot.trades || [], (trade) => trade.conditionId);
    const records = [];

    for (const [conditionId, rawTrades] of tradeMap) {
        const metadata = metadataMap.get(conditionId) || {};
        const closedPositions = closedMap.get(conditionId) || [];
        const trades = rawTrades.map((trade) => {
            const activity = tradeActivity.get(trade.transactionHash);
            // The public trades feed can show one maker sub-fill while activity reports
            // the target's full fill in that settlement. Activity is authoritative for
            // target size/cash; the transaction hash remains the one-to-one join key.
            const normalized = {
                ...trade,
                side: activity?.side || trade.side,
                asset: activity?.asset || trade.asset,
                outcome: activity?.outcome || trade.outcome,
                size: Number(activity?.size ?? trade.size),
                price: Number(activity?.price ?? trade.price)
            };
            const observedFeeUsdc = inferObservedFee(normalized, activity);
            const liquidityRole = takerHashes.size
                ? (takerHashes.has(trade.transactionHash) ? 'TAKER' : 'MAKER')
                : (observedFeeUsdc > 0 ? 'TAKER' : 'MAKER');
            return {
                ...normalized,
                publicTradeSize: Number(trade.size || 0),
                activityReportedSize: activity ? Number(activity.size || 0) : null,
                quoteNotional: tradeQuoteNotional(normalized),
                cashNotional: Number(activity?.usdcSize || tradeQuoteNotional(normalized)),
                observedFeeUsdc,
                liquidityRole
            };
        }).sort((a, b) => a.timestamp - b.timestamp || a.transactionHash.localeCompare(b.transactionHash));
        const outcomeStats = buildOutcomeStats(trades);
        const dominant = outcomeStats[0] || {};
        const totalBuy = sum(outcomeStats, (outcome) => outcome.buyCashUsdc);
        const totalQuote = sum(trades, (trade) => trade.quoteNotional);
        const makerQuote = sum(trades.filter((trade) => trade.liquidityRole === 'MAKER'), (trade) => trade.quoteNotional);
        const takerQuote = totalQuote - makerQuote;
        const gameStartTimestamp = metadata.gameStartTime ? Date.parse(metadata.gameStartTime) / 1000 : null;
        const firstTradeTimestamp = trades[0].timestamp;
        const lastTradeTimestamp = trades.at(-1).timestamp;
        const pregameQuote = gameStartTimestamp
            ? sum(trades.filter((trade) => trade.timestamp < gameStartTimestamp), (trade) => trade.quoteNotional)
            : 0;
        const inPlayQuote = gameStartTimestamp ? totalQuote - pregameQuote : 0;
        const rebateRows = rebatesMap.get(conditionId) || [];
        const makerRebatesUsdc = sum(rebateRows, (rebate) => rebate.rebated_fees_usdc);
        const cost = sum(closedPositions, (position) => Number(position.totalBought || 0) * Number(position.avgPrice || 0));
        const pnl = sum(closedPositions, (position) => position.realizedPnl);
        const winner = resolvedWinner(metadata, closedPositions);

        records.push({
            conditionId,
            title: trades[0].title,
            slug: trades[0].slug,
            eventSlug: trades[0].eventSlug,
            discipline: classifyDiscipline(trades[0], metadata),
            marketType: classifyMarketType(trades[0]),
            tags: metadata.tags || [],
            gameStartTime: metadata.gameStartTime || null,
            gameStartTimestamp,
            firstTradeTimestamp,
            lastTradeTimestamp,
            firstTradeTime: iso(firstTradeTimestamp),
            lastTradeTime: iso(lastTradeTimestamp),
            durationMinutes: (lastTradeTimestamp - firstTradeTimestamp) / 60,
            firstTradeMinutesFromStart: gameStartTimestamp ? (firstTradeTimestamp - gameStartTimestamp) / 60 : null,
            lastTradeMinutesFromStart: gameStartTimestamp ? (lastTradeTimestamp - gameStartTimestamp) / 60 : null,
            fills: trades.length,
            makerFills: trades.filter((trade) => trade.liquidityRole === 'MAKER').length,
            takerFills: trades.filter((trade) => trade.liquidityRole === 'TAKER').length,
            quoteNotionalUsdc: totalQuote,
            cashNotionalUsdc: sum(trades, (trade) => trade.cashNotional),
            buyCashUsdc: totalBuy,
            sellCashUsdc: sum(outcomeStats, (outcome) => outcome.sellCashUsdc),
            makerQuoteUsdc: makerQuote,
            takerQuoteUsdc: takerQuote,
            takerNotionalPct: pct(takerQuote, totalQuote),
            observedTakerFeesUsdc: sum(trades, (trade) => trade.observedFeeUsdc),
            makerRebatesUsdc,
            pregameQuoteUsdc: pregameQuote,
            inPlayQuoteUsdc: inPlayQuote,
            inPlayNotionalPct: gameStartTimestamp ? pct(inPlayQuote, totalQuote) : null,
            outcomes: outcomeStats,
            dominantOutcome: dominant.outcome || null,
            dominantOutcomeBuySharePct: pct(dominant.buyCashUsdc, totalBuy),
            tradedBothOutcomes: outcomeStats.length > 1,
            hasSells: outcomeStats.some((outcome) => outcome.sellShares > 0),
            resolvedWinner: winner,
            dominantOutcomeWon: winner ? dominant.outcome === winner : null,
            closedCostBasisUsdc: cost,
            realizedPnlUsdc: pnl,
            pnlWithMakerRebatesUsdc: pnl + makerRebatesUsdc,
            roiPct: pct(pnl, cost),
            closedPositions,
            metadata,
            _trades: trades
        });
    }
    for (const record of records) record.eventKey = canonicalEventKey(record);
    return records.sort((a, b) => a.firstTradeTimestamp - b.firstTradeTimestamp);
}

function aggregatePerformance(markets, keyFn) {
    return [...groupBy(markets, keyFn).entries()].map(([key, rows]) => {
        const cost = sum(rows, (row) => row.closedCostBasisUsdc);
        const pnl = sum(rows, (row) => row.realizedPnlUsdc);
        const grossWins = sum(rows.filter((row) => row.realizedPnlUsdc > 0), (row) => row.realizedPnlUsdc);
        const grossLosses = Math.abs(sum(rows.filter((row) => row.realizedPnlUsdc < 0), (row) => row.realizedPnlUsdc));
        return {
            key,
            markets: rows.length,
            resolvedMarkets: rows.filter((row) => row.resolvedWinner).length,
            costBasisUsdc: cost,
            realizedPnlUsdc: pnl,
            makerRebatesUsdc: sum(rows, (row) => row.makerRebatesUsdc),
            roiPct: pct(pnl, cost),
            profitableMarkets: rows.filter((row) => row.realizedPnlUsdc > 0).length,
            dominantOutcomeHitRatePct: pct(rows.filter((row) => row.dominantOutcomeWon).length, rows.filter((row) => row.resolvedWinner).length),
            profitFactor: grossLosses ? grossWins / grossLosses : grossWins ? Infinity : 0,
            quoteNotionalUsdc: sum(rows, (row) => row.quoteNotionalUsdc),
            takerNotionalPct: pct(sum(rows, (row) => row.takerQuoteUsdc), sum(rows, (row) => row.quoteNotionalUsdc))
        };
    }).sort((a, b) => b.costBasisUsdc - a.costBasisUsdc);
}

function priceBins(snapshot) {
    const definitions = [[0, 0.2], [0.2, 0.35], [0.35, 0.5], [0.5, 0.65], [0.65, 0.8], [0.8, 1.01]];
    return definitions.map(([low, high]) => {
        const rows = snapshot.closedPositions.filter((position) => Number(position.avgPrice) >= low && Number(position.avgPrice) < high);
        const cost = sum(rows, (position) => Number(position.totalBought) * Number(position.avgPrice));
        const pnl = sum(rows, (position) => position.realizedPnl);
        return {
            range: `${low.toFixed(2)}-${Math.min(high, 1).toFixed(2)}`,
            positions: rows.length,
            costBasisUsdc: cost,
            realizedPnlUsdc: pnl,
            roiPct: pct(pnl, cost),
            winRatePct: pct(rows.filter((position) => Number(position.curPrice) >= 0.99).length, rows.length),
            averageEntryPrice: mean(rows.map((position) => position.avgPrice))
        };
    });
}

function sizeBuckets(markets) {
    const rows = markets.filter((market) => market.closedCostBasisUsdc > 0).sort((a, b) => a.closedCostBasisUsdc - b.closedCostBasisUsdc);
    const cutoffs = [quantile(rows.map((row) => row.closedCostBasisUsdc), 0.25), quantile(rows.map((row) => row.closedCostBasisUsdc), 0.5), quantile(rows.map((row) => row.closedCostBasisUsdc), 0.75)];
    const label = (value) => value <= cutoffs[0] ? 'Q1 smallest' : value <= cutoffs[1] ? 'Q2' : value <= cutoffs[2] ? 'Q3' : 'Q4 largest';
    return aggregatePerformance(rows, (row) => label(row.closedCostBasisUsdc));
}

function canonicalEventKey(market) {
    const title = market.title
        .replace(/^(Dota 2|Counter-Strike|League of Legends|Valorant):\s*/i, '')
        .replace(/\s+-\s+(Game|Map) \d+ Winner.*$/i, '')
        .replace(/\s+\(BO\d+\).*$/i, '')
        .replace(/\s+-\s+[^-]+$/i, '')
        .trim();
    const match = title.match(/^(.+?)\s+vs\.?\s+(.+)$/i);
    if (!match) return null;
    const normalize = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const teams = [normalize(match[1]), normalize(match[2])].sort();
    const date = (market.gameStartTime || market.firstTradeTime || '').slice(0, 10);
    return `${date}|${teams.join('|')}`;
}

function timingPerformance(markets) {
    const timed = markets.filter((market) => market.gameStartTimestamp && market.closedCostBasisUsdc > 0);
    return {
        byFirstEntry: aggregatePerformance(timed, (market) =>
            market.firstTradeTimestamp < market.gameStartTimestamp ? 'started pregame' : 'started in-play'),
        byNotionalMajority: aggregatePerformance(timed, (market) =>
            market.pregameQuoteUsdc >= market.inPlayQuoteUsdc ? 'majority pregame' : 'majority in-play')
    };
}

function correlatedEventSummary(groups) {
    const aggregate = (rows) => {
        const cost = sum(rows, (row) => row.costBasisUsdc);
        const pnl = sum(rows, (row) => row.realizedPnlUsdc);
        return {
            groups: rows.length,
            costBasisUsdc: cost,
            realizedPnlUsdc: pnl,
            roiPct: pct(pnl, cost)
        };
    };
    const sameDirection = groups.filter((group) => group.consistentDirection);
    const mixedDirection = groups.filter((group) => !group.consistentDirection);
    const gameMapConditions = groups.flatMap((group) => group.conditions)
        .filter((condition) => condition.marketType === 'single-game/map');
    const gameMapCost = sum(gameMapConditions, (condition) => condition.costBasisUsdc);
    const gameMapPnl = sum(gameMapConditions, (condition) => condition.realizedPnlUsdc);
    return {
        all: aggregate(groups),
        sameDirection: aggregate(sameDirection),
        mixedDirection: aggregate(mixedDirection),
        gameMapLegs: {
            conditions: gameMapConditions.length,
            costBasisUsdc: gameMapCost,
            realizedPnlUsdc: gameMapPnl,
            roiPct: pct(gameMapPnl, gameMapCost)
        }
    };
}

function nearestPriorDeposit(snapshot, timestamp) {
    const deposits = snapshot.activity
        .filter((row) => row.type === 'DEPOSIT' && row.timestamp <= timestamp)
        .sort((a, b) => b.timestamp - a.timestamp);
    const deposit = deposits[0];
    return deposit ? {
        timestamp: deposit.timestamp,
        time: iso(deposit.timestamp),
        usdc: Number(deposit.usdcSize || 0),
        secondsBeforeReference: timestamp - deposit.timestamp,
        transactionHash: deposit.transactionHash
    } : null;
}

function phaseStats(market, predicate) {
    const trades = market._trades.filter(predicate);
    return {
        fills: trades.length,
        quoteNotionalUsdc: sum(trades, (trade) => trade.quoteNotional),
        makerQuoteUsdc: sum(trades.filter((trade) => trade.liquidityRole === 'MAKER'), (trade) => trade.quoteNotional),
        takerQuoteUsdc: sum(trades.filter((trade) => trade.liquidityRole === 'TAKER'), (trade) => trade.quoteNotional),
        takerBuyQuoteUsdc: sum(trades.filter((trade) => trade.liquidityRole === 'TAKER' && trade.side === 'BUY'), (trade) => trade.quoteNotional),
        takerSellQuoteUsdc: sum(trades.filter((trade) => trade.liquidityRole === 'TAKER' && trade.side === 'SELL'), (trade) => trade.quoteNotional)
    };
}

function accumulationMilestones(market) {
    const thresholds = [25_000, 100_000, 250_000, 500_000, 1_000_000];
    const rows = market._trades.filter((trade) =>
        trade.liquidityRole === 'TAKER'
        && trade.side === 'BUY'
        && trade.outcome === market.dominantOutcome);
    let cumulative = 0;
    let next = 0;
    const milestones = [];
    for (const trade of rows) {
        cumulative += trade.quoteNotional;
        while (next < thresholds.length && cumulative >= thresholds[next]) {
            milestones.push({
                thresholdUsdc: thresholds[next],
                timestamp: trade.timestamp,
                time: iso(trade.timestamp),
                price: Number(trade.price),
                cumulativeTakerBuyUsdc: cumulative,
                minutesFromStart: market.gameStartTimestamp
                    ? (trade.timestamp - market.gameStartTimestamp) / 60
                    : null,
                transactionHash: trade.transactionHash
            });
            next += 1;
        }
    }
    return milestones;
}

function marketCaseStudy(market, snapshot, label) {
    const takerBuys = market._trades.filter((trade) => trade.liquidityRole === 'TAKER' && trade.side === 'BUY');
    const firstAggressiveBuy = takerBuys[0];
    const largestAggressiveFills = market._trades
        .filter((trade) => trade.liquidityRole === 'TAKER')
        .sort((a, b) => b.quoteNotional - a.quoteNotional)
        .slice(0, 8)
        .map((trade) => ({
            time: iso(trade.timestamp),
            minutesFromStart: market.gameStartTimestamp
                ? (trade.timestamp - market.gameStartTimestamp) / 60
                : null,
            side: trade.side,
            outcome: trade.outcome,
            price: Number(trade.price),
            quoteNotionalUsdc: trade.quoteNotional,
            feeUsdc: trade.observedFeeUsdc,
            transactionHash: trade.transactionHash
        }));
    return {
        label,
        conditionId: market.conditionId,
        eventKey: market.eventKey,
        title: market.title,
        discipline: market.discipline,
        marketType: market.marketType,
        gameStartTime: market.gameStartTime,
        firstTradeTime: market.firstTradeTime,
        firstTradeMinutesFromStart: market.firstTradeMinutesFromStart,
        dominantOutcome: market.dominantOutcome,
        resolvedWinner: market.resolvedWinner,
        costBasisUsdc: market.closedCostBasisUsdc,
        realizedPnlUsdc: market.realizedPnlUsdc,
        roiPct: market.roiPct,
        takerNotionalPct: market.takerNotionalPct,
        nearestPriorDeposit: firstAggressiveBuy ? nearestPriorDeposit(snapshot, firstAggressiveBuy.timestamp) : null,
        phases: {
            pregame: phaseStats(market, (trade) => market.gameStartTimestamp && trade.timestamp < market.gameStartTimestamp),
            inPlay: phaseStats(market, (trade) => market.gameStartTimestamp && trade.timestamp >= market.gameStartTimestamp)
        },
        accumulationMilestones: accumulationMilestones(market),
        largestAggressiveFills
    };
}

function buildCaseStudies(markets, snapshot, correlatedGroups) {
    const resolved = markets.filter((market) => market.closedCostBasisUsdc > 0);
    const selected = [];
    const seen = new Set();
    const add = (market, label) => {
        if (!market || seen.has(market.conditionId)) return;
        seen.add(market.conditionId);
        selected.push(marketCaseStudy(market, snapshot, label));
    };
    resolved.slice().sort((a, b) => b.realizedPnlUsdc - a.realizedPnlUsdc).slice(0, 3)
        .forEach((market, index) => add(market, `top winner ${index + 1}`));
    resolved.slice().sort((a, b) => a.realizedPnlUsdc - b.realizedPnlUsdc).slice(0, 3)
        .forEach((market, index) => add(market, `top loss ${index + 1}`));
    correlatedGroups.slice().sort((a, b) => a.realizedPnlUsdc - b.realizedPnlUsdc).slice(0, 3)
        .forEach((group, groupIndex) => group.conditions.forEach((condition) =>
            add(markets.find((market) => market.conditionId === condition.conditionId), `correlated loss group ${groupIndex + 1}`)));
    return selected;
}

function correlatedEvents(markets) {
    const groups = new Map();
    for (const market of markets) {
        const key = canonicalEventKey(market);
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(market);
    }
    return [...groups.entries()]
        .filter(([, rows]) => rows.length > 1)
        .map(([key, rows]) => {
            const normalizeDirection = (outcome) => String(outcome || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
            const directions = [...new Set(rows.map((row) => normalizeDirection(row.dominantOutcome)).filter(Boolean))];
            return {
                key,
                markets: rows.length,
                conditions: rows.map((row) => ({
                    conditionId: row.conditionId,
                    title: row.title,
                    marketType: row.marketType,
                    dominantOutcome: row.dominantOutcome,
                    winner: row.resolvedWinner,
                    firstTradeTime: row.firstTradeTime,
                    costBasisUsdc: row.closedCostBasisUsdc,
                    realizedPnlUsdc: row.realizedPnlUsdc
                })),
                directions,
                consistentDirection: directions.length === 1,
                costBasisUsdc: sum(rows, (row) => row.closedCostBasisUsdc),
                realizedPnlUsdc: sum(rows, (row) => row.realizedPnlUsdc),
                roiPct: pct(sum(rows, (row) => row.realizedPnlUsdc), sum(rows, (row) => row.closedCostBasisUsdc))
            };
        })
        .sort((a, b) => b.costBasisUsdc - a.costBasisUsdc);
}

function cashAnalysis(snapshot, onchain = null) {
    const signed = (row) => {
        const amount = Number(row.usdcSize || 0);
        if (row.type === 'DEPOSIT') return amount;
        if (row.type === 'WITHDRAWAL') return -amount;
        if (row.type === 'TRADE') return row.side === 'BUY' ? -amount : amount;
        if (['REDEEM', 'REWARD', 'MAKER_REBATE', 'TAKER_REBATE', 'YIELD'].includes(row.type)) return amount;
        return 0;
    };
    const byType = [...groupBy(snapshot.activity, (row) => row.type).entries()].map(([type, rows]) => ({
        type,
        count: rows.length,
        usdc: sum(rows, (row) => row.usdcSize),
        signedCashUsdc: sum(rows, signed)
    })).sort((a, b) => b.usdc - a.usdc);
    const typeMap = Object.fromEntries(byType.map((row) => [row.type, row]));
    const activityLedgerResidualUsdc = sum(snapshot.activity, signed);
    const currentPositionValue = sum(snapshot.positions, (position) => position.currentValue);
    const onchainStablecoinBalance = Number(onchain?.wallet?.stablecoinBalanceUsdc ?? onchain?.wallet?.pusdBalance);
    const hasOnchainBalance = Number.isFinite(onchainStablecoinBalance);
    const netWithdrawn = Number(typeMap.WITHDRAWAL?.usdc || 0) - Number(typeMap.DEPOSIT?.usdc || 0);
    const closedPnl = sum(snapshot.closedPositions, (position) => position.realizedPnl);
    const rebatesAndRewards = ['MAKER_REBATE', 'TAKER_REBATE', 'REWARD', 'YIELD']
        .reduce((total, type) => total + Number(typeMap[type]?.usdc || 0), 0);
    const confirmedEconomicProfit = netWithdrawn
        + currentPositionValue
        + (hasOnchainBalance ? onchainStablecoinBalance : 0);
    const closedPnlPlusIncentives = closedPnl + rebatesAndRewards;

    const dailyMap = new Map();
    for (const row of snapshot.activity) {
        const day = iso(row.timestamp).slice(0, 10);
        const current = dailyMap.get(day) || { day, deposits: 0, withdrawals: 0, buys: 0, sells: 0, redeems: 0, rebates: 0 };
        if (row.type === 'DEPOSIT') current.deposits += Number(row.usdcSize);
        if (row.type === 'WITHDRAWAL') current.withdrawals += Number(row.usdcSize);
        if (row.type === 'REDEEM') current.redeems += Number(row.usdcSize);
        if (row.type === 'TRADE' && row.side === 'BUY') current.buys += Number(row.usdcSize);
        if (row.type === 'TRADE' && row.side === 'SELL') current.sells += Number(row.usdcSize);
        if (row.type.includes('REBATE')) current.rebates += Number(row.usdcSize);
        dailyMap.set(day, current);
    }
    const daily = [...dailyMap.values()];
    const buys = snapshot.activity.filter((row) => row.type === 'TRADE' && row.side === 'BUY').sort((a, b) => a.timestamp - b.timestamp);
    const deposits = snapshot.activity.filter((row) => row.type === 'DEPOSIT').sort((a, b) => a.timestamp - b.timestamp);
    const lags = deposits.map((deposit) => {
        const buy = buys.find((row) => row.timestamp >= deposit.timestamp);
        return buy ? buy.timestamp - deposit.timestamp : null;
    }).filter(Number.isFinite);

    return {
        byType,
        activityLedgerResidualUsdc,
        onchainStablecoinBalanceUsdc: hasOnchainBalance ? onchainStablecoinBalance : null,
        activityLedgerVsOnchainGapUsdc: hasOnchainBalance
            ? activityLedgerResidualUsdc - onchainStablecoinBalance
            : null,
        currentPositionValueUsdc: currentPositionValue,
        netWithdrawnUsdc: netWithdrawn,
        confirmedEconomicProfitUsdc: confirmedEconomicProfit,
        closedRealizedPnlUsdc: closedPnl,
        rebatesAndRewardsUsdc: rebatesAndRewards,
        closedPnlPlusIncentivesUsdc: closedPnlPlusIncentives,
        confirmedAccountingDifferenceUsdc: confirmedEconomicProfit - closedPnlPlusIncentives,
        capitalTurnover: pct(Number(typeMap.TRADE?.usdc || 0), Number(typeMap.DEPOSIT?.usdc || 0)) / 100,
        depositBuyCorrelationDaily: pearson(daily.map((row) => row.deposits), daily.map((row) => row.buys)),
        depositToNextBuyLag: {
            observations: lags.length,
            medianSeconds: median(lags),
            p90Seconds: quantile(lags, 0.9),
            withinOneMinutePct: pct(lags.filter((lag) => lag <= 60).length, lags.length),
            withinFiveMinutesPct: pct(lags.filter((lag) => lag <= 300).length, lags.length),
            withinFifteenMinutesPct: pct(lags.filter((lag) => lag <= 900).length, lags.length)
        },
        daily
    };
}

function roleAnalysis(markets) {
    const fills = markets.flatMap((market) => market._trades);
    const maker = fills.filter((trade) => trade.liquidityRole === 'MAKER');
    const taker = fills.filter((trade) => trade.liquidityRole === 'TAKER');
    const rates = taker.map((trade) => {
        const denominator = Number(trade.size) * Number(trade.price) * (1 - Number(trade.price));
        return denominator ? trade.observedFeeUsdc / denominator : 0;
    }).filter((rate) => rate > 0 && rate < 0.2);
    const makerRebatesUsdc = sum(markets, (market) => market.makerRebatesUsdc);
    const observedTakerFeesUsdc = sum(taker, (trade) => trade.observedFeeUsdc);
    const activityAdjusted = fills.filter((trade) =>
        trade.activityReportedSize !== null
        && Math.abs(trade.activityReportedSize - trade.publicTradeSize) > 0.000001);
    return {
        fills: fills.length,
        makerFills: maker.length,
        takerFills: taker.length,
        makerFillPct: pct(maker.length, fills.length),
        quoteNotionalUsdc: sum(fills, (trade) => trade.quoteNotional),
        makerQuoteNotionalUsdc: sum(maker, (trade) => trade.quoteNotional),
        takerQuoteNotionalUsdc: sum(taker, (trade) => trade.quoteNotional),
        makerNotionalPct: pct(sum(maker, (trade) => trade.quoteNotional), sum(fills, (trade) => trade.quoteNotional)),
        activitySizeJoinCoveragePct: pct(fills.filter((trade) => trade.activityReportedSize !== null).length, fills.length),
        publicTradeSizeAdjustedFills: activityAdjusted.length,
        publicTradeQuoteAdjustmentUsdc: sum(activityAdjusted, (trade) =>
            (trade.activityReportedSize - trade.publicTradeSize) * Number(trade.price)),
        observedTakerFeesUsdc,
        publicMakerRebatesUsdc: makerRebatesUsdc,
        netFeesLessMakerRebatesUsdc: observedTakerFeesUsdc - makerRebatesUsdc,
        medianInferredTakerFeeRate: median(rates),
        inferredFeeRateP10: quantile(rates, 0.1),
        inferredFeeRateP90: quantile(rates, 0.9),
        medianMakerFillUsdc: median(maker.map((trade) => trade.quoteNotional)),
        medianTakerFillUsdc: median(taker.map((trade) => trade.quoteNotional)),
        meanMakerFillUsdc: mean(maker.map((trade) => trade.quoteNotional)),
        meanTakerFillUsdc: mean(taker.map((trade) => trade.quoteNotional)),
        largestTakerFills: taker.slice().sort((a, b) => b.quoteNotional - a.quoteNotional).slice(0, 25).map((trade) => ({
            timestamp: trade.timestamp,
            time: iso(trade.timestamp),
            title: trade.title,
            outcome: trade.outcome,
            side: trade.side,
            size: trade.size,
            price: trade.price,
            quoteNotionalUsdc: trade.quoteNotional,
            observedFeeUsdc: trade.observedFeeUsdc,
            transactionHash: trade.transactionHash
        }))
    };
}

function concentrationAnalysis(markets) {
    const resolved = markets.filter((market) => market.closedCostBasisUsdc > 0);
    const sorted = resolved.slice().sort((a, b) => b.realizedPnlUsdc - a.realizedPnlUsdc);
    const total = sum(sorted, (market) => market.realizedPnlUsdc);
    const top = (count) => sum(sorted.slice(0, count), (market) => market.realizedPnlUsdc);
    const chronological = resolved.slice().sort((a, b) => a.lastTradeTimestamp - b.lastTradeTimestamp);
    let cumulative = 0;
    let peak = 0;
    let peakTimestamp = null;
    let maxDrawdown = 0;
    let drawdownFrom = null;
    let drawdownTo = null;
    for (const market of chronological) {
        cumulative += market.realizedPnlUsdc;
        if (cumulative > peak) {
            peak = cumulative;
            peakTimestamp = market.lastTradeTimestamp;
        }
        if (peak - cumulative > maxDrawdown) {
            maxDrawdown = peak - cumulative;
            drawdownFrom = peakTimestamp;
            drawdownTo = market.lastTradeTimestamp;
        }
    }
    return {
        totalRealizedPnlUsdc: total,
        top1PnlUsdc: top(1),
        top5PnlUsdc: top(5),
        top10PnlUsdc: top(10),
        top1ContributionPct: pct(top(1), total),
        top5ContributionPct: pct(top(5), total),
        pnlWithoutTop1Usdc: total - top(1),
        pnlWithoutTop5Usdc: total - top(5),
        pnlWithoutTop10Usdc: total - top(10),
        maxDrawdownUsdc: maxDrawdown,
        drawdownFrom: iso(drawdownFrom),
        drawdownTo: iso(drawdownTo),
        winners: sorted.slice(0, 25).map(stripMarket),
        losers: sorted.slice(-25).reverse().map(stripMarket)
    };
}

function stripMarket(market) {
    const { _trades, metadata, closedPositions, ...clean } = market;
    return clean;
}

function buildDeepAnalysis(snapshot, enrichment) {
    const markets = buildMarketRecords(snapshot, enrichment);
    const resolved = markets.filter((market) => market.closedCostBasisUsdc > 0);
    const role = roleAnalysis(markets);
    const cash = cashAnalysis(snapshot, enrichment.onchain);
    const backtest = runBacktests(markets);
    const gameTimed = markets.filter((market) => market.gameStartTimestamp);
    const correlatedGroups = correlatedEvents(markets);

    const analysis = {
        generatedAt: new Date().toISOString(),
        target: {
            username: snapshot.profile.name,
            pseudonym: snapshot.profile.pseudonym,
            profileCreatedAt: snapshot.profile.createdAt || null,
            profileUrl: `https://polymarket.com/@${snapshot.username}`,
            wallet: snapshot.wallet,
            owner: enrichment.onchain?.wallet?.owner || null
        },
        coverage: {
            firstTrade: iso(markets[0]?.firstTradeTimestamp),
            lastTrade: iso(markets.at(-1)?.lastTradeTimestamp),
            trades: snapshot.trades.length,
            activityRows: snapshot.activity.length,
            markets: markets.length,
            marketsWithMetadata: markets.filter((market) => market.metadata?.question).length,
            marketsWithGameStart: gameTimed.length,
            closedPositions: snapshot.closedPositions.length,
            resolvedMarkets: resolved.length,
            activePositions: snapshot.positions.length,
            takerEndpointTrades: enrichment.takerTrades?.length || 0,
            makerRebateRows: enrichment.makerRebates?.length || 0
        },
        execution: role,
        cash,
        performance: {
            closedCostBasisUsdc: sum(resolved, (market) => market.closedCostBasisUsdc),
            realizedPnlUsdc: sum(resolved, (market) => market.realizedPnlUsdc),
            roiPct: pct(sum(resolved, (market) => market.realizedPnlUsdc), sum(resolved, (market) => market.closedCostBasisUsdc)),
            activePositionValueUsdc: sum(snapshot.positions, (position) => position.currentValue),
            activeCashPnlUsdc: sum(snapshot.positions, (position) => position.cashPnl),
            byDiscipline: aggregatePerformance(resolved, (market) => market.discipline),
            byMarketType: aggregatePerformance(resolved, (market) => market.marketType),
            byEntryPrice: priceBins(snapshot),
            bySizeQuartile: sizeBuckets(resolved),
            byTakerNotionalShare: aggregatePerformance(resolved, (market) =>
                market.takerNotionalPct < 25 ? '0-25%' : market.takerNotionalPct < 50 ? '25-50%' : market.takerNotionalPct < 75 ? '50-75%' : '75-100%'),
            correlations: {
                logCostVsPnl: pearson(resolved.map((market) => Math.log1p(market.closedCostBasisUsdc)), resolved.map((market) => market.realizedPnlUsdc)),
                costVsPnl: pearson(resolved.map((market) => market.closedCostBasisUsdc), resolved.map((market) => market.realizedPnlUsdc)),
                takerShareVsRoi: pearson(resolved.map((market) => market.takerNotionalPct), resolved.map((market) => market.roiPct)),
                makerShareVsRoi: pearson(resolved.map((market) => 100 - market.takerNotionalPct), resolved.map((market) => market.roiPct))
            }
        },
        timing: {
            marketsWithGameStart: gameTimed.length,
            quoteNotionalUsdc: sum(gameTimed, (market) => market.quoteNotionalUsdc),
            pregameQuoteUsdc: sum(gameTimed, (market) => market.pregameQuoteUsdc),
            inPlayQuoteUsdc: sum(gameTimed, (market) => market.inPlayQuoteUsdc),
            inPlayNotionalPct: pct(sum(gameTimed, (market) => market.inPlayQuoteUsdc), sum(gameTimed, (market) => market.quoteNotionalUsdc)),
            firstTradeAfterStartPct: pct(gameTimed.filter((market) => market.firstTradeTimestamp >= market.gameStartTimestamp).length, gameTimed.length),
            lastTradeAfterStartPct: pct(gameTimed.filter((market) => market.lastTradeTimestamp >= market.gameStartTimestamp).length, gameTimed.length),
            medianFirstTradeMinutesFromStart: median(gameTimed.map((market) => market.firstTradeMinutesFromStart)),
            medianLastTradeMinutesFromStart: median(gameTimed.map((market) => market.lastTradeMinutesFromStart)),
            performance: timingPerformance(markets)
        },
        construction: {
            medianFillsPerMarket: median(markets.map((market) => market.fills)),
            medianDurationMinutes: median(markets.map((market) => market.durationMinutes)),
            marketsTradingBothOutcomes: markets.filter((market) => market.tradedBothOutcomes).length,
            marketsWithSells: markets.filter((market) => market.hasSells).length,
            medianDominantOutcomeBuySharePct: median(markets.map((market) => market.dominantOutcomeBuySharePct)),
            correlatedEventGroups: correlatedGroups,
            correlatedEventSummary: correlatedEventSummary(correlatedGroups)
        },
        concentration: concentrationAnalysis(markets),
        backtest,
        caseStudies: buildCaseStudies(markets, snapshot, correlatedGroups),
        activePositions: snapshot.positions,
        markets: markets.map(stripMarket)
    };
    return { analysis, markets };
}

module.exports = {
    aggregatePerformance,
    buildDeepAnalysis,
    buildMarketRecords,
    canonicalEventKey,
    cashAnalysis,
    classifyDiscipline,
    classifyMarketType,
    stripMarket
};
