/**
 * Validation script for ZRO scan results
 * Compares claim event count vs ERC-20 Transfer(from=0x0) count per chain.
 * Since every ZRO claim mints tokens, these two must always be equal.
 *
 * Run: npx ts-node -r tsconfig-paths/register src/zro/validate-scan.ts
 */
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const CONTRACT_ADDRESS = '0x6985884c4392d348587b19cb9eaaf157f13271cd';

// topic we used in run-scan.ts (claim event)
const CLAIM_TOPIC =
  '0xefed6d3500546b29533b128a29e3a94d70788727f0507505ac12eaf2e578fd9c';

// ERC-20 Transfer topic — independent second source of truth
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// Transfer from address(0) = mint = airdrop claim
const ZERO_ADDRESS =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

// Known recipient from verified tx 0x6412140a67f609ecd3c44b7c74cc3b4618564ec4dd8f929bc88ae24b9c6c330c
const KNOWN_RECIPIENT = '0xdaeD957eD3D5870b3C28aA31082E5e5ee15A4e0f';

const NETWORKS = [
  { name: 'Ethereum',  envKey: 'ZRO_ETH_RPC',     fromBlock: 20_000_000,  batchSize: 10_000  },
  { name: 'Arbitrum',  envKey: 'ZRO_ARB_RPC',     fromBlock: 221_000_000, batchSize: 500_000 },
  { name: 'Optimism',  envKey: 'ZRO_OP_RPC',      fromBlock: 121_000_000, batchSize: 50_000  },
  { name: 'Base',      envKey: 'ZRO_BASE_RPC',    fromBlock: 15_500_000,  batchSize: 50_000  },
  { name: 'Polygon',   envKey: 'ZRO_POLYGON_RPC', fromBlock: 57_500_000,  batchSize: 10_000  },
  { name: 'BSC',       envKey: 'ZRO_BSC_RPC',     fromBlock: 39_500_000,  batchSize: 10_000  },
  { name: 'Avalanche', envKey: 'ZRO_AVAX_RPC',    fromBlock: 46_000_000,  batchSize: 10_000  },
];

const BATCH_DELAY_MS = 100;
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isRetryable(err: unknown): boolean {
  const msg = (err as Error).message ?? '';
  const code = (err as { error?: { code?: number } }).error?.code;
  return code === 429 || msg.includes('ETIMEDOUT') || msg.includes('timeout') || msg.includes('rate');
}

async function getLogsWithRetry(
  provider: ethers.JsonRpcProvider,
  params: Parameters<typeof provider.getLogs>[0],
  attempt = 0,
): Promise<ethers.Log[]> {
  try {
    return await provider.getLogs(params);
  } catch (err) {
    if (isRetryable(err) && attempt < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[attempt]);
      return getLogsWithRetry(provider, params, attempt + 1);
    }
    throw err;
  }
}

