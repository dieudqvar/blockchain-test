# blockchain-test

NestJS app with two blockchain integrations: real-time Hyperliquid trade monitoring and daily ZRO token on-chain analytics.

---

## Module Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                          NestJS App                             │
│                                                                 │
│   ┌─────────────────────────────┐   ┌────────────────────────┐ │
│   │   HyperliquidMonitorModule  │   │       ZroModule        │ │
│   │                             │   │                        │ │
│   │  ┌──────────────────────┐   │   │  ┌──────────────────┐  │ │
│   │  │ HyperliquidMonitor   │   │   │  │ TotalZroClaimed  │  │ │
│   │  │     Service          │   │   │  │    Service       │  │ │
│   │  └──────────────────────┘   │   │  └──────────────────┘  │ │
│   │  ┌──────┐ ┌──────────────┐  │   │  ┌──────────────────┐  │ │
│   │  │  WS  │ │ PushNotifier │  │   │  │  ZroRecipients   │  │ │
│   │  │Client│ │   Service    │  │   │  │    Service       │  │ │
│   │  └──────┘ └──────────────┘  │   │  └──────────────────┘  │ │
│   │  ┌──────┐ ┌──────────────┐  │   │  ┌──────────────────┐  │ │
│   │  │Redis │ │   UserRepo   │  │   │  │  ZroController   │  │ │
│   │  │Client│ │              │  │   │  │  (REST API)      │  │ │
│   │  └──────┘ └──────────────┘  │   │  └──────────────────┘  │ │
│   └─────────────────────────────┘   └────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

---

## HyperliquidMonitorModule

### Startup Sequence

```
App Start
    │
    ▼
HyperliquidMonitorService.onModuleInit()
    │
    ├──► RedisClient.connect()
    │
    ├──► UserRepo.getAllMonitoredUsers()
    │         │
    │         └── returns: [{ userId, walletAddress, deviceTokens }]
    │
    ├──► WsClient.start(users)
    │         │
    │         └── opens WebSocket shards, subscribes each wallet
    │
    └──► PushNotifier.start()
              │
              └── runs as background worker loop
```

### Event Pipeline

```
Database (Prisma / UserRepo)
      │
      │  load wallet addresses + device tokens on startup
      ▼
┌─────────────┐        subscribe userEvents        ┌──────────────────────┐
│  WsClient   │ ◄────────────────────────────────► │  Hyperliquid WS API  │
│  (Shards)   │                                    │  wss://api.hl.xyz/ws │
└─────────────┘                                    └──────────────────────┘
      │
      │  on event (fill / liquidation / order / funding) → enqueue
      ▼
┌─────────────┐
│    Redis    │  BLMOVE queue  ──►  processing  ──►  ack
│    Queue    │                         │
└─────────────┘                    fail (nack)
      ▲                                 │
      │   retry (max 3)  ◄──────────────┘
      │
      │  retries exhausted
      ▼
┌─────────────┐
│     DLQ     │  (hl:notification:failed)
└─────────────┘
      │
      │  dequeue (normal path)
      ▼
┌──────────────┐        HTTP         ┌───────────────────┐
│ PushNotifier │ ──────────────────► │  FCM / OneSignal  │
└──────────────┘                     └───────────────────┘
                                              │
                                              │  push notification
                                              ▼
                                        User's Device
```

### WebSocket Sharding

```
users[] (N wallets)
      │
      │  chunk — max 50 wallets per shard
      │
      ├──► Shard 0 ──► ws connection ──► subscribe wallet 1..50
      │                     │
      │                ping every 30s
      │                reconnect after 5s on close
      │
      ├──► Shard 1 ──► ws connection ──► subscribe wallet 51..100
      │
      └──► Shard n ──► ws connection ──► subscribe wallet ...
```

### Shutdown Sequence

```
SIGINT / SIGTERM
      │
      ▼
HyperliquidMonitorService.onModuleDestroy()
      │
      ├──► WsClient.stop()       — close all shard WebSocket connections
      ├──► PushNotifier.stop()   — exit the worker loop
      └──► RedisClient.disconnect()
```

---

## ZroModule

### TotalZroClaimedService

Scans a ZRO contract for all `Claimed` events and sums the total amount.

```
  Cron: every day at 00:00
  or  : GET /zro/total-claimed
              │
              ▼
  ┌───────────────────────┐
  │    JsonRpcProvider    │
  │    (ZRO_RPC_URL)      │
  └───────────────────────┘
              │
              │  getLogs({ address, topic, fromBlock: 0, toBlock: "latest" })
              ▼
  ┌───────────────────────┐
  │  logs[]               │
  │  each log.data = raw  │
  │  claimed amount       │
  └───────────────────────┘
              │
              │  sum all log.data as BigInt
              ▼
  ┌───────────────────────────────────────┐
  │  {                                    │
  │    totalClaimed:    "1234567.89"      │  ← formatUnits(sum, 18)
  │    totalClaimedRaw: "123456789..."    │  ← raw BigInt string
  │    eventCount:      42                │
  │    syncedAt:        "2026-04-28..."   │
  │  }                                    │
  └───────────────────────────────────────┘
```

