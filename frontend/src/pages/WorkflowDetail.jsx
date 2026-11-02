import { Fragment, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client.js';
import { useFetch } from '../lib/useFetch.js';
import { usePageChrome } from '../context/ui.jsx';
import { Button, ErrorState, SectionLabel, Spinner } from '../components/ui.jsx';
import { Figure, FigureStrip, Page, PageHeader } from '../components/app.jsx';
import { PromptHighlight } from '../components/PromptEditor.jsx';
import Drawer from '../components/Drawer.jsx';
import { availableKeysForDepth, groupByDepth, workflowDeleteState } from '../lib/workflow.js';
import { parseTemplateRefs, refResolves, REQUIRED_VULN_KEYS } from '../lib/keys.js';
import { downloadWorkflowExport } from '../lib/workflowTransfer.js';

const promptExcerpt = (content) => `${content.replace(/\{\{\s*|\s*\}\}/g, '').slice(0, 90)}…`;

export default function WorkflowDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [selStepId, setSelStepId] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState(null);
  const { data: wf, loading, error, reload } = useFetch(() => api.workflow(id), [id]);

  usePageChrome(
    [
      { label: 'Workflows', to: '/workflows' },
      { label: wf?.name || '…', active: true },
    ],
    { label: '+ New workflow', to: '/workflows?new=1' },
    [wf?.name]
  );

  if (loading)
    return (
      <Page>
        <Spinner />
      </Page>
    );
  if (error)
    return (
      <Page>
        <ErrorState error={error} onRetry={reload} />
      </Page>
    );
  if (!wf) return null;

  const levels = groupByDepth(wf.steps);
  const sel = wf.steps.find((s) => s.id === selStepId);
  const deleteState = workflowDeleteState(wf);
  const stepLabel = (step) => step.name || 'Untitled step';
  const boundSourceLabel = (step) =>
    wf.steps.find((candidate) => candidate.id === step.boundSourceStepId)?.name || `step ${step.boundSourceStepId}`;
  const editWorkflowPath = (stepId) => {
    const stepQuery = stepId ? `?step=${encodeURIComponent(stepId)}` : '';
    return `/workflows/${wf.id}/edit${stepQuery}`;
  };
  const deleteWorkflow = async () => {
    if (!deleteState.canDelete || deleting) return;
    const confirmed = window.confirm(
      `Permanently delete workflow "${wf.name}" and its configured steps? This cannot be undone.`
    );
    if (!confirmed) return;

    setDeleting(true);
    setActionError(null);
    try {
      await api.deleteWorkflow(wf.id);
      navigate('/workflows', { replace: true });
    } catch (deleteError) {
      setActionError(deleteError);
      setDeleting(false);
      if (deleteError instanceof ApiError && deleteError.status === 409) reload();
    }
  };

  return (
    <div style={{ position: 'relative', height: '100%', minHeight: 0, overflow: 'hidden' }}>
      <div style={{ height: '100%', overflowY: 'auto' }}>
        <Page>
          <PageHeader
            title={wf.name}
            meta={
              <>
                {wf.description && <div>{wf.description}</div>}
                <div className="chip-row" style={{ marginTop: wf.description ? 'var(--space-3)' : 0 }}>
                  {wf.depthChips.map((chip) => (
                    <span key={chip.depth} className="chip">
                      {chip.label}
                    </span>
                  ))}
                  {wf.extra.length > 0 && (
                    <span className="chip chip--accent">expects extra: {wf.extra.join(', ')}</span>
                  )}
                </div>
              </>
            }
            actions={
              <>
                <Button variant="ghost" to={`/scans/new?workflow=${wf.id}`} disabled={deleting}>
                  Run scan
                </Button>
                <Button variant="ghost" disabled={deleting} onClick={() => downloadWorkflowExport(wf)}>
                  Export JSON
                </Button>
                <Button variant="subtle" to={editWorkflowPath()} disabled={deleting}>
                  Edit
                </Button>
                {!wf.isDefault && (
                  <Button
                    variant="danger"
                    disabled={!deleteState.canDelete || deleting}
                    title={deleteState.canDelete ? 'Delete unused workflow' : deleteState.reason}
                    aria-describedby={!deleteState.canDelete ? 'workflow-delete-reason' : undefined}
                    onClick={deleteWorkflow}
                  >
                    {deleting ? 'Deleting…' : 'Delete'}
                  </Button>
                )}
              </>
            }
          />

          {!wf.isDefault && !deleteState.canDelete && (
            <div
              id="workflow-delete-reason"
              className="field-note"
              style={{ textAlign: 'right', marginBottom: 'var(--space-5)' }}
            >
              {deleteState.reason}
            </div>
          )}

          {actionError && (
            <div role="alert" style={{ marginBottom: 'var(--space-5)' }}>
              <ErrorState error={actionError} />
            </div>
          )}

          <div style={{ marginBottom: 'var(--space-6)' }}>
            <FigureStrip>
              <Figure label="Steps" value={wf.stepCount} />
              <Figure label="Depth levels" value={wf.depths.length} />
              <Figure label="Scans run" value={wf.scanCount} />
            </FigureStrip>
          </div>

          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Step</th>
                  <th>Prompt</th>
                  <th>Output keys</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {levels.map((level) => (
                  <Fragment key={level.depth}>
                    <tr>
                      <td
                        colSpan={4}
                        style={{
                          height: 34,
                          padding: '0 12px',
                          background: 'var(--surface-2)',
                          borderBottom: '1px solid var(--border-2)',
                        }}
                      >
                        <div className="chip-row" style={{ alignItems: 'center' }}>
                          <span className="chip">Depth {level.depth}</span>
                          {level.steps.length > 1 && (
                            <span className="chip" title="Siblings share one output schema">
                              {level.steps.length} siblings (shared schema)
                            </span>
                          )}
                          {level.consumesAll && (
                            <span
                              className="chip"
                              style={{
                                color: 'var(--run)',
                                background: 'var(--run-bg)',
                                borderColor: 'transparent',
                              }}
                              title={`Batched: one agent receives {{multi_output_depth_${level.depth - 1}}}`}
                            >
                              batched
                            </span>
                          )}
                          {level.bindPrevious && (
                            <span
                              className="chip"
                              style={{
                                color: 'var(--accent-strong)',
                                background: 'var(--accent-subtle)',
                                borderColor: 'transparent',
                              }}
                              title={`Bound: each depth-${level.depth - 1} sibling routes only to its selected depth-${level.depth} sibling`}
                            >
                              bound 1:1
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                    {level.steps.map((step) => (
                      <tr key={step.id}>
                        <td style={{ minWidth: 240 }}>
                          <button
                            type="button"
                            className="cell-main"
                            style={{ textAlign: 'left' }}
                            onClick={() => setSelStepId(step.id)}
                          >
                            {stepLabel(step)}
                          </button>
                          {step.multiOutput && (
                            <span className="cell-sub" title="Fan-out: one agent per result">
                              multi-output
                            </span>
                          )}
                          {step.boundSourceStepId && (
                            <span className="cell-sub">input only from {boundSourceLabel(step)}</span>
                          )}
                        </td>
                        <td>
                          <span
                            style={{
                              display: 'block',
                              maxWidth: '56ch',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              color: 'var(--text-2)',
                              fontSize: 'var(--text-xs)',
                            }}
                          >
                            {promptExcerpt(step.content)}
                          </span>
                        </td>
                        <td>
                          <span className="mono" style={{ color: 'var(--text-2)', fontSize: 'var(--text-2xs)' }}>
                            {Object.keys(step.outputFormat).join(', ')}
                          </span>
                        </td>
                        <td>
                          <div className="cell-actions">
                            <Button
                              variant="ghost"
                              aria-label={`View ${stepLabel(step)}`}
                              onClick={() => setSelStepId(step.id)}
                            >
                              View
                            </Button>
                            <Button
                              variant="ghost"
                              aria-label={`Edit ${stepLabel(step)}`}
                              to={editWorkflowPath(step.id)}
                            >
                              Edit
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </Page>
      </div>

      <Drawer open={!!sel} onClose={() => setSelStepId(null)} width={560}>
        {sel && (
          <StepPanel step={sel} steps={wf.steps} editTo={editWorkflowPath(sel.id)} onClose={() => setSelStepId(null)} />
        )}
      </Drawer>
    </div>
  );
}

export function StepPanel({ step, steps, editTo, onClose }) {
  const available = availableKeysForDepth(steps, step.depth);
  const parsedRefs = parseTemplateRefs(step.content);
  const refs = [...new Set(parsedRefs.refs)];
  const malformedRefs = [...new Set(parsedRefs.malformed)];
  const bad = malformedRefs.length + refs.filter((k) => !refResolves(k, available, true)).length;
  const boundSource = step.boundSourceStepId
    ? steps.find((candidate) => candidate.id === step.boundSourceStepId)
    : null;

  return (
    <>
      <div
        style={{
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--space-4)',
          padding: 'var(--space-4) var(--space-5)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div className="field-note">Depth {step.depth}</div>
          <div
            style={{
              fontSize: 'var(--text-md)',
              fontWeight: 600,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {step.name || 'Untitled step'}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flex: 'none' }}>
          <Button variant="subtle" to={editTo}>
            Edit step
          </Button>
          <button
            type="button"
            className="btn btn--icon"
            onClick={onClose}
            aria-label="Close step details"
            title="Close step details"
            style={{ fontSize: 'var(--text-md)' }}
          >
            ×
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-5)' }}>
        <dl
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gap: 'var(--space-4) var(--space-6)',
            margin: '0 0 var(--space-6)',
          }}
        >
          {[
            {
              label: 'multi_output:',
              value: String(step.multiOutput),
              tone: step.multiOutput ? 'var(--accent-strong)' : 'var(--text-2)',
            },
            {
              label: 'consumes_all:',
              value: String(!!step.consumesAll),
              tone: step.consumesAll ? 'var(--run)' : 'var(--text-2)',
            },
            {
              label: 'bound_source_step_id:',
              value: step.boundSourceStepId || 'null',
              tone: step.boundSourceStepId ? 'var(--accent-strong)' : 'var(--text-2)',
            },
            { label: 'output_table:', value: step.outputTable, tone: 'var(--text)' },
          ].map((row) => (
            <div key={row.label} style={{ minWidth: 0 }}>
              <dt className="field-note mono" style={{ fontSize: 'var(--text-2xs)' }}>
                {row.label}
              </dt>
              <dd
                className="mono"
                style={{
                  margin: 'var(--space-1) 0 0',
                  color: row.tone,
                  fontSize: 'var(--text-xs)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {row.value}
              </dd>
            </div>
          ))}
        </dl>

        {step.consumesAll && step.depth > 0 && (
          <div
            style={{
              marginBottom: 'var(--space-5)',
              padding: 'var(--space-4) var(--space-5)',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--run-bg)',
              color: 'var(--run)',
              fontSize: 'var(--text-xs)',
              lineHeight: 'var(--leading-prose)',
            }}
          >
            Batched input: one agent runs this depth over the full array of depth {step.depth - 1} outputs, available as{' '}
            <span className="mono">{`{{multi_output_depth_${step.depth - 1}}}`}</span>. Individual depth-
            {step.depth - 1} keys are not available here or downstream.
          </div>
        )}

        {boundSource && (
          <div
            style={{
              marginBottom: 'var(--space-5)',
              padding: 'var(--space-4) var(--space-5)',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--accent-subtle)',
              color: 'var(--accent-strong)',
              fontSize: 'var(--text-xs)',
              lineHeight: 'var(--leading-prose)',
            }}
          >
            Bound input - this step receives results only from{' '}
            <span className="mono">{boundSource.name || `step ${boundSource.id}`}</span> at depth {step.depth - 1}.
          </div>
        )}

        <SectionLabel style={{ marginBottom: 'var(--space-3)' }}>Prompt content</SectionLabel>
        <PromptHighlight content={step.content} available={available} allowExtra />

        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: 'var(--space-4)',
            margin: 'var(--space-6) 0 var(--space-3)',
          }}
        >
          <SectionLabel>Referenced keys</SectionLabel>
          <span className="field-note" style={{ color: bad ? 'var(--fail)' : 'var(--ok)' }}>
            {bad ? `${bad} invalid` : 'All references resolve'}
          </span>
        </div>
        <div className="chip-row">
          {refs.map((k) => {
            const ok = refResolves(k, available, true);
            return (
              <span
                key={k}
                className="chip chip--code"
                style={{
                  color: ok ? 'var(--ok)' : 'var(--fail)',
                  background: ok ? 'var(--ok-bg)' : 'var(--fail-bg)',
                  borderColor: 'transparent',
                }}
              >
                {k}
                {!ok && <span style={{ color: 'var(--fail)' }}>invalid</span>}
              </span>
            );
          })}
          {malformedRefs.map((token, index) => (
            <span
              key={`${token}-${index}`}
              className="chip chip--code"
              style={{ color: 'var(--fail)', background: 'var(--fail-bg)', borderColor: 'transparent' }}
            >
              {token}
              <span>invalid</span>
            </span>
          ))}
          {refs.length === 0 && malformedRefs.length === 0 && <span className="field-note">No references.</span>}
        </div>

        <SectionLabel style={{ margin: 'var(--space-6) 0 var(--space-3)' }}>Output format (JSON schema)</SectionLabel>
        <div style={{ borderTop: '1px solid var(--border-2)' }}>
          {Object.entries(step.outputFormat).map(([key, type]) => (
            <div
              key={key}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 'var(--space-4)',
                padding: 'var(--space-3) 0',
                borderBottom: '1px solid var(--border-2)',
                fontSize: 'var(--text-xs)',
              }}
            >
              <span className="mono" style={{ color: 'var(--accent-strong)' }}>
                {key}
              </span>
              <span className="field-note mono">{type}</span>
            </div>
          ))}
        </div>
        {step.isLast && (
          <div
            style={{
              marginTop: 'var(--space-5)',
              padding: 'var(--space-4) var(--space-5)',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--ok-bg)',
              color: 'var(--ok)',
              fontSize: 'var(--text-xs)',
              lineHeight: 'var(--leading-prose)',
            }}
          >
            Terminal step: emits all {REQUIRED_VULN_KEYS.length} required vulnerability keys to
            workflows.vulnerabilities.
          </div>
        )}

        <SectionLabel style={{ margin: 'var(--space-6) 0 0' }}>Available keys here</SectionLabel>
        <div style={{ borderTop: '1px solid var(--border-2)', marginTop: 'var(--space-3)' }}>
          {[...available.entries()].map(([name, from]) => (
            <div
              key={name}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 'var(--space-4)',
                padding: 'var(--space-3) 0',
                borderBottom: '1px solid var(--border-2)',
              }}
            >
              <span className="mono" style={{ fontSize: 'var(--text-xs)' }}>
                {name}
              </span>
              <span className="field-note">{from}</span>
            </div>
          ))}
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 'var(--space-4)',
              padding: 'var(--space-3) 0',
              borderBottom: '1px solid var(--border-2)',
            }}
          >
            <span className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-strong)' }}>
              extra.&lt;key&gt;
            </span>
            <span className="field-note">dynamic</span>
          </div>
        </div>
      </div>
    </>
  );
}
