// ============================================================================
// bootstrap-superadmin.mjs
// ----------------------------------------------------------------------------
// ONE-TIME operational script for the canvasspro-7edd6 Firebase project.
//
// It will, in order:
//   1. DELETE every Firebase Authentication user.
//   2. DELETE every document in the `users` Firestore collection.
//   3. CREATE michael@rockymountainsolar.net with a temporary password.
//   4. Mark that account as the four-tier SUPERADMIN
//      (custom claim superAdmin:true + role:"superadmin"; tiers are
//       superadmin > admin > manager > user).
//
// ⚠️  DESTRUCTIVE + IRREVERSIBLE. It removes the other live accounts
//     (michael@rmenergy.net, info@rockymountainsolar.net,
//      michael.lindsay@youtility.us). Deleted auth users cannot be restored.
//
// It runs in DRY-RUN by default (lists what it would do). To actually execute,
// pass the flag:  --yes-delete-all-users
//
// ---- Auth (one of) --------------------------------------------------------
//   A) Service account key (recommended):
//        Firebase console → Project settings → Service accounts →
//        "Generate new private key". Then:
//        export GOOGLE_APPLICATION_CREDENTIALS=/abs/path/serviceAccountKey.json
//   B) gcloud ADC:  gcloud auth application-default login
//
// ---- Run ------------------------------------------------------------------
//   npm install firebase-admin            # if not already available
//   node scripts/bootstrap-superadmin.mjs                       # dry run
//   node scripts/bootstrap-superadmin.mjs --yes-delete-all-users
// ============================================================================

import { initializeApp, applicationDefault, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync } from "node:fs";

// ── Config ──────────────────────────────────────────────────────────────────
const PROJECT_ID = "canvasspro-7edd6";
const SUPERADMIN_EMAIL = "michael@rockymountainsolar.net";
const SUPERADMIN_NAME = "Michael Lindsay";
const TEMP_PASSWORD = "Knock-q2MvpxfTny_2026"; // change on first login
const ROLE = "superadmin"; // four-tier top tier
const USERS_COLLECTION = "users";
const PUBLIC_PROFILES_COLLECTION = "publicProfiles";

const CONFIRMED = process.argv.includes("--yes-delete-all-users");

// Optional explicit key path: --key /path/to/serviceAccountKey.json
const keyArgIdx = process.argv.indexOf("--key");
const keyPath = keyArgIdx !== -1 ? process.argv[keyArgIdx + 1] : null;

function initAdmin() {
  if (keyPath) {
    const svc = JSON.parse(readFileSync(keyPath, "utf8"));
    return initializeApp({ credential: cert(svc), projectId: svc.project_id || PROJECT_ID });
  }
  // Uses GOOGLE_APPLICATION_CREDENTIALS or gcloud ADC.
  return initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
}

async function listAllUsers(auth) {
  const all = [];
  let pageToken;
  do {
    const res = await auth.listUsers(1000, pageToken);
    all.push(...res.users);
    pageToken = res.pageToken;
  } while (pageToken);
  return all;
}

async function deleteAllAuthUsers(auth, users) {
  const uids = users.map((u) => u.uid);
  for (let i = 0; i < uids.length; i += 1000) {
    const batch = uids.slice(i, i + 1000);
    const res = await auth.deleteUsers(batch);
    console.log(`  deleted ${res.successCount}/${batch.length} (failures: ${res.failureCount})`);
    res.errors.forEach((e) => console.warn("   !", e.index, e.error.message));
  }
}

async function deleteAllDocs(db, collectionName) {
  const snap = await db.collection(collectionName).get();
  let n = 0;
  for (let i = 0; i < snap.docs.length; i += 450) {
    const batch = db.batch();
    snap.docs.slice(i, i + 450).forEach((d) => batch.delete(d.ref));
    await batch.commit();
    n += Math.min(450, snap.docs.length - i);
  }
  return n;
}

async function main() {
  const app = initAdmin();
  const auth = getAuth(app);
  const db = getFirestore(app);

  console.log(`\nProject: ${PROJECT_ID}`);
  console.log(`Mode: ${CONFIRMED ? "EXECUTE (destructive)" : "DRY RUN (no changes)"}\n`);

  const users = await listAllUsers(auth);
  console.log(`Existing auth users (${users.length}):`);
  users.forEach((u) => console.log(`  - ${u.email || "(no email)"}  [${u.uid}]`));

  const userDocs = await db.collection(USERS_COLLECTION).get();
  console.log(`Existing /${USERS_COLLECTION} docs: ${userDocs.size}\n`);

  if (!CONFIRMED) {
    console.log("DRY RUN — would delete ALL of the above, then create:");
    console.log(`  ${SUPERADMIN_EMAIL}  role=${ROLE}  superAdmin=true`);
    console.log(`  temp password: ${TEMP_PASSWORD}`);
    console.log("\nRe-run with --yes-delete-all-users to execute.\n");
    return;
  }

  console.log("Deleting all auth users…");
  await deleteAllAuthUsers(auth, users);

  console.log(`Deleting all /${USERS_COLLECTION} and /${PUBLIC_PROFILES_COLLECTION} docs…`);
  const removedUsers = await deleteAllDocs(db, USERS_COLLECTION);
  const removedProfiles = await deleteAllDocs(db, PUBLIC_PROFILES_COLLECTION);
  console.log(`  removed ${removedUsers} user docs, ${removedProfiles} public profiles`);

  console.log(`Creating ${SUPERADMIN_EMAIL}…`);
  const rec = await auth.createUser({
    email: SUPERADMIN_EMAIL,
    password: TEMP_PASSWORD,
    displayName: SUPERADMIN_NAME,
    emailVerified: true,
  });

  // Four-tier role: superadmin > admin > manager > user
  await auth.setCustomUserClaims(rec.uid, { superAdmin: true, role: ROLE });
  await db.collection(USERS_COLLECTION).doc(rec.uid).set({
    uid: rec.uid,
    email: SUPERADMIN_EMAIL,
    displayName: SUPERADMIN_NAME,
    role: ROLE,
    superAdmin: true,
    mustChangePassword: true,
    createdAt: Date.now(),
  });
  // Display-only mirror for team lists / chat names (see canvasspro-firestore.rules).
  await db.collection(PUBLIC_PROFILES_COLLECTION).doc(rec.uid).set({
    uid: rec.uid,
    displayName: SUPERADMIN_NAME,
    photoURL: null,
    role: ROLE,
  });

  console.log("\n✅ Done.");
  console.log(`   uid:           ${rec.uid}`);
  console.log(`   email:         ${SUPERADMIN_EMAIL}`);
  console.log(`   role:          ${ROLE} (superAdmin claim set)`);
  console.log(`   temp password: ${TEMP_PASSWORD}`);
  console.log("   → Sign in, then change the password immediately.\n");
}

main().catch((err) => {
  console.error("\n❌ Failed:", err.message || err);
  process.exit(1);
});
