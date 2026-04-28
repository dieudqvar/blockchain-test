import { GoogleAuth } from 'google-auth-library';
import {
  HyperliquidEvent,
  NotificationPayload,
  RedisClient,
} from '../queue/redis-client';

export interface PushResult {
  success: string[];
  failed: string[];
}

export class PushNotifier {
  private running = false;
  private readonly auth: GoogleAuth;
  private readonly fcmEndpoint: string;

  constructor(
    private readonly queue: RedisClient,
    private readonly provider: 'fcm' | 'onesignal' = 'fcm',
  ) {
    const projectId = process.env.FCM_PROJECT_ID ?? '';
    this.fcmEndpoint = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
    this.auth = new GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? '{}'),
      scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
    });
  }

  async start(): Promise<void> {
    this.running = true;
    console.log(`[PushNotifier] starting worker (provider: ${this.provider})`);

    while (this.running) {
      const job = await this.queue.dequeue();
      if (!job) continue;

      try {
        await this.dispatch(job.payload);
        await this.queue.ack(job.jobRaw);
      } catch (err) {
        console.error(
          '[PushNotifier] dispatch failed:',
          (err as Error).message,
        );
        await this.queue.nack(job.jobRaw);
      }
    }
  }

  stop(): void {
    this.running = false;
  }

  private async dispatch(payload: NotificationPayload): Promise<void> {
    const message = this.buildMessage(payload.event);

    if (this.provider === 'fcm') {
      await this.sendViaFCM(payload.deviceTokens, message);
    } else {
      await this.sendViaOneSignal(payload.deviceTokens, message);
    }
  }

  private async sendViaFCM(
    tokens: string[],
    message: { title: string; body: string; data: Record<string, string> },
  ): Promise<PushResult> {
    const result: PushResult = { success: [], failed: [] };
    const chunks = this.chunk(tokens, 500);
    const accessToken = await this.auth.getAccessToken();

    for (const chunk of chunks) {
      const response = await fetch(this.fcmEndpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            notification: { title: message.title, body: message.body },
            data: message.data,
            tokens: chunk,
          },
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`FCM error: ${err}`);
      }

      const json = (await response.json()) as {
        successCount: number;
        failureCount: number;
      };
      console.log(
        `[PushNotifier] FCM batch sent — success: ${json.successCount}, failed: ${json.failureCount}`,
      );

      result.success.push(...chunk);
    }

    return result;
  }

  private async sendViaOneSignal(
    tokens: string[],
    message: { title: string; body: string; data: Record<string, string> },
  ): Promise<void> {
    const response = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${process.env.ONESIGNAL_REST_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        app_id: process.env.ONESIGNAL_APP_ID,
        include_player_ids: tokens,
        headings: { en: message.title },
        contents: { en: message.body },
        data: message.data,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OneSignal error: ${err}`);
    }

    const json = (await response.json()) as { id: string; recipients: number };
    console.log(
      `[PushNotifier] OneSignal sent — id: ${json.id}, recipients: ${json.recipients}`,
    );
  }

  private buildMessage(event: HyperliquidEvent): {
    title: string;
    body: string;
    data: Record<string, string>;
  } {
    const templates: Record<
      HyperliquidEvent['type'],
      { title: string; body: string }
    > = {
      fill: { title: 'Order Filled', body: 'Your order was filled on Hyperliquid.' },
      liquidation: { title: 'Liquidation Alert', body: 'Your position is being liquidated!' },
      order: { title: 'Order Update', body: 'Your order status has changed.' },
      funding: { title: 'Funding Payment', body: 'A funding payment was applied to your position.' },
    };

    return {
      ...templates[event.type],
      data: {
        type: event.type,
        timestamp: String(event.timestamp),
        payload: JSON.stringify(event.data),
      },
    };
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }
}
