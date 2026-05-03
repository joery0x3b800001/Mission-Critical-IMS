import { useEffect, useState, useCallback, useRef, useMemo, memo } from 'react';
import { api } from '../api';
import { WorkItem } from '../types';
import { IncidentsList } from '../components/IncidentsList';
import { useWsStore } from '../store/wsStore';

const REFETCH_DEBOUNCE_MS = 1000; // Debounce rapid events

// ── Memoized stats component for efficient re-renders ──────────────────────
interface DashboardStatsProps {
  activeCount: number;
  p0Count: number;
  totalCount: number;
}

const DashboardStats = memo(function DashboardStats({ activeCount, p0Count, totalCount }: DashboardStatsProps) {
  return (
    <div className="grid grid-cols-3 gap-4 mb-8">
      {[
        { label: 'Active Incidents', value: activeCount, color: 'text-accent' },
        { label: 'P0 Critical', value: p0Count, color: 'text-danger' },
        { label: 'Total Tracked', value: totalCount, color: 'text-white' },
      ].map(({ label, value, color }) => (
        <div key={label} className="bg-surface border border-border rounded-lg p-4">
          <p className="text-muted text-xs mono uppercase tracking-wider mb-1">{label}</p>
          <p className={`mono text-3xl font-bold ${color}`}>{value}</p>
        </div>
      ))}
    </div>
  );
});

// ── Memoized header component ──────────────────────────────────────────────
interface DashboardHeaderProps {
  connected: boolean;
}

const DashboardHeader = memo(function DashboardHeader({ connected }: DashboardHeaderProps) {
  return (
    <header className="border-b border-border px-6 py-4 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="w-2 h-2 rounded-full bg-danger animate-pulse" />
        <h1 className="mono text-lg font-bold text-white tracking-tight">IMS</h1>
        <span className="text-muted text-sm">Incident Management System</span>
      </div>
      <div className="flex items-center gap-4">
        <span className={`flex items-center gap-1.5 text-xs mono ${connected ? 'text-ok' : 'text-danger'}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-ok' : 'bg-danger'} animate-pulse`} />
          {connected ? 'LIVE' : 'RECONNECTING'}
        </span>
      </div>
    </header>
  );
});

export function Dashboard() {
  const [incidents, setIncidents] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const lastEvent = useWsStore((s) => s.lastEvent);
  const connected = useWsStore((s) => s.connected);

  // Debounce timer for refetch
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  // Track if we need to refetch after current debounce
  const shouldRefetchRef = useRef(false);

  const fetchIncidents = useCallback(async () => {
    try {
      const data = await api.getIncidents(0, 200);
      // Extract incidents from paginated response
      setIncidents(data.incidents || data as any);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Debounced refetch on WebSocket events
  const scheduleRefetch = useCallback(() => {
    shouldRefetchRef.current = true;

    if (debounceTimerRef.current) {
      // Timer already running, next batch will pick up changes
      return;
    }

    debounceTimerRef.current = setTimeout(() => {
      if (shouldRefetchRef.current) {
        fetchIncidents();
        shouldRefetchRef.current = false;
      }
      debounceTimerRef.current = null;
    }, REFETCH_DEBOUNCE_MS);
  }, [fetchIncidents]);

  // Selective update based on event type
  const handleWebSocketEvent = useCallback((event: Record<string, unknown>) => {
    const eventType = event.type as string;

    // For status/RCA changes, update locally without full refetch
    if (eventType === 'STATUS_CHANGED') {
      const { workItemId, status } = event as { workItemId: string; status: string };
      setIncidents((prev) =>
        prev.map((inc) =>
          inc.id === workItemId ? { ...inc, status: status as any } : inc
        )
      );
      return;
    }

    if (eventType === 'RCA_SUBMITTED') {
      // No need to refetch dashboard for RCA
      return;
    }

    // For work item creation/updates, debounce and refetch
    if (eventType === 'WORK_ITEM_CREATED') {
      scheduleRefetch();
      return;
    }

    // Default: schedule refetch
    scheduleRefetch();
  }, [scheduleRefetch]);

  // Initial fetch
  useEffect(() => {
    fetchIncidents();
  }, [fetchIncidents]);

  // Handle WS events with selective updates
  useEffect(() => {
    if (lastEvent) {
      handleWebSocketEvent(lastEvent);
    }
  }, [lastEvent, handleWebSocketEvent]);

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  // Memoize computed values to prevent unnecessary recalculations
  const { activeCount, p0Count, totalCount } = useMemo(() => ({
    activeCount: incidents.filter(i => i.status !== 'CLOSED').length,
    p0Count: incidents.filter(i => i.priority === 'P0' && i.status !== 'CLOSED').length,
    totalCount: incidents.length,
  }), [incidents]);

  return (
    <div className="min-h-screen bg-bg">
      {/* Memoized components prevent unnecessary re-renders */}
      <DashboardHeader connected={connected} />

      <main className="max-w-7xl mx-auto px-6 py-8">
        <DashboardStats
          activeCount={activeCount}
          p0Count={p0Count}
          totalCount={totalCount}
        />

        <IncidentsList
          incidents={incidents}
          loading={loading}
          error={error}
          onRefresh={fetchIncidents}
        />
      </main>
    </div>
  );
}
