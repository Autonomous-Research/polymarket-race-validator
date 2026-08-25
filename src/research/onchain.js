'use strict';

const { ethers } = require('ethers');
const {
    BLOCKSCOUT_API,
    POLYGON_RPC,
    getJson,
    iso,
    mapLimit,
    pct,
    readJson,
    sleep,
    sum,
    writeJson
} = require('./common');

const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const PUSD = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const NATIVE_USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const RELAYER_API = 'https://relayer-v2.polymarket.com';
const ZERO = '0x0000000000000000000000000000000000000000';
const WALLET_ABI = [
    'function owner() view returns (address)',
    'function pendingOwner() view returns (address)',
    'function factory() view returns (address)',
    'function id() view returns (bytes32)',
    'function nonce() view returns (uint256)',
    'function paused() view returns (uint256)',
    'function eip712Domain() view returns (bytes1,string,string,uint256,address,bytes32,uint256[])'
];
const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)'
];

function lower(address) {
    return String(address || '').toLowerCase();
}

function normalizeTransfer(transfer) {
    return {
        from: transfer.from?.hash || null,
        to: transfer.to?.hash || null,
        token: transfer.token?.symbol || null,
        tokenAddress: transfer.token?.address_hash || null,
        value: Number(transfer.total?.value || 0) / (10 ** Number(transfer.total?.decimals || 0)),
        type: transfer.type || null
    };
}

function normalizeTransaction(transaction) {
    return {
        hash: transaction.hash,
        status: transaction.status,
        timestamp: transaction.timestamp,
        blockNumber: transaction.block_number || transaction.block || null,
        method: transaction.method,
        from: transaction.from?.hash || null,
        to: transaction.to?.hash || null,
        tokenTransfers: (transaction.token_transfers || []).map(normalizeTransfer)
    };
}

async function collectAddressPages(address, endpoint) {
    const items = [];
    let params = {};
    while (true) {
        const page = await getJson(`${BLOCKSCOUT_API}/addresses/${address}/${endpoint}`, params);
        items.push(...(page.items || []));
        if (!page.next_page_params) break;
        params = page.next_page_params;
    }
    return items;
}

function controlEvent(log) {
    const call = log.decoded?.method_call || '';
    return /^(Initialized|Ownership|SessionSigner|Upgraded|Paused|Unpaused|BatchExecuted)/.test(call);
}

function aggregateCounterparties(records, direction, wallet) {
    const map = new Map();
    for (const record of records) {
        const transfers = record.transaction?.tokenTransfers || [];
        let candidates;
        if (direction === 'deposit') {
            candidates = transfers.filter((transfer) => {
                const token = String(transfer.token || '').toUpperCase();
                const destination = lower(transfer.to);
                const isBackingDeposit = ['USDC', 'USDC.E'].includes(token)
                    && [lower(PUSD), lower(wallet)].includes(destination);
                const isDirectPusd = token === 'PUSD'
                    && lower(transfer.tokenAddress) === lower(PUSD)
                    && destination === lower(wallet);
                return (isBackingDeposit || isDirectPusd)
                && lower(transfer.from) !== lower(wallet)
                && lower(transfer.from) !== lower(ZERO)
                && Math.abs(transfer.value - record.reportedUsdc) <= Math.max(1, record.reportedUsdc * 0.001);
            });
        } else {
            candidates = transfers.filter((transfer) =>
                ['USDC', 'USDC.E'].includes(String(transfer.token || '').toUpperCase())
                && lower(transfer.from) === lower(wallet)
                && Math.abs(transfer.value - record.reportedUsdc) <= Math.max(1, record.reportedUsdc * 0.001));
        }
        for (const transfer of candidates) {
            const address = direction === 'deposit' ? transfer.from : transfer.to;
            const key = lower(address);
            const current = map.get(key) || { address, count: 0, usdc: 0, routes: {} };
            const route = direction === 'withdrawal'
                ? 'wallet transfer'
                : lower(transfer.to) === lower(PUSD)
                    ? 'PUSD backing deposit'
                    : String(transfer.token || '').toUpperCase() === 'PUSD'
                        ? 'direct PUSD transfer'
                        : 'direct stablecoin transfer';
            current.count += 1;
            current.usdc += transfer.value;
            current.routes[route] = (current.routes[route] || 0) + 1;
            map.set(key, current);
        }
    }
    return [...map.values()].sort((a, b) => b.usdc - a.usdc);
}

