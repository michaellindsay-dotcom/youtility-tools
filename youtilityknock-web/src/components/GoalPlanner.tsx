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

  // Start of the current week (Sunday 00:00) — the goal resets each week.
  const weekStartSun = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - d.getDay());
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }, []);
  const isSunday = new Date().getDay() === 0;

  // Measured numbers from the rep's last-30-day history. These are VIEW-ONLY —
  // the planner's conversion rates come straight from the rep's real activity;
  // reps can't edit or reset their numbers.
  const [measured, setMeasured] = useState<Actuals>({ doors: 0, conv: 0, appt: 0, closes: 0, hours: 0 });
  // The one number the rep sets: their WEEKLY close goal.
  const [goalCount, setGoalCount] = useState(3);
  // The week the goal was last set for — used to allow the first edit of a new
  // week even if it isn't Sunday yet.
  const [goalWeek, setGoalWeek] = useState(0);
  // Days of logged activity (capped at 30) — drives the baseline→rolling blend.
  const [daysActive, setDaysActive] = useState(0);

  // The goal is editable on Sundays OR the first time it's opened in a new week
  // (incl. a rep's very first login), then locks for the rest of that week.
  const canEditGoal = isSunday || goalWeek !== weekStartSun;

  // Load the saved close goal + the week it was set for (local to this device).
  useEffect(() => {
    if (!uid) return;
    try {
      const c = localStorage.getItem(`yk_closegoal_${uid}`);
      if (c) setGoalCount(Math.max(1, Number(c)));
      const w = localStorage.getItem(`yk_closegoal_week_${uid}`);
      if (w) setGoalWeek(Number(w));
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
        // Days of logged activity (capped at the window): drives how much the
        // doors/hours baseline has blended toward the rep's real rolling pace.
        const stamps = [
          ...leadSnap.docs.map((d) => (d.data() as Lead).createdAt || 0),
          ...shiftSnap.docs.map((d) => (d.data() as Shift).startAt || 0),
        ].filter((t) => t > 0);
        const earliest = stamps.length ? Math.min(...stamps) : 0;
        setDaysActive(earliest ? Math.min(WINDOW_DAYS, Math.floor((Date.now() - earliest) / 86400000) + 1) : 0);
      } catch (e) {
        console.error("planner data", e);
      }
    })();
    return () => { off = true; };
  }, [uid]);

  const saveGoalCount = (n: number) => {
    const v = Math.max(1, n);
    setGoalCount(v);
    setGoalWeek(weekStartSun); // lock it in for this week
    if (uid) {
      localStorage.setItem(`yk_closegoal_${uid}`, String(v));
      localStorage.setItem(`yk_closegoal_week_${uid}`, String(weekStartSun));
    }
  };

  // Derived conversion rates straight from the rep's measured activity (no
  // manual overrides). Fall back to sane defaults when a field is still 0.
  const rates = useMemo(() => {
    const a = measured;
    return {
      closeRate: a.appt > 0 ? a.closes / a.appt : FALLBACK.closeRate,
      apptPerDoor: a.doors > 0 ? a.appt / a.doors : FALLBACK.apptPerDoor,
      apptPerConv: a.conv > 0 ? a.appt / a.conv : FALLBACK.apptPerConv,
      doorsPerHour: a.hours > 0 ? a.doors / a.hours : FALLBACK.doorsPerHour,
    };
  }, [measured]);

  // Reverse-plan the WEEKLY close goal through the rep's conversion rates into
  // daily / weekly / monthly targets. Appointments & conversations come from the
  // conversion math; doors & hours start at the baseline and blend toward the
  // rep's real rolling pace from day one, reaching a full 30-day average at day 30.
  const plan = useMemo(() => {
    const closesWeek = goalCount;
    const apptsWeek = closesWeek / (rates.closeRate || FALLBACK.closeRate);
    const convWeek = apptsWeek / (rates.apptPerConv || FALLBACK.apptPerConv);

    const w = Math.min(daysActive / WINDOW_DAYS, 1); // 0 = baseline, 1 = full rolling
    const derivedDoorsWeek = apptsWeek / (rates.apptPerDoor || FALLBACK.apptPerDoor);
    const doorsWeek = DEFAULT_DOORS_WEEK * (1 - w) + derivedDoorsWeek * w;
    const derivedHoursWeek = doorsWeek / (rates.doorsPerHour || FALLBACK.doorsPerHour);
    const hoursWeek = DEFAULT_HOURS_WEEK * (1 - w) + derivedHoursWeek * w;

    const per = (weekly: number) => ({
      week: weekly,
      day: weekly / DAYS_PER_WEEK,
      month: weekly * WEEKS_PER_MONTH,
    });
    return {
      closes: per(closesWeek),
      appts: per(apptsWeek),
      conv: per(convWeek),
      doors: per(doorsWeek),
      hours: per(hoursWeek),
    };
  }, [goalCount, rates, daysActive]);

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

  // View-only number from the rep's measured data — not editable.
  const aField = (label: string, key: keyof Actuals) => (
    <label className="field">
      <span>{label}</span>
      <input type="number" className="input" value={measured[key]} readOnly disabled />
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
      {/* ── Weekly reverse goal calculator ─────────────────── */}
      <div className="card">
        <h2 className="planner-h">◎ Weekly Goal Planner</h2>
        <p className="muted small">
          Set your weekly close target and we'll work backward through <em>your</em> rolling-average conversion
          rates into a daily and weekly game plan.
        </p>

        <div className="planner-goalbar">
          <span>I want to close</span>
          <input
            type="number" min={1} className="input goal-input"
            value={goalCount}
            disabled={!canEditGoal}
            onChange={(e) => saveGoalCount(Number(e.target.value))}
          />
          <span>per week</span>
        </div>

        {!canEditGoal && (
          <div className="muted small" style={{ marginTop: 6 }}>
            🔒 Your close goal is set for this week — you can change it again on <strong>Sunday</strong> (or your
            first login next week). Everything else adjusts automatically from your rolling {WINDOW_DAYS}-day average.
          </div>
        )}

        <div className="muted small" style={{ margin: "10px 0 4px" }}>Your weekly game plan:</div>
        <div className="plan-grid">
          <PlanStat n={ceil(plan.appts.week)} label="Appts / wk" />
          <PlanStat n={ceil(plan.conv.week)} label="Conversations / wk" />
          <PlanStat n={ceil(plan.doors.week)} label="Doors / wk" />
          <PlanStat n={r1(plan.hours.week)} label="Hours / wk" />
        </div>

        {daysActive < WINDOW_DAYS && (
          <div className="muted small" style={{ marginTop: 4 }}>
            Doors &amp; hours start from a {DEFAULT_DOORS_WEEK}/{DEFAULT_HOURS_WEEK} weekly baseline and shift toward your
            real pace from day one — reaching a full {WINDOW_DAYS}-day rolling average at day {WINDOW_DAYS}
            {daysActive > 0 ? ` (day ${daysActive} so far)` : ""}.
          </div>
        )}
      </div>

      {/* ── Your numbers (view-only — straight from your logged activity) ── */}
      <div className="card">
        <div className="planner-row-head">
          <h2 className="planner-h">Your numbers</h2>
          <span className="muted small">View only</span>
        </div>
        <p className="muted small">
          Your real activity from the rolling last {WINDOW_DAYS} days — these drive the plan above and update
          automatically as you log doors, appointments and closes. They can't be edited.
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
