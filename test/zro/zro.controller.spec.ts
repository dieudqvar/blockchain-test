import { Test, TestingModule } from '@nestjs/testing';
import { ZroController } from '../../src/zro/zro.controller';
import { TotalZroClaimedService } from '../../src/zro/services/total-zro-claimed.service';
import { ZroRecipientsService } from '../../src/zro/services/zro-recipients.service';

const mockTotalResult = {
  totalClaimed: '100.0',
  totalClaimedRaw: '100000000000000000000',
  eventCount: 5,
  syncedAt: '2026-04-28T00:00:00.000Z',
};

const mockRecipientsResult = {
  total: 3,
  recipients: ['0xAAA', '0xBBB', '0xCCC'],
  networks: [
    { network: 'Ethereum', eventCount: 2 },
    { network: 'Arbitrum', eventCount: 1 },
    { network: 'Base', eventCount: 0, skipped: true },
  ],
  syncedAt: '2026-04-28T00:00:00.000Z',
};

describe('ZroController', () => {
  let controller: ZroController;
  let totalClaimedService: jest.Mocked<TotalZroClaimedService>;
  let recipientsService: jest.Mocked<ZroRecipientsService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ZroController],
      providers: [
        {
          provide: TotalZroClaimedService,
          useValue: {
            syncTotalClaimed: jest.fn().mockResolvedValue(mockTotalResult),
          },
        },
        {
          provide: ZroRecipientsService,
          useValue: {
            syncRecipients: jest.fn().mockResolvedValue(mockRecipientsResult),
          },
        },
      ],
    }).compile();

    controller = module.get(ZroController);
    totalClaimedService = module.get(
      TotalZroClaimedService,
    ) as jest.Mocked<TotalZroClaimedService>;
    recipientsService = module.get(
      ZroRecipientsService,
    ) as jest.Mocked<ZroRecipientsService>;
  });

  describe('GET /zro/total-claimed', () => {
    it('delegates to TotalZroClaimedService and returns its result', async () => {
      const result = await controller.getTotalClaimed();

      expect(result).toEqual(mockTotalResult);
      expect(totalClaimedService.syncTotalClaimed).toHaveBeenCalledTimes(1);
    });

    it('propagates service errors', async () => {
      totalClaimedService.syncTotalClaimed.mockRejectedValue(
        new Error('RPC down'),
      );

      await expect(controller.getTotalClaimed()).rejects.toThrow('RPC down');
    });
  });

  describe('GET /zro/recipients', () => {
    it('delegates to ZroRecipientsService and returns its result', async () => {
      const result = await controller.getRecipients();

      expect(result).toEqual(mockRecipientsResult);
      expect(recipientsService.syncRecipients).toHaveBeenCalledTimes(1);
    });

    it('propagates service errors', async () => {
      recipientsService.syncRecipients.mockRejectedValue(
        new Error('scan failed'),
      );

      await expect(controller.getRecipients()).rejects.toThrow('scan failed');
    });
  });
});
