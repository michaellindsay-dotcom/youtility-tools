import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { computePoints, levelInfo, tierFor, pointLines } from "../lib/points";
import type { UserStats } from "../types";

const BADGES = [
  { key: "first_blood", label: "First Knock", emoji: "👊", test: (s: UserStats) => (s.doorsKnocked ?? 0) >= 1 },
  { key: "centurion", label: "100 Doors", emoji: "💯", test: (s: UserStats) => (s.doorsKnocked ?? 0) >= 100 },
  { key: "closer", label: "First Sale", emoji: "💰", test: (s: UserStats) => (s.sales ?? 0) >= 1 },
  { key: "setter", label: "10 Appointments", emoji: "📅", test: (s: UserStats) => (s.appointments ?? 0) >= 10 },
  { key: "grinder", label: "500 Doors", emoji: "⚙️", test: (s: UserStats) => (s.doorsKnocked ?? 0) >= 500 },
  { key: "rainmaker", label: "10 Sales", emoji: "🌧️", test: (s: UserStats) => (s.sales ?? 0) >= 10 },
];

export default function Gamify() {
  const { profile } = useAuth();
  const [stats, setStats] = useState<UserStats | null>(null);

  useEffect(() => {
    if (!profile) return;
    return onSnapshot(doc(db, "userStats", profile.uid), (snap) =>
      setStats(snap.exists() ? ({ uid: snap.id, ...(snap.data() as Omit<UserStats, "uid">) }) : null)
    );
  }, [profile]);

  const s = stats || ({ uid: profile?.uid || "", companyId: profile?.companyId || "", managerPath: [] } as UserStats);
  const points = computePoints(s);
  const lvl = levelInfo(points);
  const tier = tierFor(lvl.level);
  const lines = pointLines(s);

  return (
    <div className="page-body">
      <div className="page-head">
        <h1>Gamify</h1>
        <p className="page-sub">Earn points, level up, and collect badges.</p>
      </div>

      <div className="card gamify-hero" style={{ ["--tier" as string]: tier.color }}>
        <div className="gamify-level">
          <div className="ring-pct">L{lvl.level}</div>
          <div className="lb-tier" style={{ background: tier.color, marginTop: 6 }}>{tier.emoji} {tier.name}</div>
        </div>
        <div className="gamify-stats">
          <div className="stat-value">{points.toLocaleString()} pts</div>
          <div className="lb-hero-chips" style={{ marginTop: 8 }}>
            {lines.filter((l) => l.count > 0).map((l) => (
              <span key={l.key} className="lb-chip" title={`${l.count} × ${l.per} = ${l.total}`}>{l.emoji} {l.count}</span>
            ))}
          </div>
          <div className="goal-bar" style={{ marginTop: 10 }}>
            <span style={{ width: `${lvl.pct}%` }} />
          </div>
          <div className="muted small" style={{ marginTop: 6 }}>{lvl.toNext} pts to Level {lvl.level + 1}</div>
        </div>
      </div>

      <h2 className="section-h">Badges</h2>
      <div className="badge-grid">
        {BADGES.map((b) => {
          const earned = b.test(s);
          return (
            <div key={b.key} className={"badge-card card" + (earned ? " earned" : "")}>
              <div className="badge-emoji">{b.emoji}</div>
              <div className="badge-label">{b.label}</div>
              <div className="muted small">{earned ? "Earned" : "Locked"}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
