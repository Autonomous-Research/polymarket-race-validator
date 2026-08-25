'use strict';

const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');

const GAMMA_API = 'https://gamma-api.polymarket.com';
const DATA_API = 'https://data-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';
const BLOCKSCOUT_API = 'https://polygon.blockscout.com/api/v2';
const POLYGON_RPC = process.env.POLYGON_RPC || 'https://polygon-bor-rpc.publicnode.com';
const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 30_000);

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(url, params = {}, attempt = 1) {
    try {
        const response = await axios.get(url, {
            params,
            timeout: HTTP_TIMEOUT_MS,
            headers: { accept: 'application/json' }
        });
        return response.data;
    } catch (error) {
        const status = error.response?.status;
        if (attempt < 6 && (!status || status === 408 || status === 429 || status >= 500)) {
            await sleep(400 * attempt * attempt);
            return getJson(url, params, attempt + 1);
        }
        const detail = error.response?.data ? JSON.stringify(error.response.data).slice(0, 500) : error.message;
        throw new Error(`GET ${url} failed (${status || 'network'}): ${detail}`);
    }
}

async function mapLimit(items, concurrency, worker, onProgress) {
    const results = new Array(items.length);
    let next = 0;
    let completed = 0;

    async function run() {
        while (true) {
            const index = next++;
            if (index >= items.length) return;
            results[index] = await worker(items[index], index);
            completed += 1;
            if (onProgress) onProgress(completed, items.length);
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
    return results;
}

function uniqueBy(items, keyFn) {
    const seen = new Set();
    return items.filter((item) => {
        const key = keyFn(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function sum(items, valueFn) {
    return items.reduce((total, item) => total + Number(valueFn(item) || 0), 0);
}

function median(values) {
    const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return 0;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function quantile(values, q) {
    const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return 0;
    const position = (sorted.length - 1) * q;
    const lower = Math.floor(position);
    const remainder = position - lower;
    return sorted[lower + 1] === undefined
        ? sorted[lower]
        : sorted[lower] + remainder * (sorted[lower + 1] - sorted[lower]);
}

function mean(values) {
    const finite = values.map(Number).filter(Number.isFinite);
    return finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : 0;
}

function pearson(xs, ys) {
    const pairs = xs.map((x, index) => [Number(x), Number(ys[index])])
        .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    if (pairs.length < 2) return 0;
    const xMean = mean(pairs.map(([x]) => x));
    const yMean = mean(pairs.map(([, y]) => y));
    let numerator = 0;
    let xSquare = 0;
    let ySquare = 0;
    for (const [x, y] of pairs) {
        const dx = x - xMean;
        const dy = y - yMean;
        numerator += dx * dy;
        xSquare += dx * dx;
        ySquare += dy * dy;
    }
    return xSquare && ySquare ? numerator / Math.sqrt(xSquare * ySquare) : 0;
}

function pct(numerator, denominator) {
    return denominator ? (Number(numerator) / Number(denominator)) * 100 : 0;
}

function iso(timestamp) {
    return timestamp ? new Date(Number(timestamp) * 1000).toISOString() : null;
}

function tradeQuoteNotional(trade) {
    return Number(trade.size || 0) * Number(trade.price || 0);
}

function activityCashNotional(activity) {
    return Number(activity.usdcSize || 0);
}

function jsonReplacer(_key, value) {
    return typeof value === 'bigint' ? value.toString() : value;
}

async function readJson(filePath) {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value, space = 2) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(value, jsonReplacer, space)}\n`);
}

module.exports = {
    BLOCKSCOUT_API,
    CLOB_API,
    DATA_API,
    GAMMA_API,
    POLYGON_RPC,
    activityCashNotional,
    getJson,
    iso,
    mapLimit,
    mean,
    median,
    pct,
    pearson,
    quantile,
    readJson,
    sleep,
    sum,
    tradeQuoteNotional,
    uniqueBy,
    writeJson
};
