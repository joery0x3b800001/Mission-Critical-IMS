export type Priority = 'P0' | 'P1' | 'P2';
export type WorkItemStatus = 'OPEN' | 'INVESTIGATING' | 'RESOLVED' | 'CLOSED';
export type ComponentType = 'RDBMS' | 'CACHE' | 'API' | 'QUEUE' | 'NOSQL' | 'MCP_HOST';
export type RootCauseCategory =
  | 'INFRASTRUCTURE' | 'APPLICATION_BUG' | 'CONFIGURATION'
  | 'DEPENDENCY_FAILURE' | 'CAPACITY' | 'NETWORK'
  | 'SECURITY' | 'HUMAN_ERROR' | 'UNKNOWN';

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

export interface RawSignal {
  componentId: string;
  componentType: ComponentType;
  errorCode: string;
  message: string;
  latencyMs?: number;
  timestamp: string;
  ingestedAt: string;
  workItemId: string;
}

export interface IncidentDetail {
  workItem: WorkItem;
  rca: RcaRecord | null;
  rawSignals: RawSignal[];
}
