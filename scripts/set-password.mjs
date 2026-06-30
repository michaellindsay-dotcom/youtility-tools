// ============================================================================
// set-password.mjs — directly set a user's password (no email needed).
// Safe + non-destructive: only updates the one account you name.
//
// Auth (one of):
//   A) gcloud ADC (easiest in Cloud Shell):  gcloud auth application-default login
//   B) Service account key:  node scripts/set-password.mjs --key /path/key.json ...
//
// Run:
//   npm --prefix youtilityknock-web/functions install   # ensures firebase-admin is available
//   node scripts/set-password.mjs <email> <newPassword>
//
// Example:
//   node scripts/set-password.mjs michael@rockymountainsolar.net 'MyNewPass123!'
//
// It also (re)asserts superAdmin claim if the email is the platform super-admin.
// ============================================================================
import { initializeApp, applicationDefault, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { readFileSync } from "node:fs";

const PROJECT_ID = "youtilityknock";
const SUPERADMIN_EMAIL = "michael@rockymountainsolar.net";

const args = process.argv.slice(2).filter((a) => a !== "--key" && !a.endsWith(".json"));
const keyIdx = process.argv.indexOf("--key");
const keyPath = keyIdx !== -1 ? process.argv[keyIdx + 1] : null;

const email = args[0];
const newPassword = args[1];
if (!email || !newPassword) {
  console.error("Usage: node scripts/set-password.mjs <email> <newPassword>");
  process.exit(1);
}
if (newPassword.length < 6) {
  console.error("Password must be at least 6 characters.");
  process.exit(1);
}

const app = keyPath
  ? initializeApp({ credential: cert(JSON.parse(readFileSync(keyPath, "utf8"))), projectId: PROJECT_ID })
  : initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });

const auth = getAuth(app);

try {
  const user = await auth.getUserByEmail(email);
  await auth.updateUser(user.uid, { password: newPassword, disabled: false });
  if (email === SUPERADMIN_EMAIL) {
    const claims = user.customClaims || {};
    await auth.setCustomUserClaims(user.uid, { ...claims, role: "superadmin", superAdmin: true });
    console.log("Re-asserted superAdmin claim.");
  }
  console.log(`\n✅ Password updated for ${email} (uid ${user.uid}).`);
  console.log("   Sign in now at /admin.html (super-admin) or /app (others).");
  process.exit(0);
} catch (e) {
  console.error("\n❌ Failed:", e?.message || e);
  console.error("   If it's a credentials error, run:  gcloud auth application-default login");
  process.exit(1);
}
