-- Enable TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- Work Items (Source of Truth)
CREATE TABLE IF NOT EXISTS work_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  component_id  VARCHAR(255) NOT NULL,
  component_type VARCHAR(50) NOT NULL, -- RDBMS, CACHE, API, QUEUE, NOSQL, MCP_HOST
  priority      VARCHAR(10) NOT NULL,  -- P0, P1, P2
  status        VARCHAR(20) NOT NULL DEFAULT 'OPEN', -- OPEN, INVESTIGATING, RESOLVED, CLOSED
  title         VARCHAR(500) NOT NULL,
  signal_count  INTEGER NOT NULL DEFAULT 1,
  start_time    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at     TIMESTAMPTZ,
  mttr_seconds  INTEGER -- populated on close
);

-- RCA Records (linked 1:1 to work_items)
CREATE TABLE IF NOT EXISTS rca_records (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id      UUID NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  incident_start    TIMESTAMPTZ NOT NULL,
  incident_end      TIMESTAMPTZ NOT NULL,
  root_cause_category VARCHAR(100) NOT NULL,
  fix_applied       TEXT NOT NULL,
  prevention_steps  TEXT NOT NULL,
  submitted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(work_item_id)
);

-- Timeseries: signal throughput aggregations (TimescaleDB hypertable)
CREATE TABLE IF NOT EXISTS signal_metrics (
  time          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  component_id  VARCHAR(255) NOT NULL,
  signal_count  INTEGER NOT NULL DEFAULT 1
);

SELECT create_hypertable('signal_metrics', 'time', if_not_exists => TRUE);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(status);
CREATE INDEX IF NOT EXISTS idx_work_items_component ON work_items(component_id);
CREATE INDEX IF NOT EXISTS idx_work_items_priority ON work_items(priority, status);
