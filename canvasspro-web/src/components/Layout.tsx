import { Outlet, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import Sidebar from "./Sidebar";
import Topbar from "./Topbar";
import { usePresenceHeartbeat } from "../lib/presence";

export default function Layout() {
  usePresenceHeartbeat();
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
  // Close the mobile drawer whenever the route changes.
  useEffect(() => { setNavOpen(false); }, [location.pathname]);
  return (
    <div className="app-shell">
      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
      {navOpen && <div className="sidebar-backdrop" onClick={() => setNavOpen(false)} />}
      <div className="app-main">
        <Topbar onMenu={() => setNavOpen((v) => !v)} />
        <main className="app-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
