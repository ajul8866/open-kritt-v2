import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { useFetch } from '../lib/useFetch.js';
import { usePageChrome } from '../context/ui.jsx';
import { Spinner, ErrorState, EmptyState, StatusBadge } from '../components/ui.jsx';
import { Page, PageHeader, FigureStrip, Figure } from '../components/app.jsx';

const todayLabel = () => new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

export default function Overview() {
  usePageChrome([{ label: 'Overview', active: true }], null, []);
  const { data, loading, error, reload } = useFetch(() => api.overview(), []);

  return (
    <Page>
      <PageHeader title="Overview" meta={todayLabel()} />

      {loading && <Spinner />}
      {error && <ErrorState error={error} onRetry={reload} />}
      {data && (
        <>
          <FigureStrip>
            <Figure label="Workflows" value={data.workflowCount} note="blueprints defined" />
            <Figure label="Scans" value={data.scanCount} note={`${data.runningCount} running now`} />
            <Figure label="Findings" value={data.findingsCount} note="across all scans" tone="accent" />
            <Figure label="Exploitable" value={data.exploitableCount} note="confirmed by final pass" tone="fail" />
          </FigureStrip>

          <div style={{ marginTop: 'var(--space-8)' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 'var(--space-4)',
                marginBottom: 'var(--space-4)',
              }}
            >
              <h2 style={{ fontSize: 'var(--text-md)' }}>Active &amp; recent scans</h2>
              <Link className="btn btn--quiet btn--sm" to="/scans">
                View all scans
              </Link>
            </div>

            {data.recentScans.length === 0 ? (
              <EmptyState
                title="No scans yet"
                sub="Start a scan to see its runs, findings and exploitability here."
                action={
                  <Link className="btn btn--primary" to="/scans?new=1">
                    New scan
                  </Link>
                }
              />
            ) : (
              <div className="table-wrap">
                <table className="data-table overview-table" aria-label="Active and recent scans">
                  <thead>
                    <tr>
                      <th>Repository</th>
                      <th>Workflow</th>
                      <th>Model</th>
                      <th>State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentScans.map((s) => (
                      <tr key={s.id} className={s.status === 'running' ? 'is-live' : undefined}>
                        <td style={{ minWidth: 200 }}>
                          <Link className="cell-main" to={`/scans/${s.id}`}>
                            {s.repoDisplay || s.repoFull}
                          </Link>
                          <span className="cell-sub">{s.repoKind === 'local' ? 'local snapshot' : s.repoFull}</span>
                        </td>
                        <td className="cell-muted" style={{ whiteSpace: 'nowrap' }}>
                          {s.workflowName}
                        </td>
                        <td className="mono" style={{ color: 'var(--text-2)', fontSize: 'var(--text-xs)' }}>
                          {s.model}
                          {Object.keys(s.modelOverrides || {}).length
                            ? ` +${Object.keys(s.modelOverrides || {}).length}`
                            : ''}
                        </td>
                        <td>
                          <StatusBadge status={s.status} reasoning={s.reasoning} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </Page>
  );
}
