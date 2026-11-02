import { api } from '../api/client.js';
import { useFetch } from '../lib/useFetch.js';
import { usePageChrome } from '../context/ui.jsx';
import { Spinner, ErrorState, EmptyState } from '../components/ui.jsx';
import { Page, PageHeader } from '../components/app.jsx';
import { usePagination } from '../lib/usePagination.js';
import Pagination from '../components/Pagination.jsx';

export default function Steps() {
  usePageChrome([{ label: 'Steps', active: true }], null, []);
  const { data, loading, error, reload } = useFetch(() => api.steps(), []);
  const stepPages = usePagination(data || [], { pageSize: 25 });

  return (
    <Page>
      <PageHeader title="Steps" meta="Every step defined across your workflows." />

      {loading && <Spinner />}
      {error && <ErrorState error={error} onRetry={reload} />}
      {data && data.length === 0 && <EmptyState title="No steps yet" sub="Steps are created as part of a workflow." />}
      {data && data.length > 0 && (
        <>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="cell-num">Depth</th>
                  <th>Multi</th>
                  <th>Output keys</th>
                  <th>Workflow</th>
                </tr>
              </thead>
              <tbody>
                {stepPages.pageItems.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <span className="cell-main">{s.name || 'Untitled step'}</span>
                    </td>
                    <td className="cell-num">{s.depth}</td>
                    <td className="cell-muted">{String(s.multiOutput)}</td>
                    <td>
                      <span className="mono" style={{ color: 'var(--text-2)', fontSize: 'var(--text-2xs)' }}>
                        {s.keys.join(', ')}
                      </span>
                    </td>
                    <td className="cell-muted">{s.workflowName || 'None'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 'var(--space-4)' }}>
            <Pagination {...stepPages} itemLabel="steps" />
          </div>
        </>
      )}
    </Page>
  );
}
