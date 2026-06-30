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

  // On iOS the WKWebView often hasn't settled its safe-area insets / viewport
  // height the instant the app shell mounts after login, so the fixed header
  // and content render at the wrong size until the first tap forces a reflow.
  // Nudge a couple of reflows once we're mounted so it's correct from the start.
  useEffect(() => {
    const fire = () => {
      // Reading offsetHeight forces a synchronous layout, then a resize event
      // re-runs anything that measures the viewport.
      void document.body.offsetHeight;
      window.dispatchEvent(new Event("resize"));
    };
    const r = requestAnimationFrame(fire);
    const t = setTimeout(fire, 300);
    return () => {
      cancelAnimationFrame(r);
      clearTimeout(t);
    };
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
