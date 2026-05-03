import {
  AlertContext,
  resolveAlertStrategy,
} from '../patterns/alertStrategy';
import { ComponentType } from '../types';

describe('AlertStrategy Pattern', () => {
  // ── P0 Priority Strategy Tests ───────────────────────────────────────────────
  describe('P0 Priority Strategy (RDBMS, MCP_HOST)', () => {
    it('should return P0 priority', () => {
      const strategy = resolveAlertStrategy('RDBMS');
      expect(strategy.getPriority()).toBe('P0');
    });

    it('should format P0 critical title with componentId and errorCode', () => {
      const strategy = resolveAlertStrategy('RDBMS');
      const title = strategy.getTitle('postgres-primary', 'DB_CONNECTION_TIMEOUT');
      expect(title).toContain('[P0 CRITICAL]');
      expect(title).toContain('postgres-primary');
      expect(title).toContain('DB_CONNECTION_TIMEOUT');
    });

    it('should log P0 alert notification', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const strategy = resolveAlertStrategy('MCP_HOST');
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

  // ── P1 Priority Strategy Tests ───────────────────────────────────────────────
  describe('P1 Priority Strategy (API, QUEUE)', () => {
    it('should return P1 priority', () => {
      const strategy = resolveAlertStrategy('API');
      expect(strategy.getPriority()).toBe('P1');
    });

    it('should format P1 high title with componentId and errorCode', () => {
      const strategy = resolveAlertStrategy('QUEUE');
      const title = strategy.getTitle('api-gateway', 'HIGH_LATENCY');
      expect(title).toContain('[P1 HIGH]');
      expect(title).toContain('api-gateway');
      expect(title).toContain('HIGH_LATENCY');
    });

    it('should log P1 alert notification', () => {
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const strategy = resolveAlertStrategy('API');
      strategy.notify('api-gateway', 'work-item-456');
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('🟠 [P1 ALERT]')
      );
      consoleWarnSpy.mockRestore();
    });
  });

  // ── P2 Priority Strategy Tests ───────────────────────────────────────────────
  describe('P2 Priority Strategy (CACHE, NOSQL)', () => {
    it('should return P2 priority', () => {
      const strategy = resolveAlertStrategy('CACHE');
      expect(strategy.getPriority()).toBe('P2');
    });

    it('should format P2 medium title with componentId and errorCode', () => {
      const strategy = resolveAlertStrategy('NOSQL');
      const title = strategy.getTitle('cache-server', 'MEMORY_USAGE_HIGH');
      expect(title).toContain('[P2 MEDIUM]');
      expect(title).toContain('cache-server');
      expect(title).toContain('MEMORY_USAGE_HIGH');
    });

    it('should log P2 alert notification', () => {
      const consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
      const strategy = resolveAlertStrategy('CACHE');
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
      const strategy = resolveAlertStrategy('RDBMS');
      const context = new AlertContext(strategy);
      expect(context.getPriority()).toBe('P0');
    });

    it('should delegate title generation to strategy', () => {
      const context = new AlertContext(resolveAlertStrategy('RDBMS'));
      const title = context.getTitle('db-primary', 'CRASH');
      expect(title).toContain('[P0 CRITICAL]');
    });

    it('should delegate notify to strategy', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const context = new AlertContext(resolveAlertStrategy('RDBMS'));
      context.notify('component', 'wi-123');
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('🔴 [P0 ALERT]')
      );
      consoleSpy.mockRestore();
    });
  });

  // ── Strategy Resolution Tests ────────────────────────────────────────────────
  describe('resolveAlertStrategy Factory', () => {
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

  // ── Integration Tests ────────────────────────────────────────────────────────
  describe('AlertContext + Strategy Integration', () => {
    it('should use factory-resolved strategies through context', () => {
      const p2Strategy = resolveAlertStrategy('CACHE');
      const context = new AlertContext(p2Strategy);
      const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

      // P2 alert should log to info
      context.notify('app-cache', 'wi-001');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('🟡 [P2 ALERT]'));

      consoleSpy.mockRestore();
    });

    it('should format consistent titles across all priority levels', () => {
      const componentId = 'payment-api';
      const errorCode = 'TIMEOUT_500MS';
      
      const p0Strategy = resolveAlertStrategy('RDBMS');
      const p1Strategy = resolveAlertStrategy('API');
      const p2Strategy = resolveAlertStrategy('CACHE');

      const title0 = p0Strategy.getTitle(componentId, errorCode);
      const title1 = p1Strategy.getTitle(componentId, errorCode);
      const title2 = p2Strategy.getTitle(componentId, errorCode);

      expect(title0).toContain('[P0 CRITICAL]');
      expect(title0).toContain(componentId);
      expect(title0).toContain(errorCode);
      
      expect(title1).toContain('[P1 HIGH]');
      expect(title1).toContain(componentId);
      expect(title1).toContain(errorCode);
      
      expect(title2).toContain('[P2 MEDIUM]');
      expect(title2).toContain(componentId);
      expect(title2).toContain(errorCode);
    });
  });
});
