import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import Sidebar from "./Sidebar";
import Topbar from "./Topbar";
import ChatFab from "./ChatFab";
import LocationGate from "./LocationGate";
import { usePresenceHeartbeat } from "../lib/presence";
import { NavContext, type PreviewPos } from "./NavContext";

export default function Layout() {
  usePresenceHeartbeat();
  const [navOpen, setNavOpen] = useState(false);
  // Admin "preview menu as" role — set on the Settings page, read by the
  // Sidebar. Lives here so it survives route changes (Layout doesn't unmount).
  const [previewPos, setPreviewPos] = useState<PreviewPos>("");

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
    <NavContext.Provider value={{ openNav: () => setNavOpen(true), previewPos, setPreviewPos }}>
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
        <LocationGate />
      </div>
    </NavContext.Provider>
  );
}
