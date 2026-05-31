import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import type { Role, UserProfile } from "../types";

const ROLES: Role[] = ["rep", "manager", "admin"];

export default function Admin() {
  const { profile: me, role: myRole } = useAuth();
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyUid, setBusyUid] = useState<string | null>(null);
  const [msg, setMsg] = useState<string>("");

  useEffect(() => {
    const q = query(collection(db, "users"), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setUsers(snap.docs.map((d) => ({ uid: d.id, ...(d.data() as Omit<UserProfile, "uid">) })));
        setLoading(false);
      },
      (err) => {
        console.error(err);
        setLoading(false);
      }
    );
    return unsub;
  }, []);

  // Role changes go through a Cloud Function (admin SDK), never directly from
  // the client — Firestore rules forbid client-side role edits.
  const changeRole = async (uid: string, role: Role) => {
    setBusyUid(uid);
    setMsg("");
    try {
      const setUserRole = httpsCallable(functions, "setUserRole");
      await setUserRole({ uid, role });
      setMsg("Role updated.");
    } catch (err: any) {
      setMsg(err?.message || "Failed to update role.");
    } finally {
      setBusyUid(null);
    }
  };

  return (
    <div className="page-body">
      <div className="page-head">
        <h1>Admin · Users</h1>
        <p className="page-sub">Manage team members and their access levels.</p>
      </div>

      {msg && <div className="banner info show">{msg}</div>}

      {loading ? (
        <div className="muted">Loading users…</div>
      ) : (
        <div className="card table-card">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.uid}>
                  <td>{u.displayName}</td>
                  <td className="muted">{u.email}</td>
                  <td>
                    {myRole === "admin" && u.uid !== me?.uid ? (
                      <select
                        value={u.role}
                        disabled={busyUid === u.uid}
                        onChange={(e) => changeRole(u.uid, e.target.value as Role)}
                        className="status-select"
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className={`role-badge role-${u.role}`}>{u.role}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {myRole !== "admin" && (
        <p className="muted small">
          Only admins can change roles. You can view the team as a manager.
        </p>
      )}
    </div>
  );
}
