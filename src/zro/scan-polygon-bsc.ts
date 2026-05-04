/**
 * ZRO Airdrop Scanner — Polygon & BSC focused
 * Optimized with checkpoint/resume + adaptive batch sizing
 * Run: npx ts-node -r tsconfig-paths/register src/zro/scan-polygon-bsc.ts
 */
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// ─── Config ───────────────────────────────────────────────────────────────────

const CONTRACT_ADDRESS = '0x6985884c4392d348587b19cb9eaaf157f13271cd';
const CLAIMED_TOPIC =
    '0xefed6d3500546b29533b128a29e3a94d70788727f0507505ac12eaf2e578fd9c';

const NETWORKS = [
    {
        name: 'Polygon',
        envKey: 'ZRO_POLYGON_RPC',
        chainId: 137,
        fromBlock: 57_500_000,
        batchSize: 1_000,
        maxBatchSize: 5_000,
        minBatchSize: 200,
        fallbackRpcs: [
            'https://polygon-rpc.com',
            'https://polygon.meowrpc.com',
            'https://1rpc.io/matic',
        ],
    },
    {
        name: 'BSC',
        envKey: 'ZRO_BSC_RPC',
        chainId: 56,
        fromBlock: 39_500_000,
        batchSize: 250,
        maxBatchSize: 1_000,
        minBatchSize: 50,
        fallbackRpcs: [
            'https://bsc-dataseed.binance.org',
            'https://bsc-dataseed1.defibit.io',
            'https://bsc-dataseed1.ninicoin.io',
        ],
    },
];

const BATCH_DELAY_MS = 500;
const RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 60_000];
const PARALLEL_CHAINS = (process.env.ZRO_PARALLEL_CHAINS ?? 'true') === 'true';
const DRY_RUN = (process.env.ZRO_DRY_RUN ?? 'false') === 'true';

// ─── Per-chain checkpoint ─────────────────────────────────────────────────────

interface ChainCheckpoint {
    nextBlock: number;
    recipients: string[];
    events: number;
    toBlock: number;
    done: boolean;
    failedRanges?: Array<{ start: number; end: number; reason: string }>;
}

function cpFile(chain: string) {
    return path.join(__dirname, `zro-checkpoint-${chain.toLowerCase()}.json`);
}

function loadChainCheckpoint(chain: string): ChainCheckpoint | null {
    const file = cpFile(chain);
    return fs.existsSync(file)
        ? (JSON.parse(fs.readFileSync(file, 'utf8')) as ChainCheckpoint)
        : null;
}

function saveChainCheckpoint(chain: string, cp: ChainCheckpoint) {
    fs.writeFileSync(cpFile(chain), JSON.stringify(cp, null, 2));
}

// ─── Per-chain log ────────────────────────────────────────────────────────────

const lastPct = new Map<string, number>();

function logChain(name: string, msg: string) {
    console.log(`  [${name}] ${msg}`);
}

