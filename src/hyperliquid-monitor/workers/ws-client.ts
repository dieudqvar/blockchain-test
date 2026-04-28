import WebSocket from 'ws';
import { RedisClient } from '../queue/redis-client';
import { UserDevice } from '../database/user-repo';

const HL_WS_URL = 'wss://api.hyperliquid.xyz/ws';
const PING_INTERVAL_MS = 30_000;
const RECONNECT_DELAY_MS = 5_000;
const MAX_USERS_PER_SHARD = 50;

interface Shard {
  id: number;
  ws: WebSocket | null;
  users: UserDevice[];
  pingTimer: NodeJS.Timeout | null;
}

export class WsClient {
  private shards: Shard[] = [];
  private destroyed = false;

  constructor(
    private readonly queue: RedisClient,
    private readonly walletMap: Map<string, UserDevice>,
  ) {}

  async start(users: UserDevice[]): Promise<void> {
    for (const user of users) {
      this.walletMap.set(user.walletAddress.toLowerCase(), user);
    }

    const shardGroups = this.chunk(users, MAX_USERS_PER_SHARD);
    shardGroups.forEach((group, idx) => {
      const shard: Shard = { id: idx, ws: null, users: group, pingTimer: null };
      this.shards.push(shard);
      this.connectShard(shard);
    });

    console.log(
      `[WsClient] started ${this.shards.length} shard(s) for ${users.length} users`,
    );
  }

  stop(): void {
    this.destroyed = true;
    for (const shard of this.shards) {
      shard.pingTimer && clearInterval(shard.pingTimer);
      shard.ws?.close();
    }
  }

  private connectShard(shard: Shard): void {
    if (this.destroyed) return;

    const ws = new WebSocket(HL_WS_URL);
    shard.ws = ws;

    ws.on('open', () => {
      console.log(`[WsClient] shard ${shard.id} connected`);
      this.subscribeAll(shard);
      this.startPing(shard);
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      this.handleMessage(raw.toString());
    });

    ws.on('error', (err) => {
      console.error(`[WsClient] shard ${shard.id} error:`, err.message);
    });

    ws.on('close', (code) => {
      console.warn(
        `[WsClient] shard ${shard.id} closed (code: ${code}), reconnecting in ${RECONNECT_DELAY_MS}ms`,
      );
      shard.pingTimer && clearInterval(shard.pingTimer);
      shard.ws = null;

      if (!this.destroyed) {
        setTimeout(() => this.connectShard(shard), RECONNECT_DELAY_MS);
      }
    });
  }

  private subscribeAll(shard: Shard): void {
    for (const user of shard.users) {
      this.subscribe(shard, user.walletAddress);
    }
  }

  private subscribe(shard: Shard, walletAddress: string): void {
    if (shard.ws?.readyState !== WebSocket.OPEN) return;

    shard.ws.send(
      JSON.stringify({
        method: 'subscribe',
        subscription: { type: 'userEvents', user: walletAddress.toLowerCase() },
      }),
    );
  }

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    if (msg['channel'] !== 'userEvents') return;

    const data = msg['data'] as Record<string, unknown> | undefined;
    if (!data) return;

    const wallet = (data['user'] as string | undefined)?.toLowerCase();
    if (!wallet) return;

    const userDevice = this.walletMap.get(wallet);
    if (!userDevice) return;

    this.routeEvent(userDevice, data);
  }

  private routeEvent(
    user: UserDevice,
    data: Record<string, unknown>,
  ): void {
    const eventTypes = [
      { key: 'fills', type: 'fill' },
      { key: 'liquidations', type: 'liquidation' },
      { key: 'orders', type: 'order' },
      { key: 'fundings', type: 'funding' },
    ] as const;

    for (const { key, type } of eventTypes) {
      if (!data[key]) continue;

      this.queue
        .enqueue({
          walletAddress: user.walletAddress,
          deviceTokens: user.deviceTokens,
          event: {
            type,
            data: data[key] as Record<string, unknown>,
            timestamp: Date.now(),
          },
        })
        .catch((err: Error) => {
          console.error(
            `[WsClient] enqueue failed for ${user.walletAddress}:`,
            err.message,
          );
        });
    }
  }

  private startPing(shard: Shard): void {
    shard.pingTimer = setInterval(() => {
      if (shard.ws?.readyState === WebSocket.OPEN) {
        shard.ws.send(JSON.stringify({ method: 'ping' }));
      }
    }, PING_INTERVAL_MS);
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }
}
