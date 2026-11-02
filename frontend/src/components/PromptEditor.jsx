import { useRef, useState, useImperativeHandle, useEffect, forwardRef } from 'react';
import { refResolves } from '../lib/keys.js';
import { getCaretCoordinates } from '../lib/caret.js';

// Render content with {{key}} tokens colored by whether they resolve against
// `available` (a Set or Map of allowed key names). When allowExtra is true,
// {{extra.<key>}} references resolve too.
export function renderHighlighted(content, available, allowExtra = false) {
  const parts = [];
  const re = /(\{\{\s*[a-zA-Z0-9_.]+\s*\}\})/g;
  let last = 0;
  let m;
  let i = 0;
  while ((m = re.exec(content))) {
    if (m.index > last) parts.push(<span key={`t${i++}`}>{content.slice(last, m.index)}</span>);
    const raw = m[0];
    const key = raw.replace(/\{\{\s*|\s*\}\}/g, '');
    const ok = refResolves(key, available, allowExtra);
    parts.push(
      <span
        key={`k${i++}`}
        style={{
          color: ok ? 'var(--ok)' : 'var(--fail)',
          background: ok ? 'var(--ok-bg)' : 'var(--fail-bg)',
          borderRadius: 'var(--radius-xs)',
          textDecoration: ok ? 'none' : 'underline wavy',
        }}
      >
        {raw}
      </span>
    );
    last = m.index + raw.length;
  }
  if (last < content.length) parts.push(<span key={`t${i++}`}>{content.slice(last)}</span>);
  return parts;
}

// Read-only highlighted prompt (used in the detail drawer).
export function PromptHighlight({ content, available, allowExtra = false, style }) {
  return (
    <div
      className="mono"
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--code-bg)',
        padding: 'var(--space-5)',
        fontSize: 'var(--text-xs)',
        lineHeight: 'var(--leading-prose)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: 'var(--text)',
        ...style,
      }}
    >
      {renderHighlighted(content || '', available, allowExtra)}
    </div>
  );
}

const POPUP_W = 268;
const POPUP_H = 232;
const closedAc = { open: false, items: [], index: 0, top: 0, left: 0 };

