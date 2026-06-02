import { useNavigate } from "react-router-dom";
import { useShift, fmtElapsed } from "../shift/ShiftContext";

export default function ShiftBar() {
  const { active, elapsedSec, doors, stopShift } = useShift();
  const navigate = useNavigate();

  if (!active) {
    // Start Shift takes the rep to the Map, where the on-map button actually
    // starts the shift (and they're ready to work the route).
    return (
      <button className="btn primary sm shift-btn" onClick={() => navigate("/map")}>
        ▶ Start Shift
      </button>
    );
  }
  return (
    <div className="shift-live-bar">
      <span className="shift-dot" />
      <span className="shift-time mono">{fmtElapsed(elapsedSec)}</span>
      <span className="shift-doors">{doors} doors</span>
      <button className="btn sm" onClick={() => stopShift()}>Stop</button>
    </div>
  );
}
