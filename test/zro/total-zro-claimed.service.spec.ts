import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';
import { TotalZroClaimedService } from '../../src/zro/services/total-zro-claimed.service';

jest.mock('ethers', () => ({
  ethers: {
    JsonRpcProvider: jest.fn(),
    formatUnits: jest.fn(),
  },
}));

describe('TotalZroClaimedService', () => {
  let service: TotalZroClaimedService;
  let mockGetLogs: jest.Mock;
  let mockGetBlockNumber: jest.Mock;

  const configValues: Record<string, string> = {
    ZRO_RPC_URL: 'https://rpc.example.com',
    ZRO_CONTRACT_ADDRESS: '0xCONTRACT',
    ZRO_CLAIMED_EVENT_TOPIC: '0xTOPIC',
    ZRO_FROM_BLOCK: '0',
    ZRO_BATCH_SIZE: '2000',
  };

  beforeEach(async () => {
    mockGetLogs = jest.fn().mockResolvedValue([]);
    mockGetBlockNumber = jest.fn().mockResolvedValue(3999);

    (ethers.JsonRpcProvider as jest.Mock).mockImplementation(() => ({
      getLogs: mockGetLogs,
      getBlockNumber: mockGetBlockNumber,
    }));
    (ethers.formatUnits as jest.Mock).mockReturnValue('3.0');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TotalZroClaimedService,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn((key: string) => {
              if (!configValues[key]) throw new Error(`Missing: ${key}`);
              return configValues[key];
            }),
            get: jest.fn((key: string) => configValues[key] ?? undefined),
          },
        },
      ],
    }).compile();

    service = module.get(TotalZroClaimedService);
  });

  afterEach(() => jest.clearAllMocks());

  it('paginates getLogs across block batches', async () => {
    // latestBlock=3999, batchSize=2000 → expects 2 calls: [0,1999] and [2000,3999]
    await service.syncTotalClaimed();

    expect(mockGetLogs).toHaveBeenCalledTimes(2);
    expect(mockGetLogs).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ fromBlock: 0, toBlock: 1999 }),
    );
    expect(mockGetLogs).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ fromBlock: 2000, toBlock: 3999 }),
    );
  });

  it('sums amounts across all batches', async () => {
    const amount1 = BigInt('1000000000000000000');
    const amount2 = BigInt('2000000000000000000');
    mockGetLogs
      .mockResolvedValueOnce([{ data: amount1.toString() }]) // batch 1
      .mockResolvedValueOnce([{ data: amount2.toString() }]); // batch 2

    const result = await service.syncTotalClaimed();

    expect(result.eventCount).toBe(2);
    expect(result.totalClaimedRaw).toBe('3000000000000000000');
    expect(ethers.formatUnits).toHaveBeenCalledWith(BigInt('3000000000000000000'), 18);
  });

  it('returns zero when no logs found across all batches', async () => {
    mockGetLogs.mockResolvedValue([]);
    (ethers.formatUnits as jest.Mock).mockReturnValue('0.0');

    const result = await service.syncTotalClaimed();

    expect(result.eventCount).toBe(0);
    expect(result.totalClaimedRaw).toBe('0');
  });

  it('exposes fromBlock and toBlock in result', async () => {
    const result = await service.syncTotalClaimed();

    expect(result.fromBlock).toBe(0);
    expect(result.toBlock).toBe(3999);
    expect(result.syncedAt).toBeDefined();
  });

  it('uses correct contract address and topic in every batch', async () => {
    await service.syncTotalClaimed();

    for (const call of mockGetLogs.mock.calls) {
      expect(call[0]).toMatchObject({
        address: '0xCONTRACT',
        topics: ['0xTOPIC'],
      });
    }
  });

  it('propagates RPC errors', async () => {
    mockGetLogs.mockRejectedValue(new Error('RPC unavailable'));

    await expect(service.syncTotalClaimed()).rejects.toThrow('RPC unavailable');
  });
});
