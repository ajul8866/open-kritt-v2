// Small shared presentational components used across screens.
import { Link } from 'react-router-dom';
import { statusMeta } from '../lib/format.js';
import { StatusGlyph } from './ui/status-glyph.jsx';

const STATUS_CLASS = {
  completed: 'status--ok',
  running: 'status--run',
  prewarming_cache: 'status--pend',
  post_processing: 'status--run',
  paused: 'status--stop',
  queued: 'status--pend',
  pending: 'status--pend',
  rate_limited: 'status--pend',
  failed: 'status--fail',
  stopped: 'status--stop',
};

export function Spinner({ label = 'Loading…' }) {
  return (
    <div className="loading-line">
      <span className="spinner" />
      {label}
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  return (
    <div className="state-block state-block--error" role="alert">
      <div className="state-title">Something went wrong</div>
      <div className="state-note">{error?.message || 'Failed to load.'}</div>
      {onRetry && (
        <button className="btn btn--sm" type="button" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, sub, action }) {
  return (
    <div className="state-block">
      <div className="state-title">{title}</div>
      {sub && <div className="state-note">{sub}</div>}
      {action && <div style={{ marginTop: 'var(--space-2)' }}>{action}</div>}
    </div>
  );
}

// Work that is actually in progress gets the Solid Glass activity glyph; states
// that are only waiting (queued, pending, rate-limited) keep the static tint.
const ACTIVE_GLYPHS = {
  running: 'running',
  prewarming_cache: 'searching',
  post_processing: 'writing',
};

export function StatusBadge({ status, reasoning, size = 'md' }) {
  const m = statusMeta(status, reasoning);
  const glyph = ACTIVE_GLYPHS[status];
  return (
    <span
      className={`status ${STATUS_CLASS[status] || 'status--stop'}`}
      style={size === 'sm' ? { height: 20 } : undefined}
    >
      {glyph && <StatusGlyph activity={glyph} className="size-3" />}
      {m.label}
    </span>
  );
}

export function Toggle({ on, onClick, label }) {
  return (
    <label className="checkbox-row" style={{ userSelect: 'none' }}>
      <input className="checkbox" type="checkbox" checked={on} onChange={onClick} />
      {label}
    </label>
  );
}

export function SectionLabel({ children, style }) {
  return (
    <div className="field-label" style={{ color: 'var(--text-2)', fontWeight: 500, ...style }}>
      {children}
    </div>
  );
}

// A button that follows the accent / muted styling used in the mockup.
export function Button({ children, onClick, variant = 'primary', disabled, style, type = 'button', to, ...props }) {
  const variantClass =
    variant === 'primary'
      ? 'btn btn--primary'
      : variant === 'ghost'
        ? 'btn'
        : variant === 'subtle'
          ? 'btn btn--soft'
          : variant === 'danger'
            ? 'btn btn--danger'
            : 'btn';
  const combinedStyle = { textDecoration: 'none', ...style };
  if (to && !disabled) {
    return (
      <Link to={to} onClick={onClick} className={variantClass} style={combinedStyle} {...props}>
        {children}
      </Link>
    );
  }
  return (
    <button type={type} disabled={disabled} onClick={onClick} className={variantClass} style={combinedStyle} {...props}>
      {children}
    </button>
  );
}

// Makes an entire card/row a native link while allowing sibling controls to
// sit above it with position: relative and z-index: 2.
export function CardLinkOverlay({ to, label, style }) {
  return (
    <Link
      to={to}
      aria-label={label}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 1,
        borderRadius: 'inherit',
        color: 'inherit',
        textDecoration: 'none',
        ...style,
      }}
    />
  );
}

// A key chip — colored by whether the reference resolves.
export function KeyChip({ name, ok = true, from }) {
  return (
    <span
      className="chip chip--code"
      style={{
        color: ok ? 'var(--ok)' : 'var(--fail)',
        background: ok ? 'var(--ok-bg)' : 'var(--fail-bg)',
        borderColor: 'transparent',
      }}
    >
      {name}
      {from && <span style={{ color: 'var(--text-3)' }}> / {from}</span>}
    </span>
  );
}
