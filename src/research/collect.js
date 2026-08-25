'use strict';

const {
    CLOB_API,
    DATA_API,
    GAMMA_API,
    getJson,
    mapLimit,
    uniqueBy
} = require('./common');

const MIN_TIMESTAMP = Number(process.env.START_TS || 1);

async function resolveProfile(usernameOrWallet) {
    let wallet = usernameOrWallet;
    let searchProfile = null;
    if (!/^0x[a-fA-F0-9]{40}$/.test(usernameOrWallet)) {
        const search = await getJson(`${GAMMA_API}/public-search`, {
            q: usernameOrWallet,
            search_profiles: true,
            limit_per_type: 10,
            optimized: true,
            cache: false
        });
        const profiles = search.profiles || [];
        searchProfile = profiles.find((profile) => String(profile.name || '').toLowerCase() === usernameOrWallet.toLowerCase());
        if (!searchProfile) {
            throw new Error(`No exact Polymarket profile match for ${usernameOrWallet}`);
        }
        wallet = searchProfile.proxyWallet;
    }

    const fullProfile = await getJson(`${GAMMA_API}/public-profile`, { address: wallet });
    return { ...searchProfile, ...fullProfile, proxyWallet: wallet };
}

async function collectOffset(endpoint, params, limit, offsetCap) {
    const rows = [];
    for (let offset = 0; offset <= offsetCap; offset += limit) {
        const page = await getJson(`${DATA_API}/${endpoint}`, { ...params, limit, offset });
        if (!Array.isArray(page)) throw new Error(`${endpoint} returned a non-array response`);
        rows.push(...page);
        if (page.length < limit) break;
    }
    return rows;
}

async function collectWindowed(endpoint, baseParams, options) {
    const { limit, offsetCap, start, end, sortDirection = 'ASC' } = options;
    const rows = await collectOffset(endpoint, { ...baseParams, start, end, sortDirection }, limit, offsetCap);
    const hitCap = rows.length >= offsetCap + limit;
    const allSameSecond = rows.length > 0 && rows.every((row) => row.timestamp === rows[0].timestamp);
    if (!hitCap || allSameSecond || end - start <= 1) return rows;

    const middle = Math.floor((start + end) / 2);
    const [left, right] = await Promise.all([
        collectWindowed(endpoint, baseParams, { ...options, end: middle }),
        collectWindowed(endpoint, baseParams, { ...options, start: middle + 1 })
    ]);
    return uniqueBy([...left, ...right], (row) => `${row.transactionHash}|${row.type || ''}|${row.asset || ''}`);
}

async function collectTrades(wallet, takerOnly) {
    const now = Math.floor(Date.now() / 1000) + 3600;
    const rows = await collectWindowed('trades', { user: wallet, takerOnly }, {
        limit: 10_000,
        offsetCap: 10_000,
        start: MIN_TIMESTAMP,
        end: now,
        sortDirection: 'ASC'
    });
    return rows.sort((a, b) => a.timestamp - b.timestamp || a.transactionHash.localeCompare(b.transactionHash));
}

async function collectActivity(wallet) {
    const now = Math.floor(Date.now() / 1000) + 3600;
    const rows = await collectWindowed('activity', {
        user: wallet,
        excludeDepositsWithdrawals: false
    }, {
        limit: 500,
        offsetCap: 5_000,
        start: MIN_TIMESTAMP,
        end: now,
        sortDirection: 'ASC'
    });
    return rows.sort((a, b) => a.timestamp - b.timestamp || a.transactionHash.localeCompare(b.transactionHash));
}

async function collectClosedPositions(wallet) {
    const rows = [];
    const limit = 50;
    for (let offset = 0; offset <= 100_000; offset += limit) {
        const page = await getJson(`${DATA_API}/closed-positions`, {
            user: wallet,
            limit,
            offset,
            sortBy: 'TIMESTAMP',
            sortDirection: 'DESC'
        });
        if (!Array.isArray(page)) throw new Error('closed-positions returned a non-array response');
        rows.push(...page);
        if (page.length < limit) break;
    }
    return rows;
}

async function collectSnapshot(usernameOrWallet) {
    const profile = await resolveProfile(usernameOrWallet);
    const wallet = profile.proxyWallet;
    const [positions, closedPositions, activity, trades, value, marketsTraded] = await Promise.all([
        collectOffset('positions', {
            user: wallet,
            sizeThreshold: 0,
            sortBy: 'CURRENT',
            sortDirection: 'DESC'
        }, 500, 10_000),
        collectClosedPositions(wallet),
        collectActivity(wallet),
        collectTrades(wallet, false),
        getJson(`${DATA_API}/value`, { user: wallet }),
        getJson(`${DATA_API}/traded`, { user: wallet })
    ]);

    return {
        generatedAt: new Date().toISOString(),
        username: usernameOrWallet,
        wallet,
        profile,
        positions,
        closedPositions,
        activity,
        trades,
        value,
        marketsTraded
    };
}

function compactMarket(market) {
    return {
        conditionId: market.condition_id,
        questionId: market.question_id,
        question: market.question,
        description: market.description,
        slug: market.market_slug,
        active: market.active,
        closed: market.closed,
        acceptingOrders: market.accepting_orders,
        acceptingOrderTimestamp: market.accepting_order_timestamp,
        gameStartTime: market.game_start_time,
        endDate: market.end_date_iso,
        secondsDelay: market.seconds_delay,
        makerBaseFee: market.maker_base_fee,
        takerBaseFee: market.taker_base_fee,
        negRisk: market.neg_risk,
        rewards: market.rewards || null,
        tags: market.tags || [],
        tokens: market.tokens || []
    };
}

async function collectMarketMetadata(conditionIds, progress = console.log) {
    let lastReported = 0;
    const rows = await mapLimit([...new Set(conditionIds)], 12, async (conditionId) => {
        try {
            return compactMarket(await getJson(`${CLOB_API}/markets/${conditionId}`));
        } catch (error) {
            return { conditionId, error: error.message };
        }
    }, (completed, total) => {
        if (completed === total || completed - lastReported >= 50) {
            lastReported = completed;
            progress(`Market metadata: ${completed}/${total}`);
        }
    });
    return rows;
}

function utcDatesBetween(firstTimestamp, lastTimestamp) {
    const dates = [];
    const cursor = new Date(Number(firstTimestamp) * 1000);
    cursor.setUTCHours(0, 0, 0, 0);
    const end = new Date(Number(lastTimestamp) * 1000);
    end.setUTCHours(0, 0, 0, 0);
    while (cursor <= end) {
        dates.push(cursor.toISOString().slice(0, 10));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return dates;
}

async function collectMakerRebates(wallet, firstTimestamp, lastTimestamp, progress = console.log) {
    const dates = utcDatesBetween(firstTimestamp, lastTimestamp);
    let lastReported = 0;
    const pages = await mapLimit(dates, 6, async (date) => {
        try {
            const rows = await getJson(`${CLOB_API}/rebates/current`, {
                date,
                maker_address: wallet
            });
            return Array.isArray(rows) ? rows : [];
        } catch (error) {
            progress(`Maker rebates unavailable for ${date}: ${error.message}`);
            return [];
        }
    }, (completed, total) => {
        if (completed === total || completed - lastReported >= 20) {
            lastReported = completed;
            progress(`Maker rebates: ${completed}/${total} days`);
        }
    });
    return pages.flat();
}

module.exports = {
    collectActivity,
    collectMakerRebates,
    collectMarketMetadata,
    collectSnapshot,
    collectTrades,
    resolveProfile
};
