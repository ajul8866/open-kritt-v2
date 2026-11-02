import { Link, useLocation } from 'react-router-dom';
import { useTheme } from '../context/ui.jsx';
import Logo from './Logo.jsx';

function NavItem({ label, to, active }) {
  return (
    <Link className={active ? 'nav-item is-active' : 'nav-item'} to={to}>
      <span className="nav-mark" aria-hidden="true" />
      {label}
    </Link>
  );
}

export const COMMUNITY_LINKS = [
  { label: 'GitHub', href: 'https://github.com/Kritt-ai/open-kritt' },
  { label: 'X / Twitter', href: 'https://x.com/Kritt_AI' },
  { label: 'Website', href: 'https://kritt.ai/' },
  { label: 'Discord', href: 'https://discord.gg/JJr2CbBjc' },
  { label: 'Contact us', href: 'mailto:info@kritt.ai', external: false },
];

export function CommunityLinks() {
  return (
    <nav className="sidebar-community-links" aria-label="Project and community links">
      {COMMUNITY_LINKS.map(({ label, href, external = true }) => (
        <a
          className="sidebar-community-link"
          href={href}
          key={href}
          {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
        >
          {label}
        </a>
      ))}
    </nav>
  );
}

export function CommunityShareButton({ onClick }) {
  return (
    <button type="button" className="sidebar-community-share" onClick={onClick}>
      Support open·kritt
    </button>
  );
}

export default function Sidebar({ onShareCommunity, open = false, onNavigate }) {
  const { pathname } = useLocation();
  const { theme, toggle } = useTheme();

  const isActive = (base, exact = false) =>
    exact ? pathname === base : pathname === base || pathname.startsWith(base + '/');

  const lt = theme === 'light';

  return (
    <div
      id="app-nav"
      className={open ? 'app-sidebar is-open' : 'app-sidebar'}
      onClick={(event) => {
        if (event.target.closest('a')) onNavigate?.();
      }}
    >
      <div className="sidebar-inner">
        <Link className="sidebar-brand" to="/">
          <Logo size={30} color="var(--accent)" />
          <span className="sidebar-brand-name">
            open<span className="brand-dot">·</span>kritt
          </span>
        </Link>

        <div className="nav-group" role="group" aria-label="Operate">
          <div className="nav-group-label">Operate</div>
          <NavItem label="Overview" to="/" active={isActive('/', true)} />
          <NavItem label="Workflows" to="/workflows" active={isActive('/workflows')} />
          <NavItem label="Scans" to="/scans" active={isActive('/scans')} />
        </div>

        <div className="nav-group" role="group" aria-label="Configure">
          <div className="nav-group-label">Configure</div>
          <NavItem label="Agent skills" to="/agent-skills" active={isActive('/agent-skills')} />
          <NavItem label="Severity rankers" to="/severity-rankers" active={isActive('/severity-rankers')} />
          <NavItem label="Post-scripts" to="/post-scripts" active={isActive('/post-scripts')} />
        </div>

        <div className="nav-group" role="group" aria-label="Workspace">
          <div className="nav-group-label">Workspace</div>
          <NavItem label="Accounts" to="/accounts" active={isActive('/accounts')} />
          <NavItem label="Settings" to="/settings" active={isActive('/settings')} />
        </div>

        <div className="sidebar-spacer" />

        <div className="sidebar-community">
          <div className="sidebar-community-label">Community</div>
          <CommunityLinks />
          <CommunityShareButton onClick={onShareCommunity} />
        </div>

        <div className="sidebar-foot">
          <button
            className="theme-toggle"
            type="button"
            onClick={toggle}
            aria-label={lt ? 'Switch to the dark theme' : 'Switch to the light theme'}
          >
            <span className={lt ? 'theme-option is-active' : 'theme-option'}>Light</span>
            <span className={lt ? 'theme-option' : 'theme-option is-active'}>Dark</span>
          </button>
          <div className="engine-line">
            <span className="engine-dot" aria-hidden="true" />
            <span>Engine online</span>
            <span className="engine-version mono">v{__APP_VERSION__}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
