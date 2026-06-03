import { Navigate, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "./AuthContext";
import type { Role } from "../types";

interface Props {
  children: ReactNode;
  /** If set, only these roles may view the route. */
  roles?: Role[];
}

export default function ProtectedRoute({ children, roles }: Props) {
  const { user, role, company, noAccess, loading, logout } = useAuth();
  const location = useLocation();

  if (loading) {
    return <div className="centered-loader">Loading…</div>;
  }
  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  // Signed in but no company/profile — account not provisioned by an admin.
  if (noAccess) {
    return (
      <div className="auth-wrap">
        <div className="auth-card card" style={{ textAlign: "center" }}>
          <h2 style={{ border: 0 }}>Account not set up</h2>
          <p className="muted">
            Your sign-in worked, but your account hasn't been added to a company yet.
            Ask your administrator to provision your access in the admin console.
          </p>
          <button className="btn block" style={{ marginTop: 16 }} onClick={() => logout()}>
            Sign out
          </button>
        </div>
      </div>
    );
  }
  // Suspended company → the account is paused (an expired trial or overdue
  // payment). Lock the app until they subscribe; their data stays untouched and
  // access restores automatically once payment flips the status back to active.
  if (company?.status === "suspended") {
    const trialEnded = company.trialExpired === true;
    return (
      <div className="auth-wrap">
        <div className="auth-card card" style={{ textAlign: "center" }}>
          <h2 style={{ border: 0 }}>{trialEnded ? "Trial ended" : "Account paused"}</h2>
          <p className="muted">
            {trialEnded
              ? "Your free trial has ended and the account is paused. Your data is safe — subscribe to a plan to pick up right where you left off."
              : "This account is paused. Your data is safe — once payment is received, access is restored automatically."}{" "}
            Contact your administrator or billing to reactivate.
          </p>
          <button className="btn block" style={{ marginTop: 16 }} onClick={() => logout()}>
            Sign out
          </button>
        </div>
      </div>
    );
  }
  if (roles && role && !roles.includes(role)) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}
