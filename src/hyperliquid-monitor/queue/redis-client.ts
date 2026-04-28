import Redis from 'ioredis';

export interface NotificationPayload {
  walletAddress: string;
  deviceTokens: string[];
  event: HyperliquidEvent;
}

export interface HyperliquidEvent {
  type: 'fill' | 'liquidation' | 'order' | 'funding';
  data: Record<string, unknown>;
  timestamp: number;
}

const QUEUE_KEY = 'hl:notification:queue';
const PROCESSING_KEY = 'hl:notification:processing';
const FAILED_KEY = 'hl:notification:failed';
const MAX_RETRY = 3;

export class RedisClient {
  private readonly client: Redis;

  constructor(redisUrl = process.env.REDIS_URL ?? '') {
    this.client = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });

    this.client.on('error', (err) => {
      console.error('[RedisClient] connection error:', err.message);
    });
  }

  async connect(): Promise<void> {
    await this.client.connect();
    console.log('[RedisClient] connected');
  }

  async disconnect(): Promise<void> {
    await this.client.quit();
  }

  async enqueue(payload: NotificationPayload): Promise<void> {
    const job = JSON.stringify({ payload, retries: 0, enqueuedAt: Date.now() });
    await this.client.rpush(QUEUE_KEY, job);
  }

  async dequeue(): Promise<{
    payload: NotificationPayload;
    retries: number;
    jobRaw: string;
  } | null> {
    const jobRaw = await this.client.blmove(
      QUEUE_KEY,
      PROCESSING_KEY,
      'LEFT',
      'RIGHT',
      5,
    );
    if (!jobRaw) return null;

    const job = JSON.parse(jobRaw) as {
      payload: NotificationPayload;
      retries: number;
      enqueuedAt: number;
    };
    return { ...job, jobRaw };
  }

  async ack(jobRaw: string): Promise<void> {
    await this.client.lrem(PROCESSING_KEY, 1, jobRaw);
  }

  async nack(jobRaw: string): Promise<void> {
    await this.client.lrem(PROCESSING_KEY, 1, jobRaw);

    const job = JSON.parse(jobRaw) as {
      payload: NotificationPayload;
      retries: number;
      enqueuedAt: number;
    };
    job.retries += 1;

    if (job.retries >= MAX_RETRY) {
      await this.client.rpush(FAILED_KEY, JSON.stringify(job));
      console.warn('[RedisClient] job moved to DLQ after max retries');
    } else {
      await this.client.rpush(QUEUE_KEY, JSON.stringify(job));
    }
  }

  async queueLength(): Promise<number> {
    return this.client.llen(QUEUE_KEY);
  }

  async failedLength(): Promise<number> {
    return this.client.llen(FAILED_KEY);
  }
}
