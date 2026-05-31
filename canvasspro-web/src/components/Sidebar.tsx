import { NavLink } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

const links = [
  { to: "/", label: "Dashboard", icon: "▦", end: true },
  { to: "/lookup", label: "Address Lookup", icon: "⌖" },
  { to: "/leads", label: "Leads", icon: "☰" },
  { to: "/territories", label: "Territories", icon: "▰" },
];

export default function Sidebar() {
  const { role } = useAuth();
  const canAdmin = role === "admin" || role === "manager";

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">CP</div>
        <div>
          <div className="brand-name">Canvass Pro</div>
          <div className="brand-sub">Field intel</div>
        </div>
      </div>

      <nav className="nav">
        {links.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            end={l.end}
            className={({ isActive }) => "nav-link" + (isActive ? " active" : "")}
          >
            <span className="nav-icon">{l.icon}</span>
            {l.label}
          </NavLink>
        ))}
        {canAdmin && (
          <NavLink
            to="/admin"
            className={({ isActive }) => "nav-link" + (isActive ? " active" : "")}
          >
            <span className="nav-icon">⚙</span>
            Admin
          </NavLink>
        )}
        <NavLink
          to="/settings"
          className={({ isActive }) => "nav-link" + (isActive ? " active" : "")}
        >
          <span className="nav-icon">⚐</span>
          Settings
        </NavLink>
      </nav>
    </aside>
  );
}
