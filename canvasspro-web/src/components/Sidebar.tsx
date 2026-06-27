import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { hasFeature, type FeatureKey } from "../lib/features";
import type { Role } from "../types";

// `feat` shows the link only when the plan has that feature; `anyFeat` shows it
// when the plan has any one of several. `mobileHidden` hides the link on the
// phone layout (Movers lives on the map; Leads/Team Chat are reachable from the
// main flow), keeping the mobile nav lean while desktop keeps the full list.
const links: { to: string; label: string; icon: string; end?: boolean; feat?: FeatureKey; anyFeat?: FeatureKey[]; roles?: Role[]; closer?: boolean; mobileHidden?: boolean }[] = [
  { to: "/", label: "Dashboard", icon: "▦", end: true },
  { to: "/map", label: "Map", icon: "◉" },
  { to: "/movers", label: "Movers", icon: "🚚", mobileHidden: true },
  { to: "/leads", label: "Leads", icon: "☰", mobileHidden: true },
  { to: "/chat", label: "Team Chat", icon: "💬", feat: "chat", mobileHidden: true },
  { to: "/schedule", label: "Schedule", icon: "📅", feat: "scheduling" },
  { to: "/shifts", label: "Success Planner", icon: "◎", anyFeat: ["planner", "analytics"] },
  { to: "/team", label: "Team", icon: "⛩" },
  { to: "/closer", label: "Closer", icon: "🤝", closer: true },
  { to: "/battery", label: "Battery Tool", icon: "🔋", closer: true },
  { to: "/reports", label: "Reports", icon: "📊", roles: ["admin", "manager"] },
  { to: "/pitches", label: "My Pitches", icon: "🎙️", feat: "pitch" },
  { to: "/training", label: "Training", icon: "🎓" },
  { to: "/pitch-library", label: "Pitch Library", icon: "🎬", feat: "pitch", roles: ["admin", "manager"] },
  { to: "/working", label: "Who's Working", icon: "🔥", feat: "chat" },
  { to: "/leaderboard", label: "Leaderboard", icon: "🏆", feat: "rewards" },
  { to: "/gamify", label: "Gamify", icon: "🎮", feat: "rewards" },
  { to: "/rewards", label: "Rewards", icon: "🎁", feat: "rewards" },
  { to: "/territories", label: "Territories", icon: "▰" },
  { to: "/settings", label: "Settings", icon: "⚐" },
];

export default function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { company, role, profile, logout } = useAuth();
  const navigate = useNavigate();
  const onSignOut = async () => {
    await logout();
    onNavigate?.();
    navigate("/login", { replace: true });
  };
  const visible = links.filter((l) => {
    if (l.closer && !(profile?.isCloser || role === "admin" || role === "manager")) return false;
    if (l.roles && !(role && l.roles.includes(role))) return false;
    if (l.anyFeat) return l.anyFeat.some((f) => hasFeature(company, f));
    return !l.feat || hasFeature(company, l.feat);
  });
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
            className={({ isActive }) => "nav-link" + (isActive ? " active" : "") + (l.mobileHidden ? " mobile-hidden" : "")}
          >
            <span className="nav-icon">{l.icon}</span>
            {l.label}
          </NavLink>
        ))}
      </nav>
      <div className="sidebar-foot">
        <button className="btn ghost sidebar-signout" onClick={onSignOut}>⏻ Sign out</button>
        <div className="brand-sub">build BUILD-48</div>
      </div>
    </aside>
  );
}
