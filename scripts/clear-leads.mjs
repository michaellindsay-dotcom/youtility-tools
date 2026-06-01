// ============================================================================
// clear-leads.mjs — delete ALL leads (and lookup logs) for a clean slate.
// Old test leads were mis-geocoded by the earlier free geocoder; this wipes
// them so the map only shows correctly-placed pins going forward.
//
// DESTRUCTIVE. Dry-run by default; pass --yes to actually delete.
// Auth: gcloud ADC (Cloud Shell) or --key serviceAccountKey.json
//   node scripts/clear-leads.mjs            # dry run (counts only)
//   node scripts/clear-leads.mjs --yes
// ============================================================================
import { initializeApp, applicationDefault, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync } from "node:fs";

const PROJECT_ID = "youtilityknock";
const COLLECTIONS = ["leads", "lookups"];
const CONFIRMED = process.argv.includes("--yes");
const keyIdx = process.argv.indexOf("--key");
const keyPath = keyIdx !== -1 ? process.argv[keyIdx + 1] : null;

function init() {
  if (keyPath) {
    const svc = JSON.parse(readFileSync(keyPath, "utf8"));
    return initializeApp({ credential: cert(svc), projectId: svc.project_id || PROJECT_ID });
  }
  return initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
}

async function wipe(db, name) {
  const snap = await db.collection(name).get();
  if (!CONFIRMED) return snap.size;
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
  const db = getFirestore(init());
  console.log(`Project: ${PROJECT_ID}\nMode: ${CONFIRMED ? "DELETE" : "DRY RUN"}\n`);
  for (const c of COLLECTIONS) {
    const n = await wipe(db, c);
    console.log(`${CONFIRMED ? "Deleted" : "Would delete"} ${n} docs from /${c}`);
  }
  if (!CONFIRMED) console.log("\nRe-run with --yes to delete.");
  else console.log("\n✅ Cleared. The map starts clean — new leads place correctly.");
}

main().catch((e) => { console.error("❌", e.message || e); process.exit(1); });
