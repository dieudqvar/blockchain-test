import { ethers } from 'ethers';

const RETRY_DELAYS_MS = [1_000, 3_000, 10_000];
const BATCH_DELAY_MS = 300;

async function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function getLogsWithRetry(
  provider: ethers.JsonRpcProvider,
  params: Parameters<typeof provider.getLogs>[0],
  attempt = 0,
): Promise<ethers.Log[]> {
  try {
    return await provider.getLogs(params);
  } catch (err) {
    const code = (err as { error?: { code?: number } }).error?.code;
    if (code === 429 && attempt < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[attempt]);
      return getLogsWithRetry(provider, params, attempt + 1);
    }
    throw err;
  }
}

export async function getLogsPaginated(
  provider: ethers.JsonRpcProvider,
  filter: { address: string; topics: string[] },
  fromBlock: number,
  batchSize: number,
): Promise<ethers.Log[]> {
  const latestBlock = await provider.getBlockNumber();

  if (latestBlock < fromBlock) return [];

  const allLogs: ethers.Log[] = [];
  const normalizedFilter = { ...filter, address: filter.address.toLowerCase() };

  for (let start = fromBlock; start <= latestBlock; start += batchSize) {
    const end = Math.min(start + batchSize - 1, latestBlock);
    const logs = await getLogsWithRetry(provider, { ...normalizedFilter, fromBlock: start, toBlock: end });
    allLogs.push(...logs);
    await sleep(BATCH_DELAY_MS);
  }

  return allLogs;
}