// Editable prompt with a syntax-highlight backdrop layered under a transparent
// textarea, an IDE-style {{…}} autocomplete, and an optional full-screen dialog.
// Exposes an imperative `insert(token)` that wraps the token in {{ }} at the caret.
export const PromptEditor = forwardRef(function PromptEditor(
  {
    value,
    onChange,
    available,
    allowExtra = false,
    height = 188,
    expandable = false,
    paletteChips = null,
    title = 'Prompt content',
  },
  ref
) {
  const taRef = useRef(null);
  const backRef = useRef(null);
  const modalTaRef = useRef(null);
  const modalBackRef = useRef(null);
  const pendingCaret = useRef(null);
  const [expanded, setExpanded] = useState(false);
  const [ac, setAc] = useState(closedAc); // autocomplete popup state

  const activeTa = () => (expanded ? modalTaRef.current : taRef.current);
  const closeAC = () => setAc((a) => (a.open ? closedAc : a));

  // Restore caret after a programmatic change (insert / edit / accept).
  useEffect(() => {
    if (pendingCaret.current != null) {
      const ta = activeTa();
      if (ta) {
        const pos = Math.min(pendingCaret.current, ta.value.length);
        try {
          ta.focus();
          ta.setSelectionRange(pos, pos);
        } catch {
          /* noop */
        }
      }
      pendingCaret.current = null;
    }
  });

  // Focus the big editor when it opens; close on Escape; reset autocomplete.
  useEffect(() => {
    closeAC();
    if (!expanded) return undefined;
    modalTaRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  // ---- token insertion ----
  const doInsert = (token) => {
    const ta = activeTa();
    const ins = `{{${token}}}`;
    const pos = ta ? ta.selectionStart : value.length;
    const next = value.slice(0, pos) + ins + value.slice(pos);
    pendingCaret.current = pos + ins.length;
    onChange({ target: { value: next } });
  };
  useImperativeHandle(ref, () => ({ insert: doInsert }));

  // ---- autocomplete ----
  const suggestionsFor = (query) => {
    let base = [];
    if (available instanceof Map)
      base = [...available.entries()].map(([name, from]) => ({ token: name, label: name, hint: String(from) }));
    else if (available && typeof available.forEach === 'function')
      base = [...available].map((name) => ({ token: name, label: name, hint: 'reserved' }));
    if (allowExtra) base.push({ token: 'extra.', label: 'extra.<key>', hint: 'dynamic', partial: true });
    const q = query.toLowerCase();
    return base
      .filter((k) => k.token.toLowerCase().includes(q))
      .sort((a, b) => {
        const ap = a.token.toLowerCase().startsWith(q) ? 0 : 1;
        const bp = b.token.toLowerCase().startsWith(q) ? 0 : 1;
        return ap - bp || a.token.localeCompare(b.token);
      })
      .slice(0, 8);
  };

  const refreshAC = (ta) => {
    if (!ta) return;
    const pos = ta.selectionStart;
    if (pos !== ta.selectionEnd) return closeAC();
    const before = ta.value.slice(0, pos);
    const openIdx = before.lastIndexOf('{{');
    if (openIdx === -1) return closeAC();
    const query = before.slice(openIdx + 2);
    if (!/^[a-zA-Z0-9_.]*$/.test(query)) return closeAC(); // closed token / stray text
    const items = suggestionsFor(query);
    if (!items.length) return closeAC();

    const coords = getCaretCoordinates(ta, openIdx);
    const rect = ta.getBoundingClientRect();
    let left = rect.left + coords.left - ta.scrollLeft;
    let top = rect.top + coords.top - ta.scrollTop + coords.lineHeight + 4;
    if (left + POPUP_W > window.innerWidth - 8) left = window.innerWidth - POPUP_W - 8;
    if (left < 8) left = 8;
    if (top + POPUP_H > window.innerHeight - 8) top = rect.top + coords.top - ta.scrollTop - POPUP_H - 6;
    if (top < 8) top = 8;
    return setAc({ open: true, items, index: 0, top, left });
  };

  const acceptSuggestion = (item, ta) => {
    if (!item || !ta) return;
    const pos = ta.selectionStart;
    const openIdx = value.slice(0, pos).lastIndexOf('{{');
    if (openIdx === -1) return closeAC();
    const insert = item.token + (item.partial ? '' : '}}');
    const next = value.slice(0, openIdx + 2) + insert + value.slice(pos);
    pendingCaret.current = openIdx + 2 + insert.length;
    closeAC();
    onChange({ target: { value: next } });
  };

  const handleChange = (e) => {
    pendingCaret.current = e.target.selectionStart;
    onChange(e);
    refreshAC(e.target);
  };

  const onEditorKeyDown = (e) => {
    if (!ac.open) return;
    const n = ac.items.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setAc((a) => ({ ...a, index: (a.index + 1) % n }));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setAc((a) => ({ ...a, index: (a.index - 1 + n) % n }));
    } else if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault();
      acceptSuggestion(ac.items[ac.index], e.target);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // don't also close the fullscreen dialog
      closeAC();
    }
  };

  const makeScroll = (backR) => (e) => {
    if (backR.current) {
      backR.current.scrollTop = e.target.scrollTop;
      backR.current.scrollLeft = e.target.scrollLeft;
    }
    if (ac.open) refreshAC(e.target);
  };

  const shared = {
    position: 'absolute',
    inset: 0,
    margin: 0,
    padding: 'var(--space-5)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--leading-prose)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    overflow: 'auto',
  };

  // The backdrop + transparent textarea pair, reused inline and in the dialog.
  const surface = (taR, backR, h) => (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: h,
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        overflow: 'hidden',
        background: 'var(--code-bg)',
      }}
    >
      <div ref={backR} aria-hidden style={{ ...shared, color: 'var(--text)', pointerEvents: 'none' }}>
        {renderHighlighted(value || ' ', available, allowExtra)}
      </div>
      <textarea
        ref={taR}
        value={value}
        onChange={handleChange}
        onScroll={makeScroll(backR)}
        onKeyDown={onEditorKeyDown}
        onSelect={(e) => refreshAC(e.target)}
        onBlur={() => setTimeout(closeAC, 120)}
        spellCheck={false}
        style={{
          ...shared,
          border: 'none',
          outline: 'none',
          resize: 'none',
          background: 'transparent',
          color: 'transparent',
          caretColor: 'var(--accent)',
        }}
      />
    </div>
  );

  return (
    <>
      <div style={{ position: 'relative' }}>
        {surface(taRef, backRef, height)}
        {expandable && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            title="Expand editor (full screen)"
            className="btn btn--sm"
            style={{
              position: 'absolute',
              right: 'var(--space-4)',
              bottom: 'var(--space-4)',
              background: 'var(--surface)',
              boxShadow: 'var(--shadow-pop)',
            }}
          >
            Expand
          </button>
        )}
      </div>

      {expanded && (
        <div
          className="scrim"
          onClick={() => setExpanded(false)}
          role="presentation"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 'var(--space-6)',
          }}
        >
          <div
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-label={title}
            onClick={(e) => e.stopPropagation()}
            style={{
              display: 'flex',
              width: 'min(1100px, 100%)',
              height: '92dvh',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            <div className="dialog-head" style={{ alignItems: 'center' }}>
              <h2 className="dialog-title">{title}</h2>
              <button
                type="button"
                className="btn btn--icon btn--sm"
                aria-label="Close (Esc)"
                title="Close (Esc)"
                onClick={() => setExpanded(false)}
              >
                ×
              </button>
            </div>
            <div style={{ flex: 1, minHeight: 0, padding: 'var(--space-6)' }}>
              {surface(modalTaRef, modalBackRef, '100%')}
            </div>
            {paletteChips && paletteChips.length > 0 && (
              <div
                style={{
                  flex: 'none',
                  borderTop: '1px solid var(--border)',
                  padding: 'var(--space-5) var(--space-6)',
                  maxHeight: '26vh',
                  overflowY: 'auto',
                }}
              >
                <div
                  style={{
                    marginBottom: 'var(--space-3)',
                    color: 'var(--text-2)',
                    fontSize: 'var(--text-xs)',
                  }}
                >
                  Available keys, click to insert
                </div>
                <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                  {paletteChips.map((c, i) => (
                    <span
                      key={i}
                      onClick={() => doInsert(c.token)}
                      className={c.accent ? 'chip chip--code chip--accent' : 'chip chip--code'}
                      style={{ cursor: 'pointer' }}
                    >
                      {c.label}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* {{…}} autocomplete popup, fixed to the caret position */}
      {ac.open && (
        <div
          className="menu-pop"
          style={{
            position: 'fixed',
            top: ac.top,
            left: ac.left,
            right: 'auto',
            zIndex: 'var(--z-toast)',
            width: POPUP_W,
            maxHeight: POPUP_H,
            overflowY: 'auto',
            padding: 'var(--space-1)',
          }}
        >
          {ac.items.map((it, i) => (
            <div
              key={`${it.token}-${i}`}
              className="menu-item"
              onMouseDown={(e) => {
                e.preventDefault(); // keep textarea focus
                acceptSuggestion(it, activeTa());
              }}
              onMouseEnter={() => setAc((a) => ({ ...a, index: i }))}
              style={{
                height: 'auto',
                justifyContent: 'space-between',
                gap: 'var(--space-4)',
                padding: 'var(--space-2) var(--space-3)',
                background: i === ac.index ? 'var(--accent-subtle)' : 'transparent',
              }}
            >
              <span
                className="mono"
                style={{
                  fontSize: 'var(--text-xs)',
                  color: i === ac.index ? 'var(--accent-strong)' : 'var(--text)',
                }}
              >
                {it.label}
              </span>
              <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-3)' }}>{it.hint}</span>
            </div>
          ))}
          <div
            style={{
              display: 'flex',
              gap: 'var(--space-4)',
              marginTop: 'var(--space-1)',
              padding: 'var(--space-2) var(--space-3) var(--space-1)',
              borderTop: '1px solid var(--border-2)',
              color: 'var(--text-3)',
              fontSize: 'var(--text-2xs)',
            }}
          >
            <span>
              <kbd className="kbd">up/down</kbd> navigate
            </span>
            <span>
              <kbd className="kbd">tab</kbd> insert
            </span>
            <span>
              <kbd className="kbd">esc</kbd> close
            </span>
          </div>
        </div>
      )}
    </>
  );
});
