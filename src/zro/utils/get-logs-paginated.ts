import { ethers } from 'ethers';

export async function getLogsPaginated(
  provider: ethers.JsonRpcProvider,
  filter: { address: string; topics: string[] },
  fromBlock: number,
  batchSize: number,
): Promise<ethers.Log[]> {
  const latestBlock = await provider.getBlockNumber();

  if (latestBlock < fromBlock) return [];

  const allLogs: ethers.Log[] = [];

  for (let start = fromBlock; start <= latestBlock; start += batchSize) {
    const end = Math.min(start + batchSize - 1, latestBlock);
    const logs = await provider.getLogs({ ...filter, fromBlock: start, toBlock: end });
    allLogs.push(...logs);
  }

  return allLogs;
}
