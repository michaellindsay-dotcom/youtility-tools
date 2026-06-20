import { useAuth } from "../auth/AuthContext";
import { isImpersonating } from "../firebase";
import ShiftBar from "./ShiftBar";
import NotificationBell from "./NotificationBell";

export default function Topbar({ onMenu }: { onMenu?: () => void }) {
  const { profile, logout } = useAuth();

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
      {/* Start Shift on the right, notifications just to its right.
          Sign out now lives at the bottom of the sidebar. */}
      <div className="topbar-actions">
        <ShiftBar />
        <NotificationBell />
      </div>
    </header>
  );
}
