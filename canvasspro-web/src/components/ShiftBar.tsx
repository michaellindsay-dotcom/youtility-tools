import { useShift, fmtElapsed } from "../shift/ShiftContext";

export default function ShiftBar() {
  const { active, elapsedSec, doors, starting, startShift, stopShift } = useShift();

  if (!active) {
    return (
      <button className="btn primary sm shift-btn" onClick={() => startShift()} disabled={starting}>
        ▶ {starting ? "Starting…" : "Start Shift"}
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
