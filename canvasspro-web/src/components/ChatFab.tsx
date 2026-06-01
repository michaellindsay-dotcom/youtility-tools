import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { collection, limit, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../auth/AuthContext";

// Floating Team Chat button shown on every page. Glows with a red dot when
// there's a new company message / announcement or DM the rep hasn't seen.
export default function ChatFab() {
  const { profile, companyId } = useAuth();
  const loc = useLocation();
  const onChat = loc.pathname === "/chat";
  const [latest, setLatest] = useState(0); // newest activity from someone else
  const [seen, setSeen] = useState(0);

  useEffect(() => {
    if (!profile) return;
    setSeen(Number(localStorage.getItem(`yk_chat_seen_${profile.uid}`) || 0));
  }, [profile]);

  // Latest company-channel message that wasn't from me (covers announcements +
  // the weekly recap, which post as "system").
  useEffect(() => {
    if (!companyId || !profile) return;
    const q = query(
      collection(db, "chat"),
      where("companyId", "==", companyId),
      orderBy("createdAt", "desc"),
      limit(6)
    );
    return onSnapshot(
      q,
      (snap) => {
        const other = snap.docs.map((d) => d.data() as { userId?: string; createdAt?: number })
          .find((m) => m.userId !== profile.uid);
        if (other?.createdAt) setLatest((p) => Math.max(p, other.createdAt!));
      },
      () => {}
    );
  }, [companyId, profile]);

  // Latest DM activity in any of my channels.
  useEffect(() => {
    if (!profile) return;
    const q = query(collection(db, "dms"), where("members", "array-contains", profile.uid));
    return onSnapshot(
      q,
      (snap) => {
        let max = 0;
        snap.docs.forEach((d) => {
          const c = d.data() as { lastAt?: number };
          if (c.lastAt) max = Math.max(max, c.lastAt);
        });
        if (max) setLatest((p) => Math.max(p, max));
      },
      () => {}
    );
  }, [profile]);

  // Visiting chat clears the alert.
  useEffect(() => {
    if (onChat && profile) {
      const now = Date.now();
      localStorage.setItem(`yk_chat_seen_${profile.uid}`, String(now));
      setSeen(now);
    }
  }, [onChat, latest, profile]);

  if (!profile || onChat) return null;

  const unread = latest > seen;
  return (
    <Link to="/chat" className="chat-fab-global" aria-label="Team chat">
      💬
      {unread && <span className="chat-fab-dot" />}
    </Link>
  );
}
