import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../ui.jsx';

export function initialFeedback(snapshot) {
  return (
    snapshot.feedback || {
      target_fingerprint: snapshot.source_fingerprint || '',
      findings: snapshot.findings.map((finding) => ({
        id: String(finding.id),
        verdict: 'unverified',
        severity: 'informational',
        confidence: 0,
        case_key: '',
        evidence: '',
      })),
      known_misses: [],
    }
  );
}

export function reviewIsValid(feedback, reviewer) {
  return (
    Boolean(reviewer.trim()) &&
    /^(git:[a-f0-9]{40}|sha256:[a-f0-9]{64})$/.test(feedback.target_fingerprint) &&
    feedback.findings.every(
      (finding) =>
        finding.case_key.trim() &&
        finding.evidence.trim() &&
        Number.isFinite(Number(finding.confidence)) &&
        Number(finding.confidence) >= 0 &&
        Number(finding.confidence) <= 1
    ) &&
    feedback.known_misses.every((miss) => miss.case_key.trim() && miss.evidence.trim())
  );
}

export default function ReviewForm({ snapshot, reviewer, onSave, busy, disabled }) {
  const [feedback, setFeedback] = useState(() => initialFeedback(snapshot));
  const changeFinding = (id, patch) =>
    setFeedback((current) => ({
      ...current,
      findings: current.findings.map((finding) => (finding.id === id ? { ...finding, ...patch } : finding)),
    }));
  const prefix = `sil-review-${snapshot.scan_id}`;
  return (
    <details className="sil-review">
      <summary>
        Review scan #{snapshot.scan_id} · {snapshot.findings.length} findings
        {snapshot.feedback ? ' · Saved' : ' · Required for comparison'}
      </summary>
      <p>
        <Link to={`/scans/${snapshot.scan_id}`}>Open scan findings</Link>. Review every finding; use the same root-cause
        key for the same bug across versions.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSave({
            ...feedback,
            reviewer,
            findings: feedback.findings.map((finding) => ({ ...finding, confidence: Number(finding.confidence) })),
          });
        }}
      >
        <fieldset disabled={busy || disabled}>
          <label htmlFor={`${prefix}-source`}>Reviewed source fingerprint</label>
          <input
            id={`${prefix}-source`}
            value={feedback.target_fingerprint}
            onChange={(event) => setFeedback({ ...feedback, target_fingerprint: event.target.value })}
            required
          />
          <p className="sil-muted">
            Pinned Git revisions are filled automatically. Local sources need sha256: followed by the complete source
            and dependency hash.
          </p>
          {feedback.findings.map((finding) => {
            const source = snapshot.findings.find((item) => String(item.id) === finding.id);
            const fid = `${prefix}-${finding.id}`;
            return (
              <details className="sil-finding" key={finding.id}>
                <summary>
                  #{finding.id} · {source?.summary || 'Finding'} · {finding.verdict.replaceAll('_', ' ')}
                </summary>
                <div className="sil-grid">
                  <label htmlFor={`${fid}-verdict`}>
                    Verdict
                    <select
                      id={`${fid}-verdict`}
                      value={finding.verdict}
                      onChange={(event) => changeFinding(finding.id, { verdict: event.target.value })}
                    >
                      <option value="unverified">Unverified</option>
                      <option value="validated">Validated</option>
                      <option value="false_positive">False positive</option>
                    </select>
                  </label>
                  <label htmlFor={`${fid}-severity`}>
                    Reviewed severity
                    <select
                      id={`${fid}-severity`}
                      value={finding.severity}
                      onChange={(event) => changeFinding(finding.id, { severity: event.target.value })}
                    >
                      {['critical', 'high', 'medium', 'low', 'informational'].map((severity) => (
                        <option key={severity} value={severity}>
                          {severity}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label htmlFor={`${fid}-confidence`}>
                    Confidence (0–1)
                    <input
                      id={`${fid}-confidence`}
                      type="number"
                      min="0"
                      max="1"
                      step="0.01"
                      value={finding.confidence}
                      onChange={(event) => changeFinding(finding.id, { confidence: event.target.value })}
                      required
                    />
                  </label>
                  <label htmlFor={`${fid}-case`}>
                    Stable root-cause key
                    <input
                      id={`${fid}-case`}
                      value={finding.case_key}
                      onChange={(event) => changeFinding(finding.id, { case_key: event.target.value })}
                      required
                    />
                  </label>
                </div>
                <label htmlFor={`${fid}-evidence`}>
                  Evidence or reason for the verdict
                  <textarea
                    id={`${fid}-evidence`}
                    value={finding.evidence}
                    onChange={(event) => changeFinding(finding.id, { evidence: event.target.value })}
                    required
                    rows={3}
                  />
                </label>
              </details>
            );
          })}
          {feedback.findings.length === 0 && (
            <p>This scan has no findings. Save an empty review to confirm that result.</p>
          )}
          <div className="sil-actions">
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                setFeedback({ ...feedback, known_misses: [...feedback.known_misses, { case_key: '', evidence: '' }] })
              }
            >
              Add evidenced missed bug
            </Button>
          </div>
          {feedback.known_misses.map((miss, index) => (
            <div className="sil-finding" key={index}>
              <label htmlFor={`${prefix}-miss-${index}`}>
                Missed bug root-cause key
                <input
                  id={`${prefix}-miss-${index}`}
                  value={miss.case_key}
                  onChange={(event) =>
                    setFeedback({
                      ...feedback,
                      known_misses: feedback.known_misses.map((item, i) =>
                        i === index ? { ...item, case_key: event.target.value } : item
                      ),
                    })
                  }
                  required
                />
              </label>
              <label htmlFor={`${prefix}-miss-evidence-${index}`}>
                Independent evidence
                <textarea
                  id={`${prefix}-miss-evidence-${index}`}
                  value={miss.evidence}
                  onChange={(event) =>
                    setFeedback({
                      ...feedback,
                      known_misses: feedback.known_misses.map((item, i) =>
                        i === index ? { ...item, evidence: event.target.value } : item
                      ),
                    })
                  }
                  required
                  rows={3}
                />
              </label>
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  setFeedback({ ...feedback, known_misses: feedback.known_misses.filter((_, i) => i !== index) })
                }
              >
                Remove missed bug
              </Button>
            </div>
          ))}
          <Button type="submit" disabled={!reviewIsValid(feedback, reviewer)}>
            Save review for scan #{snapshot.scan_id}
          </Button>
        </fieldset>
      </form>
    </details>
  );
}
