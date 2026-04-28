import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppService } from './app.service';
import { HyperliquidMonitorModule } from './hyperliquid-monitor/hyperliquid-monitor.module';
import { ZroModule } from './zro/zro.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    HyperliquidMonitorModule,
    ZroModule,
  ],
  controllers: [],
  providers: [AppService],
})
export class AppModule {}