async function addressSummary(provider, address) {
    const [blockscout, counters, code, balance, transactionCount] = await Promise.all([
        getJson(`${BLOCKSCOUT_API}/addresses/${address}`).catch(() => ({})),
        getJson(`${BLOCKSCOUT_API}/addresses/${address}/counters`).catch(() => ({})),
        provider.getCode(address),
        provider.getBalance(address),
        provider.getTransactionCount(address)
    ]);
    return {
        address: ethers.utils.getAddress(address),
        isContract: code !== '0x',
        codeHash: code === '0x' ? null : ethers.utils.keccak256(code),
        codeBytes: code === '0x' ? 0 : (code.length - 2) / 2,
        proxyType: blockscout.proxy_type || null,
        implementations: blockscout.implementations || [],
        polBalance: Number(ethers.utils.formatEther(balance)),
        transactionCount,
        explorerTransactionsCount: Number(counters.transactions_count || 0),
        explorerTokenTransfersCount: Number(counters.token_transfers_count || 0),
        metadata: blockscout.metadata || null
    };
}

async function collectOnchainEvidence(snapshot, progress = console.log, cachePath = null) {
    const provider = new ethers.providers.JsonRpcProvider(POLYGON_RPC, 137);
    const walletAddress = ethers.utils.getAddress(snapshot.wallet);
    const wallet = new ethers.Contract(walletAddress, WALLET_ABI, provider);
    const pusd = new ethers.Contract(PUSD, ERC20_ABI, provider);
    const usdcE = new ethers.Contract(USDC_E, ERC20_ABI, provider);
    const nativeUsdc = new ethers.Contract(NATIVE_USDC, ERC20_ABI, provider);

    const [
        code,
        implementationStorage,
        owner,
        pendingOwner,
        factory,
        id,
        nonce,
        paused,
        domain,
        pusdBalance,
        usdcEBalance,
        nativeUsdcBalance,
        walletPol,
        latestBlock,
        safeDeployment,
        walletDeployment
    ] = await Promise.all([
        provider.getCode(walletAddress),
        provider.getStorageAt(walletAddress, IMPLEMENTATION_SLOT),
        wallet.owner(),
        wallet.pendingOwner(),
        wallet.factory(),
        wallet.id(),
        wallet.nonce(),
        wallet.paused(),
        wallet.eip712Domain(),
        pusd.balanceOf(walletAddress),
        usdcE.balanceOf(walletAddress),
        nativeUsdc.balanceOf(walletAddress),
        provider.getBalance(walletAddress),
        provider.getBlock('latest'),
        getJson(`${RELAYER_API}/deployed`, { address: walletAddress, type: 'SAFE' }).catch(() => ({ deployed: null })),
        getJson(`${RELAYER_API}/deployed`, { address: walletAddress, type: 'WALLET' }).catch(() => ({ deployed: null }))
    ]);
    const implementation = ethers.utils.getAddress(`0x${implementationStorage.slice(-40)}`);

    const flowRows = snapshot.activity.filter((row) => row.type === 'DEPOSIT' || row.type === 'WITHDRAWAL');
    let cachedTransactions = [];
    if (cachePath) {
        try {
            cachedTransactions = await readJson(cachePath);
        } catch (_error) {
            cachedTransactions = [];
        }
    }
    const cache = new Map(cachedTransactions.map((record) => [record.transaction?.hash || record.transactionHash, record]));
    let lastReported = 0;
    const flowTransactions = await mapLimit(flowRows, 3, async (row) => {
        const cached = cache.get(row.transactionHash);
        if (cached && cached.reportedUsdc === Number(row.usdcSize || 0)) return cached;
        try {
            const transaction = normalizeTransaction(await getJson(`${BLOCKSCOUT_API}/transactions/${row.transactionHash}`));
            await sleep(125);
            return {
                type: row.type,
                timestamp: row.timestamp,
                reportedUsdc: Number(row.usdcSize || 0),
                transaction
            };
        } catch (error) {
            return {
                type: row.type,
                timestamp: row.timestamp,
                reportedUsdc: Number(row.usdcSize || 0),
                transactionHash: row.transactionHash,
                error: error.message
            };
        }
    }, (completed, total) => {
        if (completed === total || completed - lastReported >= 50) {
            lastReported = completed;
            progress(`Onchain flow transactions: ${completed}/${total}`);
        }
    });

    if (cachePath) await writeJson(cachePath, flowTransactions);
    await sleep(3_000);

    const [walletLogs, ownerTransactionsRaw, walletSummary, ownerSummary] = await Promise.all([
        collectAddressPages(walletAddress, 'logs').catch((error) => {
            progress(`Wallet log lookup degraded: ${error.message}`);
            return [];
        }),
        collectAddressPages(owner, 'transactions').catch((error) => {
            progress(`Owner transaction lookup degraded: ${error.message}`);
            return [];
        }),
        addressSummary(provider, walletAddress),
        addressSummary(provider, owner)
    ]);
    const ownerTransactions = ownerTransactionsRaw.map(normalizeTransaction);
    const deposits = flowTransactions.filter((record) => record.type === 'DEPOSIT' && record.transaction);
    const withdrawals = flowTransactions.filter((record) => record.type === 'WITHDRAWAL' && record.transaction);
    const depositOrigins = aggregateCounterparties(deposits, 'deposit', walletAddress);
    const withdrawalDestinations = aggregateCounterparties(withdrawals, 'withdrawal', walletAddress);

    const linkedAddresses = [...new Set([
        ...depositOrigins.slice(0, 5).map((item) => item.address),
        ...withdrawalDestinations.slice(0, 5).map((item) => item.address)
    ].filter(Boolean).map(lower))];
    const linkedSummaries = await mapLimit(linkedAddresses, 2, (address) => addressSummary(provider, address));
    const directOwnerLinks = ownerTransactions.filter((transaction) =>
        transaction.from && lower(transaction.from) === lower(owner)
        && depositOrigins.some((origin) => lower(origin.address) === lower(transaction.to)))
        .map((transaction) => ({
            transactionHash: transaction.hash,
            timestamp: transaction.timestamp,
            from: transaction.from,
            to: transaction.to,
            method: transaction.method
        }));

    const controlEvents = walletLogs.filter(controlEvent).map((log) => ({
        transactionHash: log.transaction_hash,
        blockNumber: log.block_number,
        index: log.index,
        event: log.decoded?.method_call || null,
        parameters: log.decoded?.parameters || []
    }));
    const sessionEvents = controlEvents.filter((event) => event.event?.startsWith('SessionSigner'));
    const batchEvents = controlEvents.filter((event) => event.event?.startsWith('BatchExecuted'));
    const ownershipEvents = controlEvents.filter((event) => event.event?.startsWith('Ownership'));
    const firstOwnership = ownershipEvents.slice().sort((a, b) => a.blockNumber - b.blockNumber)[0] || null;
    const firstBatch = batchEvents.slice().sort((a, b) => a.blockNumber - b.blockNumber)[0] || null;
    const [ownershipBlock, firstBatchBlock] = await Promise.all([
        firstOwnership ? provider.getBlock(firstOwnership.blockNumber) : null,
        firstBatch ? provider.getBlock(firstBatch.blockNumber) : null
    ]);
    const firstTrade = snapshot.trades.slice().sort((a, b) => a.timestamp - b.timestamp)[0] || null;
    const depositTotal = sum(flowRows.filter((row) => row.type === 'DEPOSIT'), (row) => row.usdcSize);
    const withdrawalTotal = sum(flowRows.filter((row) => row.type === 'WITHDRAWAL'), (row) => row.usdcSize);

    return {
        generatedAt: new Date().toISOString(),
        chain: {
            name: 'Polygon PoS',
            chainId: 137,
            rpc: POLYGON_RPC,
            blockNumber: latestBlock.number,
            blockTimestamp: new Date(latestBlock.timestamp * 1000).toISOString()
        },
        wallet: {
            ...walletSummary,
            walletType: 'POLY_1271 Deposit Wallet',
            signatureType: 3,
            relayerDeployment: {
                safe: safeDeployment.deployed,
                wallet: walletDeployment.deployed
            },
            implementation,
            implementationSlot: IMPLEMENTATION_SLOT,
            runtimeCode: code,
            owner,
            pendingOwner,
            factory,
            id,
            nonce: nonce.toString(),
            paused: !paused.isZero(),
            eip712Domain: {
                fields: domain[0],
                name: domain[1],
                version: domain[2],
                chainId: domain[3].toString(),
                verifyingContract: domain[4]
            },
            pusdBalance: Number(ethers.utils.formatUnits(pusdBalance, 6)),
            stablecoinBalances: {
                pUsd: Number(ethers.utils.formatUnits(pusdBalance, 6)),
                usdcE: Number(ethers.utils.formatUnits(usdcEBalance, 6)),
                nativeUsdc: Number(ethers.utils.formatUnits(nativeUsdcBalance, 6))
            },
            stablecoinBalanceUsdc: Number(ethers.utils.formatUnits(pusdBalance.add(usdcEBalance).add(nativeUsdcBalance), 6)),
            polBalance: Number(ethers.utils.formatEther(walletPol))
        },
        owner: ownerSummary,
        ownerTransactions,
        control: {
            totalWalletLogs: walletLogs.length,
            batchExecutions: batchEvents.length,
            firstBatch,
            lastBatch: batchEvents.slice().sort((a, b) => b.blockNumber - a.blockNumber)[0] || null,
            sessionSignerEvents: sessionEvents,
            ownershipEvents,
            upgradeEvents: controlEvents.filter((event) => event.event?.startsWith('Upgraded')),
            chronology: {
                initializedBlock: firstOwnership?.blockNumber || null,
                initializedAt: ownershipBlock ? new Date(ownershipBlock.timestamp * 1000).toISOString() : null,
                firstBatchBlock: firstBatch?.blockNumber || null,
                firstBatchAt: firstBatchBlock ? new Date(firstBatchBlock.timestamp * 1000).toISOString() : null,
                firstObservedTradeAt: firstTrade ? iso(firstTrade.timestamp) : null,
                firstObservedTradeHash: firstTrade?.transactionHash || null,
                initializationToFirstTradeSeconds: ownershipBlock && firstTrade
                    ? firstTrade.timestamp - ownershipBlock.timestamp
                    : null
            }
        },
        flows: {
            dataApi: {
                deposits: deposits.length,
                depositUsdc: depositTotal,
                withdrawals: withdrawals.length,
                withdrawalUsdc: withdrawalTotal,
                netWithdrawnUsdc: withdrawalTotal - depositTotal
            },
            transactionLookupCoveragePct: pct(deposits.length + withdrawals.length, flowRows.length),
            depositOrigins,
            withdrawalDestinations,
            transactions: flowTransactions
        },
        linkedAddresses: linkedSummaries,
        identityLinks: {
            directOwnerTransactionsToDepositOrigins: directOwnerLinks
        }
    };
}

module.exports = {
    IMPLEMENTATION_SLOT,
    PUSD,
    aggregateCounterparties,
    collectOnchainEvidence,
    normalizeTransaction
};
