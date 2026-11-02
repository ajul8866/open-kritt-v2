import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { useFetch } from '../lib/useFetch.js';
import { usePageChrome } from '../context/ui.jsx';
import { Spinner, ErrorState, EmptyState, Button } from '../components/ui.jsx';
import { Page, PageHeader } from '../components/app.jsx';
import { rankerDescOf, rankerRuleCount } from '../lib/severityRanker.js';
import { useNewestFirst, usePagination } from '../lib/usePagination.js';
import Pagination from '../components/Pagination.jsx';
import { downloadResourceExport } from '../lib/resourceTransfer.js';
import { useResourceImport } from '../lib/useResourceImport.js';

function updatedLabel(value) {
  if (!value) return 'unknown';
  return new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

const DESCRIPTION_STYLE = {
  display: 'block',
  maxWidth: '62ch',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--text-2)',
};

export default function SeverityRankers() {
  const navigate = useNavigate();
  usePageChrome(
    [{ label: 'Severity rankers', active: true }],
    { label: '+ New severity ranker', to: '/severity-rankers/new' },
    []
  );
  const { data, loading, error, reload } = useFetch(() => api.severityRankers(), []);
  const rankers = useNewestFirst(data);
  const rankerPages = usePagination(rankers, { pageSize: 9 });
  const resourceImport = useResourceImport({
    resourceType: 'severityRanker',
    label: 'Severity ranker',
    create: api.createSeverityRanker,
    onImported: (ranker) => navigate(`/severity-rankers/${ranker.id}`),
  });

  return (
    <Page>
      <PageHeader
        title="Severity rankers"
        meta="Reusable rule-sets that tell the model how to rank a finding: critical, high, medium, low or informational. Attach one or more when you create a scan."
        actions={
          <Button variant="ghost" disabled={resourceImport.importing} onClick={resourceImport.chooseFile}>
            {resourceImport.importing ? 'Importing…' : 'Import JSON'}
          </Button>
        }
      />
      <input
        ref={resourceImport.inputRef}
        type="file"
        accept=".json,application/json"
        aria-label="Import severity ranker JSON"
        onChange={resourceImport.importFile}
        style={{ display: 'none' }}
      />

      {resourceImport.importError && (
        <div role="alert" style={{ marginBottom: 'var(--space-5)' }}>
          <ErrorState error={{ message: resourceImport.importError }} />
        </div>
      )}

      {loading && <Spinner />}
      {error && <ErrorState error={error} onRetry={reload} />}
      {data && data.length === 0 && (
        <EmptyState
          title="No severity rankers yet"
          sub="Write the rules by which findings should be ranked, then attach them to scans."
          action={<Button to="/severity-rankers/new">+ New severity ranker</Button>}
        />
      )}
      {data && data.length > 0 && (
        <>
          <div className="table-wrap">
            <table className="data-table">
              <colgroup>
                <col style={{ width: '26%' }} />
                <col style={{ width: '42%' }} />
                <col style={{ width: '10%' }} />
                <col style={{ width: '14%' }} />
                <col style={{ width: '8%' }} />
              </colgroup>
              <thead>
                <tr>
                  <th>Ranker</th>
                  <th>Description</th>
                  <th className="cell-num">Rules</th>
                  <th>Updated</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rankerPages.pageItems.map((r) => {
                  const count = rankerRuleCount(r.content);
                  return (
                    <tr key={r.id}>
                      <td style={{ minWidth: 200 }}>
                        <Link className="cell-main" to={`/severity-rankers/${r.id}`}>
                          {r.name}
                        </Link>
                      </td>
                      <td>
                        <span style={DESCRIPTION_STYLE}>{r.description || rankerDescOf(r.content)}</span>
                      </td>
                      <td className="cell-num">{count}</td>
                      <td className="cell-muted" style={{ whiteSpace: 'nowrap' }}>
                        {updatedLabel(r.updatedAt)}
                      </td>
                      <td>
                        <div className="cell-actions">
                          <Button
                            variant="ghost"
                            aria-label={`Export ${r.name}`}
                            title="Export severity ranker as JSON"
                            onClick={(event) => {
                              event.stopPropagation();
                              downloadResourceExport('severityRanker', r);
                            }}
                          >
                            Export
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 'var(--space-4)' }}>
            <Pagination {...rankerPages} itemLabel="rankers" />
          </div>
        </>
      )}
    </Page>
  );
}
