import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../ui.jsx';
import ReviewForm from './ReviewForm.jsx';

const CLOSED = new Set(['completed', 'failed', 'cancelled']);
const LABELS = {
  waiting_scan: 'Waiting for completed scan',
  waiting_generation: 'Analyzing workflow',
  awaiting_approval: 'Human approval required',
  approved: 'Approved, preparing workflow',
  workflow_ready: 'Queueing approved rerun',
  waiting_candidate: 'Rerun in progress',
  awaiting_evaluation: 'Review both scans to compare results',
  submission_unknown: 'Creation outcome unknown, reconciliation required',
  completed: 'Loop completed',
  failed: 'Loop stopped with an error',
  cancelled: 'Loop cancelled',
};

export default function LoopProgress({ loop, busy, onApprove, onReview, onCancel, onRecover, onExport }) {
  const [reviewer, setReviewer] = useState('');
  const [reviewedDigest, setReviewedDigest] = useState(null);
  const [reason, setReason] = useState('');
  const [remoteId, setRemoteId] = useState('');
  const closed = CLOSED.has(loop.state);
  const latest = loop.runs.at(-1);
  return (
    <div>
      <p role="status" style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2) var(--space-5)' }}>
        <strong>{LABELS[loop.state] || loop.state}</strong>
        <span>
          Iteration {loop.iterations}/{loop.config.max_loops}
        </span>
      </p>
      {latest?.no_change_reason && <p role="status">{latest.no_change_reason}</p>}
      {loop.error && (
        <p className="sil-error" role="alert">
          {loop.error}
        </p>
      )}
      {loop.read_retry && (
        <p className="sil-muted" role="status">
          Backend read temporarily unavailable. Retrying automatically without creating another job.{' '}
          {loop.read_retry.error}
        </p>
      )}
      {loop.proposal_validation_errors?.length > 0 && (
        <div className="sil-error" role="alert">
          <strong>Workflow input handoff is invalid. This version cannot be approved or promoted.</strong>
          <ul>
            {loop.proposal_validation_errors.map((issue, index) => (
              <li key={index}>{issue.message}</li>
            ))}
          </ul>
        </div>
      )}
      <p style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2) var(--space-5)' }}>
        <span>
          Best workflow: <Link to={`/workflows/${loop.best_workflow_id}`}>#{loop.best_workflow_id}</Link>
        </span>
        <span>
          Best scan: <Link to={`/scans/${loop.best_scan_id}`}>#{loop.best_scan_id}</Link>
        </span>
        {latest?.scan_id && (
          <span>
            Candidate: <Link to={`/scans/${latest.scan_id}`}>#{latest.scan_id}</Link>
          </span>
        )}
      </p>
      {!closed && (
        <label className="field" htmlFor="sil-reviewer">
          Human reviewer
          <input
            id="sil-reviewer"
            className="input"
            value={reviewer}
            onChange={(event) => setReviewer(event.target.value)}
            placeholder="Your name"
            disabled={busy}
          />
        </label>
      )}
      {loop.proposal && (
        <details className="sil-review" open={loop.state === 'awaiting_approval'}>
          <summary>Proposed workflow and target settings</summary>
          <p>{loop.proposal.description}</p>
          <h3>Workflow changes</h3>
          <pre className="sil-code" tabIndex={0}>
            {loop.diff}
          </pre>
          <h3>Rerun target and settings</h3>
          <pre className="sil-code" tabIndex={0}>
            {JSON.stringify(loop.scan_request, null, 2)}
          </pre>
          {loop.state === 'awaiting_approval' && (
            <>
              <label className="sil-checkbox">
                <input
                  className="checkbox"
                  type="checkbox"
                  checked={reviewedDigest === loop.approval_digest}
                  onChange={(event) => setReviewedDigest(event.target.checked ? loop.approval_digest : null)}
                  disabled={busy}
                />
                I reviewed this workflow diff and target settings, and approve this rerun.
              </label>
              <Button
                disabled={
                  busy ||
                  loop.proposal_validation_errors?.length > 0 ||
                  !reviewer.trim() ||
                  reviewedDigest !== loop.approval_digest
                }
                onClick={() => onApprove({ reviewer, digest: loop.approval_digest, reviewed: true })}
              >
                Approve this version and queue rerun
              </Button>
            </>
          )}
        </details>
      )}
      {loop.reviews.map((snapshot) => (
        <ReviewForm
          key={`${snapshot.scan_id}-${Boolean(snapshot.feedback)}`}
          snapshot={snapshot}
          reviewer={reviewer}
          busy={busy}
          disabled={closed}
          onSave={(feedback) => onReview(snapshot.scan_id, feedback)}
        />
      ))}
      {loop.runs.filter((run) => run.evaluation || run.failure).length > 0 && (
        <>
          <h3>Comparison history</h3>
          <div className="sil-table-wrap">
            <table className="sil-table">
              <thead>
                <tr>
                  <th>Iteration</th>
                  <th>Baseline</th>
                  <th>Candidate</th>
                  <th>Delta</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {loop.runs
                  .filter((run) => run.evaluation || run.failure)
                  .map((run) => (
                    <tr key={run.iteration}>
                      <td>{run.iteration}</td>
                      <td>{run.evaluation?.baseline[loop.config.metric] ?? 'n/a'}</td>
                      <td>{run.evaluation?.candidate[loop.config.metric] ?? 'n/a'}</td>
                      <td>{run.evaluation?.delta ?? 'n/a'}</td>
                      <td>
                        {run.evaluation
                          ? run.evaluation.better
                            ? 'Kept improved version'
                            : run.evaluation.reasons.join('; ')
                          : run.failure?.kind === 'invalid_handoff'
                            ? 'Invalid input handoff; rejected and returned to the model'
                            : 'Run failed; previous best kept'}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {loop.state === 'submission_unknown' && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onRecover(remoteId);
          }}
        >
          <p>
            Inspect the backend for the existing {loop.pending?.kind} record. Enter its ID to reconcile without creating
            another job.
          </p>
          <label className="field" htmlFor="sil-remote">
            Existing record ID
            <input
              id="sil-remote"
              className="input"
              value={remoteId}
              onChange={(event) => setRemoteId(event.target.value)}
              required
              pattern="[1-9][0-9]*"
            />
          </label>
          <Button type="submit" disabled={busy || !/^[1-9][0-9]*$/.test(remoteId)}>
            Reconcile existing record
          </Button>
        </form>
      )}
      <div className="sil-actions">
        <Button variant="ghost" onClick={onExport} disabled={busy}>
          Download complete audit JSON
        </Button>
      </div>
      {!closed && (
        <details className="sil-review">
          <summary>Cancel loop</summary>
          <p>Queued or running scans continue; manage them through the scan controls.</p>
          <label className="field" htmlFor="sil-reason">
            Reason
            <input
              id="sil-reason"
              className="input"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <Button variant="danger" disabled={busy || !reason.trim()} onClick={() => onCancel(reason)}>
            Cancel loop
          </Button>
        </details>
      )}
    </div>
  );
}
