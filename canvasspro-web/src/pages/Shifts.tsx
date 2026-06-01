import ShiftsPanel from "../components/ShiftsPanel";

export default function Shifts() {
  return (
    <div className="page-body">
      <div className="page-head">
        <h1>Shifts</h1>
        <p className="page-sub">Clock your canvassing time. Door knocks count automatically while on shift.</p>
      </div>
      <ShiftsPanel />
    </div>
  );
}
