import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { WorkItem } from '../types';
import { PriorityBadge, StatusBadge } from '../components/Badges';
import { useWsStore } from '../store/wsStore';
import { formatDistanceToNow } from 'date-fns';

export function Dashboard() {
  const [incidents, setIncidents] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const lastEvent = useWsStore((s) => s.lastEvent);
  const connected = useWsStore((s) => s.connected);
  const navigate = useNavigate();

  const fetchIncidents = useCallback(async () => {
    try {
      const data = await api.getIncidents();
      setIncidents(data);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchIncidents(); }, [fetchIncidents]);

  // Refresh on any WS event
  useEffect(() => {
    if (lastEvent) fetchIncidents();
  }, [lastEvent, fetchIncidents]);

  const activeCount = incidents.filter(i => i.status !== 'CLOSED').length;
  const p0Count = incidents.filter(i => i.priority === 'P0' && i.status !== 'CLOSED').length;

  return (
    <div className="min-h-screen bg-bg">
      {/* Header */}
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

      <main className="max-w-7xl mx-auto px-6 py-8">
        {/* Stats bar */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          {[
            { label: 'Active Incidents', value: activeCount, color: 'text-accent' },
            { label: 'P0 Critical', value: p0Count, color: 'text-danger' },
            { label: 'Total Tracked', value: incidents.length, color: 'text-white' },
          ].map(({ label, value, color }) => (
            <div key={label} className="bg-surface border border-border rounded-lg p-4">
              <p className="text-muted text-xs mono uppercase tracking-wider mb-1">{label}</p>
              <p className={`mono text-3xl font-bold ${color}`}>{value}</p>
            </div>
          ))}
        </div>

        {/* Incident table */}
        <div className="bg-surface border border-border rounded-lg overflow-hidden">
          <div className="px-5 py-3 border-b border-border flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Active Incidents</h2>
            <button
              onClick={fetchIncidents}
              className="text-xs text-muted hover:text-accent transition-colors mono"
            >
              ↻ Refresh
            </button>
          </div>

          {loading ? (
            <div className="p-12 text-center text-muted mono text-sm">Loading incidents...</div>
          ) : error ? (
            <div className="p-12 text-center text-danger mono text-sm">{error}</div>
          ) : incidents.length === 0 ? (
            <div className="p-12 text-center text-muted text-sm">
              <p className="mono text-2xl mb-2">✓</p>
              <p>No active incidents. All systems operational.</p>
            </div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-border text-xs mono text-muted uppercase tracking-wider">
                  {['Priority', 'Component', 'Title', 'Status', 'Signals', 'Age', ''].map(h => (
                    <th key={h} className="px-4 py-3 text-left font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {incidents.map((inc) => (
                  <tr
                    key={inc.id}
                    className="border-b border-border/50 hover:bg-white/[0.02] transition-colors cursor-pointer animate-slide_in"
                    onClick={() => navigate(`/incidents/${inc.id}`)}
                  >
                    <td className="px-4 py-3"><PriorityBadge priority={inc.priority} /></td>
                    <td className="px-4 py-3">
                      <span className="mono text-xs text-accent">{inc.componentId}</span>
                      <span className="ml-2 text-xs text-muted">{inc.componentType}</span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-300 max-w-xs truncate">{inc.title}</td>
                    <td className="px-4 py-3"><StatusBadge status={inc.status} /></td>
                    <td className="px-4 py-3 mono text-sm text-muted">{inc.signalCount}</td>
                    <td className="px-4 py-3 mono text-xs text-muted">
                      {formatDistanceToNow(new Date(inc.startTime), { addSuffix: true })}
                    </td>
                    <td className="px-4 py-3 text-muted text-sm">→</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </div>
  );
}
