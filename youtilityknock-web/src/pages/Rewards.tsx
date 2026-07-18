import { useEffect, useRef, useState } from "react";
import { addDoc, collection, getDocs, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { confettiBurst } from "../lib/confetti";
import {
  METRIC_LABEL, METRIC_EMOJI, PERIOD_LABEL, valsFromCounts, valsFromStats, ZERO_VALS, type MetricVals,
} from "../lib/rewards";
import type { Reward, UserStats, Lead, Shift } from "../types";

const CONVO = new Set(["pipeline", "appointment", "not_interested", "sold"]);
const startOfWeek = () => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); d.setHours(0,0,0,0); return d.getTime(); };
const startOfMonth = () => new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();

// A reward shows only if it's active and inside its scheduled window (if any).
function isLive(r: Reward): boolean {
  if (!(r.active ?? true)) return false;
  const now = Date.now();
  if (r.startsAt && now < r.startsAt) return false;
  if (r.expiresAt && now > r.expiresAt) return false;
  return true;
}

// View-only rewards board. Reps see rewards + progress and can claim store
// rewards; ALL creation/management lives in the admin console (admin.html).
export default function Rewards() {
  const { profile, role, companyId } = useAuth();
  const isAdmin = role === "admin";
  const [rewards, setRewards] = useState<Reward[]>([]);

  const [myAll, setMyAll] = useState<MetricVals>(ZERO_VALS);
  const [myWeek, setMyWeek] = useState<MetricVals>(ZERO_VALS);
  const [myMonth, setMyMonth] = useState<MetricVals>(ZERO_VALS);
  const [teamAll, setTeamAll] = useState<MetricVals>(ZERO_VALS);
  const [claimed, setClaimed] = useState<Set<string>>(new Set());
  const [statsReady, setStatsReady] = useState(false);
  const [windowReady, setWindowReady] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const seenRef = useRef<Set<string> | null>(null);
  const seededRef = useRef(false);

  // Rewards (live).
  useEffect(() => {
    if (!companyId) return;
    return onSnapshot(collection(db, "companies", companyId, "rewards"), (snap) =>
      setRewards(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Reward, "id">) })))
    );
  }, [companyId]);

  // Team + my all-time from userStats.
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
      const sum = rows.reduce(
        (a, r) => ({
          doorsKnocked: (a.doorsKnocked ?? 0) + (r.doorsKnocked ?? 0),
          leadsCreated: (a.leadsCreated ?? 0) + (r.leadsCreated ?? 0),
          appointments: (a.appointments ?? 0) + (r.appointments ?? 0),
          sales: (a.sales ?? 0) + (r.sales ?? 0),
          shifts: (a.shifts ?? 0) + (r.shifts ?? 0),
        }),
        {} as Partial<UserStats>
      );
      setTeamAll(valsFromStats(sum));
      setStatsReady(true);
    });
  }, [profile, companyId, isAdmin]);

  // My windowed (week/month) numbers from leads + shifts.
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
      const wk = startOfWeek();
      const calc = (ts: number) => {
        const ls = leads.filter((l) => (l.knockedAt || l.createdAt) >= ts);
        return valsFromCounts({
          doors: ls.length,
          conv: ls.filter((l) => CONVO.has(l.status)).length,
          appt: ls.filter((l) => l.status === "appointment").length,
          sales: ls.filter((l) => l.status === "sold").length,
          shifts: shifts.filter((s) => s.startAt >= ts).length,
        });
      };
      setMyMonth(calc(since));
      setMyWeek(calc(wk));
      setWindowReady(true);
    })();
    return () => { off = true; };
  }, [profile]);

  const valueFor = (r: Reward): number => {
    if (r.audience === "team") return teamAll[r.metric];
    const bundle = r.period === "weekly" ? myWeek : r.period === "monthly" ? myMonth : myAll;
    return bundle[r.metric];
  };

  // Celebrate newly-unlocked rewards (seed silently on first load).
  useEffect(() => {
    if (!profile || !rewards.length || !statsReady || !windowReady) return;
    if (!seenRef.current) {
      try {
        const raw = localStorage.getItem(`yk_unlocked_${profile.uid}`);
        seenRef.current = new Set(raw ? JSON.parse(raw) : []);
      } catch { seenRef.current = new Set(); }
    }
    const seen = seenRef.current;
    const met = rewards.filter((r) => isLive(r) && valueFor(r) >= r.target);
    const persist = () => localStorage.setItem(`yk_unlocked_${profile.uid}`, JSON.stringify([...seen]));
    if (!seededRef.current) {
      seededRef.current = true;
      met.forEach((r) => seen.add(r.id));
      persist();
      return;
    }
    const fresh = met.filter((r) => !seen.has(r.id));
    if (fresh.length) {
      confettiBurst();
      const r0 = fresh[0];
      setToast(`🎉 Unlocked: ${r0.name}${fresh.length > 1 ? ` +${fresh.length - 1} more` : ""}`);
      setTimeout(() => setToast(null), 6000);
      fresh.forEach((r) => {
        seen.add(r.id);
        addDoc(collection(db, "notifications"), {
          userId: profile.uid, type: "reward",
          title: `🎁 Reward unlocked: ${r.name}`,
          body: r.description || (r.audience === "team" ? "Your team hit the goal!" : "You hit the goal!"),
          link: "/app/rewards", read: false, createdAt: Date.now(),
        }).catch(() => {});
      });
      const mine = fresh.filter((r) => r.audience === "individual");
      if (mine.length && companyId) {
        const names = mine.map((r) => `"${r.name}"`).join(", ");
        // Reward brags belong in the rep's TEAM chat, not the company-wide
        // channel (which is for company-wide updates only). No team → company.
        const text = `🎉 ${profile.displayName} just unlocked ${names}! 🔥 Who's next?`;
        const post = profile.teamId
          ? addDoc(collection(db, "teamChat"), { companyId, teamId: profile.teamId, userId: profile.uid, userName: profile.displayName, text, createdAt: Date.now() })
          : addDoc(collection(db, "chat"), { companyId, userId: profile.uid, userName: profile.displayName, text, createdAt: Date.now() });
        post.catch(() => {});
      }
      persist();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rewards, myAll, myWeek, myMonth, teamAll, statsReady, windowReady, profile]);

  const team = rewards.filter((r) => r.audience === "team" && isLive(r));
  const indiv = rewards.filter((r) => r.audience === "individual" && isLive(r));

  async function claim(r: Reward) {
    if (!profile || !companyId) return;
    await addDoc(collection(db, "redemptions"), {
      companyId, rewardId: r.id, rewardName: r.name,
      userId: profile.uid, userName: profile.displayName,
      status: "requested", createdAt: Date.now(),
    });
    setClaimed((s) => new Set(s).add(r.id));
  }

  return (
    <div className="page-body">
      <div className="page-head">
        <h1>🎁 Rewards</h1>
        <p className="page-sub">Earn rewards for hitting benchmarks — and team goals everyone shares in.</p>
      </div>

      {toast && <div className="reward-toast">{toast}</div>}

      <Section title="🏆 Team Rewards" subtitle="Unlocked when the whole team hits the goal — a group win."
        rewards={team} valueFor={valueFor} onClaim={claim} claimed={claimed}
        empty="No team rewards yet — your admin can add a group goal." />

      <Section title="⭐ Individual Rewards" subtitle="For the reps putting in the daily work."
        rewards={indiv} valueFor={valueFor} onClaim={claim} claimed={claimed}
        empty="No individual rewards yet." />
    </div>
  );
}

