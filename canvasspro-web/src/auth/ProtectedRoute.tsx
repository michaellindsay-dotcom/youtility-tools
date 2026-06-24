import { Navigate, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "./AuthContext";
import { isBillingLocked, PAYMENT_LOCK_MSG } from "../lib/billing";
import type { Role } from "../types";

interface Props {
  children: ReactNode;
  /** If set, only these roles may view the route. */
  roles?: Role[];
}

export default function ProtectedRoute({ children, roles }: Props) {
  const { user, role, company, companyLoaded, noAccess, loading, logout } = useAuth();
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
  // Inactive or removed company → no access. (AuthContext also signs these
  // accounts out, landing them on the login screen with the same message; this
  // branch just avoids any flash of the app in the meantime.) Data is never
  // deleted — access restores automatically once the company is active again.
  // Only block on a SERVER-confirmed company state (companyLoaded). A stale
  // browser cache can briefly report an old "suspended" status or a missing
  // doc; we must not lock an active company out before the server replies.
  const status = String(company?.status || "active").toLowerCase();
  const companyInactive =
    companyLoaded &&
    (company ? status === "suspended" || status === "inactive" : true);
  if (companyInactive) {
    const billing = isBillingLocked(company);
    return (
      <div className="auth-wrap">
        <div className="auth-card card" style={{ textAlign: "center" }}>
          <h2 style={{ border: 0 }}>{billing ? "Payment required" : "Account inactive"}</h2>
          <p className="muted">
            {billing ? PAYMENT_LOCK_MSG : "This account is no longer active. Please contact your system administrator."}
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
