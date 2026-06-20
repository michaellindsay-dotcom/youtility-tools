// ============================================================================
// fix-superadmin.mjs
// ----------------------------------------------------------------------------
// Make ONE account the only platform super-admin, and strip the super-admin
// flag from everyone else — WITHOUT deleting any users or data.
//
// Unlike bootstrap-superadmin.mjs (which wipes ALL users), this script only
// adjusts the `superAdmin` custom claim (and the mirrored `superAdmin` field on
// the /users doc). Company scoping is read from each user's /users doc
// (companyId + role), so demoting a super-admin simply turns them back into a
// normal member of whatever company their profile already points at. For a
// demoted account whose role was "superadmin", the role is reset to "admin" so
// it remains a company admin.
//
// ---- Auth (one of) --------------------------------------------------------
//   A) Service account key (recommended):
//        Firebase console → Project settings → Service accounts →
//        "Generate new private key", then either:
//          export GOOGLE_APPLICATION_CREDENTIALS=/abs/path/serviceAccountKey.json
//        or pass it explicitly:  --key /abs/path/serviceAccountKey.json
//   B) gcloud ADC:  gcloud auth application-default login
//
// ---- Run ------------------------------------------------------------------
//   npm install firebase-admin            # if not already available
//   node scripts/fix-superadmin.mjs                 # DRY RUN (shows the plan)
//   node scripts/fix-superadmin.mjs --apply         # make the changes
//
// After it runs, the affected people must sign out and back in (or just reload)
// so their ID token picks up the new claim.
// ============================================================================

import { initializeApp, applicationDefault, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync } from "node:fs";

// ── Config ──────────────────────────────────────────────────────────────────
const PROJECT_ID = "youtilityknock";
const SUPERADMIN_EMAIL = "michael@rockymountainsolar.net"; // the ONLY super-admin
const USERS_COLLECTION = "users";

const APPLY = process.argv.includes("--apply");
const keyArgIdx = process.argv.indexOf("--key");
const keyPath = keyArgIdx !== -1 ? process.argv[keyArgIdx + 1] : null;

function initAdmin() {
  if (keyPath) {
    const svc = JSON.parse(readFileSync(keyPath, "utf8"));
    return initializeApp({ credential: cert(svc), projectId: svc.project_id || PROJECT_ID });
  }
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

async function main() {
  const app = initAdmin();
  const auth = getAuth(app);
  const db = getFirestore(app);

  console.log(`\nProject: ${PROJECT_ID}`);
  console.log(`Sole super-admin: ${SUPERADMIN_EMAIL}`);
  console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY RUN (no changes)"}\n`);

  const users = await listAllUsers(auth);
  const target = users.find((u) => (u.email || "").toLowerCase() === SUPERADMIN_EMAIL.toLowerCase());
  if (!target) {
    console.error(`✗ No auth user found for ${SUPERADMIN_EMAIL}. Aborting.`);
    process.exit(1);
  }

  const grant = [];   // who we make super
  const revoke = [];  // who we strip super from
  for (const u of users) {
    const claims = u.customClaims || {};
    const isTarget = u.uid === target.uid;
    if (isTarget) {
      if (claims.superAdmin !== true || claims.role !== "superadmin") grant.push(u);
    } else if (claims.superAdmin === true || claims.role === "superadmin") {
      revoke.push(u);
    }
  }

  console.log(`Will GRANT super-admin to: ${grant.length ? grant.map((u) => u.email).join(", ") : "(already set)"}`);
  console.log(`Will REVOKE super-admin from: ${revoke.length ? revoke.map((u) => u.email).join(", ") : "(none)"}\n`);

  if (!APPLY) {
    console.log("DRY RUN — re-run with --apply to make these changes.\n");
    return;
  }

  // Grant the sole super-admin.
  {
    const claims = target.customClaims || {};
    await auth.setCustomUserClaims(target.uid, { ...claims, superAdmin: true, role: "superadmin" });
    await db.collection(USERS_COLLECTION).doc(target.uid).set(
      { superAdmin: true, role: "superadmin" }, { merge: true }
    );
    console.log(`✓ ${SUPERADMIN_EMAIL} is now super-admin.`);
  }

  // Revoke everyone else.
  for (const u of revoke) {
    const { superAdmin, ...rest } = u.customClaims || {};
    // A former super-admin keeps any company role; if they were literally
    // "superadmin", drop them to company "admin".
    if (rest.role === "superadmin") rest.role = "admin";
    await auth.setCustomUserClaims(u.uid, rest);

    const docRef = db.collection(USERS_COLLECTION).doc(u.uid);
    const snap = await docRef.get();
    const patch = { superAdmin: false };
    if (snap.exists && snap.data().role === "superadmin") patch.role = "admin";
    await docRef.set(patch, { merge: true });
    console.log(`✓ Revoked super-admin from ${u.email || u.uid}` +
      (patch.role ? " (role → admin)" : ""));
  }

  console.log("\nDone. Affected users should sign out and back in to refresh their token.\n");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
