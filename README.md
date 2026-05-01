# Mission-Critical Incident Management System (IMS)

A resilient, production-grade Incident Management System built to monitor distributed stacks and manage failure mediation workflows.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        Signal Producers                         │
│              (APIs, MCP Hosts, Caches, Queues, DBs)             │
└────────────────────────────┬────────────────────────────────────┘
                             │ POST /signals (HTTP)
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Fastify API Server                          │
│  ┌──────────────┐  ┌─────────────────┐  ┌───────────────────┐  │
│  │ Rate Limiter │  │  Zod Validation │  │  202 Accepted     │  │
│  │ (Redis TB)   │  │                 │  │  (Immediate ACK)  │  │
│  └──────────────┘  └─────────────────┘  └───────────────────┘  │
└────────────────────────────┬────────────────────────────────────┘
                             │ enqueue (BullMQ)
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    BullMQ Signal Queue                          │
│              (Redis-backed, persistent, retryable)              │
│              ← BACKPRESSURE BUFFER: absorbs 10k/s bursts        │
└────────────────────────────┬────────────────────────────────────┘
                             │ consume (Worker Pool, concurrency=10)
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Signal Processor                           │
│                                                                 │
│  1. Redis INCR(debounce:{componentId}, TTL=10s)                 │
│     → count==1? Create Work Item in Postgres                    │
│     → count>1?  Increment signal_count in Postgres              │
│                                                                 │
│  2. Strategy Pattern: resolve alert by component type           │
│     RDBMS/MCP_HOST → P0 | API/QUEUE → P1 | CACHE/NOSQL → P2    │
│                                                                 │
│  3. MongoDB: insert raw signal payload (audit log)              │
│  4. TimescaleDB: insert signal_metrics (timeseries)             │
│  5. WebSocket: broadcast update to dashboard                    │
└──────────┬──────────────────────┬──────────────────────────────┘
           │                      │
           ▼                      ▼
┌──────────────────┐   ┌──────────────────────────────────────┐
│   PostgreSQL     │   │              MongoDB                  │
│  (TimescaleDB)   │   │           raw_signals collection      │
│                  │   │  • Every signal payload               │
│ work_items       │   │  • Indexed by workItemId              │
│ rca_records      │   │  • 500-record UI limit per incident   │
│ signal_metrics   │   └──────────────────────────────────────┘
│ (hypertable)     │
└──────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────────┐
│                        React Dashboard                           │
│                                                                  │
│  ┌─────────────────┐  ┌───────────────────┐  ┌───────────────┐  │
│  │   Live Feed     │  │  Incident Detail  │  │   RCA Form    │  │
│  │  sorted by P0→P2│  │  + Raw Signals    │  │  + Validation │  │
│  └─────────────────┘  └───────────────────┘  └───────────────┘  │
│                         WebSocket (live updates)                 │
└──────────────────────────────────────────────────────────────────┘
```

## Design Patterns

### Strategy Pattern — Alerting
Different component failures trigger different alert strategies:
- `P0AlertStrategy` — RDBMS, MCP_HOST (page on-call)
- `P1AlertStrategy` — API, QUEUE (Slack notification)
- `P2AlertStrategy` — CACHE, NOSQL (create ticket)

The `AlertContext` allows swapping strategies at runtime without changing the processor.

### State Pattern — Work Item Lifecycle
```
OPEN → INVESTIGATING → RESOLVED → CLOSED
```
Each state enforces valid transitions. Attempting `RESOLVED → CLOSED` without a complete RCA record throws a `422 Unprocessable Entity`.

## Tech Stack

| Layer | Technology | Reason |
|---|---|---|
| API Server | Fastify + TypeScript | Schema validation, native async, fastest Node HTTP |
| Queue / Backpressure | BullMQ + Redis | Durable, retryable, handles 10k+/s bursts |
| Source of Truth | PostgreSQL (TimescaleDB) | ACID transactions for state transitions |
| Audit Log | MongoDB | Flexible schema for raw signal payloads |
| Hot Cache | Redis | O(1) debounce windows, dashboard state |
| Timeseries | TimescaleDB hypertable | Efficient signal throughput aggregations |
| Frontend | React + Vite + Tailwind | Fast HMR, responsive dashboard |
| Real-time | WebSocket (fastify-websocket) | Push-based live feed updates |

## Backpressure Strategy

The ingestion endpoint returns **202 Accepted immediately** after enqueuing to BullMQ. The queue acts as a shock absorber:

1. **Rate Limiter**: Redis token bucket caps at 10,000 req/10s before BullMQ
2. **BullMQ Queue**: Redis-backed durable buffer — if Postgres is slow, signals buffer here rather than timing out
3. **Worker Concurrency**: Workers process at their own pace (configurable, default 10 concurrent)
4. **Exponential Backoff**: Failed jobs retry 3 times with exponential delay (500ms × attempt)
5. **Throughput Metrics**: `console.log` every 5s shows ingested vs processed vs queue depth

This means the system **cannot crash** under Postgres latency spikes — signals buffer in Redis until the DB catches up.

## Setup Instructions

### Prerequisites
- Docker Desktop (includes Docker Compose)
- Node.js 22+ (via nvm)

### Start Everything

```bash
# Clone / enter the project
cd Mission-Critical-IMS

