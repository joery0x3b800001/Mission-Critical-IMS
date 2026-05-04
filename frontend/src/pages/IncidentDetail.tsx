import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { IncidentDetail, WorkItemStatus, RootCauseCategory } from '../types';
import { PriorityBadge, StatusBadge } from '../components/Badges';
import { format, formatDistanceToNow, differenceInSeconds, isValid } from 'date-fns';

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

// ── Validation result shape ──────────────────────────────────────────────────
interface RcaValidation {
  startMissing: boolean;
  endMissing: boolean;
  endBeforeStart: boolean;
  endBeforeCreated: boolean;
  durationSeconds: number | null;
  endInvalid: boolean;
  endErrorMsg: string | null;
  fixTooShort: boolean;
  preventionTooShort: boolean;
  formReady: boolean;
}

// ── Pure validation hook: All RCA form validation logic in one place ─────────
function useRcaValidation(
  form: { incidentStart: string; incidentEnd: string; fixApplied: string; preventionSteps: string },
  _workItemStartTime: string,
): RcaValidation {
  return useMemo(() => {
    const startDate = form.incidentStart ? new Date(form.incidentStart) : null;
    const endDate = form.incidentEnd ? new Date(form.incidentEnd) : null;

    const startMissing = !startDate || !isValid(startDate);
    const endMissing = !endDate || !isValid(endDate);
    const endBeforeStart = !startMissing && !endMissing && endDate! <= startDate!;
    const endInvalid = endMissing || endBeforeStart;

    let endErrorMsg: string | null = null;
    if (endMissing) endErrorMsg = 'End date is required';
    else if (endBeforeStart) endErrorMsg = 'End must be after start';

    const durationSeconds = !startMissing && !endInvalid
      ? differenceInSeconds(endDate!, startDate!)
      : null;

    const fixTooShort = form.fixApplied.trim().length < 10;
    const preventionTooShort = form.preventionSteps.trim().length < 10;
    const formReady = !startMissing && !endInvalid && !fixTooShort && !preventionTooShort;

    return {
      startMissing, endMissing, endBeforeStart,
      endBeforeCreated: false, durationSeconds, endInvalid, endErrorMsg,
      fixTooShort, preventionTooShort, formReady,
    };
  }, [form.incidentStart, form.incidentEnd, form.fixApplied, form.preventionSteps]);
}

// ── Duration formatter: Convert seconds to human-readable format ──────────────
const formatDuration = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
};

// ── Character count badge: Real-time validation feedback ────────────────────
const CharCount = ({ value, min }: { value: string; min: number }) => {
  const len = value.trim().length;
  const color = len >= min ? 'text-ok' : len > 0 ? 'text-warn' : 'text-muted';
  return (
    <span className={`mono text-xs ${color} transition-colors duration-200`}>
      {len}/{min} min
    </span>
  );
};

