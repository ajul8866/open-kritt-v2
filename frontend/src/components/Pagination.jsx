import { ChevronLeft, ChevronRight } from 'lucide-react';
import { paginationTokens } from '../lib/pagination.js';

export default function Pagination({
  page,
  pageSize,
  totalItems,
  totalPages,
  startIndex,
  endIndex,
  setPage,
  itemLabel = 'items',
  compact = false,
  style,
}) {
  if (totalItems <= pageSize) return null;

  return (
    <nav
      aria-label={`${itemLabel} pagination`}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 10,
        ...style,
      }}
    >
      <span style={{ color: 'var(--text-2)', fontSize: 'var(--text-xs)' }}>
        {startIndex + 1}-{endIndex} of {totalItems} {itemLabel}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
        <button
          type="button"
          className="btn btn--icon btn--sm"
          aria-label={`Previous ${itemLabel} page`}
          disabled={page === 1}
          onClick={() => setPage(page - 1)}
        >
          <ChevronLeft size={14} strokeWidth={1.75} />
        </button>
        {paginationTokens(page, totalPages, compact ? 5 : 7).map((token) =>
          typeof token === 'number' ? (
            <button
              key={token}
              type="button"
              className={token === page ? 'btn btn--sm page-num is-active' : 'btn btn--sm page-num'}
              aria-label={`Page ${token}`}
              aria-current={token === page ? 'page' : undefined}
              onClick={() => setPage(token)}
            >
              {token}
            </button>
          ) : (
            <span key={token} aria-hidden="true" style={{ color: 'var(--text-3)', padding: '0 2px' }}>
              …
            </span>
          )
        )}
        <button
          type="button"
          className="btn btn--icon btn--sm"
          aria-label={`Next ${itemLabel} page`}
          disabled={page === totalPages}
          onClick={() => setPage(page + 1)}
        >
          <ChevronRight size={14} strokeWidth={1.75} />
        </button>
      </div>
    </nav>
  );
}
