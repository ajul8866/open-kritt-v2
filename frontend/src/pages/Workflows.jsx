import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, apiErrorMessages } from '../api/client.js';
import { useFetch } from '../lib/useFetch.js';
import { usePageChrome } from '../context/ui.jsx';
import { Spinner, ErrorState, EmptyState, Button } from '../components/ui.jsx';
import { Page, PageHeader } from '../components/app.jsx';
import { useModalDialog } from '../lib/useModalDialog.js';
import { useNewestFirst, usePagination } from '../lib/usePagination.js';
import { downloadWorkflowExport, parseWorkflowImport, WORKFLOW_IMPORT_MAX_BYTES } from '../lib/workflowTransfer.js';
import { workflowDeleteState } from '../lib/workflow.js';
import Pagination from '../components/Pagination.jsx';

export default function Workflows() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const newDialogParam = params.get('new');
  const [dialogOpen, setDialogOpen] = useState(newDialogParam === '1');
  const closeDialog = () => {
    setDialogOpen(false);
    if (params.has('new')) setParams({}, { replace: true });
  };
  useEffect(() => {
    setDialogOpen(newDialogParam === '1');
  }, [newDialogParam]);
  usePageChrome([{ label: 'Workflows', active: true }], { label: '+ New workflow', to: '/workflows?new=1' }, []);
  const { data, loading, error, reload, setData } = useFetch(() => api.workflows(), []);
  const workflows = useNewestFirst(data);
  const workflowPages = usePagination(workflows, { pageSize: 6 });
  const importInputRef = useRef(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const [busyWorkflowId, setBusyWorkflowId] = useState(null);
  const [actionError, setActionError] = useState(null);

  const chooseWorkflowFile = () => {
    setImportError('');
    importInputRef.current?.click();
  };
  const importWorkflow = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setImporting(true);
    setImportError('');
    try {
      if (file.size > WORKFLOW_IMPORT_MAX_BYTES) {
        throw new Error('Workflow JSON files must be 2 MB or smaller.');
      }
      const payload = parseWorkflowImport(await file.text());
      const imported = await api.createWorkflow(payload);
      navigate(`/workflows/${imported.id}`);
    } catch (importFailure) {
      const messages =
        importFailure instanceof ApiError
          ? apiErrorMessages(importFailure)
          : [importFailure?.message || 'The workflow could not be imported.'];
      setImportError(messages.join(' '));
    } finally {
      setImporting(false);
    }
  };
  const deleteWorkflow = async (event, workflow) => {
    event.preventDefault();
    event.stopPropagation();
    if (!workflowDeleteState(workflow).canDelete || busyWorkflowId !== null) return;

    const confirmed = window.confirm(
      `Permanently delete workflow "${workflow.name}" and its configured steps? This cannot be undone.`
    );
    if (!confirmed) return;

    setBusyWorkflowId(workflow.id);
    setActionError(null);
    try {
      await api.deleteWorkflow(workflow.id);
      setData((current) => (current || []).filter((item) => item.id !== workflow.id));
    } catch (deleteError) {
      setActionError(deleteError);
      if (deleteError instanceof ApiError && deleteError.status === 409) reload();
    } finally {
      setBusyWorkflowId(null);
    }
  };

  return (
    <Page>
      <PageHeader
        title="Workflows"
        meta="Reusable scan blueprints, chains of AI analysis steps."
        actions={
          <Button variant="ghost" disabled={importing} onClick={chooseWorkflowFile}>
            {importing ? 'Importing…' : 'Import JSON'}
          </Button>
        }
      />
      <input
        ref={importInputRef}
        type="file"
        accept=".json,application/json"
        aria-label="Import workflow JSON"
        onChange={importWorkflow}
        style={{ display: 'none' }}
      />

      {importError && (
        <div role="alert" style={{ marginBottom: 18 }}>
          <ErrorState error={{ message: importError }} />
        </div>
      )}

      {dialogOpen && (
        <NewWorkflowDialog
          workflows={workflows}
          onClose={closeDialog}
          onImport={chooseWorkflowFile}
          importing={importing}
          importError={importError}
        />
      )}

      {loading && <Spinner />}
      {error && <ErrorState error={error} onRetry={reload} />}
      {actionError && (
        <div role="alert" style={{ marginBottom: 18 }}>
          <ErrorState error={actionError} />
        </div>
      )}
      {data && data.length === 0 && (
        <EmptyState
          title="No workflows yet"
          sub="Workflows are the blueprints the engine runs. Create your first one to start scanning."
          action={<Button to="/workflows?new=1">+ New workflow</Button>}
        />
      )}
      {data && data.length > 0 && (
        <>
          <div className="table-wrap">
            <table className="data-table workflow-table">
              <thead>
                <tr>
                  <th>Workflow</th>
                  <th>Depth</th>
                  <th className="cell-num">Scans</th>
                  <th>Last used</th>
                  <th className="cell-num">Steps</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {workflowPages.pageItems.map((w) => (
                  <WorkflowCard
                    key={w.id}
                    workflow={w}
                    busy={busyWorkflowId !== null}
                    deleting={busyWorkflowId === w.id}
                    onDelete={deleteWorkflow}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 'var(--space-4)' }}>
            <Pagination {...workflowPages} itemLabel="workflows" />
          </div>
        </>
      )}
    </Page>
  );
}

