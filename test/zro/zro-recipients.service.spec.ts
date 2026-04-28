import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';
import { ZroRecipientsService } from '../../src/zro/services/zro-recipients.service';

jest.mock('ethers', () => ({
  ethers: {
    JsonRpcProvider: jest.fn(),
    getAddress: jest.fn((addr: string) => addr.toUpperCase()),
    dataSlice: jest.fn((_data: string) => _data),
  },
}));

const makeLog = (topic1: string) => ({ topics: ['0xEVENT', topic1] });

describe('ZroRecipientsService', () => {
  let service: ZroRecipientsService;
  let mockGetLogs: jest.Mock;
  let mockGetBlockNumber: jest.Mock;
  let mockConfigGet: jest.Mock;

  const allRpcs: Record<string, string> = {
    ZRO_ETH_RPC: 'https://eth.rpc',
    ZRO_ARB_RPC: 'https://arb.rpc',
    ZRO_BASE_RPC: 'https://base.rpc',
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

    mockConfigGet = jest.fn((key: string) => allRpcs[key]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ZroRecipientsService,
        { provide: ConfigService, useValue: { get: mockConfigGet } },
      ],
    }).compile();

    service = module.get(ZroRecipientsService);
  });

  afterEach(() => jest.clearAllMocks());

  it('paginates getLogs per network', async () => {
    // only ETH configured, latestBlock=3999, batchSize=2000 → 2 getLogs calls per network
    mockConfigGet.mockImplementation((key: string) =>
      key === 'ZRO_ETH_RPC' ? 'https://eth.rpc'
      : key === 'ZRO_FROM_BLOCK' ? '0'
      : key === 'ZRO_BATCH_SIZE' ? '2000'
      : undefined,
    );

    await service.syncRecipients();

    // 2 batches for the one configured network
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

  it('collects unique recipients across all networks, deduplicating cross-chain', async () => {
    mockGetLogs
      .mockResolvedValueOnce([makeLog('0xaaa'), makeLog('0xbbb')]) // ETH batch 1
      .mockResolvedValueOnce([])                                   // ETH batch 2
      .mockResolvedValueOnce([makeLog('0xbbb'), makeLog('0xccc')]) // ARB batch 1 — 0xbbb dup
      .mockResolvedValueOnce([])                                   // ARB batch 2
      .mockResolvedValueOnce([makeLog('0xddd')])                   // BASE batch 1
      .mockResolvedValueOnce([]);                                  // BASE batch 2

    const result = await service.syncRecipients();

    expect(result.total).toBe(4);
    expect(result.recipients).toHaveLength(4);
  });

  it('records fromBlock and toBlock per network', async () => {
    mockConfigGet.mockImplementation((key: string) =>
      key === 'ZRO_ETH_RPC' ? 'https://eth.rpc'
      : key === 'ZRO_FROM_BLOCK' ? '0'
      : key === 'ZRO_BATCH_SIZE' ? '2000'
      : undefined,
    );

    const result = await service.syncRecipients();

    const eth = result.networks.find((n) => n.network === 'Ethereum');
    expect(eth?.fromBlock).toBe(0);
    expect(eth?.toBlock).toBe(3999);
  });

  it('skips networks with no RPC configured', async () => {
    mockConfigGet.mockImplementation((key: string) =>
      key === 'ZRO_ETH_RPC' ? 'https://eth.rpc'
      : key === 'ZRO_FROM_BLOCK' ? '0'
      : key === 'ZRO_BATCH_SIZE' ? '2000'
      : undefined,
    );

    const result = await service.syncRecipients();

    expect(result.networks.find((n) => n.network === 'Arbitrum')?.skipped).toBe(true);
    expect(result.networks.find((n) => n.network === 'Base')?.skipped).toBe(true);
  });

  it('records error for failing network and continues scanning others', async () => {
    mockGetBlockNumber
      .mockRejectedValueOnce(new Error('ETH node down')) // ETH fails at getBlockNumber
      .mockResolvedValue(3999);                          // others ok

    const result = await service.syncRecipients();

    expect(result.networks.find((n) => n.network === 'Ethereum')?.error).toBe('ETH node down');
    expect(result.networks.find((n) => n.network === 'Arbitrum')?.eventCount).toBe(0);
  });

  it('returns empty result when all networks fail', async () => {
    mockGetBlockNumber.mockRejectedValue(new Error('network down'));

    const result = await service.syncRecipients();

    expect(result.total).toBe(0);
    expect(result.networks.filter((n) => !n.skipped).every((n) => Boolean(n.error))).toBe(true);
  });
});
