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

- **Docker Desktop** with Docker Compose v2
- **Node.js 22+** — `nvm install --lts`
- **Python 3.8+** — required for `deploy.py`

---

## ⭐ Recommended: Evaluator Quick Start

This is the fastest path to deploy, test, and simulate the full system end-to-end using `deploy.py`.

**Step 1 — Start all services**

```bash
cd Mission-Critical-IMS
python3 deploy.py deploy up
```

Wait for all 5 containers to be running (check Docker Desktop or run `python3 deploy.py deploy status`).

**Step 2 — Run backend unit tests**

```bash
python3 deploy.py test backend
```

Runs the full Jest test suite — state machine, strategy pattern, route validation, integration, and stress tests.

**Step 3 — Run outage simulation**

```bash
python3 deploy.py test simulate
```

Fires 640 signals across 5 component types, debounced into Work Items. Open the dashboard at http://localhost:3000 to watch incidents populate in real time.

**Step 4 — Run burst stress test**

```bash
python3 deploy.py test simulate --mode burst
```

Fires 50,000 signals over 5 seconds and prints throughput, latency percentiles (p50/p95/p99), and a PASS/FAIL resilience verdict.

**Step 5 — Tear down**

```bash
python3 deploy.py deploy down --volumes
```

---

## Quick Start

```bash
cd Mission-Critical-IMS
python3 deploy.py deploy up
```

| Service | URL |
|---|---|
| Dashboard | http://localhost:3000 |
| Backend API | http://localhost:3001 |
| Health Check | http://localhost:3001/health |
| WebSocket | ws://localhost:3001/ws |

### Manual — Docker Compose directly

```bash
# Build images and start all services
docker compose up --build

# Start in background (detached)
docker compose up --build -d

# Stop and remove containers, keep volumes/data
docker compose down

# Full reset — remove containers AND wipe all volumes
docker compose down -v
```

### Local Development (databases in Docker, app runs locally)

```bash
docker compose up postgres mongo redis -d

cd backend && npm install && npm run dev      # hot-reload backend
cd frontend && npm install && npm run dev     # hot-reload frontend (new terminal)
```

---

## Docker Images — Multi-Stage Builds

Both services use multi-stage builds for minimal final image size. No TypeScript compiler, source files, or devDependencies ship in production.

**Backend** — 4 stages: `deps` → `builder` (tsc) → `prod-deps` (--omit=dev) → `production` (`node dist/index.js`)

**Frontend** — 3 stages: `deps` → `builder` (vite build) → `production` (nginx:1.27-alpine, ~25 MB, no Node at runtime)

> Place `Dockerfile.backend` → `backend/Dockerfile` and `Dockerfile.frontend` → `frontend/Dockerfile`

---

## deploy.py — Command Reference

Deploying, testing, and logging are fully separated — deploy never runs tests, tests never touch containers.

### Deploy

```bash
python3 deploy.py deploy up                    # start (development)
python3 deploy.py deploy up --env staging      # start (staging)
python3 deploy.py deploy up --env production   # start (production)
python3 deploy.py deploy stop                  # pause containers, data kept
python3 deploy.py deploy stop --service api    # pause one service only
python3 deploy.py deploy down                  # remove containers, data kept
python3 deploy.py deploy down --volumes        # remove containers + wipe volumes
python3 deploy.py deploy restart
python3 deploy.py deploy status
```

| Command | Containers | Data & Volumes |
|---|---|---|
| `stop` | paused | ✅ kept |
| `down` | removed | ✅ kept |
| `down --volumes` | removed | ❌ wiped |

### Test

```bash
python3 deploy.py test backend                        # npm test (unit tests)
python3 deploy.py test frontend                       # npm run build check
python3 deploy.py test simulate                       # outage simulation (burst)
python3 deploy.py test simulate --mode both           # burst + baseline
python3 deploy.py test simulate --duration 30         # custom duration (seconds)
```

### Logs

```bash
python3 deploy.py logs                         # backend, last 50 lines
python3 deploy.py logs --service frontend
python3 deploy.py logs --tail 200
python3 deploy.py logs --follow                # live tail  (Ctrl+C to stop)
python3 deploy.py logs --list                  # list all service names
```

---

## Running Tests

### Via deploy.py

```bash
python3 deploy.py test backend     # unit tests
python3 deploy.py test frontend    # build check
```

### Directly (without deploy.py)

```bash
cd backend && npm install
npm test                                           # all suites
npm run test:coverage                              # with coverage
npm test -- --testPathPattern=workItemState        # single suite
npm test -- --testPathPattern=alertStrategy
npm test -- --testPathPattern=stress
npm run test:watch                                 # watch mode
```

| Suite | Cases | Coverage |
|---|---|---|
| `workItemState.test.ts` | 18+ | All state transitions, RCA guard, MTTR calc, rollback |
| `alertStrategy.test.ts` | 20+ | P0/P1/P2 assignment, context switching, titles |
| `signals.test.ts` | 25+ | Schema enforcement, priority queuing, edge cases |
| `integration.test.ts` | 10+ | Signal → Work Item, debounce, error recovery |
| `stress.test.ts` | 8 | Burst, sustained load, mixed types, stability |

---

## Simulation Scripts

```bash
cd scripts && npm install          # install dependencies once
```

### Via deploy.py

```bash
python3 deploy.py test simulate              # cascading outage — 640 signals, 5 components
python3 deploy.py test simulate --mode burst # burst — 50,000 signals over 5s, p50/p95/p99 report
python3 deploy.py test simulate --mode both  # both scenarios back to back
```

### Directly (without deploy.py)

```bash
cd scripts

npx ts-node simulate-outage.ts               # cascading outage scenario
npx ts-node simulate-outage.ts --burst       # burst — 50,000 signals over 5s, p50/p95/p99 report
npx ts-node simulate-outage.ts --both        # both scenarios back to back
```

```bash
./scripts/reset-data.sh                      # wipe all data between runs
```

Expected dashboard after outage simulation:
- `P0` — POSTGRES_PRIMARY_01, POSTGRES_REPLICA_01, MCP_HOST_GATEWAY_01
- `P1` — QUEUE_WORKER_POOL_01
- `P2` — CACHE_CLUSTER_01

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
├── deploy.py                      ← Deployment manager (deploy / test / logs)
├── README.md
├── SECURITY.md                    ← Security hardening guide
├── PERFORMANCE.md                 ← Benchmarks and optimisation
├── ASSESSMENT_REPORT.md           ← Evaluation and scoring breakdown
├── artillery-load-test.yml        ← Artillery load test config
│
├── backend/
│   ├── Dockerfile                 ← Multi-stage: tsc build → node:22-alpine runtime
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
│   ├── Dockerfile                 ← Multi-stage: vite build → nginx:1.27-alpine runtime
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

### `Could not read package.json` during Docker build
The builder stage is missing `package.json`. Ensure both Dockerfiles have `COPY package.json package-lock.json ./` before `COPY --from=deps`.

### Burst test shows `failed=50000` with `status=0`
The `/signals/batch` endpoint is not in the running container. Rebuild:
```bash
python3 deploy.py deploy down && python3 deploy.py deploy up
```

### `Cannot find name 'process'` when running scripts
```bash
cd scripts && npm install
```

### Frontend shows no incidents after simulation
The debounce window is 10 seconds. Running the simulation twice within 10 seconds for the same `componentId` creates no new Work Items (by design). Reset between runs:
```bash
./scripts/reset-data.sh
```

### Container stuck or unhealthy
```bash
python3 deploy.py deploy stop
python3 deploy.py deploy down --volumes    # only if a clean slate is needed
python3 deploy.py deploy up
```