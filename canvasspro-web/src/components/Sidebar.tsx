import { NavLink } from "react-router-dom";

const links = [
  { to: "/", label: "Dashboard", icon: "▦", end: true },
  { to: "/lookup", label: "Address Lookup", icon: "⌖" },
  { to: "/leads", label: "Leads", icon: "☰" },
  { to: "/team", label: "Team", icon: "⛩" },
  { to: "/shifts", label: "Shifts", icon: "◷" },
  { to: "/stats", label: "Stats", icon: "★" },
  { to: "/territories", label: "Territories", icon: "▰" },
  { to: "/settings", label: "Settings", icon: "⚐" },
];

export default function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">YK</div>
        <div>
          <div className="brand-name">YoutilityKnock</div>
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
      </nav>
    </aside>
  );
}
