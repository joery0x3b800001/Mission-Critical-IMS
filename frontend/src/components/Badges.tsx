import { memo } from 'react';
import { Priority, WorkItemStatus } from '../types';

// Memoize badge components to prevent unnecessary re-renders in lists
export const PriorityBadge = memo(function PriorityBadge({ priority }: { priority: Priority }) {
  const styles: Record<Priority, string> = {
    P0: 'bg-red-900/40 text-red-400 border border-red-700/50',
    P1: 'bg-orange-900/40 text-orange-400 border border-orange-700/50',
    P2: 'bg-yellow-900/40 text-yellow-400 border border-yellow-700/50',
  };
  return (
    <span className={`mono text-xs font-bold px-2 py-0.5 rounded ${styles[priority]}`}>
      {priority}
    </span>
  );
});

export const StatusBadge = memo(function StatusBadge({ status }: { status: WorkItemStatus }) {
  const styles: Record<WorkItemStatus, string> = {
    OPEN: 'bg-red-900/30 text-red-300 border border-red-800/50',
    INVESTIGATING: 'bg-blue-900/30 text-blue-300 border border-blue-800/50',
    RESOLVED: 'bg-green-900/30 text-green-300 border border-green-800/50',
    CLOSED: 'bg-gray-800/50 text-gray-400 border border-gray-700/50',
  };
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded ${styles[status]}`}>
      {status}
    </span>
  );
});
