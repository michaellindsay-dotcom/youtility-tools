import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { collection, getDocs, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { METRIC_EMOJI, METRIC_LABEL, valsFromCounts, valsFromStats, ZERO_VALS, type MetricVals } from "../lib/rewards";
import type { Reward, UserStats, Lead, Shift } from "../types";

const CONVO = new Set(["pipeline", "appointment", "not_interested", "sold"]);
const startOfWeek = () => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); d.setHours(0, 0, 0, 0); return d.getTime(); };
const startOfMonth = () => new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();

function isLive(r: Reward): boolean {
  if (!(r.active ?? true)) return false;
  const now = Date.now();
  if (r.startsAt && now < r.startsAt) return false;
  if (r.expiresAt && now > r.expiresAt) return false;
  return r.kind !== "store"; // benchmarks to chase, not the redeem store
}

// Compact rewards tracker for the dashboard: the reps' closest active rewards
// with progress, linking to the full Rewards board.
export default function DashboardRewards() {
  const { profile, role, companyId } = useAuth();
  const isAdmin = role === "admin";
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [myAll, setMyAll] = useState<MetricVals>(ZERO_VALS);
  const [teamAll, setTeamAll] = useState<MetricVals>(ZERO_VALS);
  const [myWeek, setMyWeek] = useState<MetricVals>(ZERO_VALS);
  const [myMonth, setMyMonth] = useState<MetricVals>(ZERO_VALS);

  useEffect(() => {
    if (!companyId) return;
    return onSnapshot(collection(db, "companies", companyId, "rewards"), (snap) =>
      setRewards(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Reward, "id">) }))));
  }, [companyId]);

  useEffect(() => {
    if (!profile || !companyId) return;
    const base = collection(db, "userStats");
    const q = isAdmin
      ? query(base, where("companyId", "==", companyId))
      : query(base, where("companyId", "==", companyId), where("managerPath", "array-contains", profile.uid));
    return onSnapshot(q, (snap) => {
      const rows = snap.docs.map((d) => ({ uid: d.id, ...(d.data() as Omit<UserStats, "uid">) }));
      const mine = rows.find((r) => r.uid === profile.uid);
      setMyAll(mine ? valsFromStats(mine) : ZERO_VALS);
      const sum = rows.reduce((a, r) => ({
        doorsKnocked: (a.doorsKnocked ?? 0) + (r.doorsKnocked ?? 0), leadsCreated: (a.leadsCreated ?? 0) + (r.leadsCreated ?? 0),
        appointments: (a.appointments ?? 0) + (r.appointments ?? 0), sales: (a.sales ?? 0) + (r.sales ?? 0), shifts: (a.shifts ?? 0) + (r.shifts ?? 0),
      }), {} as Partial<UserStats>);
      setTeamAll(valsFromStats(sum));
    });
  }, [profile, companyId, isAdmin]);

  useEffect(() => {
    if (!profile) return;
    let off = false;
    (async () => {
      const since = startOfMonth();
      const [leadSnap, shiftSnap] = await Promise.all([
        getDocs(query(collection(db, "leads"), where("assignedTo", "==", profile.uid), where("createdAt", ">=", since))),
        getDocs(query(collection(db, "shifts"), where("userId", "==", profile.uid), where("startAt", ">=", since))),
      ]);
      if (off) return;
      const leads = leadSnap.docs.map((d) => d.data() as Lead).filter((l) => l.verified !== false);
      const shifts = shiftSnap.docs.map((d) => d.data() as Shift);
      const calc = (ts: number) => {
        const ls = leads.filter((l) => (l.knockedAt || l.createdAt) >= ts);
        return valsFromCounts({ doors: ls.length, conv: ls.filter((l) => CONVO.has(l.status)).length, appt: ls.filter((l) => l.status === "appointment").length, sales: ls.filter((l) => l.status === "sold").length, shifts: shifts.filter((s) => s.startAt >= ts).length });
      };
      setMyMonth(calc(since)); setMyWeek(calc(startOfWeek()));
    })();
    return () => { off = true; };
  }, [profile]);

  const valueFor = (r: Reward): number => r.audience === "team" ? teamAll[r.metric] : (r.period === "weekly" ? myWeek : r.period === "monthly" ? myMonth : myAll)[r.metric];

  // Show the rewards not-yet-hit that the rep is closest to (max 3).
  const active = rewards.filter(isLive)
    .map((r) => ({ r, value: valueFor(r), pct: Math.min(100, Math.round((valueFor(r) / Math.max(1, r.target)) * 100)) }))
    .filter((x) => x.value < x.r.target)
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 3);

  if (active.length === 0) return null;

  return (
    <>
      <h2 className="section-h">🎁 Rewards in reach <Link to="/rewards" className="muted small" style={{ fontWeight: 400 }}>→</Link></h2>
      <div className="dash-2col">
        {active.map(({ r, value, pct }) => (
          <Link key={r.id} to="/rewards" className="card link-card" style={{ textDecoration: "none" }}>
            <div className="row between" style={{ alignItems: "baseline", gap: 8 }}>
              <strong>{METRIC_EMOJI[r.metric]} {r.name}</strong>
              <span className="muted small">{r.audience === "team" ? "Team" : "You"}</span>
            </div>
            <div className="reward-bar" style={{ marginTop: 8 }}><span style={{ width: `${pct}%` }} className={pct >= 100 ? "full" : ""} /></div>
            <div className="muted small" style={{ marginTop: 4 }}>
              {value.toLocaleString()} / {r.target.toLocaleString()} {METRIC_LABEL[r.metric].toLowerCase()} · {(r.target - value).toLocaleString()} to go 🔥
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}
