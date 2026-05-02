# Mission-Critical Incident Management System (IMS)

A resilient, production-grade Incident Management System built to monitor distributed stacks (APIs, MCP Hosts, Distributed Caches, Async Queues, RDBMS, and NoSQL stores) and manage failure mediation workflows end-to-end.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Signal Producers                           │
│           (APIs · MCP Hosts · Caches · Queues · DBs · NoSQL)        │
└──────────────────────────────┬──────────────────────────────────────┘
                               │  POST /signals        POST /signals/batch
                               │  (single)             (up to 100 per request)
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Fastify API Server                           │
│                                                                     │
│   ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│   │  Rate Limiter   │  │  Zod Validation  │  │   202 Accepted   │  │
│   │  10k req/10s    │  │  strict schemas  │  │  immediate ACK   │  │
│   │  (Redis-backed) │  │  + sanitisation  │  │  never blocks    │  │
│   └─────────────────┘  └──────────────────┘  └──────────────────┘  │
└──────────────────────────────┬──────────────────────────────────────┘
                               │  addBulk() / add()
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      BullMQ Signal Queue                            │
│             Redis-backed · persistent · retryable                   │
│        ◄── BACKPRESSURE BUFFER: absorbs 10,000 signals/sec ──►      │
│             exponential back-off · 3 retry attempts                 │
└──────────────────────────────┬──────────────────────────────────────┘
                               │  Worker Pool  (concurrency = CPU × 2)
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Signal Processor                             │
│                                                                     │
│  1. Redis INCR(ims:debounce:{componentId}, TTL=10s)                 │
│       count == 1  →  CREATE Work Item in Postgres (transactional)   │
│       count  > 1  →  INCREMENT signal_count only                    │
│                                                                     │
│  2. Strategy Pattern — resolve alert priority by component type     │
│       RDBMS / MCP_HOST  →  P0AlertStrategy  (page on-call)         │
│       API   / QUEUE     →  P1AlertStrategy  (Slack notification)   │
│       CACHE / NOSQL     →  P2AlertStrategy  (create ticket)        │
│                                                                     │
│  3. MongoDB  →  insert raw signal payload  (audit log)              │
│  4. TimescaleDB  →  insert signal_metrics  (timeseries)             │
│  5. WebSocket  →  broadcast WORK_ITEM_CREATED to dashboard          │
└──────────┬───────────────────────────┬───────────────────────────────┘
           │                           │
           ▼                           ▼
┌────────────────────┐     ┌────────────────────────────────────────┐
│    PostgreSQL      │     │               MongoDB                  │
│  (TimescaleDB)     │     │          raw_signals collection        │
│                    │     │                                        │
│  work_items        │     │  • Every raw signal payload stored     │
│  rca_records       │     │  • Indexed: workItemId, componentId,   │
│  signal_metrics    │     │    timestamp                           │
│  (hypertable)      │     │  • Up to 500 signals shown per item    │
└────────────────────┘     └────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         React Dashboard                             │
│                                                                     │
│  ┌──────────────────┐  ┌───────────────────┐  ┌─────────────────┐  │
│  │    Live Feed     │  │  Incident Detail  │  │    RCA Form     │  │
│  │  sorted P0 → P2  │  │  + Raw Signals    │  │  live validation│  │
│  │  WebSocket-driven│  │  from MongoDB     │  │  MTTR computed  │  │
│  └──────────────────┘  └───────────────────┘  └─────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Design Patterns

### Strategy Pattern — Alerting (`src/patterns/alertStrategy.ts`)

Different component types require different alerting behaviour. The `AlertStrategy` interface decouples alert logic from the processor so strategies can be swapped at runtime without touching ingestion code.

```
AlertStrategy (interface)
  ├── P0AlertStrategy  → RDBMS, MCP_HOST  (page on-call engineer)
  ├── P1AlertStrategy  → API, QUEUE       (Slack #incidents channel)
  └── P2AlertStrategy  → CACHE, NOSQL     (auto-create Jira ticket)

AlertContext.execute(componentType, workItemId)
  └── resolves correct strategy via factory, fires notification
```

### State Pattern — Work Item Lifecycle (`src/patterns/workItemState.ts`)

Each state encapsulates its own valid transitions. Invalid transitions throw immediately with a descriptive error — no scattered `if/switch` logic.

```
OPEN  →  INVESTIGATING  →  RESOLVED  →  CLOSED
 ↑                                         │
 └── all other jumps rejected (422) ───────┘

RESOLVED → CLOSED requires a complete RCA record.
Missing or incomplete RCA throws: "Cannot CLOSE work item: RCA record is missing"
MTTR is calculated and persisted atomically on close.
```

