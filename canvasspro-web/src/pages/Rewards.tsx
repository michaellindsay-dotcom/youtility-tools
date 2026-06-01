import { useEffect, useMemo, useRef, useState } from "react";
import {
  addDoc, collection, deleteDoc, doc, getDocs, onSnapshot, orderBy, query, updateDoc, where,
} from "firebase/firestore";
import { ref as storageRef, uploadBytes, getDownloadURL } from "firebase/storage";
import { db, storage } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { confettiBurst } from "../lib/confetti";
import {
  METRIC_LABEL, METRIC_EMOJI, PERIOD_LABEL, valsFromCounts, valsFromStats, ZERO_VALS, type MetricVals,
} from "../lib/rewards";
import type {
  Reward, RewardKind, RewardAudience, RewardMetric, RewardPeriod, UserStats, Lead, Shift, Redemption,
} from "../types";

const CONVO = new Set(["pipeline", "appointment", "not_interested", "sold"]);
const startOfWeek = () => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); d.setHours(0,0,0,0); return d.getTime(); };
const startOfMonth = () => new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();

export default function Rewards() {
  const { profile, role, companyId } = useAuth();
  const isAdmin = role === "admin";
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [showForm, setShowForm] = useState(false);

  // Metric bundles for progress.
  const [myAll, setMyAll] = useState<MetricVals>(ZERO_VALS);
  const [myWeek, setMyWeek] = useState<MetricVals>(ZERO_VALS);
  const [myMonth, setMyMonth] = useState<MetricVals>(ZERO_VALS);
  const [teamAll, setTeamAll] = useState<MetricVals>(ZERO_VALS);
  const [claimed, setClaimed] = useState<Set<string>>(new Set());
  const [statsReady, setStatsReady] = useState(false);
  const [windowReady, setWindowReady] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [redemptions, setRedemptions] = useState<Redemption[]>([]);
  // Reward ids we've already celebrated on this device (avoid re-firing).
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

  // Celebrate newly-unlocked rewards: confetti + toast + a bell notification.
  // Seeds silently on first load so we don't party over already-earned rewards.
  useEffect(() => {
    if (!profile || !rewards.length || !statsReady || !windowReady) return;
    if (!seenRef.current) {
      try {
        const raw = localStorage.getItem(`yk_unlocked_${profile.uid}`);
        seenRef.current = new Set(raw ? JSON.parse(raw) : []);
      } catch { seenRef.current = new Set(); }
    }
    const seen = seenRef.current;
    const met = rewards.filter((r) => (r.active ?? true) && valueFor(r) >= r.target);
    const persist = () =>
      localStorage.setItem(`yk_unlocked_${profile.uid}`, JSON.stringify([...seen]));

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
          userId: profile.uid,
          type: "reward",
          title: `🎁 Reward unlocked: ${r.name}`,
          body: r.description || (r.audience === "team" ? "Your team hit the goal!" : "You hit the goal!"),
          link: "/app/rewards",
          read: false,
          createdAt: Date.now(),
        }).catch(() => {});
      });
      persist();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rewards, myAll, myWeek, myMonth, teamAll, statsReady, windowReady, profile]);

  // Admin: live redemption inbox.
  useEffect(() => {
    if (!isAdmin || !companyId) return;
    return onSnapshot(
      query(collection(db, "redemptions"), where("companyId", "==", companyId), orderBy("createdAt", "desc")),
      (snap) => setRedemptions(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Redemption, "id">) }))),
      (e) => console.error("redemptions", e)
    );
  }, [isAdmin, companyId]);

  const fulfill = (r: Redemption) => updateDoc(doc(db, "redemptions", r.id), { status: "fulfilled" }).catch(() => {});
  const dismissRedemption = (r: Redemption) => deleteDoc(doc(db, "redemptions", r.id)).catch(() => {});

  const team = rewards.filter((r) => r.audience === "team" && (r.active ?? true));
  const indiv = rewards.filter((r) => r.audience === "individual" && (r.active ?? true));
  const inactive = isAdmin ? rewards.filter((r) => r.active === false) : [];

  async function claim(r: Reward) {
    if (!profile || !companyId) return;
    await addDoc(collection(db, "redemptions"), {
      companyId, rewardId: r.id, rewardName: r.name,
      userId: profile.uid, userName: profile.displayName,
      status: "requested", createdAt: Date.now(),
    });
    setClaimed((s) => new Set(s).add(r.id));
  }

  const remove = async (r: Reward) => {
    if (companyId && confirm(`Delete "${r.name}"?`)) await deleteDoc(doc(db, "companies", companyId, "rewards", r.id));
  };
  const toggle = async (r: Reward) => {
    if (companyId) await updateDoc(doc(db, "companies", companyId, "rewards", r.id), { active: !(r.active ?? true) });
  };

  return (
    <div className="page-body">
      <div className="page-head row">
        <div>
          <h1>🎁 Rewards</h1>
          <p className="page-sub">Earn rewards for hitting benchmarks — and team goals everyone shares in.</p>
        </div>
        {isAdmin && (
          <button className="btn primary sm" onClick={() => setShowForm((v) => !v)}>
            {showForm ? "Close" : "+ New reward"}
          </button>
        )}
      </div>

      {toast && <div className="reward-toast">{toast}</div>}

      {isAdmin && showForm && <RewardForm companyId={companyId!} uid={profile!.uid} onDone={() => setShowForm(false)} />}

      {isAdmin && redemptions.length > 0 && (
        <>
          <h2 className="section-h">
            📥 Redemptions
            {redemptions.some((r) => r.status === "requested") && (
              <span className="redeem-count">{redemptions.filter((r) => r.status === "requested").length} pending</span>
            )}
          </h2>
          <div className="card table-card">
            <table className="data-table">
              <thead><tr><th>Rep</th><th>Reward</th><th>When</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {redemptions.map((r) => (
                  <tr key={r.id}>
                    <td>{r.userName}</td>
                    <td>{r.rewardName}</td>
                    <td className="muted">{new Date(r.createdAt).toLocaleDateString()}</td>
                    <td><span className={`badge ${r.status === "fulfilled" ? "disabled" : ""}`}>{r.status}</span></td>
                    <td className="row" style={{ gap: 6 }}>
                      {r.status === "requested" && <button className="btn primary sm" onClick={() => fulfill(r)}>Mark fulfilled</button>}
                      <button className="btn ghost sm" onClick={() => dismissRedemption(r)}>✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <Section title="🏆 Team Rewards" subtitle="Unlocked when the whole team hits the goal — a group win."
        rewards={team} valueFor={valueFor} isAdmin={isAdmin} onClaim={claim} claimed={claimed} onRemove={remove} onToggle={toggle}
        empty="No team rewards yet — admins can add a group goal (e.g. 500 closes → team dinner)." />

      <Section title="⭐ Individual Rewards" subtitle="For the reps putting in the daily work."
        rewards={indiv} valueFor={valueFor} isAdmin={isAdmin} onClaim={claim} claimed={claimed} onRemove={remove} onToggle={toggle}
        empty="No individual rewards yet." />

      {inactive.length > 0 && (
        <Section title="💤 Inactive" subtitle="Hidden from reps." rewards={inactive} valueFor={valueFor}
          isAdmin={isAdmin} onClaim={claim} claimed={claimed} onRemove={remove} onToggle={toggle} empty="" />
      )}
    </div>
  );
}

function Section(props: {
  title: string; subtitle: string; empty: string;
  rewards: Reward[]; valueFor: (r: Reward) => number; isAdmin: boolean;
  onClaim: (r: Reward) => void; claimed: Set<string>;
  onRemove: (r: Reward) => void; onToggle: (r: Reward) => void;
}) {
  const { title, subtitle, empty, rewards, valueFor, isAdmin, onClaim, claimed, onRemove, onToggle } = props;
  if (!rewards.length && !empty) return null;
  return (
    <>
      <h2 className="section-h">{title}</h2>
      <p className="muted small" style={{ marginTop: -8, marginBottom: 12 }}>{subtitle}</p>
      {rewards.length === 0 ? (
        <div className="empty">{empty}</div>
      ) : (
        <div className="reward-grid">
          {rewards.map((r) => (
            <RewardCard key={r.id} r={r} value={valueFor(r)} isAdmin={isAdmin}
              claimed={claimed.has(r.id)} onClaim={() => onClaim(r)} onRemove={() => onRemove(r)} onToggle={() => onToggle(r)} />
          ))}
        </div>
      )}
    </>
  );
}

function RewardCard({ r, value, isAdmin, claimed, onClaim, onRemove, onToggle }: {
  r: Reward; value: number; isAdmin: boolean; claimed: boolean;
  onClaim: () => void; onRemove: () => void; onToggle: () => void;
}) {
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
        {r.active === false && <span className="reward-off">Inactive</span>}
      </div>
      <div className="reward-body">
        <div className="reward-name">{r.name}</div>
        {r.description && <div className="muted small">{r.description}</div>}
        <div className="reward-cond">{METRIC_EMOJI[r.metric]} {cond}</div>
        <div className="reward-bar"><span style={{ width: `${pct}%` }} className={met ? "full" : ""} /></div>
        <div className="reward-progress muted small">{value.toLocaleString()} / {r.target.toLocaleString()} ({pct}%)</div>

        {r.kind === "store" && r.audience === "individual" && (
          <button className="btn primary sm" disabled={!met || claimed} onClick={onClaim} style={{ marginTop: 8 }}>
            {claimed ? "Claimed ✓" : met ? "Redeem" : "Keep grinding"}
          </button>
        )}

        {isAdmin && (
          <div className="row" style={{ marginTop: 8, gap: 6 }}>
            <button className="btn ghost sm" onClick={onToggle}>{r.active === false ? "Activate" : "Deactivate"}</button>
            <button className="btn ghost sm" onClick={onRemove}>Delete</button>
          </div>
        )}
      </div>
    </div>
  );
}

function RewardForm({ companyId, uid, onDone }: { companyId: string; uid: string; onDone: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<RewardKind>("benchmark");
  const [audience, setAudience] = useState<RewardAudience>("individual");
  const [metric, setMetric] = useState<RewardMetric>("sales");
  const [period, setPeriod] = useState<RewardPeriod>("monthly");
  const [target, setTarget] = useState(10);
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : ""), [file]);

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      let imageUrl = "";
      if (file) {
        const r = storageRef(storage, `rewards/${companyId}/${Date.now()}_${file.name.replace(/[^\w.-]/g, "_")}`);
        await uploadBytes(r, file);
        imageUrl = await getDownloadURL(r);
      }
      await addDoc(collection(db, "companies", companyId, "rewards"), {
        companyId, name: name.trim(), description: description.trim() || "", imageUrl,
        kind, audience, metric: kind === "store" ? "points" : metric,
        period: kind === "store" || audience === "team" ? "alltime" : period,
        target: Number(target) || 1, active: true, createdAt: Date.now(), createdBy: uid,
      });
      onDone();
    } catch (e) {
      alert("Could not save reward (is Storage enabled?). " + (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card reward-form">
      <h3>New reward</h3>
      <div className="reward-form-grid">
        <label className="field"><span>Name *</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. $100 gift card" /></label>
        <label className="field"><span>Description</span><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What they win" /></label>
        <label className="field"><span>Type</span>
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as RewardKind)}>
            <option value="benchmark">Benchmark — auto-unlocks at a target</option>
            <option value="store">Store — redeem with points</option>
          </select>
        </label>
        <label className="field"><span>Who for</span>
          <select className="input" value={audience} onChange={(e) => setAudience(e.target.value as RewardAudience)}>
            <option value="individual">Individual rep</option>
            <option value="team">Whole team (group goal)</option>
          </select>
        </label>
        {kind === "benchmark" && (
          <label className="field"><span>Metric</span>
            <select className="input" value={metric} onChange={(e) => setMetric(e.target.value as RewardMetric)}>
              {(["sales", "appointments", "doors", "conversations", "points"] as RewardMetric[]).map((m) => (
                <option key={m} value={m}>{METRIC_LABEL[m]}</option>
              ))}
            </select>
          </label>
        )}
        {kind === "benchmark" && audience === "individual" && (
          <label className="field"><span>Window</span>
            <select className="input" value={period} onChange={(e) => setPeriod(e.target.value as RewardPeriod)}>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="alltime">All-time</option>
            </select>
          </label>
        )}
        <label className="field"><span>{kind === "store" ? "Cost (points)" : "Target"}</span>
          <input className="input" type="number" min={1} value={target} onChange={(e) => setTarget(Number(e.target.value))} />
        </label>
        <label className="field"><span>Image</span>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <button type="button" className="btn ghost sm" onClick={() => fileRef.current?.click()}>
            {file ? "Change image" : "📷 Upload image"}
          </button>
        </label>
      </div>
      {preview && <img src={preview} alt="" className="reward-form-preview" />}
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
        <button className="btn ghost sm" onClick={onDone}>Cancel</button>
        <button className="btn primary sm" onClick={save} disabled={saving || !name.trim()}>
          {saving ? "Saving…" : "Create reward"}
        </button>
      </div>
    </div>
  );
}
