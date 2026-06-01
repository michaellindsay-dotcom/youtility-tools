import { useEffect, useMemo, useState } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import type { Lead, Shift } from "../types";

// Dispositions that mean an actual conversation happened at the door.
const CONVO = new Set(["pipeline", "appointment", "not_interested", "sold"]);

// Fallback rates when a rep has no history yet (industry-ish starting points).
const FALLBACK = { closeRate: 0.3, apptPerDoor: 0.03, apptPerConv: 0.1, doorsPerHour: 30 };

type GoalType = "closes" | "appointments";
const WEEKS_PER_MONTH = 4.345; // avg, to convert the monthly goal to a weekly pace
// Conversion rates use a rolling 30-day window once the rep has that much data;
// before then (< ~2 weeks of real data) doors & hours fall back to a baseline.
const WINDOW_DAYS = 30;
const MIN_DATA_DAYS = 14;
const DEFAULT_DOORS_WEEK = 400;
const DEFAULT_HOURS_WEEK = 35;

interface Actuals { doors: number; conv: number; appt: number; closes: number; hours: number; }
interface Goals {
  doorsDay: number; convDay: number; apptDay: number;
  doorsWeek: number; convWeek: number; apptWeek: number;
  doorsMonth: number; convMonth: number; apptMonth: number;
}
const DEFAULT_GOALS: Goals = {
  doorsDay: 100, convDay: 30, apptDay: 3,
  doorsWeek: 500, convWeek: 150, apptWeek: 15,
  doorsMonth: 2000, convMonth: 600, apptMonth: 60,
};

const ceil = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.ceil(n)) : 0);

