import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserDevice, UserRepo } from './database/user-repo';
import { RedisClient } from './queue/redis-client';
import { PushNotifier } from './services/push-notifier.service';
import { WsClient } from './workers/ws-client';

@Injectable()
export class HyperliquidMonitorService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(HyperliquidMonitorService.name);
  private readonly queue: RedisClient;
  private wsClient: WsClient;
  private notifier: PushNotifier;

  constructor(private readonly config: ConfigService) {
    this.queue = new RedisClient(this.config.get<string>('REDIS_URL'));
  }

  async onModuleInit(): Promise<void> {
    await this.queue.connect();

    const userRepo = new UserRepo();
    const users: UserDevice[] = await userRepo.getAllMonitoredUsers();
    this.logger.log(`Loaded ${users.length} users to monitor`);

    const walletMap = new Map<string, UserDevice>();
    this.wsClient = new WsClient(this.queue, walletMap);
    await this.wsClient.start(users);

    this.notifier = new PushNotifier(this.queue, 'fcm');
    void this.notifier.start();
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log('Shutting down...');
    this.wsClient?.stop();
    this.notifier?.stop();
    await this.queue?.disconnect();
  }
}
