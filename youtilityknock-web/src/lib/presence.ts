import { useEffect } from "react";
import { doc, setDoc } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../auth/AuthContext";

// Heartbeat: while the app is open and focused we touch presence/{uid} so the
// notification Cloud Functions know the user is online (and can skip the
// email/SMS fallback). Cheap — one write per HEARTBEAT_MS.
const HEARTBEAT_MS = 60 * 1000;

export function usePresenceHeartbeat() {
  const { user } = useAuth();
  useEffect(() => {
    if (!user) return;
    const ref = doc(db, "presence", user.uid);
    const beat = () => {
      if (document.visibilityState === "visible") {
        void setDoc(ref, { lastSeen: Date.now() }, { merge: true }).catch(() => {});
      }
    };
    beat();
    const t = setInterval(beat, HEARTBEAT_MS);
    document.addEventListener("visibilitychange", beat);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", beat);
    };
  }, [user]);
}
