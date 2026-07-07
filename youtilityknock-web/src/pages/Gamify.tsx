import { useEffect, useState } from "react";
import { collection, doc, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { computePoints, levelInfo, tierFor, pointLines } from "../lib/points";
import type { UserStats } from "../types";

// A company-defined milestone ladder — reps climb the steps, each with a reward.
type MilestoneMetric = "doors" | "appointments" | "sales" | "points";
interface Milestone {
  id: string;
  name: string;
  metric: MilestoneMetric;
  steps: { threshold: number; reward: string }[];
  active?: boolean;
}
const METRIC_META: Record<MilestoneMetric, { label: string; emoji: string }> = {
  doors: { label: "doors", emoji: "🚪" },
  appointments: { label: "appointments", emoji: "📅" },
  sales: { label: "sales", emoji: "💰" },
  points: { label: "points", emoji: "🎮" },
};
const metricValue = (s: UserStats, m: MilestoneMetric): number =>
  m === "doors" ? (s.doorsKnocked ?? 0)
    : m === "appointments" ? (s.appointments ?? 0)
      : m === "sales" ? (s.sales ?? 0)
        : computePoints(s);

// Standard, predesigned milestone ladders shown to every company (recognition
// tiers). Companies can add their own on top via the admin "Gamify milestones".
const STANDARD_LADDERS: Milestone[] = [
  { id: "std-doors", name: "🚪 Door Warrior", metric: "doors", steps: [
    { threshold: 100, reward: "Century Club 💯" }, { threshold: 500, reward: "Grinder ⚙️" },
    { threshold: 1000, reward: "Iron Knocker 🦾" }, { threshold: 2500, reward: "Legend 👑" },
  ] },
  { id: "std-appts", name: "📅 Setter's Path", metric: "appointments", steps: [
    { threshold: 10, reward: "Setter 📅" }, { threshold: 50, reward: "Booking Machine 🔥" },
    { threshold: 100, reward: "Appointment King 👑" },
  ] },
  { id: "std-sales", name: "💰 Closer's Climb", metric: "sales", steps: [
    { threshold: 1, reward: "First Blood 💰" }, { threshold: 10, reward: "Rainmaker 🌧️" },
    { threshold: 25, reward: "Closer 🏆" }, { threshold: 50, reward: "Titan 💎" },
  ] },
];

const BADGES = [
  { key: "first_blood", label: "First Knock", emoji: "👊", test: (s: UserStats) => (s.doorsKnocked ?? 0) >= 1 },
  { key: "centurion", label: "100 Doors", emoji: "💯", test: (s: UserStats) => (s.doorsKnocked ?? 0) >= 100 },
  { key: "closer", label: "First Sale", emoji: "💰", test: (s: UserStats) => (s.sales ?? 0) >= 1 },
  { key: "setter", label: "10 Appointments", emoji: "📅", test: (s: UserStats) => (s.appointments ?? 0) >= 10 },
  { key: "grinder", label: "500 Doors", emoji: "⚙️", test: (s: UserStats) => (s.doorsKnocked ?? 0) >= 500 },
  { key: "rainmaker", label: "10 Sales", emoji: "🌧️", test: (s: UserStats) => (s.sales ?? 0) >= 10 },
];

export default function Gamify() {
  const { profile, companyId } = useAuth();
  const [stats, setStats] = useState<UserStats | null>(null);
  const [milestones, setMilestones] = useState<Milestone[]>([]);

  useEffect(() => {
    if (!profile) return;
    return onSnapshot(doc(db, "userStats", profile.uid), (snap) =>
      setStats(snap.exists() ? ({ uid: snap.id, ...(snap.data() as Omit<UserStats, "uid">) }) : null)
    );
  }, [profile]);

  useEffect(() => {
    if (!companyId) return;
    return onSnapshot(
      query(collection(db, "companies", companyId, "milestones"), where("active", "==", true)),
      (snap) => setMilestones(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Milestone, "id">) }))),
      (e) => console.error("milestones", e)
    );
  }, [companyId]);

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

      <h2 className="section-h" style={{ marginTop: 18 }}>🏅 Standard Milestones</h2>
      <div style={{ display: "grid", gap: 12 }}>
        {STANDARD_LADDERS.map((m) => <MilestoneLadder key={m.id} m={m} value={metricValue(s, m.metric)} />)}
      </div>

      {milestones.length > 0 && (
        <>
          <h2 className="section-h" style={{ marginTop: 18 }}>🎯 Company Milestones</h2>
          <div style={{ display: "grid", gap: 12 }}>
            {milestones.map((m) => <MilestoneLadder key={m.id} m={m} value={metricValue(s, m.metric)} />)}
          </div>
        </>
      )}
    </div>
  );
}

function MilestoneLadder({ m, value }: { m: Milestone; value: number }) {
  const meta = METRIC_META[m.metric];
  const steps = [...(m.steps || [])].sort((a, b) => a.threshold - b.threshold);
  const nextIdx = steps.findIndex((st) => value < st.threshold);
  const next = nextIdx >= 0 ? steps[nextIdx] : null;
  const prevThresh = nextIdx > 0 ? steps[nextIdx - 1].threshold : 0;
  const pct = next ? Math.round(((value - prevThresh) / (next.threshold - prevThresh)) * 100) : 100;

  return (
    <div className="card">
      <div className="row between" style={{ alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
        <strong>{m.name}</strong>
        <span className="muted small">{meta.emoji} {value.toLocaleString()} {meta.label}</span>
      </div>
      <div className="goal-bar" style={{ marginTop: 8 }}><span style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} /></div>
      <div className="muted small" style={{ marginTop: 4 }}>
        {next ? `${(next.threshold - value).toLocaleString()} ${meta.label} to “${next.reward}”` : "🎉 Ladder complete — every reward unlocked!"}
      </div>
      <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
        {steps.map((st, i) => {
          const reached = value >= st.threshold;
          return (
            <div key={i} className="row" style={{ alignItems: "center", gap: 8, opacity: reached ? 1 : 0.7 }}>
              <span style={{ fontSize: 15 }}>{reached ? "✅" : "⬜"}</span>
              <span style={{ fontWeight: 700, minWidth: 64 }}>{st.threshold.toLocaleString()} {meta.emoji}</span>
              <span className="muted small">→ {st.reward}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
