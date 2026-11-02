import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { MoreHorizontal } from 'lucide-react';
import { api } from '../api/client.js';
import { useFetch } from '../lib/useFetch.js';
import { usePageChrome } from '../context/ui.jsx';
import { Spinner, ErrorState, EmptyState, StatusBadge, Button } from '../components/ui.jsx';
import { Page, PageHeader, Toolbar } from '../components/app.jsx';
import LinkifiedText from '../components/LinkifiedText.jsx';
import ResourceNotice from '../components/ResourceNotice.jsx';
import { duplicateScanPath } from '../lib/scanDuplication.js';
import { isScanDeletable } from '../lib/scanPresentation.js';
import { useModalDialog } from '../lib/useModalDialog.js';
import {
  providerCapacityAutoscalePresentation,
  rateLimitPresentation,
  rateLimitRetryText,
  storageWarningPresentation,
} from '../lib/format.js';
import { useNewestFirst, usePagination } from '../lib/usePagination.js';
import Pagination from '../components/Pagination.jsx';

const FILTERS = [
  ['all', 'All'],
  ['running', 'Running'],
  ['queued', 'Queued'],
  ['rate_limited', 'Rate limited'],
  ['completed', 'Completed'],
  ['failed', 'Failed'],
];
const SCANS_PAGE_SIZE = 6;

