import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { TotalZroClaimedService, TotalClaimedResult } from './services/total-zro-claimed.service';
import { ZroRecipientsService, RecipientsResult } from './services/zro-recipients.service';

@Controller('zro')
export class ZroController {
  constructor(
    private readonly totalZroClaimedService: TotalZroClaimedService,
    private readonly zroRecipientsService: ZroRecipientsService,
  ) {}

  @Get('total-claimed')
  @HttpCode(HttpStatus.OK)
  getTotalClaimed(): Promise<TotalClaimedResult> {
    return this.totalZroClaimedService.syncTotalClaimed();
  }

  @Get('recipients')
  @HttpCode(HttpStatus.OK)
  getRecipients(): Promise<RecipientsResult> {
    return this.zroRecipientsService.syncRecipients();
  }
}
