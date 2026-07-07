import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { isRallyCardOnly } from "../lib/features";
import type { Challenge, ChallengeMetric } from "../types";

const DAY = 86_400_000;
const METRICS: { value: ChallengeMetric; label: string }[] = [
  { value: "doors", label: "🚪 Doors knocked" },
  { value: "appointments", label: "📅 Appointments" },
  { value: "sales", label: "💰 Sales / closes" },
  { value: "points", label: "🎮 Points" },
];
const metricLabel = (m: string) => METRICS.find((x) => x.value === m)?.label || m;

function startOfToday(): number { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
function startOfWeek(): number { const d = new Date(); d.setHours(0, 0, 0, 0); const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day); return d.getTime(); }
function windowFor(period: "day" | "week"): { startAt: number; endAt: number } {
  return period === "day" ? { startAt: startOfToday(), endAt: startOfToday() + DAY } : { startAt: startOfWeek(), endAt: startOfWeek() + 7 * DAY };
}
const fmtWindow = (c: Challenge) =>
  c.period === "day" ? new Date(c.startAt).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) : "this week";

export default function ThrowDowns() {
  const { profile, company } = useAuth();
  const [rows, setRows] = useState<Challenge[]>([]);
  const [teammates, setTeammates] = useState<{ uid: string; name: string; isCloser: boolean }[]>([]);
  const [showNew, setShowNew] = useState(false);

  useEffect(() => {
    if (!profile) return;
    // Single array-contains (no orderBy) needs no composite index; sort in code.
    return onSnapshot(
      query(collection(db, "challenges"), where("participants", "array-contains", profile.uid)),
      (snap) => setRows(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Challenge, "id">) }))),
      (e) => console.error("challenges", e)
    );
  }, [profile]);

  useEffect(() => {
    httpsCallable(functions, "listTeammates")({})
      .then((r) => setTeammates(((r.data as { teammates?: { uid: string; name: string; isCloser: boolean }[] })?.teammates) || []))
      .catch((e) => console.error("listTeammates", e));
  }, []);

  const sorted = useMemo(() => [...rows].sort((a, b) => b.createdAt - a.createdAt), [rows]);
  const incoming = sorted.filter((c) => c.status === "pending" && c.opponentUid === profile?.uid);
  const outgoing = sorted.filter((c) => c.status === "pending" && c.challengerUid === profile?.uid);
  const active = sorted.filter((c) => c.status === "active");
  const history = sorted.filter((c) => c.status === "settled" || c.status === "declined" || c.status === "cancelled");

  return (
    <div className="page-body">
      <div className="page-head row">
        <div>
          <h1>⚔️ Throw Downs</h1>
          <p className="page-sub">Challenge a teammate. Stakes are between you two — keep it fun (max $100).</p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {!isRallyCardOnly(company) && <Link className="btn ghost sm" to="/">← Dashboard</Link>}
          <button className="btn primary" onClick={() => setShowNew((v) => !v)}>{showNew ? "Close" : "+ New Throw Down"}</button>
        </div>
      </div>

      {showNew && <NewThrowDown teammates={teammates} onDone={() => setShowNew(false)} />}

      {incoming.length > 0 && (
        <Section title="🔔 Challenges for you">
          {incoming.map((c) => <ChallengeCard key={c.id} c={c} me={profile?.uid} />)}
        </Section>
      )}
      {active.length > 0 && (
        <Section title="🔥 In progress">
          {active.map((c) => <ChallengeCard key={c.id} c={c} me={profile?.uid} />)}
        </Section>
      )}
      {outgoing.length > 0 && (
        <Section title="⏳ Waiting on them">
          {outgoing.map((c) => <ChallengeCard key={c.id} c={c} me={profile?.uid} />)}
        </Section>
      )}
      {history.length > 0 && (
        <Section title="🏁 History">
          {history.map((c) => <ChallengeCard key={c.id} c={c} me={profile?.uid} />)}
        </Section>
      )}

      {rows.length === 0 && (
        <div className="empty">No throw downs yet. Call someone out — winner gets bragging rights (and lunch). 😏</div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 16 }}>
      <h2 className="section-h" style={{ margin: "4px 0 8px" }}>{title}</h2>
      <div style={{ display: "grid", gap: 10 }}>{children}</div>
    </div>
  );
}

