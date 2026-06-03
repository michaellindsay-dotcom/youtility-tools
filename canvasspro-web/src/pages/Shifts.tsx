import GoalPlanner from "../components/GoalPlanner";
import ShiftsPanel from "../components/ShiftsPanel";

// The "Success Planner" surface. It pairs the goal/pace planner (what it takes
// to hit your target, computed from your real last-30-day rates) with the shift
// time keeper. The sidebar links here as "Success Planner"; the GoalPlanner is
// the half that gives the page its name — without it the page was just a shift
// log of timestamps.
export default function Shifts() {
  return (
    <div className="page-body">
      <div className="page-head">
        <h1>Success Planner</h1>
        <p className="page-sub">Set your goal and see what it takes — then clock your canvassing time. Door knocks count automatically while on shift.</p>
      </div>
      <GoalPlanner />
      <h2 className="section-h">Shifts</h2>
      <ShiftsPanel />
    </div>
  );
}
