const axios = require('axios');
const { Logger: L } = require('./utils');

/**
 * Probes the Polymarket staging environment for health and basic data.
 * Useful for verifying connectivity before running the main race test.
 * @async
 */
async function probe() {
    L.info("Starting probe of Polymarket API...");
    try {
        // Fetch global info to verify connectivity with explicit timeout
        const info = await axios.get('https://clob-staging.polymarket.com/markets', { timeout: 10000 });
        
        // Strict input validation
        if (!info || !info.data || !Array.isArray(info.data.data)) {
            throw new Error("Invalid response format from /markets API");
        }
        
        L.info(`Markets fetched successfully: ${info.data.data.length} markets found.`);
        if (info.data.data.length > 0) {
            const firstMarket = info.data.data[0];
            // Type checking
            if (firstMarket && typeof firstMarket.question === 'string') {
                L.info(`Example market preview: ${firstMarket.question}`);
            }
        }
        L.res(true, "Probe completed successfully.");
    } catch (e) {
        L.err('Probe failed', e.message);
        if (e.response && e.response.data) {
            L.err('Response Data', e.response.data);
        }
        L.res(false, "Probe encountered errors.");
    }
}

if (require.main === module) {
    probe();
}

module.exports = { probe };