# Start all services (Postgres, Mongo, Redis, Backend, Frontend)
docker compose up --build

# OR run databases in Docker and services locally for faster dev:
docker compose up postgres mongo redis -d
cd backend && npm install && npm run dev
cd frontend && npm install && npm run dev
```

### URLs
| Service | URL |
|---|---|
| Frontend Dashboard | http://localhost:3000 |
| Backend API | http://localhost:3001 |
| Health Check | http://localhost:3001/health |
| WebSocket | ws://localhost:3001/ws |

### Run the Outage Simulation

```bash
cd scripts
npx ts-node simulate-outage.ts
```

This fires 640+ signals across RDBMS, MCP_HOST, CACHE, and QUEUE components, simulating a cascading outage. Watch the dashboard update in real-time.

### Run Tests

```bash
cd backend
npm test
```

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/signals` | Ingest a signal (returns 202 immediately) |
| `GET` | `/incidents` | List all incidents sorted by priority |
| `GET` | `/incidents/:id` | Detail + raw signals from MongoDB |
| `PATCH` | `/incidents/:id/status` | Transition state (State Pattern enforced) |
| `POST` | `/incidents/:id/rca` | Submit or update RCA |
| `GET` | `/health` | Health check + queue depth + uptime |

### Signal Payload Example

```json
{
  "componentId": "POSTGRES_PRIMARY_01",
  "componentType": "RDBMS",
  "errorCode": "CONN_REFUSED",
  "message": "Connection to primary refused",
  "latencyMs": 30000,
  "metadata": { "host": "pg-primary-01.internal" }
}
```

## Project Structure

```
Mission-Critical-IMS/
├── docker-compose.yml
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   ├── db/
│   │   └── init.sql
│   └── src/
│       ├── index.ts          ← Fastify app + metrics loop
│       ├── config.ts
│       ├── types.ts
│       ├── db/
│       │   ├── postgres.ts   ← Pool + retry helper
│       │   ├── mongo.ts      ← Raw signals collection
│       │   └── redis.ts      ← Cache + debounce keys
│       ├── patterns/
│       │   ├── alertStrategy.ts  ← Strategy Pattern
│       │   └── workItemState.ts  ← State Pattern
│       ├── queue/
│       │   ├── signalQueue.ts    ← BullMQ producer + worker
│       │   └── signalProcessor.ts← Debounce + Work Item logic
│       ├── routes/
│       │   ├── signals.ts
│       │   ├── incidents.ts
│       │   └── health.ts
│       ├── ws/
│       │   └── broadcaster.ts
│       └── __tests__/
│           └── workItemState.test.ts
├── frontend/
│   ├── Dockerfile
│   ├── package.json
│   ├── vite.config.ts
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── api.ts
│       ├── types.ts
│       ├── store/wsStore.ts
│       ├── components/Badges.tsx
│       └── pages/
│           ├── Dashboard.tsx
│           └── IncidentDetail.tsx
└── scripts/
    └── simulate-outage.ts
```
