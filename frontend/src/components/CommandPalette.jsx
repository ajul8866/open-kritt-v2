import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { newScanChooserPath } from '../lib/scanDuplication.js';

// Static destinations + actions, always available even before data loads.
const STATIC = [
  { type: 'Page', label: 'Overview', to: '/' },
  { type: 'Page', label: 'Workflows', to: '/workflows' },
  { type: 'Page', label: 'Scans', to: '/scans' },
  { type: 'Page', label: 'Settings', to: '/settings' },
  { type: 'Page', label: 'Accounts', to: '/accounts' },
  { type: 'Page', label: 'Steps', to: '/steps' },
  { type: 'Page', label: 'Agent skills', to: '/agent-skills' },
  { type: 'Page', label: 'Severity rankers', to: '/severity-rankers' },
  { type: 'Page', label: 'Post-scripts', to: '/post-scripts' },
  { type: 'Action', label: 'New scan', to: newScanChooserPath() },
  { type: 'Action', label: 'New workflow', to: '/workflows?new=1' },
  { type: 'Action', label: 'Generate workflow with AI', to: '/workflows/generate' },
  { type: 'Action', label: 'New post-script', to: '/post-scripts?new=1' },
  { type: 'Action', label: 'Generate post-script with AI', to: '/post-scripts/generate' },
  { type: 'Action', label: 'New severity ranker', to: '/severity-rankers/new' },
];

function haystack(item) {
  const sub = Array.isArray(item.sub) ? item.sub.join(' ') : item.sub || '';
  return `${item.label} ${sub} ${item.type}`.toLowerCase();
}

export default function CommandPalette({ open, onClose }) {
  const navigate = useNavigate();
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const [query, setQuery] = useState('');
  const [data, setData] = useState(null); // dynamic items (null until first load)
  const [index, setIndex] = useState(0);

  // Lazily load searchable records the first time the palette opens.
  useEffect(() => {
    if (!open || data) return;
    let active = true;
    Promise.all([api.workflows(), api.scans(), api.postScripts(), api.agentSkills(), api.severityRankers()])
      .then(([wf, sc, ps, ag, sr]) => {
        if (!active) return;
        const items = [
          ...wf.map((w) => ({ type: 'Workflow', label: w.name, sub: w.description, to: `/workflows/${w.id}` })),
          ...sc.map((s) => {
            const sub = [
              s.workflowName,
              s.model,
              Object.keys(s.modelOverrides || {}).length
                ? `${Object.keys(s.modelOverrides).length} depth overrides`
                : null,
              s.status,
            ].filter(Boolean);
            return {
              type: 'Scan',
              label: s.repoDisplay || s.repoFull,
              sub,
              to: `/scans/${s.id}`,
            };
          }),
          ...ps.map((p) => ({ type: 'Post-script', label: p.name, sub: p.description, to: `/post-scripts/${p.id}` })),
          ...ag.map((a) => ({
            type: 'Agent skill',
            label: a.name,
            sub: a.description || a.slug,
            to: `/agent-skills/${a.id}`,
          })),
          ...sr.map((r) => ({
            type: 'Severity ranker',
            label: r.name,
            sub: r.description,
            to: `/severity-rankers/${r.id}`,
          })),
        ];
        setData(items);
      })
      .catch(() => active && setData([]));
    return () => {
      active = false;
    };
  }, [open, data]);

  // Reset query/selection each time the palette opens, and focus the input.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setIndex(0);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  const results = useMemo(() => {
    const all = [...STATIC, ...(data || [])];
    const q = query.trim().toLowerCase();
    if (!q) return STATIC;
    const tokens = q.split(/\s+/);
    return all
      .filter((it) => {
        const h = haystack(it);
        return tokens.every((t) => h.includes(t));
      })
      .slice(0, 40);
  }, [query, data]);

  // Keep the selection in range and scrolled into view.
  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, results.length - 1)));
  }, [results.length]);
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${index}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const go = useCallback(
    (item) => {
      if (!item) return;
      onClose();
      navigate(item.to);
    },
    [navigate, onClose]
  );

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(results[index]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 'var(--z-overlay)',
        background: 'var(--scrim)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: 'calc(var(--topbar-h) + var(--space-9)) var(--space-6) var(--space-6)',
      }}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
        style={{
          display: 'flex',
          width: 'min(560px, 100%)',
          maxHeight: 'calc(100dvh - var(--space-12))',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-4)',
            padding: 'var(--space-3) var(--space-6)',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <input
            ref={inputRef}
            className="input"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search workflows, scans, post-scripts, skills…"
            aria-label="Search the command palette"
            style={{
              flex: 1,
              height: 'var(--control-h)',
              padding: 0,
              border: 0,
              background: 'transparent',
              fontSize: 'var(--text-base)',
            }}
          />
          <kbd className="kbd">esc</kbd>
        </div>

        <div ref={listRef} style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-2)' }}>
          {results.length === 0 && (
            <div
              style={{
                padding: 'var(--space-7) var(--space-5)',
                textAlign: 'center',
                color: 'var(--text-3)',
                fontSize: 'var(--text-sm)',
              }}
            >
              {data === null ? 'Loading…' : 'No matches.'}
            </div>
          )}
          {results.map((it, i) => {
            const subParts = Array.isArray(it.sub) ? it.sub : it.sub ? [it.sub] : [];
            return (
              <Link
                key={`${it.type}-${it.to}-${i}`}
                to={it.to}
                data-idx={i}
                className="menu-item"
                onClick={onClose}
                onMouseEnter={() => setIndex(i)}
                style={{
                  height: 'auto',
                  alignItems: 'flex-start',
                  gap: 'var(--space-5)',
                  padding: 'var(--space-3) var(--space-4)',
                  background: i === index ? 'var(--hover)' : 'transparent',
                  textDecoration: 'none',
                }}
              >
                <span
                  style={{
                    flex: 'none',
                    width: '6rem',
                    paddingTop: 1,
                    color: 'var(--text-3)',
                    fontSize: 'var(--text-2xs)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {it.type}
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      fontSize: 'var(--text-sm)',
                      color: 'var(--text)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {it.label}
                  </div>
                  {subParts.length > 0 && (
                    <div
                      style={{
                        display: 'flex',
                        gap: 'var(--space-4)',
                        marginTop: 'var(--space-1)',
                        color: 'var(--text-3)',
                        fontSize: 'var(--text-xs)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                      }}
                    >
                      {subParts.map((part, partIndex) => (
                        <span key={partIndex} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {part}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {i === index && (
                  <kbd className="kbd" style={{ flex: 'none' }}>
                    enter
                  </kbd>
                )}
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
