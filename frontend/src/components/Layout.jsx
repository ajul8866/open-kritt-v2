import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar.jsx';
import Topbar from './Topbar.jsx';
import ShareResultDialog from './ShareResultDialog.jsx';
import { useTheme } from '../context/ui.jsx';

export default function Layout() {
  const { theme } = useTheme();
  const { pathname } = useLocation();
  const [communityShareOpen, setCommunityShareOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  return (
    <div className="app-shell" data-theme={theme}>
      <Sidebar
        open={menuOpen}
        onNavigate={() => setMenuOpen(false)}
        onShareCommunity={() => setCommunityShareOpen(true)}
      />
      {menuOpen && (
        <button className="scrim" type="button" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />
      )}
      {communityShareOpen && <ShareResultDialog mode="community" onClose={() => setCommunityShareOpen(false)} />}
      <div className="app-main">
        <Topbar menuOpen={menuOpen} onOpenMenu={() => setMenuOpen(true)} />
        <div className="app-scroll">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
