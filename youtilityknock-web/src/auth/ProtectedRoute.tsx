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
  // We show the signed-in email + UID so an admin can tell apart the two causes:
  //   • the account was genuinely never provisioned, or
  //   • a profile EXISTS in the console but under a different document ID than
  //     this login's UID (an imported account, or an Auth user that was deleted
  //     and recreated). The app loads the profile at users/<this UID>, so an
  //     ID that doesn't match this UID is invisible to it even though the admin
  //     console — which lists users by their companyId field — still shows it.
  if (noAccess) {
    return (
      <div className="auth-wrap">
        <div className="auth-card card" style={{ textAlign: "center" }}>
          <h2 style={{ border: 0 }}>Account not set up</h2>
          <p className="muted">
            Your sign-in worked, but this login isn't linked to a company profile yet.
            Ask your administrator to provision (or re-link) your access in the admin console.
          </p>
          <div className="muted small" style={{ marginTop: 12, textAlign: "left", wordBreak: "break-all" }}>
            <div>Signed in as: <strong>{user.email || "—"}</strong></div>
            <div>Account ID: <code>{user.uid}</code></div>
            <p style={{ marginTop: 8 }}>
              Give your administrator the Account ID above — if a profile already
              exists for you, it needs to be linked to this exact ID.
            </p>
          </div>
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
  //
  // An EXPLICIT suspended/inactive status is authoritative even from cache. A
  // device with a warm Firestore cache (or briefly offline — the norm in the
  // field) must not get a free pass into the app just because the blocking
  // decision is waiting on a fresh server snapshot that may be slow to arrive.
  // This was the bug behind "it still lets me in on my phone but not in an
  // incognito window": incognito has no cache, so it always read the suspended
  // status from the server and blocked, while a cached session never did.
  // Trusting the cached status here can only ever cause a brief, self-correcting
  // flash (the live company listener delivers the real status moments later),
  // never a permanent lockout.
  //
  // A *missing* company doc is different: a cold cache reports the doc missing
  // before its first sync, so we only treat "missing" as inactive once the
  // server has confirmed it (companyLoaded) — otherwise we'd lock valid
  // companies out on startup.
  const status = String(company?.status || "active").toLowerCase();
  const explicitlyInactive =
    !!company && (status === "suspended" || status === "inactive");
  const missingAfterLoad = companyLoaded && !company;
  const companyInactive = explicitlyInactive || missingAfterLoad;
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