async function countLogs(
  provider: ethers.JsonRpcProvider,
  topics: string[],
  fromBlock: number,
  toBlock: number,
  batchSize: number,
  label: string,
): Promise<number> {
  let total = 0;
  for (let start = fromBlock; start <= toBlock; start += batchSize) {
    const end = Math.min(start + batchSize - 1, toBlock);
    const logs = await getLogsWithRetry(provider, {
      address: CONTRACT_ADDRESS,
      topics,
      fromBlock: start,
      toBlock: end,
    });
    total += logs.length;
    process.stdout.write(`\r    [${label}] block ${end.toLocaleString()}/${toBlock.toLocaleString()}  count: ${total}   `);
    await sleep(BATCH_DELAY_MS);
  }
  process.stdout.write('\n');
  return total;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== ZRO Scan Validator ===\n');

  // ── Load previous scan results ─────────────────────────────────────────────
  const checkpointFile = 'zro-checkpoint.json';
  const resultsFile = 'zro-results.json';

  if (!fs.existsSync(checkpointFile) && !fs.existsSync(resultsFile)) {
    console.error('No scan results found. Run run-scan.ts first.');
    process.exit(1);
  }

  const checkpoint = fs.existsSync(checkpointFile)
    ? JSON.parse(fs.readFileSync(checkpointFile, 'utf8'))
    : null;

  // ── Spot-check known recipient ─────────────────────────────────────────────
  console.log('── Spot check ───────────────────────────────────────');
  if (checkpoint) {
    const ethChain = checkpoint['Ethereum'];
    if (ethChain) {
      const found = ethChain.recipients
        .map((r: string) => r.toLowerCase())
        .includes(KNOWN_RECIPIENT.toLowerCase());
      console.log(
        `  Known recipient ${KNOWN_RECIPIENT}`,
        found ? '✓ FOUND in Ethereum results' : '✗ NOT FOUND — possible decode issue',
      );
    }
  }
  console.log();

  // ── Per-chain cross-check ──────────────────────────────────────────────────
  console.log('── Cross-check: claim events vs Transfer(mint) events ───');
  console.log('  (Every claim mints tokens → both counts must be equal)\n');

  const report: {
    chain: string;
    claimCount: number;
    transferCount: number;
    match: boolean;
    error?: string;
  }[] = [];

  for (const net of NETWORKS) {
    const rpc = process.env[net.envKey];
    if (!rpc) {
      console.log(`  [${net.name}] skipped — no RPC\n`);
      continue;
    }

    const chainCp = checkpoint?.[net.name];
    if (!chainCp?.done) {
      console.log(`  [${net.name}] skipped — scan not completed yet\n`);
      continue;
    }

    const claimCount: number = chainCp.events;
    const fromBlock: number = chainCp.nextBlock - 1; // last scanned block
    const toBlock: number = chainCp.toBlock;

    console.log(`  [${net.name}] claim events from scan: ${claimCount}`);
    console.log(`    Counting Transfer(mint) events independently...`);

    try {
      const provider = new ethers.JsonRpcProvider(rpc);

      // Filter: Transfer where topics[1] = address(0) (from=0x0 = mint)
      // Use same fromBlock as run-scan so the range is identical
      const transferCount = await countLogs(
        provider,
        [TRANSFER_TOPIC, ZERO_ADDRESS],
        net.fromBlock,
        toBlock,
        net.batchSize,
        net.name,
      );

      const match = claimCount === transferCount;
      report.push({ chain: net.name, claimCount, transferCount, match });

      console.log(
        `    Claim events  : ${claimCount}`,
      );
      console.log(
        `    Transfer(mint): ${transferCount}`,
      );
      console.log(
        `    Result        : ${match ? '✓ MATCH — results look complete' : `✗ MISMATCH (diff: ${Math.abs(claimCount - transferCount)}) — possible missed events`}`,
      );
      console.log();
    } catch (err) {
      console.error(`    ERROR: ${(err as Error).message}\n`);
      report.push({ chain: net.name, claimCount, transferCount: -1, match: false, error: (err as Error).message });
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('── Validation Summary ────────────────────────────────');
  let allMatch = true;
  for (const r of report) {
    if (r.error) {
      console.log(`  ${r.name?.padEnd?.(12) ?? r.chain.padEnd(12)}  ERROR`);
      continue;
    }
    const status = r.match ? '✓' : '✗';
    console.log(
      `  ${r.chain.padEnd(12)}  ${status}  claim: ${r.claimCount}  transfer: ${r.transferCount}${r.match ? '' : `  diff: ${Math.abs(r.claimCount - r.transferCount)}`}`,
    );
    if (!r.match) allMatch = false;
  }

  console.log();
  if (allMatch && report.length > 0) {
    console.log('  Overall: ✓ All chains match — scan results are consistent');
  } else {
    console.log('  Overall: ✗ Some chains have mismatches — review above');
  }

  fs.writeFileSync('zro-validation.json', JSON.stringify(report, null, 2));
  console.log('  Report saved to zro-validation.json\n');
}

main().catch(console.error);
