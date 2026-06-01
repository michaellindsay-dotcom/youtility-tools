import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { isImpersonating } from "../firebase";
import ShiftBar from "./ShiftBar";
import NotificationBell from "./NotificationBell";

export default function Topbar() {
  const { profile, role, logout } = useAuth();
  const navigate = useNavigate();

  const onLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

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
      <div className="topbar-title"><ShiftBar /></div>
      <div className="topbar-user">
        <NotificationBell />
        <div className="topbar-user-info">
          <div className="topbar-user-name">{profile?.displayName ?? "User"}</div>
          <div className="topbar-user-role">{role ?? ""}</div>
        </div>
        <div className="avatar">
          {(profile?.displayName ?? "U").slice(0, 1).toUpperCase()}
        </div>
        <button className="btn ghost sm" onClick={onLogout}>
          Sign out
        </button>
      </div>
    </header>
  );
}
