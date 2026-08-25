const test = require('node:test');
const assert = require('node:assert');
const { getAuthHeaders } = require('../src/utils');

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
