import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { IncidentDetail, WorkItemStatus, RootCauseCategory } from '../types';
import { PriorityBadge, StatusBadge } from '../components/Badges';
import { format, formatDistanceToNow } from 'date-fns';

const STATUS_TRANSITIONS: Record<WorkItemStatus, WorkItemStatus | null> = {
  OPEN: 'INVESTIGATING',
  INVESTIGATING: 'RESOLVED',
  RESOLVED: 'CLOSED',
  CLOSED: null,
};

const ROOT_CAUSE_OPTIONS: RootCauseCategory[] = [
  'INFRASTRUCTURE', 'APPLICATION_BUG', 'CONFIGURATION',
  'DEPENDENCY_FAILURE', 'CAPACITY', 'NETWORK', 'SECURITY', 'HUMAN_ERROR', 'UNKNOWN',
];

export function IncidentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<IncidentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [transitioning, setTransitioning] = useState(false);
  const [showRcaForm, setShowRcaForm] = useState(false);
  const [rcaForm, setRcaForm] = useState({
    incidentStart: '',
    incidentEnd: '',
    rootCauseCategory: 'UNKNOWN' as RootCauseCategory,
    fixApplied: '',
    preventionSteps: '',
  });
  const [rcaError, setRcaError] = useState<string | null>(null);
  const [rcaSuccess, setRcaSuccess] = useState(false);

  const load = async () => {
    if (!id) return;
    try {
      const data = await api.getIncident(id);
      setDetail(data);
      if (data.rca) {
        setRcaForm({
          incidentStart: data.rca.incidentStart.slice(0, 16),
          incidentEnd: data.rca.incidentEnd.slice(0, 16),
          rootCauseCategory: data.rca.rootCauseCategory,
          fixApplied: data.rca.fixApplied,
          preventionSteps: data.rca.preventionSteps,
        });
      } else if (data.workItem.startTime) {
        setRcaForm(f => ({ ...f, incidentStart: data.workItem.startTime.slice(0, 16) }));
      }
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [id]);

  const handleTransition = async () => {
    if (!detail) return;
    const next = STATUS_TRANSITIONS[detail.workItem.status];
    if (!next) return;
    setTransitioning(true);
    setActionError(null);
    try {
      await api.updateStatus(detail.workItem.id, next);
      await load();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setTransitioning(false);
    }
  };

  const handleRcaSubmit = async () => {
    if (!detail) return;
    setRcaError(null);
    if (!rcaForm.fixApplied || rcaForm.fixApplied.length < 10) {
      setRcaError('Fix Applied must be at least 10 characters'); return;
    }
    if (!rcaForm.preventionSteps || rcaForm.preventionSteps.length < 10) {
      setRcaError('Prevention Steps must be at least 10 characters'); return;
    }
    try {
      await api.submitRca(detail.workItem.id, {
        ...rcaForm,
        incidentStart: new Date(rcaForm.incidentStart).toISOString(),
        incidentEnd: new Date(rcaForm.incidentEnd).toISOString(),
      });
      setRcaSuccess(true);
      await load();
    } catch (e) {
      setRcaError((e as Error).message);
    }
  };

  if (loading) return <div className="p-12 text-center text-muted mono">Loading...</div>;
  if (!detail) return <div className="p-12 text-center text-danger mono">Incident not found</div>;

  const { workItem, rca, rawSignals } = detail;
  const nextStatus = STATUS_TRANSITIONS[workItem.status];

  return (
    <div className="min-h-screen bg-bg">
      <header className="border-b border-border px-6 py-4 flex items-center gap-4">
        <button onClick={() => navigate('/')} className="text-muted hover:text-white text-sm transition-colors">← Back</button>
        <div className="w-px h-4 bg-border" />
        <PriorityBadge priority={workItem.priority} />
        <StatusBadge status={workItem.status} />
        <h1 className="text-sm font-medium text-white flex-1 truncate">{workItem.title}</h1>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 grid grid-cols-3 gap-6">
        {/* Left: Work Item + Signals */}
        <div className="col-span-2 space-y-6">
          {/* Details card */}
          <div className="bg-surface border border-border rounded-lg p-5 space-y-4">
            <h2 className="text-sm font-semibold text-white">Incident Details</h2>
            <div className="grid grid-cols-2 gap-4 text-sm">
              {[
                ['Component', workItem.componentId],
                ['Type', workItem.componentType],
                ['Signal Count', workItem.signalCount],
                ['Started', formatDistanceToNow(new Date(workItem.startTime), { addSuffix: true })],
                ...(workItem.mttrSeconds ? [['MTTR', `${Math.round(workItem.mttrSeconds / 60)} min`]] : []),
              ].map(([k, v]) => (
                <div key={String(k)}>
                  <p className="text-muted mono text-xs uppercase tracking-wider mb-0.5">{k}</p>
                  <p className="text-white mono text-sm">{v}</p>
                </div>
              ))}
            </div>

            {actionError && (
              <div className="bg-red-900/20 border border-red-800/50 rounded p-3 text-red-400 text-sm">{actionError}</div>
            )}

            {nextStatus && (
              <button
                onClick={handleTransition}
                disabled={transitioning}
                className="bg-accent/10 hover:bg-accent/20 border border-accent/30 text-accent text-sm mono px-4 py-2 rounded transition-colors disabled:opacity-50"
              >
                {transitioning ? 'Updating...' : `→ Move to ${nextStatus}`}
              </button>
            )}
          </div>

          {/* Raw signals */}
          <div className="bg-surface border border-border rounded-lg overflow-hidden">
            <div className="px-5 py-3 border-b border-border">
              <h2 className="text-sm font-semibold text-white">Raw Signals <span className="text-muted mono text-xs">({rawSignals.length})</span></h2>
            </div>
            <div className="overflow-x-auto max-h-80 overflow-y-auto">
              <table className="w-full text-xs mono">
                <thead className="sticky top-0 bg-surface border-b border-border">
                  <tr className="text-muted uppercase tracking-wider">
                    {['Time', 'Error Code', 'Message', 'Latency'].map(h => (
                      <th key={h} className="px-4 py-2 text-left">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rawSignals.map((s, i) => (
                    <tr key={i} className="border-b border-border/30 hover:bg-white/[0.02]">
                      <td className="px-4 py-2 text-muted whitespace-nowrap">{format(new Date(s.timestamp), 'HH:mm:ss.SSS')}</td>
                      <td className="px-4 py-2 text-danger">{s.errorCode}</td>
                      <td className="px-4 py-2 text-gray-300 max-w-xs truncate">{s.message}</td>
                      <td className="px-4 py-2 text-muted">{s.latencyMs ? `${s.latencyMs}ms` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Right: RCA Form */}
        <div className="space-y-4">
          <div className="bg-surface border border-border rounded-lg overflow-hidden">
            <div className="px-5 py-3 border-b border-border flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">Root Cause Analysis</h2>
              {rca && <span className="text-ok text-xs mono">✓ Submitted</span>}
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-xs text-muted mono uppercase tracking-wider mb-1">Incident Start</label>
                <input
                  type="datetime-local"
                  value={rcaForm.incidentStart}
                  onChange={e => setRcaForm(f => ({ ...f, incidentStart: e.target.value }))}
                  className="w-full bg-bg border border-border rounded px-3 py-2 text-sm mono text-white focus:border-accent outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-muted mono uppercase tracking-wider mb-1">Incident End</label>
                <input
                  type="datetime-local"
                  value={rcaForm.incidentEnd}
                  onChange={e => setRcaForm(f => ({ ...f, incidentEnd: e.target.value }))}
                  className="w-full bg-bg border border-border rounded px-3 py-2 text-sm mono text-white focus:border-accent outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-muted mono uppercase tracking-wider mb-1">Root Cause Category</label>
                <select
                  value={rcaForm.rootCauseCategory}
                  onChange={e => setRcaForm(f => ({ ...f, rootCauseCategory: e.target.value as RootCauseCategory }))}
                  className="w-full bg-bg border border-border rounded px-3 py-2 text-sm mono text-white focus:border-accent outline-none"
                >
                  {ROOT_CAUSE_OPTIONS.map(o => <option key={o} value={o}>{o.replace('_', ' ')}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-muted mono uppercase tracking-wider mb-1">Fix Applied</label>
                <textarea
                  value={rcaForm.fixApplied}
                  onChange={e => setRcaForm(f => ({ ...f, fixApplied: e.target.value }))}
                  rows={3}
                  placeholder="Describe the fix applied..."
                  className="w-full bg-bg border border-border rounded px-3 py-2 text-sm text-white focus:border-accent outline-none resize-none"
                />
              </div>
              <div>
                <label className="block text-xs text-muted mono uppercase tracking-wider mb-1">Prevention Steps</label>
                <textarea
                  value={rcaForm.preventionSteps}
                  onChange={e => setRcaForm(f => ({ ...f, preventionSteps: e.target.value }))}
                  rows={3}
                  placeholder="Steps to prevent recurrence..."
                  className="w-full bg-bg border border-border rounded px-3 py-2 text-sm text-white focus:border-accent outline-none resize-none"
                />
              </div>

              {rcaError && <p className="text-danger text-xs">{rcaError}</p>}
              {rcaSuccess && <p className="text-ok text-xs mono">✓ RCA saved successfully</p>}

              {workItem.status !== 'CLOSED' && (
                <button
                  onClick={handleRcaSubmit}
                  className="w-full bg-ok/10 hover:bg-ok/20 border border-ok/30 text-ok text-sm mono py-2 rounded transition-colors"
                >
                  {rca ? 'Update RCA' : 'Submit RCA'}
                </button>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
