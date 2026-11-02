import { useState, useRef, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, apiErrorMessages } from '../api/client.js';
import { usePageChrome } from '../context/ui.jsx';
import { useUnsavedChangesPrompt } from '../lib/useUnsavedChangesPrompt.js';
import { ErrorState, Spinner, Button, KeyChip } from '../components/ui.jsx';
import { Page, PageHeader } from '../components/app.jsx';
import { PromptEditor } from '../components/PromptEditor.jsx';
import SchemaEditor from '../components/SchemaEditor.jsx';
import { postScriptDraftFromGeneration, resultFromCompletedGeneration } from '../lib/generationDraft.js';
import {
  BUILTIN_KEYS,
  EXTRA_KEY,
  FIELD_TYPES,
  OPTIONAL_VULN_KEYS,
  POST_SCRIPT_CHIP_PREFIX,
  POST_SCRIPT_MARKDOWN_OUTPUT_KEYS,
  REQUIRED_VULN_KEYS,
  RESERVED_POST_SCRIPT_KEYS,
  isExtraRef,
  isValidKey,
  parseTemplateRefs,
  rowsToObject,
  objectToRows,
} from '../lib/keys.js';

const AVAILABLE = new Set(RESERVED_POST_SCRIPT_KEYS);
const NEW_POST_SCRIPT_CONTENT = 'Grade the finding "{{summary}}", a {{vulnerability_type}} at {{file_path}}:{{line}}.';

const META_GRID = {
  display: 'grid',
  maxWidth: 880,
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))',
  gap: 'var(--space-6)',
  marginBottom: 'var(--space-8)',
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

function newPostScriptState() {
  return {
    name: 'new-post-script',
    description: '',
    content: NEW_POST_SCRIPT_CONTENT,
    rows: [{ key: 'severity', type: 'string' }],
  };
}

function postScriptSnapshot({ name, description, content, rows }) {
  return JSON.stringify({ name, description, content, rows });
}

