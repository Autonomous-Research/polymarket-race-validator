const test = require('node:test');
const assert = require('node:assert');
const { getAuthHeaders } = require('../src/utils');
const { marketFamily, buildReplicatorConfig } = require('../src/trader_research');

test('getAuthHeaders - without API key', () => {
    const headers = getAuthHeaders('GET', '/markets', '', {});
    assert.deepStrictEqual(headers, { 'Content-Type': 'application/json' });
});

test('getAuthHeaders - with API key', () => {
    const env = {
        POLY_API_KEY: 'test-key',
        POLY_API_SECRET: 'dGVzdC1zZWNyZXQ=', // 'test-secret' in base64
        POLY_API_PASSPHRASE: 'test-pass'
    };
    
    const headers = getAuthHeaders('GET', '/markets', '', env);
    
    assert.strictEqual(headers['POLY_API_KEY'], 'test-key');
    assert.strictEqual(headers['POLY_PASSPHRASE'], 'test-pass');
    assert.strictEqual(headers['Content-Type'], 'application/json');
    assert.ok(headers['POLY_SIGNATURE']);
    assert.ok(headers['POLY_TIMESTAMP']);
});

test('marketFamily classifies core target market families', () => {
    assert.strictEqual(marketFamily({ slug: 'btc-updown-5m-1782022500', title: 'Bitcoin Up or Down' }), 'crypto-5m');
    assert.strictEqual(marketFamily({ slug: 'dota2-vsn2-ts8-2026-08-23', title: 'Dota 2: TEAM VISION vs Team Spirit' }), 'esports');
    assert.strictEqual(marketFamily({ slug: 'mlb-bos-mia-2026-08-24', title: 'Boston Red Sox vs. Miami Marlins' }), 'sports');
    assert.strictEqual(marketFamily({ slug: 'wta-swiatek-rybakin-2026-08-20', title: 'Cincinnati Open: Iga Swiatek vs Elena Rybakina' }), 'sports');
    assert.strictEqual(marketFamily({ slug: 'atp-nedic-estevez-2026-08-24', title: 'Augsburg: Andrej Nedic vs Juan Estevez' }), 'sports');
});

test('buildReplicatorConfig stays dry-run and ignores crypto by default', () => {
    const config = buildReplicatorConfig({
        generatedAt: '2026-08-25T00:00:00.000Z',
        wallet: '0x0000000000000000000000000000000000000000',
        trading: { medianFillUsdc: 42 },
        distributions: {
            topMarkets: [
                { family: 'esports', slug: 'dota2-test', title: 'Dota 2 test', notional: 100, outcomes: ['A'] },
                { family: 'crypto-5m', slug: 'btc-updown-test', title: 'BTC test', notional: 100, outcomes: ['Up'] }
            ]
        }
    });

    assert.strictEqual(config.mode, 'dry-run');
    assert.deepStrictEqual(config.rules.allowedFamilies, ['esports', 'sports']);
    assert.deepStrictEqual(config.rules.ignoredFamilies, ['crypto-5m']);
    assert.strictEqual(config.seedWatchlist.length, 1);
});
