import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Menu, Search } from 'lucide-react';
import { useChrome } from '../context/ui.jsx';
import CommandPalette from './CommandPalette.jsx';

export default function Topbar({ onOpenMenu, menuOpen = false }) {
  const { chrome } = useChrome();
  const crumbs = chrome.crumbs || [];
  const primary = chrome.primaryAction;
  const [searchOpen, setSearchOpen] = useState(false);

  // ⌘K / Ctrl-K toggles the global search palette anywhere in the app.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setSearchOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <div className="topbar">
        <div className="topbar-crumbs">
          <button
            className="menu-btn"
            type="button"
            aria-label="Open navigation"
            aria-expanded={menuOpen}
            aria-controls="app-nav"
            onClick={onOpenMenu}
          >
            <Menu size={16} strokeWidth={1.75} />
          </button>
          {crumbs.length > 1 &&
            crumbs.map((c, i) => (
              <span className={i === crumbs.length - 1 ? 'crumb is-active' : 'crumb'} key={`${c.label}-${i}`}>
                {c.to ? (
                  <Link className="crumb-link" to={c.to}>
                    {c.label}
                  </Link>
                ) : (
                  c.label
                )}
                {i < crumbs.length - 1 && <span className="crumb-sep"> / </span>}
              </span>
            ))}
        </div>

        <div className="topbar-actions">
          <button className="search-btn" type="button" aria-label="Search" onClick={() => setSearchOpen(true)}>
            <Search size={14} strokeWidth={1.75} />
            <span className="search-label">Search</span>
            <span className="search-kbd">⌘K</span>
          </button>
          {primary?.to ? (
            <Link className="btn btn--primary" to={primary.to}>
              {primary.label}
            </Link>
          ) : primary ? (
            <button className="btn btn--primary" type="button" onClick={primary.onClick}>
              {primary.label}
            </button>
          ) : null}
        </div>
      </div>
      <CommandPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
    </>
  );
}
