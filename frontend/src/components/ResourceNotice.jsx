import { Link } from 'react-router-dom';

export default function ResourceNotice({ notice }) {
  if (!notice) return null;
  return (
    <div
      className="resource-notice"
      onClick={(event) => event.stopPropagation()}
      style={{
        position: 'relative',
        zIndex: 2,
        marginTop: 'var(--space-5)',
        padding: 'var(--space-4) var(--space-5)',
        borderRadius: 'var(--radius-sm)',
        color: 'var(--text-2)',
        background: 'var(--pend-bg)',
        fontSize: 'var(--text-xs)',
        lineHeight: 'var(--leading-base)',
      }}
    >
      <div role="status">
        <strong>{notice.title}.</strong> {notice.message}
      </div>
      {(notice.detail || notice.remedy) && (
        <details style={{ marginTop: 'var(--space-2)' }}>
          <summary style={{ cursor: 'pointer', color: 'var(--text)' }}>Details and remedies</summary>
          {notice.detail && <p>{notice.detail}</p>}
          {notice.remedy && <p>{notice.remedy}</p>}
        </details>
      )}
      {notice.observedAt && (
        <div aria-live="off" style={{ marginTop: 'var(--space-2)', fontSize: 'var(--text-2xs)' }}>
          Measured <time dateTime={notice.observedAt}>{new Date(notice.observedAt).toLocaleString()}</time>
        </div>
      )}
      {notice.fixLinks?.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-5)', marginTop: 'var(--space-2)' }}>
          {notice.fixLinks.map((link) => (
            <Link key={link.url} to={link.url} style={{ color: 'var(--accent-strong)', textDecoration: 'underline' }}>
              {link.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
