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
type Frame = "day" | "week" | "month";
const FRAME_DAYS: Record<Frame, number> = { day: 1, week: 6, month: 26 }; // working days

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

const startOfMonth = () => new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
const round = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);
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
  const [frame, setFrame] = useState<Frame>("month");

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

  // Pull real numbers (this month) to seed the rate inputs.
  useEffect(() => {
    if (!uid) return;
    let off = false;
    (async () => {
      try {
        const since = startOfMonth();
        const [leadSnap, shiftSnap] = await Promise.all([
          getDocs(query(collection(db, "leads"), where("assignedTo", "==", uid), where("createdAt", ">=", since))),
          getDocs(query(collection(db, "shifts"), where("userId", "==", uid), where("startAt", ">=", since))),
        ]);
        if (off) return;
        const leads = leadSnap.docs.map((d) => d.data() as Lead).filter((l) => l.verified !== false);
        const hours = shiftSnap.docs
          .map((d) => d.data() as Shift)
          .reduce((s, sh) => s + ((sh.endAt ?? Date.now()) - sh.startAt), 0) / 3600000;
        const m: Actuals = {
          doors: leads.length,
          conv: leads.filter((l) => CONVO.has(l.status)).length,
          appt: leads.filter((l) => l.status === "appointment").length,
          closes: leads.filter((l) => l.status === "sold").length,
          hours: Math.round(hours * 10) / 10,
        };
        setMeasured(m);
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

  // Reverse-plan: from a goal, work backward to appts → conversations → doors → hours.
  const plan = useMemo(() => {
    const apptsNeeded = goalType === "closes" ? goalCount / (rates.closeRate || FALLBACK.closeRate) : goalCount;
    const convNeeded = apptsNeeded / (rates.apptPerConv || FALLBACK.apptPerConv);
    const doorsNeeded = apptsNeeded / (rates.apptPerDoor || FALLBACK.apptPerDoor);
    const hoursNeeded = doorsNeeded / (rates.doorsPerHour || FALLBACK.doorsPerHour);
    const days = FRAME_DAYS[frame];
    return {
      closes: goalType === "closes" ? goalCount : round(apptsNeeded * rates.closeRate),
      appts: ceil(apptsNeeded),
      conv: ceil(convNeeded),
      doors: ceil(doorsNeeded),
      hours: Math.round(hoursNeeded * 10) / 10,
      perDay: {
        doors: ceil(doorsNeeded / days),
        appts: Math.round((apptsNeeded / days) * 10) / 10,
        hours: Math.round((hoursNeeded / days) * 10) / 10,
      },
    };
  }, [goalType, goalCount, frame, rates]);

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

  const pctClose = Math.round(rates.closeRate * 100);
  const apptsPer100 = Math.round(rates.apptPerDoor * 100 * 10) / 10;

  return (
    <div className="planner-wrap">
      {/* ── Reverse goal calculator ─────────────────────────── */}
      <div className="card">
        <h2 className="planner-h">◎ Goal Planner</h2>
        <p className="muted small">
          Enter a target and we'll work backward through <em>your</em> conversion rates to tell you the
          appointments, doors, and hours it takes.
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
          <select className="input" value={frame} onChange={(e) => setFrame(e.target.value as Frame)}>
            <option value="day">this day</option>
            <option value="week">this week</option>
            <option value="month">this month</option>
          </select>
        </div>

        <div className="plan-grid">
          {goalType === "closes" && <PlanStat n={plan.appts} label="Appointments" />}
          <PlanStat n={plan.conv} label="Conversations" />
          <PlanStat n={plan.doors} label="Doors" />
          <PlanStat n={plan.hours} label="Hours" />
        </div>

        <div className="plan-perday muted small">
          That's about <strong>{plan.perDay.doors} doors</strong>, <strong>{plan.perDay.appts} appts</strong> and{" "}
          <strong>{plan.perDay.hours} h</strong> per working day
          {goalType === "closes" ? ` → ~${plan.closes} closes.` : "."}
        </div>

        <div className="plan-rates muted small">
          Using your rates: <strong>{pctClose}%</strong> close rate · <strong>{apptsPer100}</strong> appts per 100 doors ·{" "}
          <strong>{Math.round(rates.doorsPerHour)}</strong> doors/hour.
        </div>
      </div>

      {/* ── Your numbers (editable, seed the rates) ─────────── */}
      <div className="card">
        <div className="planner-row-head">
          <h2 className="planner-h">Your numbers</h2>
          <button className="btn ghost sm" onClick={() => saveActuals(measured)}>Reset to my data</button>
        </div>
        <p className="muted small">
          Auto-filled from your last 30 days ({measured.doors} doors, {measured.appt} appts, {measured.closes} closes,
          {measured.hours}h). Tweak any number to match your real rates.
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