function Section(props: {
  title: string; subtitle: string; empty: string;
  rewards: Reward[]; valueFor: (r: Reward) => number;
  onClaim: (r: Reward) => void; claimed: Set<string>;
}) {
  const { title, subtitle, empty, rewards, valueFor, onClaim, claimed } = props;
  return (
    <>
      <h2 className="section-h">{title}</h2>
      <p className="muted small" style={{ marginTop: -8, marginBottom: 12 }}>{subtitle}</p>
      {rewards.length === 0 ? (
        <div className="empty">{empty}</div>
      ) : (
        <div className="reward-grid">
          {rewards.map((r) => (
            <RewardCard key={r.id} r={r} value={valueFor(r)} claimed={claimed.has(r.id)} onClaim={() => onClaim(r)} />
          ))}
        </div>
      )}
    </>
  );
}

function RewardCard({ r, value, claimed, onClaim }: { r: Reward; value: number; claimed: boolean; onClaim: () => void }) {
  const pct = Math.min(100, Math.round((value / Math.max(1, r.target)) * 100));
  const met = value >= r.target;
  const cond =
    r.kind === "store"
      ? `${r.target.toLocaleString()} pts to redeem`
      : `${r.target.toLocaleString()} ${METRIC_LABEL[r.metric].toLowerCase()} ${r.audience === "team" ? "(team, all-time)" : PERIOD_LABEL[r.period]}`;
  return (
    <div className={"reward-card card" + (met ? " met" : "")}>
      <div className="reward-img" style={r.imageUrl ? { backgroundImage: `url(${r.imageUrl})` } : undefined}>
        {!r.imageUrl && <span className="reward-img-ph">{METRIC_EMOJI[r.metric]}</span>}
        {met && <span className="reward-unlocked">✓ Unlocked</span>}
      </div>
      <div className="reward-body">
        <div className="reward-name">{r.name}</div>
        {r.description && <div className="muted small">{r.description}</div>}
        <div className="reward-cond">{METRIC_EMOJI[r.metric]} {cond}</div>
        <div className="reward-bar"><span style={{ width: `${pct}%` }} className={met ? "full" : ""} /></div>
        <div className="reward-progress muted small">{value.toLocaleString()} / {r.target.toLocaleString()} ({pct}%)</div>
        {!met && pct >= 80 && (
          <div className="reward-nudge">
            🔥 {(r.target - value).toLocaleString()} {r.kind === "store" ? "pts" : METRIC_LABEL[r.metric].toLowerCase()} to go!
          </div>
        )}
        {r.kind === "store" && r.audience === "individual" && (
          <button className="btn primary sm" disabled={!met || claimed} onClick={onClaim} style={{ marginTop: 8 }}>
            {claimed ? "Claimed ✓" : met ? "Redeem" : "Keep grinding"}
          </button>
        )}
      </div>
    </div>
  );
}
