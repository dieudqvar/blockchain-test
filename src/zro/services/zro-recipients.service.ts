import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';
import { getLogsPaginated } from '../utils/get-logs-paginated';

const CONTRACT_ADDRESS = '0xE79E66186f789C18090C8eA0E235688536C56693';
const CLAIMED_EVENT_TOPIC =
  '0x1994e4438340a6b7d38356970783301a2cf6df33f3801844b20a597a7a109724';

const NETWORKS = [
  { name: 'Ethereum', envKey: 'ZRO_ETH_RPC' },
  { name: 'Arbitrum', envKey: 'ZRO_ARB_RPC' },
  { name: 'Optimism', envKey: 'ZRO_OP_RPC' },
  { name: 'Base',     envKey: 'ZRO_BASE_RPC' },
  { name: 'Polygon',  envKey: 'ZRO_POLYGON_RPC' },
  { name: 'BSC',      envKey: 'ZRO_BSC_RPC' },
  { name: 'Avalanche',envKey: 'ZRO_AVAX_RPC' },
] as const;

export interface NetworkScanResult {
  network: string;
  eventCount: number;
  fromBlock: number;
  toBlock: number;
  skipped?: boolean;
  error?: string;
}

export interface RecipientsResult {
  total: number;
  recipients: string[];
  networks: NetworkScanResult[];
  syncedAt: string;
}

@Injectable()
export class ZroRecipientsService {
  private readonly logger = new Logger(ZroRecipientsService.name);

  constructor(private readonly config: ConfigService) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async syncRecipients(): Promise<RecipientsResult> {
    const fromBlock = Number(this.config.get<string>('ZRO_FROM_BLOCK') ?? '0');
    const batchSize = Number(this.config.get<string>('ZRO_BATCH_SIZE') ?? '2000');

    const allRecipients = new Set<string>();
    const networkResults: NetworkScanResult[] = [];

    this.logger.log('Syncing ZRO recipients across networks...');

    for (const net of NETWORKS) {
      const rpc = this.config.get<string>(net.envKey);
      if (!rpc) {
        this.logger.warn(`No RPC configured for ${net.name}, skipping`);
        networkResults.push({ network: net.name, eventCount: 0, fromBlock, toBlock: 0, skipped: true });
        continue;
      }

      this.logger.log(`Scanning ${net.name} (batch ${batchSize})...`);
      const provider = new ethers.JsonRpcProvider(rpc);

      try {
        const latestBlock = await provider.getBlockNumber();

        const logs = await getLogsPaginated(
          provider,
          { address: CONTRACT_ADDRESS, topics: [CLAIMED_EVENT_TOPIC] },
          fromBlock,
          batchSize,
        );

        for (const log of logs) {
          const address = ethers.getAddress(ethers.dataSlice(log.topics[1], 12));
          allRecipients.add(address);
        }

        this.logger.log(`${net.name}: ${logs.length} events across blocks ${fromBlock}→${latestBlock}`);
        networkResults.push({ network: net.name, eventCount: logs.length, fromBlock, toBlock: latestBlock });
      } catch (err) {
        const message = (err as Error).message;
        this.logger.error(`Error scanning ${net.name}`, message);
        networkResults.push({ network: net.name, eventCount: 0, fromBlock, toBlock: 0, error: message });
      }
    }

    const result: RecipientsResult = {
      total: allRecipients.size,
      recipients: Array.from(allRecipients),
      networks: networkResults,
      syncedAt: new Date().toISOString(),
    };

    this.logger.log(`Total unique ZRO recipients: ${result.total}`);

    return result;
  }
}
