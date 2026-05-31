import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

export default function Topbar() {
  const { profile, role, logout } = useAuth();
  const navigate = useNavigate();

  const onLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

  return (
    <header className="topbar">
      <div className="topbar-title" />
      <div className="topbar-user">
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
