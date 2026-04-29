/**
 * Standalone ZRO airdrop scanner — with checkpoint/resume + parallel chains
 * Run: npx ts-node -r tsconfig-paths/register src/zro/run-scan.ts
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
  { name: 'Ethereum',  envKey: 'ZRO_ETH_RPC',     chainId: 1,     fromBlock: 20_000_000,  batchSize: 2_000   },
  { name: 'Arbitrum',  envKey: 'ZRO_ARB_RPC',     chainId: 42161, fromBlock: 221_000_000, batchSize: 100_000 },
  { name: 'Optimism',  envKey: 'ZRO_OP_RPC',      chainId: 10,    fromBlock: 121_000_000, batchSize: 2_000   },
  { name: 'Base',      envKey: 'ZRO_BASE_RPC',    chainId: 8453,  fromBlock: 15_500_000,  batchSize: 2_000   },
  { name: 'Polygon',   envKey: 'ZRO_POLYGON_RPC', chainId: 137,   fromBlock: 57_500_000,  batchSize: 2_000   },
  { name: 'BSC',       envKey: 'ZRO_BSC_RPC',     chainId: 56,    fromBlock: 39_500_000,  batchSize: 2_000   },
  { name: 'Avalanche', envKey: 'ZRO_AVAX_RPC',    chainId: 43114, fromBlock: 46_000_000,  batchSize: 2_000   },
];

const BATCH_DELAY_MS = 100;
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000];

// ─── Per-chain checkpoint ─────────────────────────────────────────────────────

interface ChainCheckpoint {
  nextBlock: number;
  recipients: string[];
  events: number;
  toBlock: number;
  done: boolean;
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
  process.stdout.write(`  [${name}] ${msg}\n`);
}

function logChainProgress(name: string, pct: number, msg: string) {
  const prev = lastPct.get(name) ?? -1;
  if (pct !== prev) {
    lastPct.set(name, pct);
    process.stdout.write(`  [${name}] ${msg}\n`);
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
    ethersCode === 'SERVER_ERROR' ||
    msg.includes('503') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('timeout') ||
    msg.includes('rate')
  );
}

function errorMessage(err: unknown): string {
  const e = err as Record<string, unknown>;
  // ethers SERVER_ERROR wraps the actual message in info.responseBody
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

async function getLogsAdaptive(
  provider: ethers.JsonRpcProvider,
  filter: { address: string; topics: string[] },
  fromBlock: number,
  toBlock: number,
  attempt = 0,
): Promise<ethers.Log[]> {
  try {
    return await provider.getLogs({ ...filter, fromBlock, toBlock });
  } catch (err) {
    if (isResponseTooLarge(err) && fromBlock < toBlock) {
      const mid = Math.floor((fromBlock + toBlock) / 2);
      const left = await getLogsAdaptive(provider, filter, fromBlock, mid);
      const right = await getLogsAdaptive(provider, filter, mid + 1, toBlock);
      return [...left, ...right];
    }
    if (isRetryable(err) && attempt < RETRY_DELAYS_MS.length) {
      const delay = RETRY_DELAYS_MS[attempt];
      logChain('retry', `[${filter.address.slice(0, 6)}] attempt ${attempt + 1}, wait ${delay / 1000}s`);
      await sleep(delay);
      return getLogsAdaptive(provider, filter, fromBlock, toBlock, attempt + 1);
    }
    throw err;
  }
}

// ─── Chain scanner ────────────────────────────────────────────────────────────

async function scanChain(
  name: string,
  rpc: string,
  chainId: number,
  fromBlock: number,
  batchSize: number,
): Promise<{ recipients: Set<string>; events: number; toBlock: number }> {
  const network = ethers.Network.from(chainId);
  const provider = new ethers.JsonRpcProvider(rpc, network, { staticNetwork: network });

  let cp = loadChainCheckpoint(name);
  if (!cp) {
    const toBlock = await provider.getBlockNumber();
    cp = { nextBlock: fromBlock, recipients: [], events: 0, toBlock, done: false };
    saveChainCheckpoint(name, cp);
  }

  const toBlock = cp.toBlock || (await provider.getBlockNumber());
  cp.toBlock = toBlock;

  const recipients = new Set<string>(cp.recipients);
  const totalBlocks = toBlock - fromBlock;

  logChain(name, `ready  toBlock=${toBlock.toLocaleString()}  totalBlocks=${totalBlocks.toLocaleString()}`);

  if (cp.done) {
    logChain(name, `already completed (${cp.events} events) — skipping`);
    return { recipients, events: cp.events, toBlock };
  }

  logChain(name, `scanning from block ${cp.nextBlock.toLocaleString()}...`);

  for (let start = cp.nextBlock; start <= toBlock; start += batchSize) {
    const end = Math.min(start + batchSize - 1, toBlock);

    let batch: ethers.Log[];
    try {
      batch = await getLogsAdaptive(
        provider,
        { address: CONTRACT_ADDRESS, topics: [CLAIMED_TOPIC] },
        start,
        end,
      );
    } catch (err) {
      logChain(name, `ERROR at block ${start.toLocaleString()}-${end.toLocaleString()}: ${errorMessage(err)}`);
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
    logChainProgress(name, pct, `${String(pct).padStart(3)}%  block ${end.toLocaleString()}/${toBlock.toLocaleString()}  events: ${cp.events}`);

    await sleep(BATCH_DELAY_MS);
  }

  cp.done = true;
  saveChainCheckpoint(name, cp);
  logChain(name, `DONE — ${cp.events} events, ${recipients.size} unique recipients`);

  return { recipients, events: cp.events, toBlock };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== ZRO Airdrop Scanner ===\n');
  console.log(`Contract : ${CONTRACT_ADDRESS}`);
  console.log(`Topic    : ${CLAIMED_TOPIC}\n`);

  const nets = NETWORKS.map((net) => ({ ...net, rpc: process.env[net.envKey] }));

  // Run all chains in parallel
  const results = await Promise.allSettled(
    nets.map(async (net) => {
      if (!net.rpc) {
        logChain(net.name, `skipped — ${net.envKey} not set`);
        return { name: net.name, recipients: new Set<string>(), events: 0, toBlock: 0, fromBlock: net.fromBlock, skipped: true };
      }
      logChain(net.name, 'connecting...');
      try {
        const { recipients, events, toBlock } = await scanChain(net.name, net.rpc, net.chainId, net.fromBlock, net.batchSize);
        return { name: net.name, recipients, events, toBlock, fromBlock: net.fromBlock, skipped: false };
      } catch (err) {
        logChain(net.name, `FAILED — ${errorMessage(err)}`);
        throw err;
      }
    }),
  );

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

  for (const result of results) {
    if (result.status === 'fulfilled') {
      const { name, recipients, events, toBlock, fromBlock, skipped } = result.value;
      if (!skipped) for (const addr of recipients) allRecipients.add(addr);
      summary.push({ chain: name, events, uniqueOnChain: recipients.size, fromBlock, toBlock });
    } else {
      const net = nets[results.indexOf(result)];
      summary.push({ chain: net.name, events: 0, uniqueOnChain: 0, fromBlock: net.fromBlock, toBlock: 0, error: result.reason?.message });
    }
  }

  fs.writeFileSync(
    path.join(__dirname, 'zro-results.json'),
    JSON.stringify({ totalUniqueRecipients: allRecipients.size, chains: summary, scannedAt: new Date().toISOString() }, null, 2),
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
  console.log('  Results → zro-results.json\n');
}

main().catch(console.error);
