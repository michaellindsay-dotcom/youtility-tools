import WhosWorkingPanel from "../components/WhosWorkingPanel";

// Standalone Who's Working page. The live board also lives inside the Chat page
// (as a rail view); this route is kept so direct links / RallyCard-only nav
// still reach it.
export default function Working() {
  return (
    <div className="page-body">
      <WhosWorkingPanel />
    </div>
  );
}
