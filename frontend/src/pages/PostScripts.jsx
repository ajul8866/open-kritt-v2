import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useFetch } from '../lib/useFetch.js';
import { usePageChrome } from '../context/ui.jsx';
import { Spinner, ErrorState, EmptyState, Button } from '../components/ui.jsx';
import { Page, PageHeader } from '../components/app.jsx';
import { useModalDialog } from '../lib/useModalDialog.js';
import { useNewestFirst, usePagination } from '../lib/usePagination.js';
import { downloadResourceExport } from '../lib/resourceTransfer.js';
import { useResourceImport } from '../lib/useResourceImport.js';
import Pagination from '../components/Pagination.jsx';

function updatedLabel(value) {
  if (!value) return 'unknown';
  return new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

const DESCRIPTION_STYLE = {
  display: 'block',
  maxWidth: '58ch',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--text-2)',
};

export default function PostScripts() {
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
  usePageChrome(
    [{ label: 'Post-scripts', active: true }],
    { label: '+ New post-script', to: '/post-scripts?new=1' },
    []
  );
  const { data, loading, error, reload } = useFetch(() => api.postScripts(), []);
  const postScripts = useNewestFirst(data);
  const postScriptPages = usePagination(postScripts, { pageSize: 9 });
  const resourceImport = useResourceImport({
    resourceType: 'postScript',
    label: 'Post-script',
    create: api.createPostScript,
    onImported: (postScript) => navigate(`/post-scripts/${postScript.id}`),
  });

  return (
    <Page>
      <PageHeader
        title="Post-scripts"
        meta="Run after every finding to enrich, grade or cluster it. Reserved keys only."
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
        aria-label="Import post-script JSON"
        onChange={resourceImport.importFile}
        style={{ display: 'none' }}
      />

      {resourceImport.importError && (
        <div role="alert" style={{ marginBottom: 'var(--space-5)' }}>
          <ErrorState error={{ message: resourceImport.importError }} />
        </div>
      )}

      {dialogOpen && <NewPostScriptDialog onClose={closeDialog} />}

      {loading && <Spinner />}
      {error && <ErrorState error={error} onRetry={reload} />}
      {data && data.length === 0 && (
        <EmptyState
          title="No post-scripts yet"
          sub="A post-script runs once per finding to enrich or grade it."
          action={<Button to="/post-scripts?new=1">+ New post-script</Button>}
        />
      )}
      {data && data.length > 0 && (
        <>
          <div className="table-wrap">
            <table className="data-table">
              <colgroup>
                <col style={{ width: '22%' }} />
                <col style={{ width: '36%' }} />
                <col style={{ width: '22%' }} />
                <col style={{ width: '12%' }} />
                <col style={{ width: '8%' }} />
              </colgroup>
              <thead>
                <tr>
                  <th>Post-script</th>
                  <th>Description</th>
                  <th>Output keys</th>
                  <th>Updated</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {postScriptPages.pageItems.map((p) => (
                  <tr key={p.id}>
                    <td style={{ minWidth: 180 }}>
                      <Link className="cell-main" to={`/post-scripts/${p.id}`}>
                        {p.name}
                      </Link>
                    </td>
                    <td>
                      <span style={DESCRIPTION_STYLE}>{p.description}</span>
                    </td>
                    <td>
                      <div className="chip-row">
                        {p.keys.map((k) => (
                          <span key={k} className="chip chip--code">
                            {k}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="cell-muted" style={{ whiteSpace: 'nowrap' }}>
                      {updatedLabel(p.updatedAt)}
                    </td>
                    <td>
                      <div className="cell-actions">
                        <Button
                          variant="ghost"
                          aria-label={`Export ${p.name}`}
                          title="Export post-script as JSON"
                          onClick={(event) => {
                            event.stopPropagation();
                            downloadResourceExport('postScript', p);
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
            <Pagination {...postScriptPages} itemLabel="post-scripts" />
          </div>
        </>
      )}
    </Page>
  );
}

function NewPostScriptDialog({ onClose }) {
  const dialogRef = useModalDialog(onClose);

  return (
    <div className="dialog-wrap" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-post-script-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        className="dialog"
        style={{ width: 'min(460px, 100%)' }}
      >
        <div className="dialog-head">
          <h2 className="dialog-title" id="new-post-script-title">
            New post-script
          </h2>
          <button type="button" className="btn btn--icon btn--sm" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
          <OptionCard
            autoFocus
            title="Generate with AI"
            sub="Describe how findings should be enriched, then review a detailed, valid post-script draft."
            to="/post-scripts/generate"
          />
          <OptionCard
            title="Blank post-script"
            sub="Start with an empty post-script and define it yourself."
            to="/post-scripts/new"
          />
        </div>
      </div>
    </div>
  );
}

function OptionCard({ title, sub, to, autoFocus = false }) {
  return (
    <Link
      to={to}
      data-autofocus={autoFocus || undefined}
      style={{
        display: 'block',
        padding: 'var(--space-5)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--surface)',
        color: 'var(--text)',
        textDecoration: 'none',
      }}
    >
      <div style={{ fontSize: 'var(--text-base)', fontWeight: 600 }}>{title}</div>
      <div
        style={{ marginTop: 'var(--space-2)', color: 'var(--text-2)', fontSize: 'var(--text-sm)', lineHeight: 1.45 }}
      >
        {sub}
      </div>
    </Link>
  );
}
