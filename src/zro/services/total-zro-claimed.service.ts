import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';
import { getLogsPaginated } from '../utils/get-logs-paginated';

export interface TotalClaimedResult {
  totalClaimed: string;
  totalClaimedRaw: string;
  eventCount: number;
  fromBlock: number;
  toBlock: number;
  syncedAt: string;
}

@Injectable()
export class TotalZroClaimedService {
  private readonly logger = new Logger(TotalZroClaimedService.name);

  constructor(private readonly config: ConfigService) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async syncTotalClaimed(): Promise<TotalClaimedResult> {
    const rpcUrl = this.config.getOrThrow<string>('ZRO_RPC_URL');
    const contractAddress = this.config.getOrThrow<string>('ZRO_CONTRACT_ADDRESS');
    const claimedEventTopic = this.config.getOrThrow<string>('ZRO_CLAIMED_EVENT_TOPIC');
    const fromBlock = Number(this.config.get<string>('ZRO_FROM_BLOCK') ?? '0');
    const batchSize = Number(this.config.get<string>('ZRO_BATCH_SIZE') ?? '2000');

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const latestBlock = await provider.getBlockNumber();

    this.logger.log(
      `Syncing total ZRO claimed (blocks ${fromBlock}→${latestBlock}, batch ${batchSize})`,
    );

    const logs = await getLogsPaginated(
      provider,
      { address: contractAddress, topics: [claimedEventTopic] },
      fromBlock,
      batchSize,
    );

    let totalClaimed = BigInt(0);
    for (const log of logs) {
      totalClaimed += BigInt(log.data);
    }

    const result: TotalClaimedResult = {
      totalClaimed: ethers.formatUnits(totalClaimed, 18),
      totalClaimedRaw: totalClaimed.toString(),
      eventCount: logs.length,
      fromBlock,
      toBlock: latestBlock,
      syncedAt: new Date().toISOString(),
    };

    this.logger.log(
      `Total ZRO Claimed: ${result.totalClaimed} ZRO (${result.eventCount} events across ${result.toBlock - result.fromBlock + 1} blocks)`,
    );

    return result;
  }
}