---

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| API Server | Fastify + TypeScript | Fastest Node HTTP framework, built-in schema serialisation |
| Queue / Backpressure | BullMQ + Redis | Durable, retryable, handles 10k+/s burst without crashing |
| Source of Truth | PostgreSQL (TimescaleDB) | ACID transactions for state transitions + timeseries metrics |
| Audit Log | MongoDB | Flexible schema, high write throughput for raw signal payloads |
| Hot Cache / Debounce | Redis | O(1) atomic INCR for debounce windows, rate-limit counters |
| Timeseries | TimescaleDB hypertable | Compressed, indexed signal throughput aggregations |
| Frontend | React + Vite + Tailwind | Sub-second HMR, responsive dark-mode dashboard |
| Real-time | WebSocket (fastify-websocket) | Push-based live feed — no polling |
| Validation | Zod | Runtime schema enforcement on every inbound payload |

---

## Backpressure Strategy

The ingestion endpoint returns **`202 Accepted` immediately** after enqueuing. The system never blocks the HTTP response waiting for DB writes.

```
[Client] → POST /signals → [Fastify] → addBulk(BullMQ) → 202 ✓
                                              ↓
                                     [BullMQ Queue in Redis]
                                              ↓  (async, at own pace)
                                       [Worker Pool]
                                              ↓
                                    [Postgres + Mongo writes]
```

Five layers prevent cascading failure under load:

1. **Rate Limiter** — Redis-backed, rejects above 10,000 req/10s with `429`
2. **BullMQ Buffer** — if Postgres is slow, jobs queue in Redis rather than timing out
3. **Batch Endpoint** — `POST /signals/batch` accepts 100 signals per HTTP call, reducing TCP overhead 100×
4. **Worker Concurrency** — configurable via `WORKER_CONCURRENCY` env var (defaults to `CPU cores × 2`)
5. **Exponential Backoff** — failed jobs retry up to 3 times (500ms → 1s → 2s delays)

Throughput metrics are printed to console every 5 seconds:
```
[Metrics] Signals ingested: 4823/5s | Processed: 4801/5s | Queue: 22 waiting
```

---

## Prerequisites

- **Docker Desktop** with Docker Compose v2 (includes Compose)
- **Node.js 22+** — install via `nvm install --lts`

---

## Quick Start

```bash
# 1. Enter the project root
cd Mission-Critical-IMS

# 2. Start every service (Postgres, MongoDB, Redis, Backend, Frontend)
docker compose up --build
```

Wait ~60 seconds for all health checks to pass, then open:

| Service | URL |
|---|---|
| Dashboard | http://localhost:3000 |
| Backend API | http://localhost:3001 |
| Health Check | http://localhost:3001/health |
| WebSocket | ws://localhost:3001/ws |

### Local Development (faster iteration)

```bash
# Start only the databases in Docker
docker compose up postgres mongo redis -d

# Backend (hot-reload)
cd backend && npm install && npm run dev

# Frontend (hot-reload, separate terminal)
cd frontend && npm install && npm run dev
```

---

## Simulation Scripts

### Install script dependencies (one time)

```bash
cd scripts
npm install
```

### Outage Scenario — cascading failure across 5 components

```bash
npx ts-node simulate-outage.ts
```

Fires 640 signals across RDBMS, MCP_HOST, CACHE, QUEUE, and NOSQL components in 5 phases. Each component's signals are debounced into a single Work Item. Watch the dashboard populate in real time.

Expected dashboard result:
- `P0` — POSTGRES_PRIMARY_01, POSTGRES_REPLICA_01, MCP_HOST_GATEWAY_01
- `P1` — QUEUE_WORKER_POOL_01
- `P2` — CACHE_CLUSTER_01

### Burst Test — 10,000 signals/sec stress test

```bash
npx ts-node simulate-outage.ts --burst
```

Fires 50,000 signals over 5 seconds (500 batch requests × 100 signals each) and reports:
- Achieved throughput (signals/sec)
- Acceptance vs rate-limited vs failed counts
- Latency percentiles (p50 / p95 / p99 / max)
- Crash resilience verdict (PASS if <1% failures)
- Post-burst health check

### Both scenarios back to back

```bash
npx ts-node simulate-outage.ts --both
```

### Reset all data between runs

```bash
chmod +x scripts/reset-data.sh
./scripts/reset-data.sh
```

