import { Module } from '@nestjs/common';
import { TotalZroClaimedService } from './services/total-zro-claimed.service';
import { ZroRecipientsService } from './services/zro-recipients.service';
import { ZroController } from './zro.controller';

@Module({
  controllers: [ZroController],
  providers: [TotalZroClaimedService, ZroRecipientsService],
})
export class ZroModule {}
