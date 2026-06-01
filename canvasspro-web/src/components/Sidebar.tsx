import { NavLink } from "react-router-dom";

const links = [
  { to: "/", label: "Dashboard", icon: "▦", end: true },
  { to: "/map", label: "Map", icon: "◉" },
  { to: "/leads", label: "Leads", icon: "☰" },
  { to: "/chat", label: "Team Chat", icon: "💬" },
  { to: "/schedule", label: "Schedule", icon: "📅" },
  { to: "/team", label: "Team", icon: "⛩" },
  { to: "/stats", label: "Analytics", icon: "★" },
  { to: "/working", label: "Who's Working", icon: "🔥" },
  { to: "/leaderboard", label: "Leaderboard", icon: "🏆" },
  { to: "/gamify", label: "Gamify", icon: "🎮" },
  { to: "/rewards", label: "Rewards", icon: "🎁" },
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
      <div className="brand-sub" style={{ marginTop: "auto", padding: "8px" }}>
        build BUILD-24
      </div>
    </aside>
  );
}