export default function Scans() {
  const [params, setParams] = useSearchParams();
  const newDialogParam = params.get('new');
  const [dialogOpen, setDialogOpen] = useState(newDialogParam === '1');
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [busyScanId, setBusyScanId] = useState(null);
  const [expandedErrorIds, setExpandedErrorIds] = useState(() => new Set());
  const [actionError, setActionError] = useState(null);
  const closeDialog = () => {
    setDialogOpen(false);
    if (params.has('new')) setParams({}, { replace: true });
  };
  useEffect(() => {
    setDialogOpen(newDialogParam === '1');
  }, [newDialogParam]);
  usePageChrome([{ label: 'Scans', active: true }], { label: '+ New scan', to: '/scans?new=1' }, []);
  const requestKey = `${filter}:${page}`;
  const { data, loading, error, reload } = useFetch(
    async () => ({ ...(await api.scanPage({ status: filter, page, pageSize: SCANS_PAGE_SIZE })), requestKey }),
    [requestKey],
    { pollMs: 1000 }
  );
  const pageData = data?.requestKey === requestKey ? data : null;
  const scans = pageData?.items || [];
  const scanPages = pageData
    ? {
        pageItems: scans,
        page: pageData.page,
        pageSize: pageData.pageSize,
        totalItems: pageData.totalItems,
        totalPages: pageData.totalPages,
        startIndex: pageData.startIndex,
        endIndex: pageData.endIndex,
        setPage,
      }
    : null;

  useEffect(() => {
    if (pageData && page > pageData.totalPages) setPage(pageData.totalPages);
  }, [page, pageData]);
  const resumeScan = async (event, scanId) => {
    event.stopPropagation();
    setBusyScanId(scanId);
    setActionError(null);
    try {
      await api.resumeScan(scanId);
      reload();
    } catch (resumeError) {
      setActionError(resumeError);
    } finally {
      setBusyScanId(null);
    }
  };
  const toggleError = (event, scanId) => {
    event.stopPropagation();
    setExpandedErrorIds((prev) => {
      const next = new Set(prev);
      if (next.has(scanId)) next.delete(scanId);
      else next.add(scanId);
      return next;
    });
  };
  const deleteScan = async (event, scan) => {
    event.stopPropagation();
    const confirmed = window.confirm(
      `Permanently delete scan #${scan.id} and all findings, attempts, logs, and review data? This cannot be undone.`
    );
    if (!confirmed) return;
    setBusyScanId(scan.id);
    setActionError(null);
    try {
      await api.deleteScan(scan.id);
      reload();
    } catch (deleteError) {
      setActionError(deleteError);
    } finally {
      setBusyScanId(null);
    }
  };

  return (
    <Page>
      <PageHeader
        title="Scans"
        meta={
          pageData
            ? `${pageData.totalItems} scan${pageData.totalItems === 1 ? '' : 's'}, ${pageData.runningCount} running now`
            : undefined
        }
      />

      {dialogOpen && <NewScanDialog onClose={closeDialog} />}

      <Toolbar end={scanPages ? <Pagination {...scanPages} itemLabel="scans" /> : null}>
        <div className="filters" role="group" aria-label="Filter scans">
          {FILTERS.map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={filter === k ? 'filter is-active' : 'filter'}
              aria-pressed={filter === k}
              onClick={() => {
                setFilter(k);
                setPage(1);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </Toolbar>

      {loading && !pageData && <Spinner />}
      {error && <ErrorState error={error} onRetry={reload} />}
      {actionError && <ErrorState error={actionError} />}
      {pageData && pageData.totalItems === 0 && (
        <EmptyState
          title="No scans here"
          sub="Queue a scan by pointing a workflow at a repository."
          action={<Button to="/scans?new=1">+ New scan</Button>}
        />
      )}
      {pageData && pageData.totalItems > 0 && (
        <div className="table-wrap">
          <table className="data-table scan-table">
            <thead>
              <tr>
                <th>Repository</th>
                <th>Workflow</th>
                <th className="cell-num">Findings</th>
                <th>Updated</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {scans.map((s) => (
                <ScanCard
                  key={s.id}
                  scan={s}
                  to={`/scans/${s.id}`}
                  busy={busyScanId === s.id}
                  errorExpanded={expandedErrorIds.has(s.id)}
                  onResume={(event) => resumeScan(event, s.id)}
                  onToggleError={(event) => toggleError(event, s.id)}
                  onDelete={(event) => deleteScan(event, s)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}

function NewScanDialog({ onClose }) {
  const [mode, setMode] = useState(null); // null | 'duplicate'
  const [selectedId, setSelectedId] = useState('');
  const { data, loading, error, reload } = useFetch(() => api.scans(), []);
  const scans = useNewestFirst(data, 'updatedAt');
  const hasScans = scans.length > 0;
  const duplicateDisabled = data !== null && !error && !hasScans;
  const dialogRef = useModalDialog(onClose);
  const duplicatePages = usePagination(scans, { pageSize: 6, resetKey: mode });

  useEffect(() => {
    setSelectedId((current) => {
      if (scans.some((scan) => `${scan.id}` === current)) return current;
      return scans[0]?.id == null ? '' : `${scans[0].id}`;
    });
  }, [scans]);

  const duplicateDescription = loading
    ? 'Loading previous scans…'
    : error
      ? 'Previous scans could not be loaded. Open this option to retry.'
      : hasScans
        ? 'Copy a previous target and configuration, then review it before starting.'
        : 'No existing scans yet to duplicate.';

  return (
    <div className="dialog-wrap" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-scan-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        className="dialog"
        style={{ width: 500 }}
      >
        <div className="dialog-head">
          <h2 className="dialog-title" id="new-scan-title">
            New scan
          </h2>
          <button type="button" className="btn btn--icon btn--sm" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="dialog-body">
          {mode !== 'duplicate' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <ScanCreationOption
                autoFocus
                title="Blank scan"
                sub="Start with the default scan configuration and choose every input yourself."
                to="/scans/new"
              />
              <ScanCreationOption
                title="Duplicate an existing scan"
                sub={duplicateDescription}
                disabled={duplicateDisabled}
                onClick={() => !duplicateDisabled && setMode('duplicate')}
              />
            </div>
          ) : (
            <div>
              <div className="field-note" style={{ marginBottom: 'var(--space-4)' }}>
                Pick a scan to copy. Only its editable configuration is carried into the new draft.
              </div>

              {loading && !data && <Spinner label="Loading previous scans…" />}
              {error && <ErrorState error={error} onRetry={reload} />}
              {data && hasScans && (
                <>
                  <div style={{ maxHeight: 300, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {duplicatePages.pageItems.map((scan) => {
                      const scanId = `${scan.id}`;
                      const selected = selectedId === scanId;
                      const label = scan.repoDisplay || scan.repoFull || `Scan ${scan.id}`;
                      const modelOverrideCount = Object.keys(scan.modelOverrides || {}).length;
                      const detail = [
                        `#${scan.id}`,
                        scan.workflowName,
                        scan.model,
                        modelOverrideCount
                          ? `${modelOverrideCount} depth override${modelOverrideCount === 1 ? '' : 's'}`
                          : null,
                        scan.repoKind === 'local' ? 'local snapshot' : null,
                        scan.age ? `${scan.age} ago` : null,
                      ]
                        .filter(Boolean)
                        .join(' / ');
                      return (
                        <button
                          key={scanId}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => setSelectedId(scanId)}
                          className={selected ? 'pick-row is-selected' : 'pick-row'}
                        >
                          <div style={{ minWidth: 0 }}>
                            <span className="cell-main">{label}</span>
                            {detail && <span className="cell-sub">{detail}</span>}
                          </div>
                          <StatusBadge status={scan.status} reasoning={scan.reasoning} size="sm" />
                        </button>
                      );
                    })}
                  </div>
                  <Pagination
                    {...duplicatePages}
                    setPage={(nextPage) => {
                      duplicatePages.setPage(nextPage);
                      const nextScan = scans[(nextPage - 1) * duplicatePages.pageSize];
                      if (nextScan) setSelectedId(`${nextScan.id}`);
                    }}
                    itemLabel="scans"
                    compact
                  />
                </>
              )}
              {data && !hasScans && (
                <div className="state-block" style={{ marginTop: 'var(--space-4)' }}>
                  <div className="state-note">No existing scans to duplicate.</div>
                </div>
              )}

              <div className="dialog-foot" style={{ marginTop: 'var(--space-5)', paddingInline: 0, paddingBottom: 0 }}>
                <button type="button" className="btn btn--quiet" onClick={() => setMode(null)}>
                  Back
                </button>
                <Button
                  to={!loading && selectedId ? duplicateScanPath(selectedId) : undefined}
                  disabled={!selectedId || loading}
                >
                  Duplicate &amp; configure
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ScanCreationOption({ title, sub, to, onClick, disabled, autoFocus = false }) {
  const content = (
    <>
      <div className="option-title">{title}</div>
      <div className="option-note">{sub}</div>
    </>
  );
  if (to) {
    return (
      <Link to={to} data-autofocus={autoFocus || undefined} className="option-card">
        {content}
      </Link>
    );
  }
  return (
    <button
      type="button"
      data-autofocus={autoFocus || undefined}
      disabled={disabled}
      onClick={onClick}
      className="option-card"
    >
      {content}
    </button>
  );
}

export function ScanCard({ scan, to, onResume, onToggleError, onDelete, busy, errorExpanded }) {
  const isRunning =
    scan.status === 'running' || scan.status === 'prewarming_cache' || scan.status === 'post_processing';
  const isPaused = scan.status === 'paused';
  const isDone = scan.status === 'completed' || scan.status === 'stopped';
  const isFailed = scan.status === 'failed';
  const isPending = scan.status === 'pending';
  const isQueued = scan.status === 'queued';
  const isRateLimited = scan.status === 'rate_limited';
  const rateLimit = rateLimitPresentation(scan.reasoning);
  const providerAutoscale = providerCapacityAutoscalePresentation(scan.reasoning);
  const storageWarning = storageWarningPresentation(scan.reasoning, scan.status);
  const summary = scan.statusSummary || {};
  const latestError = summary.latestError;
  const currentFailedAttempts = summary.currentFailedAttempts ?? summary.failedAttempts ?? 0;
  const failedLabel = currentFailedAttempts
    ? `Failed after ${currentFailedAttempts} failed attempt${currentFailedAttempts === 1 ? '' : 's'}`
    : 'Failed';
  const modelOverrideCount = Object.keys(scan.modelOverrides || {}).length;
  const repoLabel = scan.repoDisplay || scan.repoFull || `Scan ${scan.id}`;
  const stateNote = isRunning
    ? scan.progressLabel ||
      (scan.status === 'prewarming_cache'
        ? 'prewarming checkout cache'
        : scan.status === 'post_processing'
          ? 'post-processing'
          : 'running')
    : isPaused
      ? 'completed work preserved'
      : isFailed
        ? failedLabel
        : isQueued
          ? 'starts after active scans'
          : isRateLimited
            ? rateLimit.label
            : isPending
              ? 'waiting for the engine'
              : null;
  const showDetail = Boolean(
    providerAutoscale || scan.resourceNotice || storageWarning || isRunning || isFailed || isRateLimited
  );

  return (
    <>
      <tr className={isRunning ? 'is-live' : undefined}>
        <td style={{ minWidth: 200 }}>
          <Link className="cell-main" to={to}>
            {repoLabel}
          </Link>
          <span className="cell-sub">
            {scan.repoKind === 'local' ? 'local snapshot' : scan.commitShort} / scan #{scan.id}
          </span>
        </td>
        <td style={{ minWidth: 180 }}>
          <span className="cell-main" style={{ fontWeight: 400 }}>
            {scan.workflowName}
          </span>
          <span className="cell-sub mono" style={{ fontFamily: 'var(--font-mono)' }}>
            {scan.model}
            {modelOverrideCount ? ` +${modelOverrideCount}` : ''}
          </span>
        </td>
        <td className="cell-num">
          {isDone ? (
            <>
              <span className="cell-main" style={{ fontWeight: 600 }}>
                {scan.findings}
              </span>
              <span className="cell-sub">
                {scan.rawCandidates ?? scan.findings} raw / {scan.exploitable} exploitable
              </span>
            </>
          ) : (
            <span className="cell-muted">Pending</span>
          )}
        </td>
        <td className="cell-muted" style={{ whiteSpace: 'nowrap' }}>
          {scan.age ? `${scan.age} ago` : 'Pending'}
        </td>
        <td>
          <div className="scan-state">
            <div style={{ minWidth: 0 }}>
              <StatusBadge status={scan.status} reasoning={scan.reasoning} size="sm" />
              {stateNote && <span className="cell-sub">{stateNote}</span>}
            </div>
            <div className="cell-actions">
              {(isPaused || isFailed) && (
                <Button
                  variant="subtle"
                  onClick={onResume}
                  disabled={busy}
                  title={isFailed ? 'Continue from completed steps and retry failed work' : 'Continue this paused scan'}
                >
                  {busy ? '…' : 'Resume'}
                </Button>
              )}
              <ScanActionsMenu scan={scan} onDelete={onDelete} busy={busy} />
            </div>
          </div>
        </td>
      </tr>
      {showDetail && (
        <tr className="scan-detail-row">
          <td colSpan={5} className="scan-detail-cell">
            {providerAutoscale && (
              <div style={{ color: 'var(--run)', fontSize: 'var(--text-xs)' }} title={providerAutoscale.message}>
                {providerAutoscale.compact}, {providerAutoscale.reductions}{' '}
                {providerAutoscale.reductions === 1 ? 'reduction' : 'reductions'}
              </div>
            )}
            <ResourceNotice notice={scan.resourceNotice} />
            <ResourceNotice notice={storageWarning} />
            {isRunning && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)' }}>
                <div className="scan-progress" aria-hidden="true">
                  <div style={{ width: scan.progress || '40%' }} />
                </div>
                <StatusMini scan={scan} />
              </div>
            )}
            {isFailed && (
              <div>
                <FailedErrorPreview error={latestError} expanded={errorExpanded} onToggle={onToggleError} />
                <div onClick={(event) => event.stopPropagation()}>
                  <StatusMini scan={scan} />
                </div>
              </div>
            )}
            {isRateLimited && (
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-2)' }}>
                <div style={{ color: 'var(--pend)', fontWeight: 500 }}>
                  {rateLimit.accountRelated ? (
                    <Link to="/accounts" onClick={(event) => event.stopPropagation()} style={{ color: 'inherit' }}>
                      {rateLimit.label}.
                    </Link>
                  ) : (
                    `${rateLimit.label}.`
                  )}
                </div>
                <div style={{ marginTop: 2 }}>{rateLimit.message}</div>
                {rateLimit.accountRelated && (
                  <Link
                    to="/accounts"
                    onClick={(event) => event.stopPropagation()}
                    style={{ display: 'inline-block', marginTop: 4, color: 'var(--accent-strong)' }}
                  >
                    View usage and provider limits in Accounts
                  </Link>
                )}
                <div className="mono" style={{ marginTop: 4, fontSize: 'var(--text-xs)' }}>
                  {rateLimitRetryText(scan.reasoning)}
                </div>
                <StatusMini scan={scan} />
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function ScanActionsMenu({ scan, onDelete, busy }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  const triggerRef = useRef(null);
  const canDelete = isScanDeletable(scan.status);

  useEffect(() => {
    if (!open) return undefined;

    const closeOutside = (event) => {
      if (!containerRef.current?.contains(event.target)) setOpen(false);
    };
    const closeWithEscape = (event) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('focusin', closeOutside);
    document.addEventListener('keydown', closeWithEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('focusin', closeOutside);
      document.removeEventListener('keydown', closeWithEscape);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="row-menu">
      <button
        ref={triggerRef}
        type="button"
        className="btn btn--icon"
        aria-label={`Actions for scan #${scan.id}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Scan actions"
        onClick={() => setOpen((current) => !current)}
      >
        <MoreHorizontal size={15} strokeWidth={1.75} />
      </button>
      {open && (
        <div role="menu" aria-label={`Scan #${scan.id} actions`} className="menu-pop">
          <ScanMenuItem
            to={duplicateScanPath(scan.id)}
            onClick={() => {
              setOpen(false);
            }}
          >
            Duplicate scan
          </ScanMenuItem>
          <ScanMenuItem
            danger
            disabled={!canDelete || busy}
            title={!canDelete ? 'Stop this scan and wait for active work to finish before deleting it.' : undefined}
            onClick={(event) => {
              setOpen(false);
              onDelete(event);
            }}
          >
            Delete scan
          </ScanMenuItem>
        </div>
      )}
    </div>
  );
}

function ScanMenuItem({ children, danger = false, disabled = false, onClick, title, to }) {
  const className = danger ? 'menu-item menu-item--danger' : 'menu-item';
  if (to) {
    return (
      <Link to={to} role="menuitem" title={title} onClick={onClick} className={className}>
        {children}
      </Link>
    );
  }
  return (
    <button type="button" role="menuitem" disabled={disabled} title={title} onClick={onClick} className={className}>
      {children}
    </button>
  );
}

function FailedErrorPreview({ error, expanded, onToggle }) {
  const message = error?.message;
  if (!message) return null;
  const knownError = error?.knownError;
  return (
    <div className="scan-error" onClick={(event) => event.stopPropagation()}>
      <div className="scan-error-head">
        <span style={{ color: 'var(--fail)', fontSize: 'var(--text-xs)', fontWeight: 500 }}>Latest error</span>
        <button type="button" className="btn btn--sm" onClick={onToggle}>
          {expanded ? 'Hide' : 'Show'}
        </button>
      </div>
      {knownError && <KnownErrorBadge knownError={knownError} />}
      <div
        className="mono"
        style={{
          color: 'var(--text-2)',
          fontSize: 'var(--text-xs)',
          lineHeight: 1.5,
          overflowWrap: 'anywhere',
          whiteSpace: 'pre-wrap',
          ...(expanded
            ? { maxHeight: 170, overflowY: 'auto', paddingRight: 4 }
            : { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }),
        }}
      >
        <LinkifiedText text={message} />
      </div>
      <ErrorFixLinks knownError={knownError} />
    </div>
  );
}

function KnownErrorBadge({ knownError }) {
  if (!knownError?.title) return null;
  return (
    <span className="chip" style={{ marginBottom: 6, borderColor: 'var(--fail)', color: 'var(--fail)' }}>
      {knownError.title}
    </span>
  );
}

function ErrorFixLinks({ knownError }) {
  const links = knownError?.fixLinks || [];
  if (!links.length) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 7, fontSize: 'var(--text-xs)' }}>
      {links.map((link) =>
        link.internal || link.url?.startsWith('/') ? (
          <Link key={`${link.label}-${link.url}`} to={link.url} style={{ color: 'var(--accent-strong)' }}>
            {link.label || link.url}
          </Link>
        ) : (
          <a
            key={`${link.label}-${link.url}`}
            href={link.url}
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--accent-strong)' }}
          >
            {link.label || link.url}
          </a>
        )
      )}
    </div>
  );
}

function StatusMini({ scan }) {
  const summary = scan.statusSummary || {};
  const active = summary.activeJobs || [];
  const currentFailedAttempts = summary.currentFailedAttempts ?? summary.failedAttempts ?? 0;
  const rateLimited = scan.status === 'rate_limited';
  const first = active[0];
  const completedLineages = summary.completedStepLineages ?? summary.stepCompletedAttempts ?? 0;
  const expectedLineages = summary.expectedStepLineages ?? summary.stepAttempts ?? 0;
  if (!summary.totalAttempts && !active.length && !summary.latestError) return null;
  return (
    <div className="status-meta">
      {first && (
        <span style={{ color: 'var(--run)' }}>
          {first.phaseLabel}: {first.title}
        </span>
      )}
      {expectedLineages > 0 && (
        <span>
          {completedLineages}/{expectedLineages} workflow lineages
        </span>
      )}
      {summary.totalAttempts > 0 && <span>{summary.totalAttempts} attempts</span>}
      {currentFailedAttempts > 0 && (
        <span style={{ color: rateLimited ? 'var(--pend)' : 'var(--fail)' }}>
          {currentFailedAttempts} {rateLimited ? 'attempt errors' : 'failed'}
        </span>
      )}
      {summary.postRunningAttempts > 0 && <span>{summary.postRunningAttempts} post running</span>}
    </div>
  );
}
