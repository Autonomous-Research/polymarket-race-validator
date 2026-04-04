const crypto = require('crypto');

/**
 * Logger utility for standardized, colored console output.
 */
const Logger = {
    info: (msg) => console.log(`[\x1b[34mINFO\x1b[0m] ${new Date().toISOString()} - ${msg}`),
    warn: (msg) => console.warn(`[\x1b[33mWARN\x1b[0m] ${new Date().toISOString()} - ${msg}`),
    err: (msg, data) => {
        console.error(`[\x1b[31mERROR\x1b[0m] ${new Date().toISOString()} - ${msg}`);
        if (data) console.error(JSON.stringify(data, null, 2));
    },
    race: (msg) => console.log(`[\x1b[35mRACE\x1b[0m] \x1b[1m${msg}\x1b[0m`),
    step: (n, msg) => console.log(`\n\x1b[1mSTEP ${n}/5: ${msg}\x1b[0m`),
    res: (passed, msg) => {
        const color = passed ? "\x1b[32m" : "\x1b[31m";
        console.log(`\n\x1b[1m${color}RESULT: ${passed ? "YES" : "NO"}\x1b[0m - ${msg}\x1b[0m\n`);
    }
};

/**
 * Generates authentication headers for Polymarket API requests.
 * @param {string} method - The HTTP method (e.g., 'GET', 'POST').
 * @param {string} path - The request path (e.g., '/markets').
 * @param {string} [body=""] - The JSON stringified request body.
 * @param {Object} [env=process.env] - The environment variables object.
 * @returns {Object} The generated headers.
 */
function getAuthHeaders(method, path, body = "", env = process.env) {
    const { POLY_API_KEY, POLY_API_SECRET, POLY_API_PASSPHRASE } = env;
    if (!POLY_API_KEY) return { 'Content-Type': 'application/json' };
    
    const timestamp = Math.floor(Date.now() / 1000);
    const sigPayload = timestamp + method.toUpperCase() + path + body;
    const signature = crypto
        .createHmac('sha256', Buffer.from(POLY_API_SECRET || '', 'base64'))
        .update(sigPayload)
        .digest('base64');
        
    return { 
        'POLY_API_KEY': POLY_API_KEY, 
        'POLY_SIGNATURE': signature, 
        'POLY_TIMESTAMP': timestamp, 
        'POLY_PASSPHRASE': POLY_API_PASSPHRASE, 
        'Content-Type': 'application/json' 
    };
}

module.exports = { Logger, getAuthHeaders };