export default function PostScriptEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const generationId = id ? null : params.get('generation');
  const editorRef = useRef(null);

  const [loaded, setLoaded] = useState(!id && !generationId);
  const [loadError, setLoadError] = useState(null);
  const [name, setName] = useState(id ? '' : 'new-post-script');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState(id ? '' : NEW_POST_SCRIPT_CONTENT);
  const [rows, setRows] = useState(id ? [] : [{ key: 'severity', type: 'string' }]);
  const [mode, setMode] = useState('visual');
  const [saving, setSaving] = useState(false);
  const [serverErrors, setServerErrors] = useState([]);
  const initialRef = useRef(!id && !generationId ? postScriptSnapshot(newPostScriptState()) : null);

  usePageChrome(
    [
      { label: 'Post-scripts', to: '/post-scripts' },
      { label: id ? name || '…' : 'New post-script', active: true },
    ],
    null,
    [id, name]
  );

  useEffect(() => {
    let active = true;
    initialRef.current = null;
    setLoadError(null);
    setServerErrors([]);
    setSaving(false);
    setMode('visual');
    setLoaded(false);
    if (generationId) {
      api
        .generation(generationId)
        .then((job) => {
          if (!active) return;
          const draft = postScriptDraftFromGeneration(resultFromCompletedGeneration(job, 'post_script'));
          setName(draft.name);
          setDescription(draft.description);
          setContent(draft.content);
          setRows(draft.rows);
          initialRef.current = postScriptSnapshot(draft);
          setLoaded(true);
        })
        .catch((error) => active && setLoadError(error));
      return () => {
        active = false;
      };
    }
    if (!id) {
      const next = newPostScriptState();
      setName(next.name);
      setDescription(next.description);
      setContent(next.content);
      setRows(next.rows);
      initialRef.current = postScriptSnapshot(next);
      setLoaded(true);
      return () => {
        active = false;
      };
    }
    api
      .postScript(id)
      .then((p) => {
        if (!active) return;
        const next = {
          name: p.name,
          description: p.description || '',
          content: p.content || '',
          rows: objectToRows(p.outputFormat),
        };
        setName(next.name);
        setDescription(next.description);
        setContent(next.content);
        setRows(next.rows);
        initialRef.current = postScriptSnapshot(next);
        setLoaded(true);
      })
      .catch((error) => active && setLoadError(error));
    return () => {
      active = false;
    };
  }, [generationId, id]);

  const snapshot = postScriptSnapshot({ name, description, content, rows });
  const dirty = loaded && (Boolean(generationId) || (initialRef.current !== null && snapshot !== initialRef.current));
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

  // Live validation.
  const parsedRefs = parseTemplateRefs(content);
  const refs = [...new Set(parsedRefs.refs)];
  const malformedRefs = [...new Set(parsedRefs.malformed)];
  const refIsAvailable = (key) => AVAILABLE.has(key) || isExtraRef(key);
  const badRefs = refs.filter((key) => !refIsAvailable(key));
  const keyCount = {};
  rows.forEach((r) => r.key && (keyCount[r.key] = (keyCount[r.key] || 0) + 1));
  const schemaValid =
    rows.length > 0 &&
    rows.every(
      (r) =>
        r.key &&
        isValidKey(r.key) &&
        FIELD_TYPES.includes(r.type) &&
        !RESERVED_POST_SCRIPT_KEYS.includes(r.key) &&
        keyCount[r.key] === 1 &&
        r.key !== POST_SCRIPT_CHIP_PREFIX &&
        (!POST_SCRIPT_MARKDOWN_OUTPUT_KEYS.includes(r.key) || r.type === 'string')
    );

  const errs = [];
  if (!name.trim()) errs.push('Name the post-script');
  if (!content.trim()) errs.push('Content is required');
  if (!schemaValid) errs.push('Fix output schema');
  if (malformedRefs.length) errs.push(`${malformedRefs.length} malformed template reference`);
  if (badRefs.length) errs.push(`${badRefs.length} non-reserved key reference`);
  const canSave = errs.length === 0 && !saving;

  const validateKey = (key) => {
    if (!isValidKey(key)) return 'invalid key name';
    if (RESERVED_POST_SCRIPT_KEYS.includes(key)) return 'reserved key, those are inputs';
    if (key === POST_SCRIPT_CHIP_PREFIX) return 'add a label after _chip_';
    return null;
  };

  const insert = (token) => editorRef.current?.insert(token);

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setServerErrors([]);
    try {
      const body = {
        name: name.trim(),
        description,
        content,
        outputFormat: rowsToObject(rows.filter((r) => r.key)),
      };
      if (id) await api.updatePostScript(id, body);
      else await api.createPostScript(body);
      allow();
      navigate('/post-scripts');
    } catch (e) {
      if (e instanceof ApiError) setServerErrors(apiErrorMessages(e, { includeField: false }));
      else setServerErrors([e.message]);
      setSaving(false);
    }
  };

  const referenceStatus =
    refs.length === 0 && malformedRefs.length === 0
      ? 'no references yet'
      : malformedRefs.length || badRefs.length
        ? `${malformedRefs.length + badRefs.length} invalid reference${malformedRefs.length + badRefs.length > 1 ? 's' : ''}`
        : `all ${refs.length} resolved`;
  const referenceTone =
    malformedRefs.length || badRefs.length ? 'var(--fail)' : refs.length ? 'var(--ok)' : 'var(--text-3)';

  return (
    <Page style={{ paddingBottom: 0 }}>
      <PageHeader
        title={id ? 'Edit post-script' : 'New post-script'}
        meta="Runs once per finding. It may only reference the reserved context and finding keys below, not step outputs."
      />

      <div style={META_GRID}>
        <div className="field">
          <label className="field-label" htmlFor="post-script-name">
            Name
          </label>
          <input
            id="post-script-name"
            className="input mono"
            value={name}
            onChange={(e) => setName(e.target.value)}
            spellCheck={false}
            placeholder="post-script-name"
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="post-script-description">
            Description
          </label>
          <input
            id="post-script-description"
            className="input"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Describe what this post-script adds to a finding…"
          />
        </div>
      </div>

      {generationId && (
        <div
          className="state-block"
          style={{
            marginBottom: 'var(--space-6)',
            borderStyle: 'solid',
            borderColor: 'var(--run)',
            background: 'var(--run-bg)',
          }}
        >
          <div className="state-note" style={{ color: 'var(--run)' }}>
            AI-generated draft. Review the prompt, referenced variables, and output schema before saving.
          </div>
        </div>
      )}

      <div
        className="post-script-editor-grid"
        style={{
          display: 'grid',
          maxWidth: 880,
          gridTemplateColumns: 'minmax(0, 1.25fr) minmax(0, 1fr)',
          gap: 'var(--space-8)',
          alignItems: 'start',
        }}
      >
        <div>
          <div className="field">
            <div className="field-label">
              <span>Content</span>
            </div>
            <PromptEditor
              ref={editorRef}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              available={AVAILABLE}
              allowExtra
              height={240}
              expandable
              title="Post-script content"
              paletteChips={[
                ...BUILTIN_KEYS.map((k) => ({ label: `${k} (context)`, token: k })),
                ...[...REQUIRED_VULN_KEYS, ...OPTIONAL_VULN_KEYS].map((k) => ({
                  label: `${k} (finding)`,
                  token: k,
                  accent: true,
                })),
                { label: 'extra.<key> (scan input)', token: 'extra.', accent: true },
              ]}
            />
          </div>

          <div className="field-label" style={{ marginTop: 'var(--space-5)' }}>
            <span>Referenced keys</span>
            <span className="field-unit" style={{ color: referenceTone }}>
              {referenceStatus}
            </span>
          </div>
          <div className="chip-row" style={{ marginTop: 'var(--space-3)' }}>
            {refs.map((k) => {
              const ok = refIsAvailable(k);
              return <KeyChip key={k} name={`${ok ? '✓' : '✕'} ${k}`} ok={ok} />;
            })}
            {malformedRefs.map((token, index) => (
              <KeyChip key={`${token}-${index}`} name={`✕ ${token}`} ok={false} />
            ))}
          </div>

          <div className="field-label" style={{ marginTop: 'var(--space-6)' }}>
            <span>Context keys</span>
            <span className="field-unit">scan inputs</span>
          </div>
          <div className="chip-row" style={{ marginTop: 'var(--space-3)' }}>
            {[...BUILTIN_KEYS, EXTRA_KEY].map((k) => (
              <button
                key={k}
                type="button"
                className="chip chip--code"
                style={{ cursor: 'pointer' }}
                onClick={() => insert(k === EXTRA_KEY ? `${EXTRA_KEY}.` : k)}
              >
                {k === EXTRA_KEY ? 'extra.<key>' : k}
              </button>
            ))}
          </div>

          <div className="field-label" style={{ marginTop: 'var(--space-6)' }}>
            <span>Finding keys</span>
            <span className="field-unit">vulnerability fields</span>
          </div>
          <div className="chip-row" style={{ marginTop: 'var(--space-3)' }}>
            {[...REQUIRED_VULN_KEYS, ...OPTIONAL_VULN_KEYS].map((k) => (
              <button
                key={k}
                type="button"
                className="chip chip--code chip--accent"
                style={{ cursor: 'pointer' }}
                onClick={() => insert(k)}
              >
                {k}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <div className="field-label">
            <span>Output format</span>
          </div>
          <SchemaEditor
            rows={rows}
            onRowsChange={setRows}
            mode={mode}
            onToggleMode={() => setMode((m) => (m === 'visual' ? 'raw' : 'visual'))}
            validateKey={validateKey}
            inputBg="var(--surface)"
          />
          <p className="field-note" style={{ margin: 0 }}>
            Output keys become columns on <span className="mono">post_script_answer</span>. They cannot reuse a reserved
            context or finding key.
          </p>
        </div>
      </div>

      <div className="post-script-editor-footer" style={FOOTER}>
        <span className="post-script-editor-footer-status field-note" role="status">
          {serverErrors[0] || errs[0] || 'Post-script is valid.'}
        </span>
        <Button className="btn btn--primary post-script-editor-save" onClick={save} disabled={!canSave}>
          {saving
            ? 'Saving…'
            : errs.length
              ? `${errs.length} issue${errs.length > 1 ? 's' : ''} to fix`
              : id
                ? 'Save changes'
                : 'Create post-script'}
        </Button>
      </div>
    </Page>
  );
}