Wipes Postgres tables, MongoDB collection, Redis keys, and removes Docker volumes. Prompts for `YES` confirmation before proceeding.

---

## Running Tests

```bash
cd backend
npm install

# All tests
npm test

# With coverage report
npm run test:coverage

# Specific suite
npm test -- --testPathPattern=workItemState
npm test -- --testPathPattern=alertStrategy
npm test -- --testPathPattern=stress

# Watch mode
npm run test:watch
```

### Test Suites

| File | Coverage | Description |
|---|---|---|
| `workItemState.test.ts` | State machine | 18+ cases — all transitions, RCA guard, MTTR calc, rollback |
| `alertStrategy.test.ts` | Strategy pattern | 20+ cases — P0/P1/P2 assignment, context switching, titles |
| `signals.test.ts` | Route validation | 25+ cases — schema enforcement, priority queuing, edge cases |
| `integration.test.ts` | End-to-end flow | 10+ cases — signal → Work Item, debounce, error recovery |
| `stress.test.ts` | Load scenarios | 8 scenarios — burst, sustained load, mixed types, stability |

---

## API Reference

### Signal Ingestion

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/signals` | Ingest one signal — returns `202` immediately |
| `POST` | `/signals/batch` | Ingest up to 100 signals — single HTTP round-trip |

**Single signal payload:**
```json
{
  "componentId":   "POSTGRES_PRIMARY_01",
  "componentType": "RDBMS",
  "errorCode":     "CONN_REFUSED",
  "message":       "Connection to primary refused — host unreachable",
  "latencyMs":     30000,
  "metadata":      { "host": "pg-primary-01.internal", "port": 5432 }
}
```

**Batch payload:**
```json
{
  "signals": [
    { "componentId": "CACHE_01", "componentType": "CACHE", "errorCode": "EVICTION", "message": "Cache eviction storm" },
    { "componentId": "API_01",   "componentType": "API",   "errorCode": "HTTP_503",  "message": "API returning 503" }
  ]
}
```

### Incidents

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/incidents` | List all incidents sorted by priority then start time |
| `GET` | `/incidents/:id` | Incident detail + raw signals (from MongoDB) |
| `PATCH` | `/incidents/:id/status` | State transition — enforced by State Pattern |
| `POST` | `/incidents/:id/rca` | Submit or update RCA record |

**Status transition body:**
```json
{ "status": "INVESTIGATING" }
```

Valid transitions: `OPEN → INVESTIGATING → RESOLVED → CLOSED`
Attempting `RESOLVED → CLOSED` without RCA returns `422`.

**RCA submission body:**
```json
{
  "incidentStart":      "2026-05-02T05:24:00.000Z",
  "incidentEnd":        "2026-05-02T07:45:00.000Z",
  "rootCauseCategory":  "INFRASTRUCTURE",
  "fixApplied":         "Restarted primary DB, promoted replica, updated connection pool config",
  "preventionSteps":    "Add automated failover, increase connection pool size, add circuit breaker"
}
```

### System

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Health status + queue depth + per-service ping |
| `GET` | `/ws` | WebSocket — upgrade for live dashboard events |

**Health response:**
```json
{
  "status":     "ok",
  "postgres":   true,
  "mongo":      true,
  "redis":      true,
  "queueDepth": 0,
  "uptime":     3842
}
```

### Validation Rules

| Field | Rules |
|---|---|
| `componentId` | 1–255 chars, alphanumeric / hyphens / underscores / dots |
| `componentType` | Enum: `RDBMS`, `CACHE`, `API`, `QUEUE`, `NOSQL`, `MCP_HOST` |
| `errorCode` | 1–100 chars, uppercase + underscores only (`^[A-Z0-9_]*$`) |
| `message` | 1–1000 chars, trimmed |
| `latencyMs` | Integer 0–60,000 (optional) |
| `timestamp` | ISO 8601 datetime (optional, defaults to server time) |

---

## Security

### Input Validation
- Zod schemas enforce type, length, and regex on every inbound field
- Additional fields are stripped — no passthrough to DB
- Prevents SQL injection, XSS, buffer overflow, and type coercion attacks

### Rate Limiting
- Global: 10,000 requests per 10 seconds (returns `429`)
- Per-IP: 1,000 requests per 60 seconds (optional, configurable)

### Optional API Key Authentication
```bash
# Enable in environment
ENABLE_API_KEY_AUTH=true
API_KEY=your-secret-key

# Client usage
curl -H "X-API-Key: your-secret-key" http://localhost:3001/signals ...
```

