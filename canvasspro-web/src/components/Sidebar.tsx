import { NavLink } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { hasFeature, type FeatureKey } from "../lib/features";

const links: { to: string; label: string; icon: string; end?: boolean; feat?: FeatureKey }[] = [
  { to: "/", label: "Dashboard", icon: "▦", end: true },
  { to: "/map", label: "Map", icon: "◉" },
  { to: "/leads", label: "Leads", icon: "☰" },
  { to: "/chat", label: "Team Chat", icon: "💬", feat: "chat" },
  { to: "/schedule", label: "Schedule", icon: "📅", feat: "scheduling" },
  { to: "/team", label: "Team", icon: "⛩" },
  { to: "/stats", label: "Analytics", icon: "★", feat: "analytics" },
  { to: "/working", label: "Who's Working", icon: "🔥", feat: "chat" },
  { to: "/leaderboard", label: "Leaderboard", icon: "🏆", feat: "rewards" },
  { to: "/gamify", label: "Gamify", icon: "🎮", feat: "rewards" },
  { to: "/rewards", label: "Rewards", icon: "🎁", feat: "rewards" },
  { to: "/territories", label: "Territories", icon: "▰" },
  { to: "/settings", label: "Settings", icon: "⚐" },
];

export default function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { company } = useAuth();
  const visible = links.filter((l) => !l.feat || hasFeature(company, l.feat));
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
        {visible.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            end={l.end}
            onClick={onNavigate}
            className={({ isActive }) => "nav-link" + (isActive ? " active" : "")}
          >
            <span className="nav-icon">{l.icon}</span>
            {l.label}
          </NavLink>
        ))}
      </nav>
      <div className="brand-sub" style={{ marginTop: "auto", padding: "8px" }}>
        build BUILD-47
      </div>
    </aside>
  );
}
