import { doc, setDoc, increment } from "firebase/firestore";
import { db } from "../firebase";
import { seasonDocId, periodKey, type SeasonKind } from "./season";
import type { UserProfile } from "../types";

const SEASON_KINDS: SeasonKind[] = ["week", "month", "year"];

// Atomically bump a user's rolled-up stats. Writes the all-time doc (userStats)
// AND the current week/month/year buckets (seasonStats) so the leaderboard can
// show true resetting seasons. All docs carry companyId + managerPath so
// managers can read their downstream (see firestore.rules).
export async function bumpStats(
  profile: Pick<UserProfile, "uid" | "companyId" | "displayName" | "managerPath" | "createdAt">,
  deltas: Record<string, number>
): Promise<void> {
  const inc: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(deltas)) inc[k] = increment(v);
  const base = {
    uid: profile.uid,
    companyId: profile.companyId,
    userName: profile.displayName,
    managerPath: profile.managerPath ?? [],
    ...inc,
    updatedAt: Date.now(),
  };
  try {
    await Promise.all([
      setDoc(doc(db, "userStats", profile.uid), base, { merge: true }),
      ...SEASON_KINDS.map((kind) =>
        setDoc(
          doc(db, "seasonStats", seasonDocId(profile.uid, kind)),
          { ...base, kind, period: periodKey(kind), joinedAt: profile.createdAt ?? null },
          { merge: true }
        )
      ),
    ]);
  } catch (err) {
    // Stats are best-effort; never block the primary action on them.
    console.warn("bumpStats failed", err);
  }
}
