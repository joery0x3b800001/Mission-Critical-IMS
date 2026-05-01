export type ComponentType = 'RDBMS' | 'CACHE' | 'API' | 'QUEUE' | 'NOSQL' | 'MCP_HOST';
export type Priority = 'P0' | 'P1' | 'P2';
export type WorkItemStatus = 'OPEN' | 'INVESTIGATING' | 'RESOLVED' | 'CLOSED';
export type RootCauseCategory =
  | 'INFRASTRUCTURE'
  | 'APPLICATION_BUG'
  | 'CONFIGURATION'
  | 'DEPENDENCY_FAILURE'
  | 'CAPACITY'
  | 'NETWORK'
  | 'SECURITY'
  | 'HUMAN_ERROR'
  | 'UNKNOWN';

export interface Signal {
  componentId: string;
  componentType: ComponentType;
  errorCode: string;
  message: string;
  latencyMs?: number;
  metadata?: Record<string, unknown>;
  timestamp: string; // ISO
}

export interface WorkItem {
  id: string;
  componentId: string;
  componentType: ComponentType;
  priority: Priority;
  status: WorkItemStatus;
  title: string;
  signalCount: number;
  startTime: string;
  updatedAt: string;
  closedAt?: string;
  mttrSeconds?: number;
}

export interface RcaRecord {
  id: string;
  workItemId: string;
  incidentStart: string;
  incidentEnd: string;
  rootCauseCategory: RootCauseCategory;
  fixApplied: string;
  preventionSteps: string;
  submittedAt: string;
}

export interface HealthStatus {
  status: 'ok' | 'degraded';
  postgres: boolean;
  mongo: boolean;
  redis: boolean;
  queueDepth: number;
  uptime: number;
}
