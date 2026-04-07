import {
  listReports,
  type Report,
  ReportCategory,
  ReportStatus,
  ResolveAction,
  resolveReport,
} from '@meza/core';
import { useCallback, useEffect, useMemo, useState } from 'react';

interface ReportsSectionProps {
  /** Server scope. Empty string means platform queue (Administrator only). */
  serverId?: string;
}

const CATEGORY_LABELS: Record<ReportCategory, string> = {
  [ReportCategory.UNSPECIFIED]: 'Unknown',
  [ReportCategory.SPAM]: 'Spam',
  [ReportCategory.HARASSMENT]: 'Harassment',
  [ReportCategory.HATE]: 'Hate speech',
  [ReportCategory.SEXUAL]: 'Sexual content',
  [ReportCategory.VIOLENCE]: 'Violence',
  [ReportCategory.SELF_HARM]: 'Self-harm',
  [ReportCategory.ILLEGAL]: 'Illegal',
  [ReportCategory.OTHER]: 'Other',
};

const STATUS_LABELS: Record<ReportStatus, string> = {
  [ReportStatus.UNSPECIFIED]: '—',
  [ReportStatus.OPEN]: 'Open',
  [ReportStatus.RESOLVED]: 'Resolved',
  [ReportStatus.DISMISSED]: 'Dismissed',
};

const STATUS_FILTERS: Array<{ value: ReportStatus; label: string }> = [
  { value: ReportStatus.OPEN, label: 'Open' },
  { value: ReportStatus.RESOLVED, label: 'Resolved' },
  { value: ReportStatus.DISMISSED, label: 'Dismissed' },
];

export function ReportsSection({ serverId }: ReportsSectionProps) {
  const [reports, setReports] = useState<Report[]>([]);
  const [statusFilter, setStatusFilter] = useState<ReportStatus>(
    ReportStatus.OPEN,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchReports = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listReports({
        serverId,
        status: statusFilter,
        limit: 50,
      });
      setReports(res.reports);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load reports');
    } finally {
      setLoading(false);
    }
  }, [serverId, statusFilter]);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  const handleResolve = async (
    reportId: string,
    action: ResolveAction,
    note?: string,
  ) => {
    setError(null);
    try {
      const updated = await resolveReport({ reportId, action, note });
      setReports((prev) =>
        prev
          .map((r) => (r.id === reportId ? updated : r))
          // Drop the row if its new status no longer matches the active filter,
          // so mods working through the queue can tell what they've actioned.
          .filter((r) => r.status === statusFilter),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    }
  };

  const headerLabel = useMemo(
    () => (serverId ? 'Server reports' : 'Platform reports'),
    [serverId],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-text">{headerLabel}</h2>
        <div className="flex gap-2">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                statusFilter === f.value
                  ? 'bg-accent text-black'
                  : 'bg-bg-surface text-text-muted hover:text-text'
              }`}
              onClick={() => setStatusFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p className="rounded-md bg-error/10 px-3 py-2 text-sm text-error">
          {error}
        </p>
      )}

      {loading && reports.length === 0 ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : reports.length === 0 ? (
        <p className="text-sm text-text-muted">
          No {STATUS_LABELS[statusFilter].toLowerCase()} reports.
        </p>
      ) : (
        <ul className="space-y-3">
          {reports.map((r) => {
            const expanded = expandedId === r.id;
            return (
              <li
                key={r.id}
                className="rounded-md border border-border bg-bg-surface p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <span className="text-sm font-medium text-text">
                        {CATEGORY_LABELS[r.category]}
                      </span>
                      <span className="text-xs text-text-muted">
                        {STATUS_LABELS[r.status]}
                      </span>
                      <span className="text-xs text-text-muted">
                        {r.createdAt
                          ? new Date(
                              Number(r.createdAt.seconds) * 1000,
                            ).toLocaleString()
                          : ''}
                      </span>
                    </div>
                    {r.snapshotAuthorUsername && (
                      <p className="mt-1 text-xs text-text-muted">
                        Reported user: @{r.snapshotAuthorUsername}
                      </p>
                    )}
                    {r.snapshotContent && (
                      <button
                        type="button"
                        className="mt-2 block w-full text-left text-sm text-text"
                        onClick={() => setExpandedId(expanded ? null : r.id)}
                      >
                        <span
                          className={`block whitespace-pre-wrap break-words rounded bg-bg-elevated px-2 py-1 ${
                            expanded ? '' : 'line-clamp-2'
                          }`}
                        >
                          {r.snapshotContent}
                        </span>
                      </button>
                    )}
                    {r.reason && (
                      <p className="mt-2 text-xs text-text-muted">
                        <span className="font-medium text-text-muted">
                          Reporter note:
                        </span>{' '}
                        {r.reason}
                      </p>
                    )}
                  </div>
                  {r.status === ReportStatus.OPEN && (
                    <div className="flex shrink-0 flex-col gap-1">
                      <button
                        type="button"
                        className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-black hover:bg-accent/80"
                        onClick={() =>
                          handleResolve(r.id, ResolveAction.RESOLVE)
                        }
                        aria-label={`Resolve report against ${r.snapshotAuthorUsername || 'unknown user'}`}
                      >
                        Resolve
                      </button>
                      <button
                        type="button"
                        className="rounded-md bg-bg-elevated px-3 py-1 text-xs text-text-muted hover:text-text"
                        onClick={() =>
                          handleResolve(r.id, ResolveAction.DISMISS)
                        }
                        aria-label={`Dismiss report against ${r.snapshotAuthorUsername || 'unknown user'}`}
                      >
                        Dismiss
                      </button>
                    </div>
                  )}
                  {r.status !== ReportStatus.OPEN && (
                    <button
                      type="button"
                      className="shrink-0 rounded-md bg-bg-elevated px-3 py-1 text-xs text-text-muted hover:text-text"
                      onClick={() => handleResolve(r.id, ResolveAction.REOPEN)}
                      aria-label={`Reopen report against ${r.snapshotAuthorUsername || 'unknown user'}`}
                    >
                      Reopen
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