export function WorkflowCard({ workflow: w, busy, deleting, onDelete }) {
  const deleteState = workflowDeleteState(w);

  return (
    <tr>
      <td style={{ minWidth: 260 }}>
        <Link className="cell-main" to={`/workflows/${w.id}`}>
          {w.name}
        </Link>
        {w.description && (
          <span className="cell-sub" title={w.description}>
            {w.description.length > 96 ? `${w.description.slice(0, 93).trimEnd()}...` : w.description}
          </span>
        )}
      </td>
      <td>
        <div className="chip-row">
          {w.depthChips.map((d) => (
            <span key={d.label} className="chip">
              {d.label}
            </span>
          ))}
        </div>
      </td>
      <td className="cell-num">{w.scanCount}</td>
      <td className="cell-muted" style={{ whiteSpace: 'nowrap' }}>
        {w.lastUsed || 'never'}
      </td>
      <td className="cell-num">{w.stepCount}</td>
      <td>
        <div className="cell-actions">
          <Button
            variant="ghost"
            aria-label={`Export ${w.name}`}
            title="Export workflow as JSON"
            disabled={deleting}
            onClick={(event) => {
              event.stopPropagation();
              downloadWorkflowExport(w);
            }}
          >
            Export
          </Button>
          {deleteState.canDelete && (
            <Button
              variant="danger"
              aria-label={`Delete ${w.name}`}
              title="Delete unused workflow"
              disabled={busy}
              onClick={(event) => onDelete(event, w)}
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}

function NewWorkflowDialog({ workflows, onClose, onImport, importing, importError }) {
  const [mode, setMode] = useState(null); // null | 'duplicate'
  const [sel, setSel] = useState(workflows[0]?.id || '');
  const hasWorkflows = workflows.length > 0;
  const dialogRef = useModalDialog(onClose);
  const duplicatePages = usePagination(workflows, { pageSize: 6, resetKey: mode });

  return (
    <div className="dialog-wrap" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-workflow-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="dialog"
        style={{ width: 460 }}
      >
        <div className="dialog-head">
          <h2 className="dialog-title" id="new-workflow-title">
            New workflow
          </h2>
          <button type="button" className="btn btn--icon btn--sm" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="dialog-body">
          {mode !== 'duplicate' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <OptionCard
                autoFocus
                title="Generate with AI"
                sub="Describe the research process you want, then review a detailed, valid workflow draft."
                to="/workflows/generate"
              />
              <OptionCard
                title="Blank workflow"
                sub="Start from an empty blueprint and build every step yourself."
                to="/workflows/new"
              />
              <OptionCard
                title={importing ? 'Importing workflow…' : 'Import JSON file'}
                sub="Create a workflow from an open-kritt export or compatible workflow JSON."
                disabled={importing}
                onClick={onImport}
              />
              <OptionCard
                title="Duplicate an existing workflow"
                sub={
                  hasWorkflows
                    ? 'Copy another workflow’s steps as a starting point, then tweak.'
                    : 'No workflows yet to duplicate.'
                }
                disabled={!hasWorkflows}
                onClick={() => hasWorkflows && setMode('duplicate')}
              />
              {importError && (
                <div role="alert">
                  <ErrorState error={{ message: importError }} />
                </div>
              )}
            </div>
          ) : (
            <div>
              <div className="field-note" style={{ marginBottom: 'var(--space-4)' }}>
                Pick a workflow to copy. It opens as a new, unsaved draft.
              </div>
              <div
                style={{
                  maxHeight: 280,
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-2)',
                }}
              >
                {duplicatePages.pageItems.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => setSel(w.id)}
                    className={sel === w.id ? 'pick-row is-selected' : 'pick-row'}
                  >
                    <div style={{ minWidth: 0 }}>
                      <span className="cell-main">{w.name}</span>
                      {w.description && (
                        <span className="cell-sub" title={w.description}>
                          {w.description.length > 96 ? `${w.description.slice(0, 93).trimEnd()}...` : w.description}
                        </span>
                      )}
                    </div>
                    <span className="chip">{w.stepCount} steps</span>
                  </button>
                ))}
              </div>
              <Pagination
                {...duplicatePages}
                setPage={(nextPage) => {
                  duplicatePages.setPage(nextPage);
                  const nextWorkflow = workflows[(nextPage - 1) * duplicatePages.pageSize];
                  if (nextWorkflow) setSel(nextWorkflow.id);
                }}
                itemLabel="workflows"
                compact
              />
              <div className="dialog-foot" style={{ marginTop: 'var(--space-5)', paddingInline: 0, paddingBottom: 0 }}>
                <button type="button" className="btn btn--quiet" onClick={() => setMode(null)}>
                  Back
                </button>
                <Button to={sel ? `/workflows/new?from=${sel}` : undefined} disabled={!sel}>
                  Duplicate &amp; edit
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function OptionCard({ title, sub, to, onClick, disabled, autoFocus = false }) {
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
