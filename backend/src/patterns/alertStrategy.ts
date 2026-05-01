import { ComponentType, Priority } from '../types';

// ── Strategy Interface ────────────────────────────────────────────────────────
export interface AlertStrategy {
  getPriority(): Priority;
  getTitle(componentId: string, errorCode: string): string;
  notify(componentId: string, workItemId: string): void;
}

// ── Concrete Strategies ───────────────────────────────────────────────────────
export class P0AlertStrategy implements AlertStrategy {
  getPriority(): Priority { return 'P0'; }

  getTitle(componentId: string, errorCode: string): string {
    return `[P0 CRITICAL] ${componentId} failure — ${errorCode}`;
  }

  notify(componentId: string, workItemId: string): void {
    // In production: page on-call via PagerDuty / OpsGenie
    console.error(`🔴 [P0 ALERT] CRITICAL: ${componentId} | WorkItem: ${workItemId} — Paging on-call engineer!`);
  }
}

export class P1AlertStrategy implements AlertStrategy {
  getPriority(): Priority { return 'P1'; }

  getTitle(componentId: string, errorCode: string): string {
    return `[P1 HIGH] ${componentId} degraded — ${errorCode}`;
  }

  notify(componentId: string, workItemId: string): void {
    // In production: Slack #incidents channel
    console.warn(`🟠 [P1 ALERT] HIGH: ${componentId} | WorkItem: ${workItemId} — Notifying team channel`);
  }
}

export class P2AlertStrategy implements AlertStrategy {
  getPriority(): Priority { return 'P2'; }

  getTitle(componentId: string, errorCode: string): string {
    return `[P2 MEDIUM] ${componentId} issue — ${errorCode}`;
  }

  notify(componentId: string, workItemId: string): void {
    // In production: create Jira ticket
    console.info(`🟡 [P2 ALERT] MEDIUM: ${componentId} | WorkItem: ${workItemId} — Creating ticket`);
  }
}

// ── Context ───────────────────────────────────────────────────────────────────
export class AlertContext {
  private strategy: AlertStrategy;

  constructor(strategy: AlertStrategy) {
    this.strategy = strategy;
  }

  setStrategy(strategy: AlertStrategy): void {
    this.strategy = strategy;
  }

  getPriority(): Priority { return this.strategy.getPriority(); }
  getTitle(componentId: string, errorCode: string): string {
    return this.strategy.getTitle(componentId, errorCode);
  }
  notify(componentId: string, workItemId: string): void {
    this.strategy.notify(componentId, workItemId);
  }
}

// ── Factory: pick strategy by component type ──────────────────────────────────
export function resolveAlertStrategy(componentType: ComponentType): AlertStrategy {
  switch (componentType) {
    case 'RDBMS':
    case 'MCP_HOST':
      return new P0AlertStrategy();
    case 'API':
    case 'QUEUE':
      return new P1AlertStrategy();
    case 'CACHE':
    case 'NOSQL':
      return new P2AlertStrategy();
    default:
      return new P1AlertStrategy();
  }
}
