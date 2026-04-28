import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HyperliquidMonitorService } from '../../src/hyperliquid-monitor/hyperliquid-monitor.service';

jest.mock('../../src/hyperliquid-monitor/database/user-repo');
jest.mock('../../src/hyperliquid-monitor/queue/redis-client');
jest.mock('../../src/hyperliquid-monitor/workers/ws-client');
jest.mock('../../src/hyperliquid-monitor/services/push-notifier.service');

import { UserRepo } from '../../src/hyperliquid-monitor/database/user-repo';
import { RedisClient } from '../../src/hyperliquid-monitor/queue/redis-client';
import { WsClient } from '../../src/hyperliquid-monitor/workers/ws-client';
import { PushNotifier } from '../../src/hyperliquid-monitor/services/push-notifier.service';

const mockUsers = [
  { userId: 'u1', walletAddress: '0xabc', deviceTokens: ['token1'] },
];

const mockRedis = {
  connect: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn().mockResolvedValue(undefined),
};

const mockWsClient = {
  start: jest.fn().mockResolvedValue(undefined),
  stop: jest.fn(),
};

const mockNotifier = {
  start: jest.fn().mockResolvedValue(undefined),
  stop: jest.fn(),
};

describe('HyperliquidMonitorService', () => {
  let service: HyperliquidMonitorService;

  beforeEach(async () => {
    jest.clearAllMocks();

    (RedisClient as jest.Mock).mockImplementation(() => mockRedis);
    (UserRepo as jest.Mock).mockImplementation(() => ({
      getAllMonitoredUsers: jest.fn().mockResolvedValue(mockUsers),
    }));
    (WsClient as jest.Mock).mockImplementation(() => mockWsClient);
    (PushNotifier as jest.Mock).mockImplementation(() => mockNotifier);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HyperliquidMonitorService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue('redis://localhost:6379'),
          },
        },
      ],
    }).compile();

    service = module.get(HyperliquidMonitorService);
  });

  describe('onModuleInit', () => {
    it('connects redis, starts WebSocket client and push notifier', async () => {
      await service.onModuleInit();

      expect(mockRedis.connect).toHaveBeenCalledTimes(1);
      expect(mockWsClient.start).toHaveBeenCalledWith(mockUsers);
      expect(mockNotifier.start).toHaveBeenCalledTimes(1);
    });

    it('passes loaded users to WsClient', async () => {
      await service.onModuleInit();

      expect(mockWsClient.start).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ userId: 'u1' }),
        ]),
      );
    });

    it('creates RedisClient with REDIS_URL from config', () => {
      expect(RedisClient).toHaveBeenCalledWith('redis://localhost:6379');
    });
  });

  describe('onModuleDestroy', () => {
    it('stops ws, stops notifier, and disconnects redis', async () => {
      await service.onModuleInit();
      await service.onModuleDestroy();

      expect(mockWsClient.stop).toHaveBeenCalledTimes(1);
      expect(mockNotifier.stop).toHaveBeenCalledTimes(1);
      expect(mockRedis.disconnect).toHaveBeenCalledTimes(1);
    });

    it('does not throw when called before init', async () => {
      await expect(service.onModuleDestroy()).resolves.not.toThrow();
    });
  });
});
