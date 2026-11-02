import { useState, useEffect } from 'react';
import { FIELD_TYPES, rowsToObject, objectToRows } from '../lib/keys.js';

// Editable output-format schema with a visual (key/type rows) and a raw-JSON mode.
// `validateKey(key)` should return a message string for reserved-key violations,
// or null/undefined when the key is acceptable. Empty + duplicate checks are built in.
export default function SchemaEditor({
  rows,
  onRowsChange,
  mode,
  onToggleMode,
  validateKey = () => null,
  inputBg = 'var(--bg)',
  types = FIELD_TYPES,
}) {
  const [rawText, setRawText] = useState(null);
  const [rawErr, setRawErr] = useState(false);

  useEffect(() => {
    if (mode === 'raw' && rawText == null) {
      setRawText(JSON.stringify(rowsToObject(rows.filter((r) => r.key)), null, 2));
    }
    if (mode === 'visual') {
      setRawText(null);
      setRawErr(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const keyCount = {};
  rows.forEach((r) => {
    if (r.key) keyCount[r.key] = (keyCount[r.key] || 0) + 1;
  });

  const rowError = (row) => {
    if (!row.key) return 'name required';
    if (keyCount[row.key] > 1) return 'key already used in another step';
    return validateKey(row.key);
  };

  const setRow = (idx, patch) => {
    const next = rows.map((r, i) => (i === idx ? { ...r, ...patch } : r));
    onRowsChange(next);
  };
  const removeRow = (idx) => onRowsChange(rows.filter((_, i) => i !== idx));
  const addRow = () => onRowsChange([...rows, { key: '', type: 'string' }]);

  const onRaw = (e) => {
    const text = e.target.value;
    setRawText(text);
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* ignore */
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      onRowsChange(objectToRows(parsed));
      setRawErr(false);
    } else {
      setRawErr(true);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--space-4)' }}>
        <div className="filters" role="group" aria-label="Schema editor mode">
          <button
            type="button"
            className={mode === 'visual' ? 'filter is-active' : 'filter'}
            aria-pressed={mode === 'visual'}
            onClick={mode !== 'visual' ? onToggleMode : undefined}
          >
            Visual
          </button>
          <button
            type="button"
            className={mode === 'raw' ? 'filter is-active' : 'filter'}
            aria-pressed={mode === 'raw'}
            onClick={mode !== 'raw' ? onToggleMode : undefined}
          >
            JSON
          </button>
        </div>
      </div>

      {mode === 'visual' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          {rows.map((row, idx) => {
            const err = rowError(row);
            return (
              <div key={idx}>
                <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                  <input
                    value={row.key}
                    onChange={(e) => setRow(idx, { key: e.target.value.replace(/[^a-zA-Z0-9_]/g, '_') })}
                    spellCheck={false}
                    placeholder="key_name"
                    aria-invalid={err ? 'true' : undefined}
                    className="input mono"
                    style={{
                      flex: 1,
                      minWidth: 0,
                      background: inputBg,
                      color: 'var(--accent-strong)',
                    }}
                  />
                  <select
                    value={row.type}
                    onChange={(e) => setRow(idx, { type: e.target.value })}
                    className="select mono"
                    style={{ width: 104, flex: 'none', background: inputBg, color: 'var(--text-2)' }}
                  >
                    {types.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                  <span
                    onClick={() => removeRow(idx)}
                    style={{
                      color: 'var(--text-3)',
                      fontSize: 'var(--text-md)',
                      cursor: 'pointer',
                      flex: 'none',
                      width: 16,
                      textAlign: 'center',
                    }}
                  >
                    ×
                  </span>
                </div>
                {err && (
                  <div className="field-error" style={{ marginTop: 'var(--space-1)' }}>
                    {err}
                  </div>
                )}
              </div>
            );
          })}
          <button type="button" className="btn btn--sm" onClick={addRow} style={{ alignSelf: 'flex-start' }}>
            Add field
          </button>
        </div>
      ) : (
        <>
          <textarea
            value={rawText ?? ''}
            onChange={onRaw}
            spellCheck={false}
            rows={8}
            aria-invalid={rawErr ? 'true' : undefined}
            className="textarea mono"
            style={{
              background: 'var(--code-bg)',
              borderColor: rawErr ? 'var(--fail)' : undefined,
            }}
          />
          {rawErr && (
            <div className="field-error" style={{ marginTop: 'var(--space-2)' }}>
              Invalid JSON object. Keep editing to fix.
            </div>
          )}
        </>
      )}
    </div>
  );
}