export default function GoalPlanner() {
  const { profile } = useAuth();
  const uid = profile?.uid;

  // Measured numbers from the rep's last-30-day history (defaults for the rates).
  const [measured, setMeasured] = useState<Actuals>({ doors: 0, conv: 0, appt: 0, closes: 0, hours: 0 });
  // Editable copy the rep can tweak to reflect their true rates.
  const [actuals, setActuals] = useState<Actuals>({ doors: 0, conv: 0, appt: 0, closes: 0, hours: 0 });
  const [goals, setGoals] = useState<Goals>(DEFAULT_GOALS);
  const [goalType, setGoalType] = useState<GoalType>("closes");
  const [goalCount, setGoalCount] = useState(10);
  // True once the rep has ~2+ weeks of real activity — only then do doors/hours
  // come from live data instead of the 400/35 baseline.
  const [hasRealData, setHasRealData] = useState(false);

  // Load saved goals + rate overrides (local to this device, per the spec).
  useEffect(() => {
    if (!uid) return;
    try {
      const g = localStorage.getItem(`yk_goals_${uid}`);
      if (g) setGoals({ ...DEFAULT_GOALS, ...JSON.parse(g) });
      const r = localStorage.getItem(`yk_rates_${uid}`);
      if (r) setActuals(JSON.parse(r));
    } catch { /* ignore */ }
  }, [uid]);

  // Pull real numbers (rolling 30 days) to seed the rate inputs.
  useEffect(() => {
    if (!uid) return;
    let off = false;
    (async () => {
      try {
        const since = Date.now() - WINDOW_DAYS * 86400000;
        const [leadSnap, shiftSnap] = await Promise.all([
          getDocs(query(collection(db, "leads"), where("assignedTo", "==", uid), where("createdAt", ">=", since))),
          getDocs(query(collection(db, "shifts"), where("userId", "==", uid), where("startAt", ">=", since))),
        ]);
        if (off) return;
        const leads = leadSnap.docs.map((d) => d.data() as Lead).filter((l) => l.verified !== false);
        const shifts = shiftSnap.docs.map((d) => d.data() as Shift);
        const hours = shifts.reduce((s, sh) => s + ((sh.endAt ?? Date.now()) - sh.startAt), 0) / 3600000;
        const m: Actuals = {
          doors: leads.length,
          conv: leads.filter((l) => CONVO.has(l.status)).length,
          appt: leads.filter((l) => l.status === "appointment").length,
          closes: leads.filter((l) => l.status === "sold").length,
          hours: Math.round(hours * 10) / 10,
        };
        setMeasured(m);
        // "Real data" = at least 2 weeks of span AND some doors + hours logged.
        const ts = [...leads.map((l) => l.knockedAt || l.createdAt), ...shifts.map((s) => s.startAt)].filter(Boolean) as number[];
        const spanDays = ts.length ? (Date.now() - Math.min(...ts)) / 86400000 : 0;
        setHasRealData(spanDays >= MIN_DATA_DAYS && m.doors > 0 && m.hours > 0);
        // Seed editable rates from measured data only if the rep hasn't set their own.
        setActuals((cur) =>
          cur.doors || cur.appt || cur.closes || cur.hours ? cur : m
        );
      } catch (e) {
        console.error("planner data", e);
      }
    })();
    return () => { off = true; };
  }, [uid]);

  const saveGoals = (g: Goals) => {
    setGoals(g);
    if (uid) localStorage.setItem(`yk_goals_${uid}`, JSON.stringify(g));
  };
  const saveActuals = (a: Actuals) => {
    setActuals(a);
    if (uid) localStorage.setItem(`yk_rates_${uid}`, JSON.stringify(a));
  };

  // Derived conversion rates (fall back to sane defaults when a field is 0).
  const rates = useMemo(() => {
    const a = actuals;
    return {
      closeRate: a.appt > 0 ? a.closes / a.appt : FALLBACK.closeRate,
      apptPerDoor: a.doors > 0 ? a.appt / a.doors : FALLBACK.apptPerDoor,
      apptPerConv: a.conv > 0 ? a.appt / a.conv : FALLBACK.apptPerConv,
      convPerDoor: a.doors > 0 ? a.conv / a.doors : FALLBACK.apptPerDoor / FALLBACK.apptPerConv,
      doorsPerHour: a.hours > 0 ? a.doors / a.hours : FALLBACK.doorsPerHour,
    };
  }, [actuals]);

  // Reverse-plan the MONTHLY close goal, shown as a WEEKLY game plan.
  // Appointments & conversations always come from the conversion math; doors &
  // hours use a 400/35 weekly baseline until the rep has ~2 weeks of real data.
  const plan = useMemo(() => {
    const apptsMonthly = goalType === "closes" ? goalCount / (rates.closeRate || FALLBACK.closeRate) : goalCount;
    const convMonthly = apptsMonthly / (rates.apptPerConv || FALLBACK.apptPerConv);
    const doorsMonthly = apptsMonthly / (rates.apptPerDoor || FALLBACK.apptPerDoor);
    const hoursMonthly = doorsMonthly / (rates.doorsPerHour || FALLBACK.doorsPerHour);
    return {
      appts: ceil(apptsMonthly / WEEKS_PER_MONTH),
      conv: ceil(convMonthly / WEEKS_PER_MONTH),
      doors: hasRealData ? ceil(doorsMonthly / WEEKS_PER_MONTH) : DEFAULT_DOORS_WEEK,
      hours: hasRealData ? Math.round((hoursMonthly / WEEKS_PER_MONTH) * 10) / 10 : DEFAULT_HOURS_WEEK,
    };
  }, [goalType, goalCount, rates, hasRealData]);

  const aField = (label: string, key: keyof Actuals, hint?: string) => (
    <label className="field">
      <span>{label}{hint ? <em className="muted"> {hint}</em> : null}</span>
      <input
        type="number" min={0} className="input"
        value={actuals[key]}
        onChange={(e) => saveActuals({ ...actuals, [key]: Number(e.target.value) })}
      />
    </label>
  );

  const gField = (label: string, key: keyof Goals) => (
    <div className="field-row goal-row">
      <dt>{label}</dt>
      <dd>
        <input
          type="number" min={0} className="input goal-input"
          value={goals[key]}
          onChange={(e) => saveGoals({ ...goals, [key]: Number(e.target.value) })}
        />
      </dd>
    </div>
  );

  return (
    <div className="planner-wrap">
      {/* ── Monthly reverse goal calculator ─────────────────── */}
      <div className="card">
        <h2 className="planner-h">◎ Monthly Goal Planner</h2>
        <p className="muted small">
          Set your monthly close target and we'll work backward through <em>your</em> conversion rates into a
          weekly game plan.
        </p>

        <div className="planner-goalbar">
          <span>I want to hit</span>
          <input
            type="number" min={1} className="input goal-input"
            value={goalCount}
            onChange={(e) => setGoalCount(Math.max(1, Number(e.target.value)))}
          />
          <select className="input" value={goalType} onChange={(e) => setGoalType(e.target.value as GoalType)}>
            <option value="closes">closes</option>
            <option value="appointments">appointments</option>
          </select>
          <span>this month</span>
        </div>

        <div className="muted small" style={{ margin: "6px 0 4px" }}>Your weekly game plan:</div>
        <div className="plan-grid">
          {goalType === "closes" && <PlanStat n={plan.appts} label="Appts / wk" />}
          <PlanStat n={plan.conv} label="Conversations / wk" />
          <PlanStat n={plan.doors} label="Doors / wk" />
          <PlanStat n={plan.hours} label="Hours / wk" />
        </div>

        {!hasRealData && (
          <div className="muted small" style={{ marginTop: 4 }}>
            Doors &amp; hours use a {DEFAULT_DOORS_WEEK}/{DEFAULT_HOURS_WEEK} weekly baseline — they'll adjust to your
            real pace once you've logged ~2 weeks of data.
          </div>
        )}
      </div>

      {/* ── Your numbers (editable, seed the rates) ─────────── */}
      <div className="card">
        <div className="planner-row-head">
          <h2 className="planner-h">Your numbers</h2>
          <button className="btn ghost sm" onClick={() => saveActuals(measured)}>Reset to my data</button>
        </div>
        <p className="muted small">
          Auto-filled from your rolling last {WINDOW_DAYS} days ({measured.doors} doors, {measured.appt} appts,{" "}
          {measured.closes} closes, {measured.hours}h) — the more you log (min ~{MIN_DATA_DAYS} days), the more
          accurate it gets. Tweak any number to match your real rates.
        </p>
        <div className="planner-actuals">
          {aField("Doors", "doors")}
          {aField("Conversations", "conv")}
          {aField("Appointments", "appt")}
          {aField("Closes", "closes")}
          {aField("Hours worked", "hours")}
        </div>
      </div>

      {/* ── Adjustable goals (saved locally) ────────────────── */}
      <div className="card">
        <h2 className="planner-h">Goals</h2>
        <div className="goals-grid">
          <div>
            <h3 className="goals-sub">Daily</h3>
            <dl className="fields">{gField("Doors / day", "doorsDay")}{gField("Conversations / day", "convDay")}{gField("Appointments / day", "apptDay")}</dl>
          </div>
          <div>
            <h3 className="goals-sub">Weekly</h3>
            <dl className="fields">{gField("Doors / week", "doorsWeek")}{gField("Conversations / week", "convWeek")}{gField("Appointments / week", "apptWeek")}</dl>
          </div>
          <div>
            <h3 className="goals-sub">Monthly</h3>
            <dl className="fields">{gField("Doors / month", "doorsMonth")}{gField("Conversations / month", "convMonth")}{gField("Appointments / month", "apptMonth")}</dl>
          </div>
        </div>
        <p className="muted small">Goals are saved locally on this device.</p>
      </div>
    </div>
  );
}

function PlanStat({ n, label }: { n: number; label: string }) {
  return (
    <div className="plan-stat">
      <div className="plan-stat-n">{n}</div>
      <div className="muted small">{label}</div>
    </div>
  );
}
