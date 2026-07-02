import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { isRallyCardOnly } from "../lib/features";
import type { UserProfile } from "../types";

const TIER_BADGE: Record<string, string> = {
  admin: "role-admin",
  manager: "role-manager",
};

function Node({
  user,
  childrenOf,
  depth,
}: {
  user: UserProfile;
  childrenOf: (uid: string) => UserProfile[];
  depth: number;
}) {
  const kids = childrenOf(user.uid);
  return (
    <li className="org-node">
      <div className="org-card" style={{ marginLeft: depth * 4 }}>
        <div className="avatar sm">{(user.displayName || "?").slice(0, 1).toUpperCase()}</div>
        <div className="org-body">
          <div className="org-name">
            {user.displayName}
            <span className={`role-badge ${TIER_BADGE[user.role] || ""}`}>
              {user.title || user.role}
            </span>
            {user.cardEnabled && user.cardSlug && (
              <a
                className="pill"
                style={{ marginLeft: 6 }}
                href={`https://youtilityknock.web.app/app?card=${user.cardSlug}`}
                target="_blank"
                rel="noopener noreferrer"
                title="View RallyCard"
              >
                🪪 RallyCard
              </a>
            )}
          </div>
          <div className="muted small">{user.email}</div>
        </div>
      </div>
      {kids.length > 0 && (
        <ul className="org-children">
          {kids.map((k) => (
            <Node key={k.uid} user={k} childrenOf={childrenOf} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

export default function Team() {
  const { profile, role, companyId, company } = useAuth();
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!profile || !companyId) return;
    let cancelled = false;
    (async () => {
      try {
        const base = collection(db, "users");
        // Admins see the whole company; everyone else only their downstream
        // (their uid in managerPath) — self is added back below.
        const q =
          role === "admin"
            ? query(base, where("companyId", "==", companyId))
            : query(
                base,
                where("companyId", "==", companyId),
                where("managerPath", "array-contains", profile.uid)
              );
        const snap = await getDocs(q);
        let list = snap.docs.map((d) => ({ uid: d.id, ...(d.data() as Omit<UserProfile, "uid">) }));
        if (role !== "admin" && !list.some((u) => u.uid === profile.uid)) {
          list = [profile, ...list];
        }
        if (!cancelled) setUsers(list);
      } catch (err) {
        console.error(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [profile, role, companyId]);

  const ids = new Set(users.map((u) => u.uid));
  const childrenOf = (uid: string) => users.filter((u) => (u.managerId ?? null) === uid);
  const roots =
    role === "admin"
      ? users.filter((u) => !u.managerId || !ids.has(u.managerId))
      : users.filter((u) => u.uid === profile?.uid);

  return (
    <div className="page-body">
      <div className="page-head">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
          <h1>Team</h1>
          {/* RallyCard-only companies have no Dashboard to go back to. */}
          {!isRallyCardOnly(company) && (
            <Link className="btn ghost sm" to="/">← Back to Dashboard</Link>
          )}
        </div>
        <p className="page-sub">
          {role === "admin" ? "Your company" : "Your downstream"} org chart.
        </p>
      </div>

      {loading ? (
        <div className="muted">Loading team…</div>
      ) : users.length === 0 ? (
        <div className="empty">No team members yet.</div>
      ) : (
        <ul className="org-tree">
          {roots.map((r) => (
            <Node key={r.uid} user={r} childrenOf={childrenOf} depth={0} />
          ))}
        </ul>
      )}
    </div>
  );
}
