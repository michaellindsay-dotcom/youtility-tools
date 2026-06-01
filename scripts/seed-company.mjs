// ============================================================================
// seed-company.mjs
// ----------------------------------------------------------------------------
// Creates a company + its first admin account directly via the Admin SDK,
// bypassing the callable Cloud Functions (useful before the org policy that
// blocks public function invocation is relaxed).
//
// Mirrors what createCompany + createUser do: seeds Manager + User roles and a
// default "Company" team, then creates the admin user with claims + profile +
// publicProfiles mirror.
//
// Auth: GOOGLE_APPLICATION_CREDENTIALS / gcloud ADC (works in Cloud Shell), or
//       --key /path/to/serviceAccountKey.json
//
// Run:  npm run seed:company
// ============================================================================
import { initializeApp, applicationDefault, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync } from "node:fs";

const PROJECT_ID = "youtilityknock";

// ── What to create (edit here) ───────────────────────────────────────────────
const COMPANY_NAME = "Youtility";
const COMPANY_PLAN = "pro";
const ADMIN_NAME = "Michael Lindsay";
const ADMIN_EMAIL = "michael.lindsay@youtility.us";
const ADMIN_PASSWORD = "password"; // weak — change after first login
const ADMIN_TIER = "admin"; // company admin

const keyArgIdx = process.argv.indexOf("--key");
const keyPath = keyArgIdx !== -1 ? process.argv[keyArgIdx + 1] : null;
function initAdmin() {
  if (keyPath) {
    const svc = JSON.parse(readFileSync(keyPath, "utf8"));
    return initializeApp({ credential: cert(svc), projectId: svc.project_id || PROJECT_ID });
  }
  return initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
}

async function main() {
  const app = initAdmin();
  const auth = getAuth(app);
  const db = getFirestore(app);
  console.log(`Project: ${PROJECT_ID}\n`);

  // 1) Company (reuse if one with this name already exists)
  let companyId;
  const existing = await db.collection("companies").where("name", "==", COMPANY_NAME).limit(1).get();
  if (!existing.empty) {
    companyId = existing.docs[0].id;
    console.log(`Company "${COMPANY_NAME}" already exists → ${companyId}`);
  } else {
    const ref = await db.collection("companies").add({
      name: COMPANY_NAME, plan: COMPANY_PLAN, status: "active",
      createdAt: Date.now(), createdBy: "seed-script",
    });
    companyId = ref.id;
    await ref.collection("roles").add({ companyId, title: "Manager", baseTier: "manager", rank: 100, isDefault: true, createdAt: Date.now() });
    await ref.collection("roles").add({ companyId, title: "User", baseTier: "user", rank: 10, isDefault: true, createdAt: Date.now() });
    await ref.collection("teams").add({ companyId, name: "Company", parentTeamId: null, createdAt: Date.now() });
    console.log(`Created company "${COMPANY_NAME}" (${COMPANY_PLAN}) → ${companyId}`);
  }

  // 2) Admin account
  let uid;
  try {
    const rec = await auth.createUser({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, displayName: ADMIN_NAME, emailVerified: true });
    uid = rec.uid;
    console.log(`Created auth user ${ADMIN_EMAIL} → ${uid}`);
  } catch (e) {
    if (e.code === "auth/email-already-exists") {
      uid = (await auth.getUserByEmail(ADMIN_EMAIL)).uid;
      await auth.updateUser(uid, { password: ADMIN_PASSWORD, displayName: ADMIN_NAME });
      console.log(`User ${ADMIN_EMAIL} already existed → updated (${uid})`);
    } else throw e;
  }

  await auth.setCustomUserClaims(uid, { role: ADMIN_TIER, companyId });
  await db.doc(`users/${uid}`).set({
    uid, email: ADMIN_EMAIL, displayName: ADMIN_NAME, role: ADMIN_TIER,
    companyId, roleId: null, title: "Admin", teamId: null, managerId: null,
    managerPath: [], disabled: false, createdAt: Date.now(), createdBy: "seed-script",
  }, { merge: true });
  await db.doc(`publicProfiles/${uid}`).set({ uid, displayName: ADMIN_NAME, photoURL: null, role: ADMIN_TIER }, { merge: true });

  console.log("\n✅ Done.");
  console.log(`   Company: ${COMPANY_NAME} (${COMPANY_PLAN}) — ${companyId}`);
  console.log(`   Admin:   ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}  (role: ${ADMIN_TIER})`);
  console.log("   → Sign in to the field app at /app, or the admin console once the org policy is fixed.");
}

main().catch((e) => { console.error("\n❌ Failed:", e.message || e); process.exit(1); });