### ZroRecipientsService

Scans Ethereum, Arbitrum, and Base in sequence. Recipient addresses are deduplicated across chains using a Set.

```
  Cron: every day at 00:00
  or  : GET /zro/recipients
              │
              ├──────────────────┬──────────────────┐
              ▼                  ▼                  ▼
  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
  │  Ethereum RPC    │ │  Arbitrum RPC    │ │  Base RPC        │
  │  getLogs(...)    │ │  getLogs(...)    │ │  getLogs(...)    │
  └──────────────────┘ └──────────────────┘ └──────────────────┘
         │  ok                │  ok                │  error
         │                    │                    │
         ▼                    ▼                    ▼
  extract topics[1]    extract topics[1]    record error
  → address            → address            skip chain, continue
         │                    │
         └──────────┬─────────┘
                    ▼
           ┌─────────────────┐
           │  Set<address>   │  ← deduplicates cross-chain
           └─────────────────┘
                    │
                    ▼
  ┌───────────────────────────────────────────────┐
  │  {                                            │
  │    total:      1500                           │
  │    recipients: ["0xAAA", "0xBBB", ...]        │
  │    networks: [                                │
  │      { network: "Ethereum", eventCount: 800 } │
  │      { network: "Arbitrum", eventCount: 500 } │
  │      { network: "Base", error: "timeout" }    │
  │    ]                                          │
  │    syncedAt: "2026-04-28T00:00:00.000Z"       │
  │  }                                            │
  └───────────────────────────────────────────────┘
```

### On-Demand API

Both cron jobs share the same method with their REST endpoints, so triggering the API runs the exact same logic immediately.

```
Client                ZroController          Service
  │                        │                    │
  │  GET /zro/total-claimed│                    │
  │ ──────────────────────►│                    │
  │                        │  syncTotalClaimed()│
  │                        │ ──────────────────►│
  │                        │                    │  fetch & compute
  │                        │◄───────────────────│
  │◄───────────────────────│                    │
  │     200 { totalClaimed, totalClaimedRaw,    │
  │           eventCount, syncedAt }            │
  │                        │                    │
  │  GET /zro/recipients   │                    │
  │ ──────────────────────►│                    │
  │                        │  syncRecipients()  │
  │                        │ ──────────────────►│
  │                        │                    │  scan all chains
  │                        │◄───────────────────│
  │◄───────────────────────│                    │
  │     200 { total, recipients[], networks[] } │
```

---

## File Structure

```
src/
├── app.module.ts
├── main.ts
├── hyperliquid-monitor/
│   ├── hyperliquid-monitor.module.ts
│   ├── hyperliquid-monitor.service.ts    ← OnModuleInit / OnModuleDestroy
│   ├── database/
│   │   └── user-repo.ts                 ← wallet + device token source
│   ├── queue/
│   │   └── redis-client.ts              ← enqueue / dequeue / ack / nack / DLQ
│   ├── services/
│   │   └── push-notifier.service.ts     ← FCM / OneSignal dispatch worker
│   └── workers/
│       └── ws-client.ts                 ← WebSocket shards + reconnect + ping
└── zro/
    ├── zro.module.ts
    ├── zro.controller.ts                ← GET /zro/total-claimed, GET /zro/recipients
    └── services/
        ├── total-zro-claimed.service.ts ← cron + on-demand
        └── zro-recipients.service.ts    ← cron + on-demand

test/
├── hyperliquid-monitor/
│   └── hyperliquid-monitor.service.spec.ts
└── zro/
    ├── total-zro-claimed.service.spec.ts
    ├── zro-recipients.service.spec.ts
    └── zro.controller.spec.ts
```

---

## Environment Variables

| Variable | Module | Description |
|----------|--------|-------------|
| `REDIS_URL` | HyperliquidMonitor | Redis connection URL |
| `FCM_PROJECT_ID` | HyperliquidMonitor | Firebase project ID |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | HyperliquidMonitor | Firebase service account (JSON string) |
| `ONESIGNAL_REST_API_KEY` | HyperliquidMonitor | OneSignal REST key *(optional)* |
| `ONESIGNAL_APP_ID` | HyperliquidMonitor | OneSignal app ID *(optional)* |
| `ZRO_RPC_URL` | TotalZroClaimed | RPC endpoint for ZRO contract chain |
| `ZRO_CONTRACT_ADDRESS` | TotalZroClaimed | ZRO contract address |
| `ZRO_CLAIMED_EVENT_TOPIC` | TotalZroClaimed | `Claimed` event topic hash |
| `ZRO_ETH_RPC` | ZroRecipients | Ethereum RPC |
| `ZRO_ARB_RPC` | ZroRecipients | Arbitrum RPC |
| `ZRO_BASE_RPC` | ZroRecipients | Base RPC |

---

## Commands

```bash
npm install
cp .env.example .env

npm run start:dev          # development
npm run start:prod         # production

npm test                   # unit tests
npm run test:cov           # coverage
npm run test:e2e           # e2e
```