// ════════════════════════════════════════════════════════════════════════════
export function IncidentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [detail, setDetail] = useState<IncidentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [transitioning, setTransitioning] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [rcaError, setRcaError] = useState<string | null>(null);
  const [rcaSuccess, setRcaSuccess] = useState(false);

  const [rcaForm, setRcaForm] = useState({
    incidentStart: '',
    incidentEnd: '',
    rootCauseCategory: 'UNKNOWN' as RootCauseCategory,
    fixApplied: '',
    preventionSteps: '',
  });

  // Errors only surface after the user has interacted with a field
  const [touched, setTouched] = useState({
    incidentStart: false,
    incidentEnd: false,
    fixApplied: false,
    preventionSteps: false,
  });

  const v = useRcaValidation(rcaForm, detail?.workItem.startTime ?? '');

  // ── Data loader ────────────────────────────────────────────────────────────
  const load = async () => {
    if (!id) return;
    try {
      const data = await api.getIncident(id, 0, 50);
      // Extract incident detail from response
      const incidentDetail = {
        workItem: data.workItem || data.workItem,
        rca: data.rca || data.rca,
        rawSignals: data.rawSignals || data.rawSignals
      } as any;
      setDetail(incidentDetail);
      if (incidentDetail.rca) {
        setRcaForm({
          incidentStart: incidentDetail.rca.incidentStart.slice(0, 16),
          incidentEnd: incidentDetail.rca.incidentEnd.slice(0, 16),
          rootCauseCategory: incidentDetail.rca.rootCauseCategory,
          fixApplied: incidentDetail.rca.fixApplied,
          preventionSteps: incidentDetail.rca.preventionSteps,
        });
        setTouched({ incidentStart: true, incidentEnd: true, fixApplied: true, preventionSteps: true });
      } else if (incidentDetail.workItem.startTime) {
        setRcaForm(f => ({ ...f, incidentStart: incidentDetail.workItem.startTime.slice(0, 16) }));
      }
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [id]);

  // ── Status transition ──────────────────────────────────────────────────────
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

  // ── RCA submit ─────────────────────────────────────────────────────────────
  const handleRcaSubmit = async () => {
    if (!detail) return;
    // Force-show all errors on submit attempt regardless of touch state
    setTouched({ incidentStart: true, incidentEnd: true, fixApplied: true, preventionSteps: true });
    if (!v.formReady) return;
    setRcaError(null);
    setSubmitting(true);
    try {
      await api.submitRca(detail.workItem.id, {
        ...rcaForm,
        incidentStart: new Date(rcaForm.incidentStart).toISOString(),
        incidentEnd: new Date(rcaForm.incidentEnd).toISOString(),
      });
      setRcaSuccess(true);
      // Timer will be cleaned up by useEffect below
      await load();
    } catch (e) {
      setRcaError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  // ── Loading / not-found screens ────────────────────────────────────────────
  if (loading) return (
    <div className="min-h-screen bg-bg flex items-center justify-center">
      <p className="text-muted mono text-sm animate-pulse">Loading incident...</p>
    </div>
  );
  if (!detail) return (
    <div className="min-h-screen bg-bg flex items-center justify-center">
      <p className="text-danger mono text-sm">Incident not found</p>
    </div>
  );

  const { workItem, rca, rawSignals } = detail;
  const nextStatus = STATUS_TRANSITIONS[workItem.status];
  const isClosed = workItem.status === 'CLOSED';

  // ── End-date field: derive all visual flags in one place ──────────────────
  // NOTE: We intentionally do NOT gate on touched.incidentEnd here.
  // The native datetime-local picker fires onChange for each segment the user
  // edits (day, month, year, hour, minute) — but the full value isn't valid
  // until all segments are filled. Gating on touched caused the green state to
  // only appear after an explicit blur. Instead we derive state purely from
  // whether rcaForm.incidentEnd has a value, making it immediately reactive.
  const showEndError = !!rcaForm.incidentEnd && v.endInvalid;
  const showEndSuccess = !!rcaForm.incidentEnd && !v.endInvalid;

  const endInputCls = [
    'w-full rounded px-3 py-2 text-sm mono outline-none border transition-all duration-200',
    isClosed
      ? 'bg-bg/30 border-border/30 text-muted/40 cursor-not-allowed opacity-40'
      : showEndError
        ? 'bg-red-900/10 border-red-700/60 text-red-300 focus:border-red-500'
        : showEndSuccess
          ? 'bg-bg border-ok/40 text-white focus:border-ok'
          : 'bg-bg border-border text-white focus:border-accent',
  ].join(' ');

  const endLabelCls = [
    'block text-xs mono uppercase tracking-wider transition-colors duration-200',
    isClosed ? 'text-muted/40'
      : showEndError ? 'text-red-400'
        : showEndSuccess ? 'text-ok'
          : 'text-muted',
  ].join(' ');
  // Keep touched.incidentEnd for the error message below the input —
  // we still don't want to show "End date is required" before the user
  // has interacted at all with the end field.
  const endErrorVisible = (touched.incidentEnd || !!rcaForm.incidentEnd) && v.endInvalid;

  // ════════════════════════════════════════════════════════════════════════════
  return (
    <div className="min-h-screen bg-bg">

      {/* ── Page header ── */}
      <header className="border-b border-border px-6 py-4 flex items-center gap-4">
        <button
          onClick={() => navigate('/')}
          className="text-muted hover:text-white text-sm transition-colors"
        >
          ← Back
        </button>
        <div className="w-px h-4 bg-border" />
        <PriorityBadge priority={workItem.priority} />
        <StatusBadge status={workItem.status} />
        <h1 className="text-sm font-medium text-white flex-1 truncate">{workItem.title}</h1>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 grid grid-cols-3 gap-6">

        {/* ══════════════════════════════════════════
            LEFT — Incident details + raw signals
        ══════════════════════════════════════════ */}
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
                ...(workItem.mttrSeconds
                  ? [['MTTR', `${Math.round(workItem.mttrSeconds / 60)} min`]]
                  : []),
              ].map(([k, val]) => (
                <div key={String(k)}>
                  <p className="text-muted mono text-xs uppercase tracking-wider mb-0.5">{k}</p>
                  <p className="text-white mono text-sm">{val}</p>
                </div>
              ))}
            </div>

            {actionError && (
              <div className="bg-red-900/20 border border-red-800/50 rounded p-3 text-red-400 text-sm">
                {actionError}
              </div>
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

          {/* Raw signals table */}
          <div className="bg-surface border border-border rounded-lg overflow-hidden">
            <div className="px-5 py-3 border-b border-border">
              <h2 className="text-sm font-semibold text-white">
                Raw Signals{' '}
                <span className="text-muted mono text-xs">({rawSignals.length})</span>
              </h2>
            </div>
            <div className="overflow-x-auto max-h-80 overflow-y-auto">
              {rawSignals.length === 0 ? (
                <p className="text-center text-muted mono text-xs py-8">No raw signals linked yet</p>
              ) : (
                <table className="w-full text-xs mono">
                  <thead className="sticky top-0 bg-surface border-b border-border">
                    <tr className="text-muted uppercase tracking-wider">
                      {['Time', 'Error Code', 'Message', 'Latency'].map(h => (
                        <th key={h} className="px-4 py-2 text-left font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rawSignals.map((s, i) => (
                      <tr key={i} className="border-b border-border/30 hover:bg-white/[0.02]">
                        <td className="px-4 py-2 text-muted whitespace-nowrap">
                          {format(new Date(s.timestamp), 'HH:mm:ss.SSS')}
                        </td>
                        <td className="px-4 py-2 text-danger">{s.errorCode}</td>
                        <td className="px-4 py-2 text-gray-300 max-w-xs truncate">{s.message}</td>
                        <td className="px-4 py-2 text-muted">
                          {s.latencyMs ? `${s.latencyMs}ms` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>

        {/* ══════════════════════════════════════════
            RIGHT — RCA Form
        ══════════════════════════════════════════ */}
        <div className="space-y-4">
          <div className="bg-surface border border-border rounded-lg overflow-hidden">

            <div className="px-5 py-3 border-b border-border flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">Root Cause Analysis</h2>
              {rca && <span className="text-ok text-xs mono">✓ Submitted</span>}
            </div>

            <div className="p-5 space-y-5">

              {/* ── Incident Start ────────────────────────────────────────── */}
              <div className="space-y-1">
                <label className="block text-xs text-muted mono uppercase tracking-wider">
                  Incident Start
                </label>
                <input
                  type="datetime-local"
                  value={rcaForm.incidentStart}
                  disabled={isClosed}
                  onChange={e => {
                    setRcaForm(f => ({ ...f, incidentStart: e.target.value }));
                    // Re-touch end too so end re-validates against the new start immediately
                    setTouched(t => ({ ...t, incidentStart: true, incidentEnd: true }));
                  }}
                  onBlur={() => setTouched(t => ({ ...t, incidentStart: true }))}
                  className={[
                    'w-full rounded px-3 py-2 text-sm mono outline-none border transition-all duration-200',
                    isClosed
                      ? 'bg-bg/30 border-border/30 text-muted/40 cursor-not-allowed opacity-40'
                      : touched.incidentStart && v.startMissing
                        ? 'bg-red-900/10 border-red-700/60 text-red-300'
                        : rcaForm.incidentStart
                          ? 'bg-bg border-ok/40 text-white focus:border-ok'
                          : 'bg-bg border-border text-white focus:border-accent',
                  ].join(' ')}
                />
                {touched.incidentStart && v.startMissing && (
                  <p className="text-red-400 text-xs mono flex items-center gap-1 animate-slide_in">
                    <span>⚠</span> Start date is required
                  </p>
                )}
              </div>

              {/* ── Incident End ─────────────────────── KEY DYNAMIC FIELD ── */}
              <div className="space-y-1">

                {/* Label row — colour reacts to validation state */}
                <div className="flex items-center justify-between">
                  <label className={endLabelCls}>
                    Incident End
                  </label>
                  {/* Duration badge — only visible when both dates are valid */}
                  {v.durationSeconds !== null && (
                    <span className="mono text-xs bg-accent/10 border border-accent/20 text-accent px-2 py-0.5 rounded animate-slide_in">
                      ⏱ {formatDuration(v.durationSeconds)}
                    </span>
                  )}
                </div>

                {/*
                  Visual states:
                    disabled + opacity-40   → CLOSED incident (fully locked)
                    red border              → touched + any rule violated
                    green border            → touched + all rules pass
                    neutral                 → not yet interacted
                  min enforces browser-level start constraint.
                  No max — incidents can be resolved at any past or present time.
                */}
                <input
                  type="datetime-local"
                  value={rcaForm.incidentEnd}
                  disabled={isClosed}
                  onChange={e => {
                    setRcaForm(f => ({ ...f, incidentEnd: e.target.value }));
                    setTouched(t => ({ ...t, incidentEnd: true }));
                  }}
                  onBlur={() => setTouched(t => ({ ...t, incidentEnd: true }))}
                  className={endInputCls}
                />

                {/* Error — shown only after touch, one specific reason at a time */}
                {endErrorVisible && v.endErrorMsg && (
                  <p className="text-red-400 text-xs mono flex items-center gap-1 animate-slide_in">
                    <span>⚠</span> {v.endErrorMsg}
                  </p>
                )}

                {/* Success confirmation */}
                {showEndSuccess && (
                  <p className="text-ok text-xs mono flex items-center gap-1 animate-slide_in">
                    <span>✓</span> Valid end date
                  </p>
                )}

                {/* Locked hint when CLOSED */}
                {isClosed && (
                  <p className="text-muted/50 text-xs mono">
                    Locked — incident is CLOSED
                  </p>
                )}
              </div>

              {/* ── Root Cause Category ───────────────────────────────────── */}
              <div className="space-y-1">
                <label className="block text-xs text-muted mono uppercase tracking-wider">
                  Root Cause Category
                </label>
                <select
                  value={rcaForm.rootCauseCategory}
                  disabled={isClosed}
                  onChange={e => setRcaForm(f => ({
                    ...f,
                    rootCauseCategory: e.target.value as RootCauseCategory,
                  }))}
                  className={[
                    'w-full rounded px-3 py-2 text-sm mono outline-none border transition-all duration-200',
                    isClosed
                      ? 'bg-bg/30 border-border/30 text-muted/40 cursor-not-allowed opacity-40'
                      : 'bg-bg border-border text-white focus:border-accent',
                  ].join(' ')}
                >
                  {ROOT_CAUSE_OPTIONS.map(o => (
                    <option key={o} value={o}>{o.replace(/_/g, ' ')}</option>
                  ))}
                </select>
              </div>

              {/* ── Fix Applied ───────────────────────────────────────────── */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="block text-xs text-muted mono uppercase tracking-wider">
                    Fix Applied
                  </label>
                  <CharCount value={rcaForm.fixApplied} min={10} />
                </div>
                <textarea
                  value={rcaForm.fixApplied}
                  disabled={isClosed}
                  rows={3}
                  placeholder="Describe the fix applied..."
                  onChange={e => {
                    setRcaForm(f => ({ ...f, fixApplied: e.target.value }));
                    setTouched(t => ({ ...t, fixApplied: true }));
                  }}
                  onBlur={() => setTouched(t => ({ ...t, fixApplied: true }))}
                  className={[
                    'w-full rounded px-3 py-2 text-sm outline-none border transition-all duration-200 resize-none',
                    isClosed
                      ? 'bg-bg/30 border-border/30 text-muted/40 cursor-not-allowed opacity-40'
                      : touched.fixApplied && v.fixTooShort
                        ? 'bg-red-900/10 border-red-700/60 text-red-300 focus:border-red-500'
                        : !v.fixTooShort
                          ? 'bg-bg border-ok/40 text-white focus:border-ok'
                          : 'bg-bg border-border text-white focus:border-accent',
                  ].join(' ')}
                />
                {touched.fixApplied && v.fixTooShort && (
                  <p className="text-red-400 text-xs mono flex items-center gap-1 animate-slide_in">
                    <span>⚠</span> Minimum 10 characters required
                  </p>
                )}
              </div>

              {/* ── Prevention Steps ──────────────────────────────────────── */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="block text-xs text-muted mono uppercase tracking-wider">
                    Prevention Steps
                  </label>
                  <CharCount value={rcaForm.preventionSteps} min={10} />
                </div>
                <textarea
                  value={rcaForm.preventionSteps}
                  disabled={isClosed}
                  rows={3}
                  placeholder="Steps to prevent recurrence..."
                  onChange={e => {
                    setRcaForm(f => ({ ...f, preventionSteps: e.target.value }));
                    setTouched(t => ({ ...t, preventionSteps: true }));
                  }}
                  onBlur={() => setTouched(t => ({ ...t, preventionSteps: true }))}
                  className={[
                    'w-full rounded px-3 py-2 text-sm outline-none border transition-all duration-200 resize-none',
                    isClosed
                      ? 'bg-bg/30 border-border/30 text-muted/40 cursor-not-allowed opacity-40'
                      : touched.preventionSteps && v.preventionTooShort
                        ? 'bg-red-900/10 border-red-700/60 text-red-300 focus:border-red-500'
                        : !v.preventionTooShort
                          ? 'bg-bg border-ok/40 text-white focus:border-ok'
                          : 'bg-bg border-border text-white focus:border-accent',
                  ].join(' ')}
                />
                {touched.preventionSteps && v.preventionTooShort && (
                  <p className="text-red-400 text-xs mono flex items-center gap-1 animate-slide_in">
                    <span>⚠</span> Minimum 10 characters required
                  </p>
                )}
              </div>

              {/* ── Form-level server error / success ─────────────────────── */}
              {rcaError && (
                <div className="bg-red-900/20 border border-red-800/50 rounded p-3 text-red-400 text-xs mono animate-slide_in">
                  ⚠ {rcaError}
                </div>
              )}
              {rcaSuccess && (
                <div className="bg-ok/10 border border-ok/30 rounded p-3 text-ok text-xs mono animate-slide_in">
                  ✓ RCA saved successfully
                </div>
              )}

              {/* ── Submit button ─────────────────────────────────────────── */}
              {!isClosed && (
                <div className="relative group">
                  <button
                    onClick={handleRcaSubmit}
                    disabled={submitting}
                    className={[
                      'w-full border text-sm mono py-2 rounded transition-all duration-200',
                      v.formReady && !submitting
                        ? 'bg-ok/10 hover:bg-ok/20 border-ok/30 text-ok cursor-pointer'
                        : 'bg-surface border-border/40 text-muted/40 cursor-not-allowed',
                    ].join(' ')}
                  >
                    {submitting ? 'Saving...' : rca ? '↻ Update RCA' : '✓ Submit RCA'}
                  </button>

                  {/* Hover tooltip — lists every outstanding problem */}
                  {!v.formReady && (
                    <div className="absolute bottom-full left-0 right-0 mb-2 hidden group-hover:block z-10">
                      <div className="bg-gray-900 border border-border rounded p-3 text-xs mono space-y-1 shadow-xl">
                        <p className="text-white font-semibold mb-1">Form incomplete:</p>
                        {v.startMissing && <p className="text-red-400">• Start date required</p>}
                        {v.endInvalid && v.endErrorMsg && <p className="text-red-400">• {v.endErrorMsg}</p>}
                        {v.fixTooShort && <p className="text-warn">• Fix Applied: min 10 chars</p>}
                        {v.preventionTooShort && <p className="text-warn">• Prevention Steps: min 10 chars</p>}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Closed lockout notice */}
              {isClosed && (
                <p className="text-center text-muted/50 text-xs mono py-1">
                  This incident is closed — RCA is locked
                </p>
              )}

            </div>
          </div>
        </div>

      </main>
    </div>
  );
}