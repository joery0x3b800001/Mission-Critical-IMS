import {
  P0AlertStrategy,
  P1AlertStrategy,
  P2AlertStrategy,
  AlertContext,
  resolveAlertStrategy,
} from '../patterns/alertStrategy';
import { ComponentType } from '../types';

describe('AlertStrategy Pattern', () => {
  // ── P0AlertStrategy Tests ────────────────────────────────────────────────────
  describe('P0AlertStrategy', () => {
    it('should return P0 priority', () => {
      const strategy = new P0AlertStrategy();
      expect(strategy.getPriority()).toBe('P0');
    });

    it('should format P0 critical title with componentId and errorCode', () => {
      const strategy = new P0AlertStrategy();
      const title = strategy.getTitle('postgres-primary', 'DB_CONNECTION_TIMEOUT');
      expect(title).toContain('[P0 CRITICAL]');
      expect(title).toContain('postgres-primary');
      expect(title).toContain('DB_CONNECTION_TIMEOUT');
    });

    it('should log P0 alert notification', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const strategy = new P0AlertStrategy();
      strategy.notify('redis-cluster', 'work-item-123');
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('🔴 [P0 ALERT]')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('redis-cluster')
      );
      consoleSpy.mockRestore();
    });
  });

  // ── P1AlertStrategy Tests ────────────────────────────────────────────────────
  describe('P1AlertStrategy', () => {
    it('should return P1 priority', () => {
      const strategy = new P1AlertStrategy();
      expect(strategy.getPriority()).toBe('P1');
    });

    it('should format P1 high title with componentId and errorCode', () => {
      const strategy = new P1AlertStrategy();
      const title = strategy.getTitle('api-gateway', 'HIGH_LATENCY');
      expect(title).toContain('[P1 HIGH]');
      expect(title).toContain('api-gateway');
      expect(title).toContain('HIGH_LATENCY');
    });

    it('should log P1 alert notification', () => {
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const strategy = new P1AlertStrategy();
      strategy.notify('api-gateway', 'work-item-456');
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('🟠 [P1 ALERT]')
      );
      consoleWarnSpy.mockRestore();
    });
  });

  // ── P2AlertStrategy Tests ────────────────────────────────────────────────────
  describe('P2AlertStrategy', () => {
    it('should return P2 priority', () => {
      const strategy = new P2AlertStrategy();
      expect(strategy.getPriority()).toBe('P2');
    });

    it('should format P2 medium title with componentId and errorCode', () => {
      const strategy = new P2AlertStrategy();
      const title = strategy.getTitle('cache-server', 'MEMORY_USAGE_HIGH');
      expect(title).toContain('[P2 MEDIUM]');
      expect(title).toContain('cache-server');
      expect(title).toContain('MEMORY_USAGE_HIGH');
    });

    it('should log P2 alert notification', () => {
      const consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
      const strategy = new P2AlertStrategy();
      strategy.notify('cache-server', 'work-item-789');
      expect(consoleInfoSpy).toHaveBeenCalledWith(
        expect.stringContaining('🟡 [P2 ALERT]')
      );
      consoleInfoSpy.mockRestore();
    });
  });

  // ── AlertContext Tests ───────────────────────────────────────────────────────
  describe('AlertContext', () => {
    it('should initialize with a strategy', () => {
      const strategy = new P0AlertStrategy();
      const context = new AlertContext(strategy);
      expect(context.getPriority()).toBe('P0');
    });

    it('should switch strategies dynamically', () => {
      const p0 = new P0AlertStrategy();
      const p1 = new P1AlertStrategy();
      const context = new AlertContext(p0);

      expect(context.getPriority()).toBe('P0');
      context.setStrategy(p1);
      expect(context.getPriority()).toBe('P1');
    });

    it('should delegate title generation to current strategy', () => {
      const context = new AlertContext(new P0AlertStrategy());
      const title = context.getTitle('db-primary', 'CRASH');
      expect(title).toContain('[P0 CRITICAL]');

      context.setStrategy(new P2AlertStrategy());
      const p2Title = context.getTitle('db-primary', 'CRASH');
      expect(p2Title).toContain('[P2 MEDIUM]');
    });

    it('should delegate notify to current strategy', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const context = new AlertContext(new P0AlertStrategy());
      context.notify('component', 'wi-123');
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('🔴 [P0 ALERT]')
      );
      consoleSpy.mockRestore();
    });
  });

  // ── Strategy Resolution Tests ────────────────────────────────────────────────
  describe('resolveAlertStrategy', () => {
    it('should resolve RDBMS to P0 strategy', () => {
      const strategy = resolveAlertStrategy('RDBMS');
      expect(strategy.getPriority()).toBe('P0');
    });

    it('should resolve MCP_HOST to P0 strategy', () => {
      const strategy = resolveAlertStrategy('MCP_HOST');
      expect(strategy.getPriority()).toBe('P0');
    });

    it('should resolve API to P1 strategy', () => {
      const strategy = resolveAlertStrategy('API');
      expect(strategy.getPriority()).toBe('P1');
    });

    it('should resolve QUEUE to P1 strategy', () => {
      const strategy = resolveAlertStrategy('QUEUE');
      expect(strategy.getPriority()).toBe('P1');
    });

    it('should resolve CACHE to P2 strategy', () => {
      const strategy = resolveAlertStrategy('CACHE');
      expect(strategy.getPriority()).toBe('P2');
    });

    it('should resolve NOSQL to P2 strategy', () => {
      const strategy = resolveAlertStrategy('NOSQL');
      expect(strategy.getPriority()).toBe('P2');
    });

    it('should default to P1 for unknown component type', () => {
      // Cast to bypass TypeScript strict type checking for invalid test
      const strategy = resolveAlertStrategy('UNKNOWN' as ComponentType);
      expect(strategy.getPriority()).toBe('P1');
    });

    it('should maintain consistent strategy for same component type', () => {
      const strategy1 = resolveAlertStrategy('RDBMS');
      const strategy2 = resolveAlertStrategy('RDBMS');
      expect(strategy1.getPriority()).toBe(strategy2.getPriority());
    });
  });

  // ── Integration: Strategy + Context ──────────────────────────────────────────
  describe('AlertContext + Strategy Integration', () => {
    it('should handle multi-component incident escalation', () => {
      const context = new AlertContext(new P2AlertStrategy());
      const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

      // Start as P2
      context.notify('app-cache', 'wi-001');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('🟡 [P2 ALERT]'));

      // Escalate to P0 when RDBMS also fails
      context.setStrategy(new P0AlertStrategy());
      consoleSpy.mockClear();
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      context.notify('postgres', 'wi-002');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('🔴 [P0 ALERT]'));

      consoleSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('should format consistent titles across strategies', () => {
      const componentId = 'payment-api';
      const errorCode = 'TIMEOUT_500MS';
      
      const title0 = new P0AlertStrategy().getTitle(componentId, errorCode);
      const title1 = new P1AlertStrategy().getTitle(componentId, errorCode);
      const title2 = new P2AlertStrategy().getTitle(componentId, errorCode);

      expect(title0).toContain(componentId);
      expect(title0).toContain(errorCode);
      expect(title1).toContain(componentId);
      expect(title1).toContain(errorCode);
      expect(title2).toContain(componentId);
      expect(title2).toContain(errorCode);
    });
  });
});
