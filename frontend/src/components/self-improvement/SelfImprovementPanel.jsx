import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useFetch } from '../../lib/useFetch.js';
import { saveBrowserDownload } from '../../lib/download.js';
import { Button } from '../ui.jsx';
import LoopSetup from './LoopSetup.jsx';
import LoopProgress from './LoopProgress.jsx';
import './self-improvement.css';

export default function SelfImprovementPanel({ scan, references }) {
  const inheritedLoop = scan.configuration?.self_improvement_lineage?.loop_id;
  const { data, loading, error, reload, setData } = useFetch(
    () => (inheritedLoop ? api.selfImprovementLoop(inheritedLoop) : api.selfImprovementForScan(scan.id)),
    [scan.id, inheritedLoop],
    { pollMs: 5000 }
  );
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [setup, setSetup] = useState(false);
  const loop = data?.loop;
  const act = async (operation) => {
    setBusy(true);
    setActionError(null);
    try {
      setData(await operation());
    } catch (failure) {
      setActionError(failure);
    } finally {
      setBusy(false);
    }
  };
  const exportAudit = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const audit = await api.selfImprovementAudit(loop.id);
      saveBrowserDownload({
        blob: new Blob([JSON.stringify(audit, null, 2)], { type: 'application/json' }),
        filename: `self-improvement-${loop.id}.json`,
      });
    } catch (failure) {
      setActionError(failure);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="sil-panel" aria-labelledby="sil-title" aria-busy={busy}>
      <h2 id="sil-title">Self-improvement</h2>
      {loading && !data && <p role="status">Loading loop status…</p>}
      {error && (
        <div role="alert" className="sil-error">
          <p>{error.message}</p>
          <Button variant="ghost" onClick={reload}>
            Retry connection
          </Button>
        </div>
      )}
      {actionError && (
        <p className="sil-error" role="alert">
          {actionError.message}
        </p>
      )}
      {inheritedLoop && loop && (
        <p>
          This rerun belongs to the loop on <Link to={`/scans/${loop.root_scan_id}`}>scan #{loop.root_scan_id}</Link>.
        </p>
      )}
      {loop ? (
        <LoopProgress
          loop={loop}
          busy={busy}
          onApprove={(body) => act(() => api.approveSelfImprovement(loop.id, body))}
          onReview={(scanId, feedback) => act(() => api.reviewSelfImprovement(loop.id, scanId, feedback))}
          onCancel={(reason) => act(() => api.cancelSelfImprovement(loop.id, reason))}
          onRecover={(remoteId) => act(() => api.recoverSelfImprovement(loop.id, remoteId))}
          onExport={exportAudit}
        />
      ) : (
        !loading &&
        !error &&
        (setup ? (
          <LoopSetup
            scan={scan}
            references={references}
            busy={busy}
            onEnable={(config) => act(() => api.enableSelfImprovement(scan.id, config))}
          />
        ) : (
          <>
            <p>Improve this workflow using completed scan evidence, with approval before every rerun.</p>
            <Button onClick={() => setSetup(true)} disabled={['failed', 'stopped'].includes(scan.status)}>
              Configure improvement loop
            </Button>
          </>
        ))
      )}
    </section>
  );
}
