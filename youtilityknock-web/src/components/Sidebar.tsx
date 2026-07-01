import { useMemo, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { userHasService, isRallyCardOnly, type FeatureKey } from "../lib/features";
import type { Role, Position } from "../types";

// Roles an admin can preview the menu as (admin themselves sees everything).
const PREVIEW_POSITIONS: { value: Position; label: string }[] = [
  { value: "team_manager", label: "Team Manager" },
  { value: "closer_manager", label: "Closer Manager" },
  { value: "setter_manager", label: "Setter Manager" },
  { value: "closer", label: "Closer" },
  { value: "setter", label: "Setter" },
];

// `feat` shows the link only when the plan has that feature; `anyFeat` shows it
// when the plan has any one of several. `mobileHidden` hides the link on the
// phone layout (Movers lives on the map; Leads/Team Chat are reachable from the
// main flow), keeping the mobile nav lean while desktop keeps the full list.
// `canvassOnly` hides the link entirely for a RallyCard-only company (no
// canvassing map) — see `isRallyCardOnly` in lib/features.
const links: { to: string; label: string; icon: string; end?: boolean; feat?: FeatureKey; anyFeat?: FeatureKey[]; roles?: Role[]; closer?: boolean; mobileHidden?: boolean; canvassOnly?: boolean }[] = [
  { to: "/", label: "Dashboard", icon: "▦", end: true, canvassOnly: true },
  { to: "/map", label: "Map", icon: "◉", canvassOnly: true },
  { to: "/movers", label: "Movers", icon: "🚚", feat: "movers", mobileHidden: true, canvassOnly: true },
  { to: "/card", label: "RallyCard", icon: "🪪" },
  { to: "/leads", label: "Leads", icon: "☰", feat: "leads", mobileHidden: true },
  { to: "/chat", label: "Team Chat", icon: "💬", feat: "chat", mobileHidden: true },
  { to: "/schedule", label: "Schedule", icon: "📅", feat: "scheduling" },
  { to: "/shifts", label: "Success Planner", icon: "◎", anyFeat: ["planner", "analytics"], canvassOnly: true },
  { to: "/team", label: "Team", icon: "⛩", feat: "team" },
  { to: "/closer", label: "Closer", icon: "🤝", closer: true, canvassOnly: true },
  { to: "/battery", label: "Battery Tool", icon: "🔋", closer: true, feat: "battery", canvassOnly: true },
  { to: "/projects", label: "Sold Projects", icon: "📋", closer: true, canvassOnly: true },
  { to: "/reports", label: "Reports", icon: "📊", roles: ["admin", "manager"], canvassOnly: true },
  { to: "/pitches", label: "My Pitches", icon: "🎙️", feat: "pitch", canvassOnly: true },
  { to: "/training", label: "Training", icon: "🎓", feat: "voice", canvassOnly: true },
  { to: "/pitch-library", label: "Pitch Library", icon: "🎬", feat: "pitch", roles: ["admin", "manager"], canvassOnly: true },
  { to: "/working", label: "Who's Working", icon: "🔥", feat: "chat", canvassOnly: true },
  { to: "/leaderboard", label: "Leaderboard", icon: "🏆", feat: "rewards" },
  { to: "/gamify", label: "Gamify", icon: "🎮", feat: "rewards" },
  { to: "/rewards", label: "Rewards", icon: "🎁", feat: "rewards" },
  { to: "/territories", label: "Territories", icon: "▰", feat: "aiTerritories", canvassOnly: true },
  { to: "/settings", label: "Settings", icon: "⚐" },
];

export default function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { company, role, profile, team, logout } = useAuth();
  const navigate = useNavigate();
  const [previewPos, setPreviewPos] = useState<Position | "">("");
  const canPreview = role === "admin" || role === "superadmin";

  const onSignOut = async () => {
    await logout();
    onNavigate?.();
    navigate("/login", { replace: true });
  };

  // When an admin picks a role to preview, filter the menu AS IF they were that
  // position (a non-admin), so they can see the decluttered menu that role gets.
  // It's display-only — the admin's real access is unchanged.
  const eff = useMemo(() => {
    if (!previewPos || !canPreview) return { role, profile };
    const r: Role = previewPos.endsWith("_manager") ? "manager" : "user";
    const isCloser = previewPos === "closer" || previewPos === "closer_manager" || previewPos === "team_manager";
    return { role: r, profile: profile ? { ...profile, position: previewPos, isCloser, role: r } : profile };
  }, [previewPos, canPreview, role, profile]);

  // A company on a RallyCard-only plan (no "map" feature) gets the card +
  // lead capture + team competitions, with the canvassing-only tools removed
  // entirely rather than just hidden per-role — this company never had them.
  const rallyOnly = isRallyCardOnly(company);

  const visible = links.filter((l) => {
    if (l.canvassOnly && rallyOnly) return false;
    // Closer-only tools: gate on actually being a closer (closers, closer
    // managers and team managers all carry isCloser) or admin — NOT on the
    // generic manager tier, so a SETTER manager never sees closer information.
    if (l.closer && !(eff.profile?.isCloser || eff.role === "admin")) return false;
    if (l.roles && !(eff.role && l.roles.includes(eff.role))) return false;
    if (l.anyFeat) return l.anyFeat.some((f) => userHasService(company, eff.profile, team, f));
    return !l.feat || userHasService(company, eff.profile, team, l.feat);
  });
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">{rallyOnly ? "RC" : "YK"}</div>
        <div>
          <div className="brand-name">{rallyOnly ? "RallyCard" : "YoutilityKnock"}</div>
          <div className="brand-sub">{rallyOnly ? "Cards, leads & competitions" : "Field intel"}</div>
        </div>
      </div>

      {canPreview && (
        <div className="nav-preview" style={{ padding: "0 8px 12px" }}>
          <label className="brand-sub" style={{ display: "block", marginBottom: 4 }}>Preview menu as</label>
          <select
            value={previewPos}
            onChange={(e) => setPreviewPos(e.target.value as Position | "")}
            style={{ width: "100%", background: "rgba(255,255,255,0.05)", color: "var(--ink)", border: "1px solid var(--line)", borderRadius: 8, padding: "7px 8px", fontSize: 13 }}
          >
            <option value="">My menu (admin — all)</option>
            {PREVIEW_POSITIONS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
          {previewPos && (
            <div className="brand-sub" style={{ marginTop: 5, color: "#fbbf24" }}>
              Previewing — your own access is unchanged.
            </div>
          )}
        </div>
      )}

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