### Database Security
- Parameterised queries throughout — no string concatenation
- Statement timeout: 10 seconds (kills runaway queries)
- Connection pool limits prevent exhaustion attacks
- Transaction rollback on any error

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Backend server port |
| `DATABASE_URL` | `postgresql://ims_user:ims_pass@localhost:5432/ims_db` | Postgres connection string |
| `MONGO_URL` | `mongodb://ims_user:ims_pass@localhost:27017/ims_signals?authSource=admin` | MongoDB connection string |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `WORKER_CONCURRENCY` | `CPU cores × 2` | BullMQ worker concurrency |
| `DEBOUNCE_WINDOW_MS` | `10000` | Debounce window per componentId (ms) |
| `RATE_LIMIT_MAX` | `10000` | Max requests per rate limit window |
| `RATE_LIMIT_WINDOW_MS` | `10000` | Rate limit window size (ms) |
| `ENABLE_API_KEY_AUTH` | `false` | Enable X-API-Key header validation |
| `API_KEY` | `dev-key-12345` | API key value when auth is enabled |

---

## Project Structure

```
Mission-Critical-IMS/
├── docker-compose.yml
├── README.md
├── SECURITY.md                    ← Security hardening guide
├── PERFORMANCE.md                 ← Benchmarks and optimisation
├── ASSESSMENT_REPORT.md           ← Evaluation and scoring breakdown
├── artillery-load-test.yml        ← Artillery load test config
│
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   ├── db/
│   │   └── init.sql               ← Postgres schema + TimescaleDB setup
│   └── src/
│       ├── index.ts               ← Fastify app boot + metrics loop
│       ├── config.ts              ← Typed env config with validation
│       ├── types.ts               ← Shared TypeScript interfaces
│       ├── db/
│       │   ├── postgres.ts        ← Pool + withRetry + withTransaction
│       │   ├── mongo.ts           ← raw_signals collection + indexes
│       │   └── redis.ts           ← Client + namespaced key helpers
│       ├── patterns/
│       │   ├── alertStrategy.ts   ← Strategy Pattern (P0/P1/P2)
│       │   └── workItemState.ts   ← State Pattern (lifecycle + MTTR)
│       ├── queue/
│       │   ├── signalQueue.ts     ← BullMQ producer + worker factory
│       │   └── signalProcessor.ts ← Debounce + Work Item creation
│       ├── routes/
│       │   ├── signals.ts         ← POST /signals + POST /signals/batch
│       │   ├── incidents.ts       ← GET/PATCH incidents + POST RCA
│       │   └── health.ts          ← GET /health
│       ├── ws/
│       │   └── broadcaster.ts     ← WebSocket client registry + broadcast
│       └── __tests__/
│           ├── workItemState.test.ts
│           ├── alertStrategy.test.ts
│           ├── signals.test.ts
│           ├── integration.test.ts
│           └── stress.test.ts
│
├── frontend/
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   ├── postcss.config.js
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── api.ts                 ← Typed API client
│       ├── types.ts               ← Frontend type definitions
│       ├── index.css
│       ├── store/
│       │   └── wsStore.ts         ← Zustand WebSocket store + auto-reconnect
│       ├── components/
│       │   └── Badges.tsx         ← PriorityBadge + StatusBadge
│       └── pages/
│           ├── Dashboard.tsx      ← Live feed, stats, incident table
│           └── IncidentDetail.tsx ← Detail view + raw signals + RCA form
│
└── scripts/
    ├── package.json               ← ts-node + @types/node
    ├── tsconfig.json
    ├── simulate-outage.ts         ← Outage scenario + 10k/sec burst test
    └── reset-data.sh              ← Wipe all data + Docker volumes
```

---

## Troubleshooting

### Burst test shows `failed=50000` with `status=0`

The `/signals/batch` endpoint is not in your running container. Rebuild:
```bash
docker compose up --build
```

### `Cannot find name 'process'` when running scripts

Install `@types/node` inside the scripts folder:
```bash
cd scripts && npm install
```

### Containers fail health checks on startup

Wait 60 seconds — TimescaleDB takes longer to initialise than standard Postgres. If it persists:
```bash
docker compose down -v   # removes volumes
docker compose up --build
```

### Frontend shows no incidents after simulation

The debounce window is 10 seconds. If you run the simulation script twice within 10 seconds for the same `componentId`, the second run creates no new Work Items (by design). Run `reset-data.sh` between runs.

---