function logChainProgress(name: string, pct: number, msg: string) {
    const prev = lastPct.get(name) ?? -1;
    if (pct !== prev) {
        lastPct.set(name, pct);
        process.stdout.write(`\r  [${name}] ${msg}`);
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isRetryable(err: unknown): boolean {
    const msg = (err as Error).message ?? '';
    const code = (err as { error?: { code?: number } }).error?.code;
    const ethersCode = (err as { code?: string }).code;

    return (
        code === 429 ||
        code === -32005 ||
        code === -32701 ||
        ethersCode === 'SERVER_ERROR' ||
        ethersCode === 'TIMEOUT' ||
        msg.includes('503') ||
        msg.includes('429') ||
        msg.includes('limit') ||
        msg.includes('rate') ||
        msg.includes('timeout') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('ECONNRESET') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('pruned') ||
        msg.includes('header not found') ||
        msg.includes('too many requests')
    );
}

function errorMessage(err: unknown): string {
    const e = err as Record<string, unknown>;
    const body = (e['info'] as Record<string, unknown> | undefined)?.['responseBody'];
    if (typeof body === 'string') {
        try {
            const parsed = JSON.parse(body) as { error?: { code?: number; message?: string } };
            if (parsed.error?.message) return `[${parsed.error.code}] ${parsed.error.message}`;
        } catch { /* ignore */ }
    }
    const code = (e['error'] as Record<string, unknown> | undefined)?.['code'];
    const inner = (e['error'] as Record<string, unknown> | undefined)?.['message'];
    return inner ? `[${code}] ${inner}` : (err as Error).message ?? String(err);
}

function isResponseTooLarge(err: unknown): boolean {
    const msg = (err as Error).message ?? '';
    const code = (err as { error?: { code?: number } }).error?.code;
    return code === -32020 || msg.includes('too large') || msg.includes('response size');
}

function normalizeRpc(url: string): string {
    const trimmed = url.trim();
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
    if (trimmed.startsWith('ws://')) return `http://${trimmed.slice('ws://'.length)}`;
    if (trimmed.startsWith('wss://')) return `https://${trimmed.slice('wss://'.length)}`;
    return `https://${trimmed}`;
}

async function supportsGetLogs(provider: ethers.JsonRpcProvider): Promise<boolean> {
    try {
        await provider.getLogs({
            address: CONTRACT_ADDRESS,
            topics: [CLAIMED_TOPIC],
            fromBlock: 1,
            toBlock: 1,
        });
        return true;
    } catch (err) {
        const msg = (err as Error).message ?? '';
        return !msg.includes('eth_getLogs is not supported');
    }
}

async function buildProviders(
    chainId: number,
    fallbackRpcs: string[],
): Promise<ethers.JsonRpcProvider[]> {
    const rpcList = fallbackRpcs.map((rpc) => normalizeRpc(rpc));
    const providers = (await Promise.all(
        rpcList.map(async (rpc) => {
            const network = ethers.Network.from(chainId);
            const provider = new ethers.JsonRpcProvider(rpc, network, { staticNetwork: network });
            return (await supportsGetLogs(provider)) ? provider : null;
        }),
    )).filter(Boolean) as ethers.JsonRpcProvider[];

    return providers;
}

async function getLogsAdaptive(
    providers: ethers.JsonRpcProvider[],
    filter: { address: string; topics: string[] },
    fromBlock: number,
    toBlock: number,
    attempt = 0,
    rpcIndex = 0,
): Promise<ethers.Log[]> {
    if (rpcIndex >= providers.length) {
        if (fromBlock < toBlock) {
            const mid = Math.floor((fromBlock + toBlock) / 2);
            const left = await getLogsAdaptive(providers, filter, fromBlock, mid, 0, 0);
            const right = await getLogsAdaptive(providers, filter, mid + 1, toBlock, 0, 0);
            return [...left, ...right];
        }
        throw new Error(`All ${providers.length} RPCs exhausted`);
    }

    const provider = providers[rpcIndex];

    try {
        return await provider.getLogs({ ...filter, fromBlock, toBlock });
    } catch (err) {
        if (isResponseTooLarge(err) && fromBlock < toBlock) {
            const mid = Math.floor((fromBlock + toBlock) / 2);
            const left = await getLogsAdaptive(providers, filter, fromBlock, mid, 0, rpcIndex);
            const right = await getLogsAdaptive(providers, filter, mid + 1, toBlock, 0, rpcIndex);
            return [...left, ...right];
        }

        if (!isRetryable(err)) {
            throw err;
        }

        if (rpcIndex < providers.length - 1) {
            await sleep(1000);
            return getLogsAdaptive(providers, filter, fromBlock, toBlock, attempt, rpcIndex + 1);
        }

        if (attempt < RETRY_DELAYS_MS.length) {
            const delay = RETRY_DELAYS_MS[attempt];
            await sleep(delay);
            return getLogsAdaptive(providers, filter, fromBlock, toBlock, attempt + 1, rpcIndex);
        }

        throw err;
    }
}

async function scanChain(
    name: string,
    chainId: number,
    fallbackRpcs: string[],
    fromBlock: number,
    batchSize: number,
    maxBatchSize: number,
    minBatchSize: number,
): Promise<{ recipients: Set<string>; events: number; toBlock: number }> {
    const providers = await buildProviders(chainId, fallbackRpcs);

    if (providers.length === 0) {
        throw new Error(`[${name}] No RPC endpoints support eth_getLogs`);
    }

    logChain(name, `Initializing with ${providers.length} RPC endpoints...`);

    let cp = loadChainCheckpoint(name);
    if (!cp) {
        const toBlock = await providers[0].getBlockNumber();
        cp = { nextBlock: fromBlock, recipients: [], events: 0, toBlock, done: false, failedRanges: [] };
        saveChainCheckpoint(name, cp);
    }

    const toBlock = cp.toBlock || (await providers[0].getBlockNumber());
    cp.toBlock = toBlock;

    const recipients = new Set<string>(cp.recipients);
    const totalBlocks = toBlock - fromBlock;

    logChain(name, `ready  toBlock=${toBlock.toLocaleString()}  totalBlocks=${totalBlocks.toLocaleString()}`);

    if (cp.done) {
        logChain(name, `already completed (${cp.events} events) — skipping`);
        return { recipients, events: cp.events, toBlock };
    }

    logChain(name, `scanning from block ${cp.nextBlock.toLocaleString()}...`);

    let currentBatchSize = batchSize;
    let successStreak = 0;

    for (let start = cp.nextBlock; start <= toBlock; start += currentBatchSize) {
        const end = Math.min(start + currentBatchSize - 1, toBlock);

        let batch: ethers.Log[];
        try {
            batch = await getLogsAdaptive(
                providers,
                { address: CONTRACT_ADDRESS, topics: [CLAIMED_TOPIC] },
                start,
                end,
            );
            successStreak += 1;
            if (successStreak >= 3 && currentBatchSize < maxBatchSize) {
                currentBatchSize = Math.min(maxBatchSize, currentBatchSize * 2);
                successStreak = 0;
                logChain(name, `stable RPC — increasing batch to ${currentBatchSize}`);
            }
        } catch (err) {
            successStreak = 0;
            const errMsg = errorMessage(err);
            logChain(name, `\nERROR at ${start.toLocaleString()}-${end.toLocaleString()}: ${errMsg}`);

            if (isRetryable(err) && currentBatchSize > minBatchSize) {
                const nextBatch = Math.max(minBatchSize, Math.floor(currentBatchSize / 2));
                logChain(name, `retryable error — reducing batch ${currentBatchSize} → ${nextBatch}`);
                currentBatchSize = nextBatch;
                start -= currentBatchSize;
                continue;
            }
            logChain(name, `\n❌ FAILED at block ${start.toLocaleString()}-${end.toLocaleString()}: ${errMsg}\n`);
            if (!cp.failedRanges) cp.failedRanges = [];
            cp.failedRanges.push({ start, end, reason: errMsg });
            saveChainCheckpoint(name, cp);
            throw err;
        }

        for (const log of batch) {
            recipients.add(ethers.getAddress(ethers.dataSlice(log.topics[2], 12)));
        }

        cp.nextBlock = end + 1;
        cp.events += batch.length;
        cp.recipients = Array.from(recipients);
        saveChainCheckpoint(name, cp);

        const pct = Math.min(100, Math.round(((start - fromBlock) / totalBlocks) * 100));
        logChainProgress(
            name,
            pct,
            `${String(pct).padStart(3)}%  block ${end.toLocaleString()}/${toBlock.toLocaleString()}  events: ${cp.events.toLocaleString()}`,
        );

        await sleep(BATCH_DELAY_MS);
    }

    console.log('');
    cp.done = true;
    saveChainCheckpoint(name, cp);
    logChain(name, `✓ DONE — ${cp.events} events, ${recipients.size} unique recipients`);

    return { recipients, events: cp.events, toBlock };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log('\n╔════════════════════════════════════════════════════╗');
    console.log('║  ZRO Airdrop Scanner — Polygon & BSC              ║');
    console.log('╚════════════════════════════════════════════════════╝\n');
    console.log(`Contract : ${CONTRACT_ADDRESS}`);
    console.log(`Topic    : ${CLAIMED_TOPIC}\n`);

    if (DRY_RUN) {
        for (const net of NETWORKS) {
            const providers = await buildProviders(net.chainId, net.fallbackRpcs);
            logChain(net.name, `dry-run OK — ${providers.length} provider(s) support eth_getLogs`);
        }
        return;
    }

    const nets = NETWORKS.map((net) => ({
        ...net,
        rpc: process.env[net.envKey],
    }));

    const results = await (PARALLEL_CHAINS
        ? Promise.allSettled(
            nets.map(async (net) => {
                if (!net.rpc) {
                    logChain(net.name, `skipped — ${net.envKey} not set`);
                    return { name: net.name, recipients: new Set<string>(), events: 0, toBlock: 0, fromBlock: net.fromBlock, skipped: true };
                }
                logChain(net.name, 'connecting...');
                const { recipients, events, toBlock } = await scanChain(
                    net.name,
                    net.chainId,
                    net.fallbackRpcs,
                    net.fromBlock,
                    net.batchSize,
                    net.maxBatchSize,
                    net.minBatchSize,
                );
                return { name: net.name, recipients, events, toBlock, fromBlock: net.fromBlock, skipped: false };
            }),
        )
        : (async () => {
            const results = [];
            for (const net of nets) {
                if (!net.rpc) {
                    logChain(net.name, `skipped — ${net.envKey} not set`);
                    results.push({
                        status: 'fulfilled',
                        value: { name: net.name, recipients: new Set<string>(), events: 0, toBlock: 0, fromBlock: net.fromBlock, skipped: true },
                    });
                    continue;
                }
                logChain(net.name, 'connecting...');
                try {
                    const { recipients, events, toBlock } = await scanChain(
                        net.name,
                        net.chainId,
                        net.fallbackRpcs,
                        net.fromBlock,
                        net.batchSize,
                        net.maxBatchSize,
                        net.minBatchSize,
                    );
                    results.push({
                        status: 'fulfilled',
                        value: { name: net.name, recipients, events, toBlock, fromBlock: net.fromBlock, skipped: false },
                    });
                } catch (err) {
                    results.push({ status: 'rejected', reason: err });
                }
            }
            return results;
        })());

    // ─── Collect results ──────────────────────────────────────────────────────

    const allRecipients = new Set<string>();
    const summary: {
        chain: string;
        events: number;
        uniqueOnChain: number;
        fromBlock: number;
        toBlock: number;
        error?: string;
    }[] = [];

    for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === 'fulfilled') {
            const { name, recipients, events, toBlock, fromBlock, skipped } = result.value;
            if (!skipped) for (const addr of recipients) allRecipients.add(addr);
            summary.push({ chain: name, events, uniqueOnChain: recipients.size, fromBlock, toBlock });
        } else {
            const net = nets[i];
            summary.push({
                chain: net.name,
                events: 0,
                uniqueOnChain: 0,
                fromBlock: net.fromBlock,
                toBlock: 0,
                error: result.reason?.message ?? 'Unknown error',
            });
        }
    }

    fs.writeFileSync(
        path.join(__dirname, 'zro-results-polygon-bsc.json'),
        JSON.stringify(
            {
                timestamp: new Date().toISOString(),
                totalUniqueRecipients: allRecipients.size,
                chains: summary,
            },
            null,
            2,
        ),
    );

    console.log('\n\n══ SUMMARY ══════════════════════════════════════════');
    for (const c of summary) {
        if (c.error) {
            console.log(`  ${c.chain.padEnd(12)}  ERROR: ${c.error}`);
        } else {
            console.log(`  ${c.chain.padEnd(12)}  ${String(c.events).padStart(6)} events  |  ${String(c.uniqueOnChain).padStart(6)} unique`);
        }
    }
    console.log(`\n  Total unique recipients: ${allRecipients.size}`);
    console.log('  Results → zro-results-polygon-bsc.json\n');
}

main().catch(console.error);
