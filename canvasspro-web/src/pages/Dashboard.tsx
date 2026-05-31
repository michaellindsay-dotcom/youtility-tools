import { useEffect, useState } from "react";
import { collection, getCountFromServer, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import type { LeadStatus } from "../types";

interface Stats {
  total: number;
  byStatus: Partial<Record<LeadStatus, number>>;
}

const STATUS_LABELS: Record<LeadStatus, string> = {
  new: "New",
  contacted: "Contacted",
  appointment: "Appointments",
  not_home: "Not home",
  not_interested: "Not interested",
  sold: "Sold",
};

export default function Dashboard() {
  const { profile, role } = useAuth();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const leads = collection(db, "leads");
        const mine = role === "rep" && profile ? [where("assignedTo", "==", profile.uid)] : [];
        const totalSnap = await getCountFromServer(query(leads, ...mine));
        const statuses: LeadStatus[] = [
          "new",
          "contacted",
          "appointment",
          "not_home",
          "not_interested",
          "sold",
        ];
        const byStatus: Partial<Record<LeadStatus, number>> = {};
        await Promise.all(
          statuses.map(async (st) => {
            const snap = await getCountFromServer(
              query(leads, where("status", "==", st), ...mine)
            );
            byStatus[st] = snap.data().count;
          })
        );
        if (!cancelled) {
          setStats({ total: totalSnap.data().count, byStatus });
          setLoading(false);
        }
      } catch (err) {
        console.error("Failed to load stats", err);
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [profile, role]);

  return (
    <div className="page-body">
      <div className="page-head">
        <h1>Welcome back{profile?.displayName ? `, ${profile.displayName.split(" ")[0]}` : ""}</h1>
        <p className="page-sub">
          {role === "rep" ? "Your" : "Team"} canvassing activity at a glance.
        </p>
      </div>

      {loading ? (
        <div className="muted">Loading stats…</div>
      ) : !stats ? (
        <div className="banner warn show">Couldn't load stats. Check Firestore configuration.</div>
      ) : (
        <div className="stat-grid">
          <div className="stat-card highlight">
            <div className="stat-value">{stats.total}</div>
            <div className="stat-label">Total leads</div>
          </div>
          {(Object.keys(STATUS_LABELS) as LeadStatus[]).map((st) => (
            <div className="stat-card" key={st}>
              <div className="stat-value">{stats.byStatus[st] ?? 0}</div>
              <div className="stat-label">{STATUS_LABELS[st]}</div>
            </div>
          ))}
        </div>
      )}

      <div className="quick-links">
        <a href="/lookup" className="card link-card">
          <h2>⌖ Run an address lookup</h2>
          <p className="muted">Pull homeowner intel before you knock.</p>
        </a>
        <a href="/leads" className="card link-card">
          <h2>☰ Work your leads</h2>
          <p className="muted">Update statuses and notes from the field.</p>
        </a>
      </div>
    </div>
  );
}
