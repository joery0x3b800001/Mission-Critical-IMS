import { memo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { WorkItem } from '../types';
import { PriorityBadge, StatusBadge } from './Badges';
import { formatDistanceToNow } from 'date-fns';

// ── Memoized row component for efficient re-renders ──────────────────────────
interface IncidentRowProps {
  incident: WorkItem;
  onNavigate: (id: string) => void;
}

const IncidentRow = memo(function IncidentRow({ incident, onNavigate }: IncidentRowProps) {
  return (
    <tr
      className="border-b border-border/50 hover:bg-white/[0.02] transition-colors cursor-pointer animate-slide_in"
      onClick={() => onNavigate(incident.id)}
    >
      <td className="px-4 py-3"><PriorityBadge priority={incident.priority} /></td>
      <td className="px-4 py-3">
        <span className="mono text-xs text-accent">{incident.componentId}</span>
        <span className="ml-2 text-xs text-muted">{incident.componentType}</span>
      </td>
      <td className="px-4 py-3 text-sm text-gray-300 max-w-xs truncate">{incident.title}</td>
      <td className="px-4 py-3"><StatusBadge status={incident.status} /></td>
      <td className="px-4 py-3 mono text-sm text-muted">{incident.signalCount}</td>
      <td className="px-4 py-3 mono text-xs text-muted">
        {formatDistanceToNow(new Date(incident.startTime), { addSuffix: true })}
      </td>
      <td className="px-4 py-3 text-muted text-sm">→</td>
    </tr>
  );
});

// ── Virtualized incidents list component ────────────────────────────────────
interface IncidentsListProps {
  incidents: WorkItem[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

export function IncidentsList({ incidents, loading, error, onRefresh }: IncidentsListProps) {
  const navigate = useNavigate();
  const handleNavigate = useCallback((id: string) => navigate(`/incidents/${id}`), [navigate]);

  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden">
      <div className="px-5 py-3 border-b border-border flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white">Active Incidents</h2>
        <button
          onClick={onRefresh}
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
        <div className="overflow-x-auto">
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
                <IncidentRow
                  key={inc.id}
                  incident={inc}
                  onNavigate={handleNavigate}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