function NewThrowDown({ teammates, onDone }: { teammates: { uid: string; name: string; isCloser: boolean }[]; onDone: () => void }) {
  const [opponentUid, setOpponentUid] = useState("");
  const [metric, setMetric] = useState<ChallengeMetric>("doors");
  const [period, setPeriod] = useState<"day" | "week">("day");
  const [stakes, setStakes] = useState("Loser buys lunch 🌮");
  const [stakeValue, setStakeValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setErr(null);
    if (!opponentUid) { setErr("Pick who you're challenging."); return; }
    if (!stakes.trim()) { setErr("What's on the line?"); return; }
    const val = stakeValue.trim() ? Number(stakeValue) : null;
    if (val != null && (!Number.isFinite(val) || val < 0)) { setErr("Enter a valid dollar amount."); return; }
    if (val != null && val > 100) { setErr("Stakes are capped at $100."); return; }
    const { startAt, endAt } = windowFor(period);
    setBusy(true);
    try {
      await httpsCallable(functions, "createChallenge")({ opponentUid, metric, period, startAt, endAt, stakes: stakes.trim(), stakeValue: val });
      onDone();
    } catch (e) {
      setErr((e as Error)?.message || "Couldn't send the challenge.");
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 8 }}>
      <div className="grid-2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <label className="field"><span>Challenge</span>
          <select value={opponentUid} onChange={(e) => setOpponentUid(e.target.value)}>
            <option value="">— pick a teammate —</option>
            {teammates.map((t) => <option key={t.uid} value={t.uid}>{t.name}{t.isCloser ? " (closer)" : ""}</option>)}
          </select>
        </label>
        <label className="field"><span>Metric</span>
          <select value={metric} onChange={(e) => setMetric(e.target.value as ChallengeMetric)}>
            {METRICS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </label>
        <label className="field"><span>Duration</span>
          <select value={period} onChange={(e) => setPeriod(e.target.value as "day" | "week")}>
            <option value="day">Today</option>
            <option value="week">This week</option>
          </select>
        </label>
        <label className="field"><span>Cash value (optional, ≤ $100)</span>
          <input type="number" min={0} max={100} value={stakeValue} placeholder="e.g. 20" onChange={(e) => setStakeValue(e.target.value)} />
        </label>
      </div>
      <label className="field"><span>What's on the line</span>
        <input value={stakes} onChange={(e) => setStakes(e.target.value)} placeholder="Loser buys lunch / wears a costume / …" />
      </label>
      {err && <div className="banner error show" style={{ marginBottom: 8 }}>{err}</div>}
      <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
        <button className="btn ghost sm" onClick={onDone} disabled={busy}>Cancel</button>
        <button className="btn primary sm" onClick={submit} disabled={busy}>{busy ? "Sending…" : "Send challenge ⚔️"}</button>
      </div>
    </div>
  );
}

function ChallengeCard({ c, me }: { c: Challenge; me?: string }) {
  const [busy, setBusy] = useState(false);
  const iAmChallenger = c.challengerUid === me;
  const myName = iAmChallenger ? c.challengerName : c.opponentName;
  const theirName = iAmChallenger ? c.opponentName : c.challengerName;
  const myScore = iAmChallenger ? (c.challengerScore ?? 0) : (c.opponentScore ?? 0);
  const theirScore = iAmChallenger ? (c.opponentScore ?? 0) : (c.challengerScore ?? 0);

  async function act(action: "accept" | "decline" | "cancel") {
    setBusy(true);
    try { await httpsCallable(functions, "respondChallenge")({ challengeId: c.id, action }); }
    catch (e) { alert((e as Error)?.message || "Action failed."); setBusy(false); }
  }

  const won = c.status === "settled" && c.winnerUid === me;
  const lost = c.status === "settled" && !!c.winnerUid && c.winnerUid !== me;
  const border = won ? "#34d399" : lost ? "#f87171" : c.status === "active" ? "#38bdf8" : "#21314a";

  return (
    <div className="card" style={{ border: `1px solid ${border}` }}>
      <div className="row between" style={{ alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <strong>{myName} vs {theirName}</strong>
        <span className="muted small">{metricLabel(c.metric)} · {fmtWindow(c)}</span>
      </div>
      <div className="muted small" style={{ marginTop: 4 }}>🎁 On the line: {c.stakes}{c.stakeValue ? ` (up to $${c.stakeValue})` : ""}</div>

      {(c.status === "active" || c.status === "settled") && (
        <div className="row" style={{ gap: 16, marginTop: 8, alignItems: "baseline" }}>
          <div><span style={{ fontSize: 22, fontWeight: 800 }}>{myScore}</span> <span className="muted small">you</span></div>
          <span className="muted">vs</span>
          <div><span style={{ fontSize: 22, fontWeight: 800 }}>{theirScore}</span> <span className="muted small">{theirName}</span></div>
        </div>
      )}

      {c.status === "settled" && (
        <div style={{ marginTop: 8, fontWeight: 700, color: border }}>
          {won ? "🏆 You won — collect your prize!" : lost ? `😤 ${theirName} won — you owe: ${c.stakes}` : "🤝 Tied — call it a draw."}
        </div>
      )}
      {c.status === "declined" && <div className="muted small" style={{ marginTop: 8 }}>❌ Declined.</div>}
      {c.status === "cancelled" && <div className="muted small" style={{ marginTop: 8 }}>🚫 Called off.</div>}

      {c.status === "pending" && !iAmChallenger && (
        <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
          <button className="btn ghost sm" disabled={busy} onClick={() => act("decline")}>Decline</button>
          <button className="btn primary sm" disabled={busy} onClick={() => act("accept")}>Accept ⚔️</button>
        </div>
      )}
      {c.status === "pending" && iAmChallenger && (
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
          <button className="btn ghost sm" disabled={busy} onClick={() => act("cancel")}>Cancel challenge</button>
        </div>
      )}
      {c.status === "active" && iAmChallenger && (
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
          <button className="btn ghost sm" disabled={busy} onClick={() => act("cancel")}>Call it off</button>
        </div>
      )}
    </div>
  );
}
