import { ComponentType, Priority } from '../types';

// ── Alert Strategy Interface & Implementations ────────────────────────────────
export interface AlertStrategy {
  getPriority(): Priority;
  getTitle(componentId: string, errorCode: string): string;
  notify(componentId: string, workItemId: string): void;
}

// ── Priority-based alert strategies (factory pattern for component types) ────
const alertStrategies: Record<Priority, { new(): AlertStrategy }> = {
  P0: class P0AlertStrategy implements AlertStrategy {
    getPriority(): Priority { return 'P0'; }
    getTitle(componentId: string, errorCode: string): string {
      return `[P0 CRITICAL] ${componentId} failure — ${errorCode}`;
    }
    notify(componentId: string, workItemId: string): void {
      console.error(`🔴 [P0 ALERT] CRITICAL: ${componentId} | WorkItem: ${workItemId} — Paging on-call engineer!`);
    }
  },
  P1: class P1AlertStrategy implements AlertStrategy {
    getPriority(): Priority { return 'P1'; }
    getTitle(componentId: string, errorCode: string): string {
      return `[P1 HIGH] ${componentId} degraded — ${errorCode}`;
    }
    notify(componentId: string, workItemId: string): void {
      console.warn(`🟠 [P1 ALERT] HIGH: ${componentId} | WorkItem: ${workItemId} — Notifying team channel`);
    }
  },
  P2: class P2AlertStrategy implements AlertStrategy {
    getPriority(): Priority { return 'P2'; }
    getTitle(componentId: string, errorCode: string): string {
      return `[P2 MEDIUM] ${componentId} issue — ${errorCode}`;
    }
    notify(componentId: string, workItemId: string): void {
      console.info(`🟡 [P2 ALERT] MEDIUM: ${componentId} | WorkItem: ${workItemId} — Creating ticket`);
    }
  },
};

// ── Alert Context: Encapsulates strategy execution ────────────────────────────
export class AlertContext {
  constructor(private strategy: AlertStrategy) {}

  getPriority(): Priority { return this.strategy.getPriority(); }
  getTitle(componentId: string, errorCode: string): string {
    return this.strategy.getTitle(componentId, errorCode);
  }
  notify(componentId: string, workItemId: string): void {
    this.strategy.notify(componentId, workItemId);
  }
}

// ── Factory: Resolve alert strategy by component type ────────────────────────
export function resolveAlertStrategy(componentType: ComponentType): AlertStrategy {
  const priorityMap: Record<ComponentType, Priority> = {
    RDBMS: 'P0',
    MCP_HOST: 'P0',
    API: 'P1',
    QUEUE: 'P1',
    CACHE: 'P2',
    NOSQL: 'P2',
  };
  const priority = priorityMap[componentType] ?? 'P1';
  return new alertStrategies[priority]();
}
