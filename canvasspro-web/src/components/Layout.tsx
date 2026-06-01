import { useState } from "react";
import { Outlet } from "react-router-dom";
import Sidebar from "./Sidebar";
import Topbar from "./Topbar";
import ChatFab from "./ChatFab";
import { usePresenceHeartbeat } from "../lib/presence";
import { NavContext } from "./NavContext";

export default function Layout() {
  usePresenceHeartbeat();
  const [navOpen, setNavOpen] = useState(false);

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
