import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import Sidebar from "./Sidebar";
import Topbar from "./Topbar";
import ChatFab from "./ChatFab";
import { usePresenceHeartbeat } from "../lib/presence";
import { NavContext } from "./NavContext";

export default function Layout() {
  usePresenceHeartbeat();
  const [navOpen, setNavOpen] = useState(false);

  // On iOS the WKWebView reports env(safe-area-inset-*) as 0 right after the app
  // shell mounts (e.g. on first login), so the fixed header renders OVER the
  // status bar until something forces a re-layout. A plain resize event doesn't
  // recompute the insets — but briefly toggling the viewport meta's viewport-fit
  // does. Kick it a few times over the first second so the header settles below
  // the status bar from the start (this also fixes the full-screen proposal).
  useEffect(() => {
    const meta = document.querySelector('meta[name="viewport"]') as HTMLMetaElement | null;
    const base = meta?.getAttribute("content") || "";
    const kick = () => {
      void document.body.offsetHeight;
      window.dispatchEvent(new Event("resize"));
      if (meta && base.includes("viewport-fit=cover")) {
        meta.setAttribute("content", base.replace("viewport-fit=cover", "viewport-fit=auto"));
        requestAnimationFrame(() => meta.setAttribute("content", base));
      }
    };
    const timers = [80, 350, 800].map((ms) => window.setTimeout(kick, ms));
    return () => timers.forEach((t) => clearTimeout(t));
  }, []);

  return (
    <NavContext.Provider value={{ openNav: () => setNavOpen(true) }}>
      <div className={"app-shell" + (navOpen ? " nav-open" : "")}>
        <Sidebar onNavigate={() => setNavOpen(false)} />
        <div className="nav-backdrop" onClick={() => setNavOpen(false)} />
        <div className="app-main">
          <Topbar onMenu={() => setNavOpen(true)} />
          <main className="app-content">
            <Outlet />
          </main>
        </div>
        <ChatFab />
      </div>
    </NavContext.Provider>
  );
}
