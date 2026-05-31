import { doc, setDoc, increment } from "firebase/firestore";
import { db } from "../firebase";
import type { UserProfile } from "../types";

// Atomically bump a user's rolled-up stats. The doc carries companyId +
// managerPath so managers can read their downstream stats (see firestore.rules).
export async function bumpStats(
  profile: Pick<UserProfile, "uid" | "companyId" | "displayName" | "managerPath">,
  deltas: Record<string, number>
): Promise<void> {
  const inc: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(deltas)) inc[k] = increment(v);
  try {
    await setDoc(
      doc(db, "userStats", profile.uid),
      {
        uid: profile.uid,
        companyId: profile.companyId,
        userName: profile.displayName,
        managerPath: profile.managerPath ?? [],
        ...inc,
        updatedAt: Date.now(),
      },
      { merge: true }
    );
  } catch (err) {
    // Stats are best-effort; never block the primary action on them.
    console.warn("bumpStats failed", err);
  }
}
