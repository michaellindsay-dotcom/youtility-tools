import { useEffect, useState } from "react";
import { Outlet, Navigate, useLocation } from "react-router-dom";
import Sidebar from "./Sidebar";
import Topbar from "./Topbar";
import ChatFab from "./ChatFab";
import LocationGate from "./LocationGate";
import CloserDispositionGate from "./CloserDispositionGate";
import { usePresenceHeartbeat } from "../lib/presence";
import { useAuth } from "../auth/AuthContext";
import { NavContext } from "./NavContext";

// A dedicated dispatcher (Scheduler only) can reach just the Scheduler + their
// account/chat — everything else redirects to the dispatch board.
const SCHEDULER_ONLY_PATHS = new Set(["/scheduler", "/settings", "/chat"]);

export default function Layout() {
  usePresenceHeartbeat();
  const { profile, role } = useAuth();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const schedulerLocked = profile?.schedulerOnly === true && role !== "admin" && role !== "superadmin";

  // Nudge a reflow once the shell mounts so anything that measures the viewport
  // (map, sticky bars) settles after the login→app transition. The status-bar
  // placement itself is handled natively (StatusBar.setOverlaysWebView) in main.
  useEffect(() => {
    const fire = () => {
      void document.body.offsetHeight;
      window.dispatchEvent(new Event("resize"));
    };
    const r = requestAnimationFrame(fire);
    const t = window.setTimeout(fire, 300);
    return () => { cancelAnimationFrame(r); clearTimeout(t); };
  }, []);

  return (
    <NavContext.Provider value={{ openNav: () => setNavOpen(true) }}>
      <div className={"app-shell" + (navOpen ? " nav-open" : "")}>
        <Sidebar onNavigate={() => setNavOpen(false)} />
        <div className="nav-backdrop" onClick={() => setNavOpen(false)} />
        <div className="app-main">
          <Topbar onMenu={() => setNavOpen(true)} />
          <main className="app-content">
            {schedulerLocked && !SCHEDULER_ONLY_PATHS.has(location.pathname)
              ? <Navigate to="/scheduler" replace />
              : <Outlet />}
          </main>
        </div>
        <ChatFab />
        <LocationGate />
        <CloserDispositionGate />
      </div>
    </NavContext.Provider>
  );
}
