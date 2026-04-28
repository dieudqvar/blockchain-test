import { Module } from '@nestjs/common';
import { HyperliquidMonitorService } from './hyperliquid-monitor.service';

@Module({
  providers: [HyperliquidMonitorService],
})
export class HyperliquidMonitorModule {}
