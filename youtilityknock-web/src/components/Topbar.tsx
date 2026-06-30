import { useAuth } from "../auth/AuthContext";
import { isImpersonating } from "../firebase";
import ShiftBar from "./ShiftBar";
import NotificationBell from "./NotificationBell";

export default function Topbar({ onMenu }: { onMenu?: () => void }) {
  const { profile, logout, company } = useAuth();

  const exitMirror = async () => {
    await logout();
    window.close();
    // Fallback if the tab can't be closed programmatically.
    window.location.href = "/admin.html";
  };

  return (
    <header className="topbar">
      {isImpersonating && (
        <div className="mirror-bar">
          👁 Mirroring <strong>{profile?.displayName ?? "user"}</strong> ({profile?.email}) — acting as them
          <button className="btn ghost sm" onClick={exitMirror}>Exit mirror</button>
        </div>
      )}
      <button className="topbar-menu" onClick={onMenu} aria-label="Menu">☰</button>
      {/* Company name fills the space between the menu and the actions, making
          it feel like a company-specific platform. */}
      <div className="topbar-company">{company?.name ?? ""}</div>
      {/* Alerts, then Start Shift on the far right. */}
      <div className="topbar-actions">
        <NotificationBell />
        <ShiftBar />
      </div>
    </header>
  );
}
