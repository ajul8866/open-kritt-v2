// Layout furniture for the console screens: the page frame, its head, the
// figure strip, and the panel. Every page reads the same scale from these.

export function Page({ children, style }) {
  return (
    <div className="page" style={style}>
      {children}
    </div>
  );
}

export function PageHeader({ title, meta, actions, badge, aside }) {
  return (
    <header className="page-head">
      <div className="page-head-main">
        <div className="page-title-row">
          <h1 className="page-title">{title}</h1>
          {badge}
        </div>
        {meta && <div className="page-sub">{meta}</div>}
      </div>
      {(actions || aside) && (
        <div className="page-actions">
          {aside}
          {actions}
        </div>
      )}
    </header>
  );
}

export function Toolbar({ children, end }) {
  return (
    <div className="toolbar">
      <div>{children}</div>
      {end}
    </div>
  );
}

export function Filters({ options, value, onChange, label = 'Filter' }) {
  return (
    <div className="filters" role="group" aria-label={label}>
      {options.map(([key, optionLabel, count]) => (
        <button
          key={key}
          type="button"
          className={value === key ? 'filter is-active' : 'filter'}
          aria-pressed={value === key}
          onClick={() => onChange(key)}
        >
          {optionLabel}
          {count != null && <span className="filter-count">{count}</span>}
        </button>
      ))}
    </div>
  );
}

export function FigureStrip({ children }) {
  return <div className="figures">{children}</div>;
}

export function Figure({ label, value, note, tone }) {
  const toneClass = tone === 'accent' ? ' figure-value--accent' : tone === 'fail' ? ' figure-value--fail' : '';
  return (
    <div className="figure">
      <div className="figure-label">{label}</div>
      <div className={`figure-value${toneClass}`}>{value}</div>
      {note && <div className="figure-note">{note}</div>}
    </div>
  );
}

export function Panel({ title, note, actions, children, style }) {
  return (
    <section className="panel" style={style}>
      {(title || actions) && (
        <div className="panel-head">
          <div>
            {title && <div className="panel-title">{title}</div>}
            {note && <div className="panel-note">{note}</div>}
          </div>
          {actions && <div style={{ display: 'flex', gap: 'var(--space-2)' }}>{actions}</div>}
        </div>
      )}
      <div className="panel-body">{children}</div>
    </section>
  );
}
