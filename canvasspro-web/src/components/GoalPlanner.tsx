import { useEffect, useMemo, useState } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import type { Lead, Shift } from "../types";

// Dispositions that mean an actual conversation happened at the door.
const CONVO = new Set(["pipeline", "appointment", "not_interested", "sold"]);

// Fallback rates when a rep has no history yet (industry-ish starting points).
const FALLBACK = { closeRate: 0.3, apptPerDoor: 0.03, apptPerConv: 0.1, doorsPerHour: 30 };

const WEEKS_PER_MONTH = 4.345; // avg, to convert the monthly goal to a weekly pace
const DAYS_PER_WEEK = 5; // working days, to convert a weekly pace to a daily one
// Conversion rates use a rolling 30-day window. Doors & hours start adjusting to
// the rep's real pace from their very first logged day; before any data they
// fall back to a sensible weekly baseline.
const WINDOW_DAYS = 30;
const DEFAULT_DOORS_WEEK = 400;
const DEFAULT_HOURS_WEEK = 35;

interface Actuals { doors: number; conv: number; appt: number; closes: number; hours: number; }

const ceil = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.ceil(n)) : 0);
const r1 = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.round(n * 10) / 10) : 0);

export default function GoalPlanner() {
  const { profile } = useAuth();
  const uid = profile?.uid;

  // Reps may only change their close goal on Sundays.
  const isSunday = new Date().getDay() === 0;

  // Measured numbers from the rep's last-30-day history (defaults for the rates).
  const [measured, setMeasured] = useState<Actuals>({ doors: 0, conv: 0, appt: 0, closes: 0, hours: 0 });
  // Editable copy the rep can tweak to reflect their true rates.
  const [actuals, setActuals] = useState<Actuals>({ doors: 0, conv: 0, appt: 0, closes: 0, hours: 0 });
  // The one number the rep sets: their monthly close goal.
  const [goalCount, setGoalCount] = useState(10);
  // True once the rep has logged any doors + hours — their pace then drives the
  // doors/hours math instead of the baseline (adjusts from day one).
  const [hasRealData, setHasRealData] = useState(false);

  // Load saved close goal + rate overrides (local to this device, per the spec).
  useEffect(() => {
    if (!uid) return;
    try {
      const c = localStorage.getItem(`yk_closegoal_${uid}`);
      if (c) setGoalCount(Math.max(1, Number(c)));
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
        // Adjust to real data as soon as there's any — from day one of working.
        setHasRealData(m.doors > 0 && m.hours > 0);
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

  const saveGoalCount = (n: number) => {
    const v = Math.max(1, n);
    setGoalCount(v);
    if (uid) localStorage.setItem(`yk_closegoal_${uid}`, String(v));
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
      doorsPerHour: a.hours > 0 ? a.doors / a.hours : FALLBACK.doorsPerHour,
    };
  }, [actuals]);

  // Reverse-plan the monthly close goal through the rep's rolling-average
  // conversion rates into daily / weekly / monthly targets for every metric.
  // Appointments & conversations always come from the conversion math; doors &
  // hours use the weekly baseline only until the rep has logged real activity.
  const plan = useMemo(() => {
    const closesMonth = goalCount;
    const apptsMonth = closesMonth / (rates.closeRate || FALLBACK.closeRate);
    const convMonth = apptsMonth / (rates.apptPerConv || FALLBACK.apptPerConv);
    const doorsMonth = hasRealData
      ? apptsMonth / (rates.apptPerDoor || FALLBACK.apptPerDoor)
      : DEFAULT_DOORS_WEEK * WEEKS_PER_MONTH;
    const hoursMonth = hasRealData
      ? doorsMonth / (rates.doorsPerHour || FALLBACK.doorsPerHour)
      : DEFAULT_HOURS_WEEK * WEEKS_PER_MONTH;

    const per = (monthly: number) => ({
      month: monthly,
      week: monthly / WEEKS_PER_MONTH,
      day: monthly / WEEKS_PER_MONTH / DAYS_PER_WEEK,
    });
    return {
      closes: per(closesMonth),
      appts: per(apptsMonth),
      conv: per(convMonth),
      doors: per(doorsMonth),
      hours: per(hoursMonth),
    };
  }, [goalCount, rates, hasRealData]);

  // Persist the derived daily/weekly/monthly goals so the on-shift HUD and any
  // other consumer stay in sync with the planner.
  useEffect(() => {
    if (!uid) return;
    localStorage.setItem(`yk_goals_${uid}`, JSON.stringify({
      doorsDay: ceil(plan.doors.day), convDay: ceil(plan.conv.day), apptDay: ceil(plan.appts.day),
      doorsWeek: ceil(plan.doors.week), convWeek: ceil(plan.conv.week), apptWeek: ceil(plan.appts.week),
      doorsMonth: ceil(plan.doors.month), convMonth: ceil(plan.conv.month), apptMonth: ceil(plan.appts.month),
    }));
  }, [uid, plan]);

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

  // A read-only derived goal row (closes show a decimal; volume metrics round up).
  const roRow = (label: string, value: number, decimal = false) => (
    <div className="field-row goal-row">
      <dt>{label}</dt>
      <dd className="goal-ro">{decimal ? r1(value) : ceil(value)}</dd>
    </div>
  );

  return (
    <div className="planner-wrap">
      {/* ── Monthly reverse goal calculator ─────────────────── */}
      <div className="card">
        <h2 className="planner-h">◎ Monthly Goal Planner</h2>
        <p className="muted small">
          Set your monthly close target and we'll work backward through <em>your</em> rolling-average conversion
          rates into a daily, weekly, and monthly game plan.
        </p>

        <div className="planner-goalbar">
          <span>I want to close</span>
          <input
            type="number" min={1} className="input goal-input"
            value={goalCount}
            disabled={!isSunday}
            onChange={(e) => saveGoalCount(Number(e.target.value))}
          />
          <span>per month</span>
        </div>

        {!isSunday && (
          <div className="muted small" style={{ marginTop: 6 }}>
            🔒 Your close goal is locked — it can only be changed on <strong>Sundays</strong>. Everything else
            adjusts automatically from your rolling {WINDOW_DAYS}-day average.
          </div>
        )}

        <div className="muted small" style={{ margin: "10px 0 4px" }}>Your weekly game plan:</div>
        <div className="plan-grid">
          <PlanStat n={ceil(plan.appts.week)} label="Appts / wk" />
          <PlanStat n={ceil(plan.conv.week)} label="Conversations / wk" />
          <PlanStat n={ceil(plan.doors.week)} label="Doors / wk" />
          <PlanStat n={r1(plan.hours.week)} label="Hours / wk" />
        </div>

        {!hasRealData && (
          <div className="muted small" style={{ marginTop: 4 }}>
            Doors &amp; hours use a {DEFAULT_DOORS_WEEK}/{DEFAULT_HOURS_WEEK} weekly baseline — they'll adjust to your
            real pace as soon as you log your first shift.
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
          {measured.closes} closes, {measured.hours}h) — the more you log, the more accurate it gets. Tweak any
          number to match your real rates.
        </p>
        <div className="planner-actuals">
          {aField("Doors", "doors")}
          {aField("Conversations", "conv")}
          {aField("Appointments", "appt")}
          {aField("Closes", "closes")}
          {aField("Hours worked", "hours")}
        </div>
      </div>

      {/* ── Derived goals (read-only; driven by the close goal + your pace) ── */}
      <div className="card">
        <h2 className="planner-h">Goals</h2>
        <div className="goals-grid">
          <div>
            <h3 className="goals-sub">Daily</h3>
            <dl className="fields">
              {roRow("Closes / day", plan.closes.day, true)}
              {roRow("Appointments / day", plan.appts.day)}
              {roRow("Conversations / day", plan.conv.day)}
              {roRow("Doors / day", plan.doors.day)}
            </dl>
          </div>
          <div>
            <h3 className="goals-sub">Weekly</h3>
            <dl className="fields">
              {roRow("Closes / week", plan.closes.week, true)}
              {roRow("Appointments / week", plan.appts.week)}
              {roRow("Conversations / week", plan.conv.week)}
              {roRow("Doors / week", plan.doors.week)}
            </dl>
          </div>
          <div>
            <h3 className="goals-sub">Monthly</h3>
            <dl className="fields">
              {roRow("Closes / month", plan.closes.month)}
              {roRow("Appointments / month", plan.appts.month)}
              {roRow("Conversations / month", plan.conv.month)}
              {roRow("Doors / month", plan.doors.month)}
            </dl>
          </div>
        </div>
        <p className="muted small">
          These targets are calculated from your close goal and your rolling average — they can't be edited
          individually. Change your close goal on Sunday to move every target.
        </p>
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
