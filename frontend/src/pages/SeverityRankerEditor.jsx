import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client.js';
import { usePageChrome } from '../context/ui.jsx';
import { ErrorState, Spinner, Button } from '../components/ui.jsx';
import { Page, PageHeader } from '../components/app.jsx';
import Markdown from '../components/Markdown.jsx';
import { rankerDescOf } from '../lib/severityRanker.js';
import { useUnsavedChangesPrompt } from '../lib/useUnsavedChangesPrompt.js';

const STARTER = '# Ranking rules\n\n1. ';

const EDITOR_GRID = {
  display: 'grid',
  maxWidth: 880,
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))',
  gap: 'var(--space-8)',
  alignItems: 'start',
};

const FOOTER = {
  maxWidth: 880,
  position: 'sticky',
  bottom: 0,
  zIndex: 2,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--space-5)',
  marginTop: 'var(--space-9)',
  padding: 'var(--space-4) 0',
  borderTop: '1px solid var(--border)',
  background: 'var(--bg)',
};

function newSeverityRankerForm() {
  return { name: 'new-severity-ranker', content: STARTER };
}

export default function SeverityRankerEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [loaded, setLoaded] = useState(!id);
  const [form, setForm] = useState(() => (id ? { name: '', content: '' } : newSeverityRankerForm()));
  const [saving, setSaving] = useState(false);
  const [serverErrors, setServerErrors] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const initialRef = useRef(id ? null : JSON.stringify(newSeverityRankerForm()));

  usePageChrome(
    [
      { label: 'Severity rankers', to: '/severity-rankers' },
      { label: id ? form.name || '…' : 'New severity ranker', active: true },
    ],
    null,
    [id, form.name]
  );

  useEffect(() => {
    let active = true;
    initialRef.current = null;
    setLoadError(null);
    setServerErrors([]);
    setSaving(false);
    if (!id) {
      const next = newSeverityRankerForm();
      initialRef.current = JSON.stringify(next);
      setForm(next);
      setLoaded(true);
      return () => {
        active = false;
      };
    }
    setLoaded(false);
    api
      .severityRanker(id)
      .then((r) => {
        if (!active) return;
        const next = { name: r.name || '', content: r.content || '' };
        initialRef.current = JSON.stringify(next);
        setForm(next);
        setLoaded(true);
      })
      .catch((error) => {
        if (active) setLoadError(error);
      });
    return () => {
      active = false;
    };
  }, [id]);

  const snapshot = JSON.stringify(form);
  const dirty = loaded && initialRef.current !== null && snapshot !== initialRef.current;
  const { allow } = useUnsavedChangesPrompt(dirty || saving);

  if (loadError)
    return (
      <Page>
        <ErrorState error={loadError} onRetry={() => window.location.reload()} />
      </Page>
    );

  if (!loaded)
    return (
      <Page>
        <Spinner />
      </Page>
    );

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const errs = [];
  if (!form.name.trim()) errs.push('Name the severity ranker');
  if (!form.content.trim()) errs.push('Add at least one rule');
  const canSave = errs.length === 0 && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setServerErrors([]);
    const body = { name: form.name.trim(), content: form.content, description: rankerDescOf(form.content) };
    try {
      if (id) await api.updateSeverityRanker(id, body);
      else await api.createSeverityRanker(body);
      allow();
      navigate('/severity-rankers');
    } catch (e) {
      if (e instanceof ApiError) setServerErrors(e.errors?.map((x) => `${x.field}: ${x.message}`) || [e.message]);
      else setServerErrors([e.message]);
      setSaving(false);
    }
  };

  return (
    <Page style={{ paddingBottom: 0 }}>
      <PageHeader
        title={id ? 'Edit severity ranker' : 'New severity ranker'}
        meta="A set of markdown rules the model applies when ranking each finding's severity. Write them as numbered or bulleted instructions."
      />

      <div className="field" style={{ maxWidth: 520, marginBottom: 'var(--space-8)' }}>
        <label className="field-label" htmlFor="severity-ranker-name">
          Name
        </label>
        <input
          id="severity-ranker-name"
          className="input mono"
          value={form.name}
          onChange={(e) => set({ name: e.target.value })}
          spellCheck={false}
          placeholder="severity-ranker-name"
        />
      </div>

      <div style={EDITOR_GRID}>
        <div className="field">
          <div className="field-label">
            <label htmlFor="severity-ranker-content">Rules</label>
            <span className="field-unit">Markdown</span>
          </div>
          <textarea
            id="severity-ranker-content"
            className="textarea mono"
            value={form.content}
            onChange={(e) => set({ content: e.target.value })}
            spellCheck={false}
            placeholder="1. If the finding requires non-trivial privileges, downgrade by 1 rank."
            style={{ height: 440 }}
          />
        </div>

        <div>
          <div className="field-label" style={{ marginBottom: 'var(--space-3)' }}>
            <span>Preview</span>
          </div>
          <div
            style={{
              minHeight: 440,
              padding: 'var(--space-6)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--surface-2)',
            }}
          >
            {form.content.trim() ? (
              <Markdown source={form.content} />
            ) : (
              <p className="field-note" style={{ margin: 0 }}>
                Start typing rules to preview them.
              </p>
            )}
          </div>
        </div>
      </div>

      <div style={FOOTER}>
        <span className="field-note" role="status">
          {serverErrors[0] || errs[0] || 'Severity ranker is valid.'}
        </span>
        <Button onClick={save} disabled={!canSave}>
          {saving
            ? 'Saving…'
            : errs.length
              ? `${errs.length} issue${errs.length > 1 ? 's' : ''} to fix`
              : id
                ? 'Save changes'
                : 'Create severity ranker'}
        </Button>
      </div>
    </Page>
  );
}
