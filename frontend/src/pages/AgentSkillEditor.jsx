import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api, ApiError, apiErrorMessages } from '../api/client.js';
import { usePageChrome } from '../context/ui.jsx';
import { ErrorState, Spinner, Button } from '../components/ui.jsx';
import { Page, PageHeader } from '../components/app.jsx';
import { useUnsavedChangesPrompt } from '../lib/useUnsavedChangesPrompt.js';

function slugify(value) {
  return (value || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function newAgentSkillForm() {
  return {
    name: 'new-agent-skill',
    slug: 'new-agent-skill',
    description: '',
    content:
      'Use this skill when a scan needs focused security-review guidance.\n\nProcess:\n- Map reachable attacker input.\n- Trace to sensitive sinks or invariants.\n- Report vulnerabilities that are production-reachable, including uncertain ones; downstream ranking filters them.',
    sourceUrl: '',
    licenseSpdx: '',
    attribution: '',
  };
}

const FIELD_GRID = {
  display: 'grid',
  maxWidth: 880,
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))',
  gap: 'var(--space-6)',
};

const FULL_ROW = { gridColumn: '1 / -1' };

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

export default function AgentSkillEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [loaded, setLoaded] = useState(!id);
  const [form, setForm] = useState(() =>
    id ? { ...newAgentSkillForm(), name: '', slug: '', content: '' } : newAgentSkillForm()
  );
  const [saving, setSaving] = useState(false);
  const [serverErrors, setServerErrors] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const initialRef = useRef(id ? null : JSON.stringify(newAgentSkillForm()));

  usePageChrome(
    [
      { label: 'Agent skills', to: '/agent-skills' },
      { label: id ? form.name || '…' : 'New skill', active: true },
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
      const next = newAgentSkillForm();
      initialRef.current = JSON.stringify(next);
      setForm(next);
      setLoaded(true);
      return () => {
        active = false;
      };
    }
    setLoaded(false);
    api
      .agentSkill(id)
      .then((skill) => {
        if (!active) return;
        const next = {
          name: skill.name || '',
          slug: skill.slug || '',
          description: skill.description || '',
          content: skill.content || '',
          sourceUrl: skill.sourceUrl || '',
          licenseSpdx: skill.licenseSpdx || '',
          attribution: skill.attribution || '',
        };
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
  if (!form.name.trim()) errs.push('Name the skill');
  if (!form.slug.trim()) errs.push('Set a slug');
  if (!form.content.trim()) errs.push('Content is required');
  if (form.sourceUrl.trim()) {
    try {
      const parsed = new URL(form.sourceUrl.trim());
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        errs.push('Source URL must use http or https');
      }
    } catch {
      errs.push('Source URL is invalid');
    }
  }
  const canSave = errs.length === 0 && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setServerErrors([]);
    const body = {
      name: form.name.trim(),
      slug: slugify(form.slug),
      description: form.description,
      content: form.content,
      sourceUrl: form.sourceUrl.trim() || null,
      licenseSpdx: form.licenseSpdx.trim() || null,
      attribution: form.attribution.trim() || null,
    };
    try {
      if (id) await api.updateAgentSkill(id, body);
      else await api.createAgentSkill(body);
      allow();
      navigate('/agent-skills');
    } catch (e) {
      if (e instanceof ApiError) setServerErrors(apiErrorMessages(e));
      else setServerErrors([e.message]);
      setSaving(false);
    }
  };

  return (
    <Page style={{ paddingBottom: 0 }}>
      <PageHeader
        title={id ? 'Edit agent skill' : 'New agent skill'}
        meta="Markdown instructions installed as a Codex skill for selected scans."
      />

      <div style={FIELD_GRID}>
        <div className="field">
          <label className="field-label" htmlFor="agent-skill-name">
            Name
          </label>
          <input
            id="agent-skill-name"
            className="input mono"
            value={form.name}
            onChange={(e) => set({ name: e.target.value, slug: id ? form.slug : slugify(e.target.value) })}
            spellCheck={false}
            placeholder="skill name"
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="agent-skill-slug">
            Slug
          </label>
          <input
            id="agent-skill-slug"
            className="input mono"
            value={form.slug}
            onChange={(e) => set({ slug: slugify(e.target.value) })}
            spellCheck={false}
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="agent-skill-license">
            License SPDX
          </label>
          <input
            id="agent-skill-license"
            className="input mono"
            value={form.licenseSpdx}
            onChange={(e) => set({ licenseSpdx: e.target.value })}
            spellCheck={false}
            placeholder="MIT, CC-BY-SA-4.0, Apache-2.0"
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="agent-skill-source-url">
            Source URL
          </label>
          <input
            id="agent-skill-source-url"
            className="input mono"
            value={form.sourceUrl}
            onChange={(e) => set({ sourceUrl: e.target.value })}
            spellCheck={false}
            placeholder="https://github.com/…"
          />
        </div>

        <div className="field" style={FULL_ROW}>
          <label className="field-label" htmlFor="agent-skill-description">
            Description
          </label>
          <input
            id="agent-skill-description"
            className="input"
            value={form.description}
            onChange={(e) => set({ description: e.target.value })}
          />
        </div>

        <div className="field" style={FULL_ROW}>
          <label className="field-label" htmlFor="agent-skill-attribution">
            Attribution
          </label>
          <input
            id="agent-skill-attribution"
            className="input"
            value={form.attribution}
            onChange={(e) => set({ attribution: e.target.value })}
          />
        </div>

        <div className="field" style={FULL_ROW}>
          <label className="field-label" htmlFor="agent-skill-content">
            Content
          </label>
          <textarea
            id="agent-skill-content"
            className="textarea mono"
            value={form.content}
            onChange={(e) => set({ content: e.target.value })}
            spellCheck={false}
            style={{ minHeight: 420 }}
          />
        </div>
      </div>

      <div style={FOOTER}>
        <span className="field-note" role="status">
          {serverErrors[0] || errs[0] || 'Agent skill is valid.'}
        </span>
        <Button onClick={save} disabled={!canSave}>
          {saving
            ? 'Saving…'
            : errs.length
              ? `${errs.length} issue${errs.length > 1 ? 's' : ''} to fix`
              : id
                ? 'Save changes'
                : 'Create skill'}
        </Button>
      </div>
    </Page>
  );
}
