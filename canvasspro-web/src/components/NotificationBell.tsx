import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import type { AppNotification } from "../types";

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const ICON: Record<string, string> = { chat: "💬", dm: "✉️", event: "📅" };

export default function NotificationBell() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [items, setItems] = useState<AppNotification[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!user) return;
    const q = query(
      collection(db, "notifications"),
      where("userId", "==", user.uid),
      orderBy("createdAt", "desc"),
      limit(30)
    );
    return onSnapshot(q, (snap) =>
      setItems(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<AppNotification, "id">) })))
    );
  }, [user]);

  // Close on outside click.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const unread = items.filter((n) => !n.read).length;

  const markAll = async () => {
    const batch = writeBatch(db);
    items.filter((n) => !n.read).forEach((n) => batch.update(doc(db, "notifications", n.id), { read: true }));
    await batch.commit().catch(() => {});
  };

  const onClick = async (n: AppNotification) => {
    if (!n.read) await updateDoc(doc(db, "notifications", n.id), { read: true }).catch(() => {});
    setOpen(false);
    if (n.link) navigate(n.link.replace(/^\/app/, "") || "/");
  };

  return (
    <div className="notif" ref={ref}>
      <button
        className="notif-btn"
        onClick={() => setOpen((o) => !o)}
        aria-label="Notifications"
        title="Notifications"
      >
        🔔
        {unread > 0 && <span className="notif-badge">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div className="notif-panel">
          <div className="notif-head">
            <strong>Notifications</strong>
            {unread > 0 && (
              <button className="btn ghost sm" onClick={markAll}>
                Mark all read
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <div className="notif-empty muted">You're all caught up.</div>
          ) : (
            <ul className="notif-list">
              {items.map((n) => (
                <li
                  key={n.id}
                  className={"notif-item" + (n.read ? "" : " unread")}
                  onClick={() => onClick(n)}
                >
                  <span className="notif-ico">{ICON[n.type] || "•"}</span>
                  <div className="notif-body">
                    <div className="notif-title">{n.title}</div>
                    {n.body && <div className="notif-text muted small">{n.body}</div>}
                    <div className="notif-time muted small">{timeAgo(n.createdAt)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
