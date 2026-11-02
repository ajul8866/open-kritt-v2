import { Link, useNavigate } from 'react-router-dom';
import { Spinner, ErrorState, EmptyState, Button } from '../components/ui.jsx';
import { Page, PageHeader } from '../components/app.jsx';
import { api } from '../api/client.js';
import { useFetch } from '../lib/useFetch.js';
import { usePageChrome } from '../context/ui.jsx';
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
  maxWidth: '52ch',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--text-2)',
};

export default function AgentSkills() {
  const navigate = useNavigate();
  usePageChrome([{ label: 'Agent skills', active: true }], { label: '+ New skill', to: '/agent-skills/new' }, []);
  const { data, loading, error, reload } = useFetch(() => api.agentSkills(), []);
  const skills = useNewestFirst(data);
  const skillPages = usePagination(skills, { pageSize: 9 });
  const resourceImport = useResourceImport({
    resourceType: 'agentSkill',
    label: 'Agent skill',
    create: api.createAgentSkill,
    onImported: (skill) => navigate(`/agent-skills/${skill.id}`),
  });

  return (
    <Page>
      <PageHeader
        title="Agent skills"
        meta="Selected per scan and installed into each executor agent home."
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
        aria-label="Import agent skill JSON"
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
          title="No agent skills yet"
          sub="Create reusable security-review instructions and attach them to scans."
          action={<Button to="/agent-skills/new">+ New skill</Button>}
        />
      )}
      {data && data.length > 0 && (
        <>
          <div className="table-wrap">
            <table className="data-table">
              <colgroup>
                <col style={{ width: '24%' }} />
                <col style={{ width: '34%' }} />
                <col style={{ width: '12%' }} />
                <col style={{ width: '10%' }} />
                <col style={{ width: '12%' }} />
                <col style={{ width: '8%' }} />
              </colgroup>
              <thead>
                <tr>
                  <th>Skill</th>
                  <th>Description</th>
                  <th>License</th>
                  <th>Source</th>
                  <th>Updated</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {skillPages.pageItems.map((skill) => (
                  <tr key={skill.id}>
                    <td style={{ minWidth: 200 }}>
                      <Link className="cell-main" to={`/agent-skills/${skill.id}`}>
                        {skill.name}
                      </Link>
                      <span className="cell-sub mono">{skill.slug}</span>
                    </td>
                    <td>
                      <span style={DESCRIPTION_STYLE}>{skill.description}</span>
                    </td>
                    <td>
                      {skill.licenseSpdx ? (
                        <span className="chip chip--code">{skill.licenseSpdx}</span>
                      ) : (
                        <span className="cell-muted">None</span>
                      )}
                    </td>
                    <td>
                      {skill.sourceUrl && (
                        <a
                          href={skill.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            color: 'var(--accent-strong)',
                            fontSize: 'var(--text-xs)',
                            textDecoration: 'underline',
                            textUnderlineOffset: 2,
                          }}
                        >
                          Source
                        </a>
                      )}
                    </td>
                    <td className="cell-muted" style={{ whiteSpace: 'nowrap' }}>
                      {updatedLabel(skill.updatedAt)}
                    </td>
                    <td>
                      <div className="cell-actions">
                        <Button
                          variant="ghost"
                          aria-label={`Export ${skill.name}`}
                          title="Export agent skill as JSON"
                          onClick={(event) => {
                            event.stopPropagation();
                            downloadResourceExport('agentSkill', skill);
                          }}
                        >
                          Export
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 'var(--space-4)' }}>
            <Pagination {...skillPages} itemLabel="skills" />
          </div>
        </>
      )}
    </Page>
  );
}
