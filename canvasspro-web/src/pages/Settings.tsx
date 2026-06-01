import { useAuth } from "../auth/AuthContext";

export default function Settings() {
  const { profile, role } = useAuth();
  return (
    <div className="page-body">
      <div className="page-head">
        <h1>Settings</h1>
        <p className="page-sub">Your account.</p>
      </div>

      <div className="card">
        <dl className="fields">
          <div className="field-row">
            <dt>Name</dt>
            <dd>{profile?.displayName}</dd>
          </div>
          <div className="field-row">
            <dt>Email</dt>
            <dd>{profile?.email}</dd>
          </div>
          <div className="field-row">
            <dt>Role</dt>
            <dd>
              <span className={`role-badge role-${role}`}>{role}</span>
            </dd>
          </div>
          <div className="field-row">
            <dt>User ID</dt>
            <dd className="mono">{profile?.uid}</dd>
          </div>
        </dl>
      </div>

      <p className="muted small">
        Need a role change? Ask an admin from the Admin · Users screen.
      </p>
    </div>
  );
}
