// ============================================================================
// seed-demo-activity.mjs
// ----------------------------------------------------------------------------
// Fills a company with a realistic week of door-to-door activity so the admin
// Town Hall, the rep dashboards, the leaderboard, the map, and "Who's working"
// all populate with believable numbers — perfect for a demo or for capturing
// Google Play / App Store screenshots.
//
// It creates a handful of demo rep accounts under the company's admin, then for
// each rep generates this week's knocked leads (with dispositions), a few
// active/ended shifts, and the rolled-up userStats + seasonStats the
// leaderboard and Top Performers card read.
//
// Everything it writes is tagged `seedTag: "demo-activity"`, so `--wipe` can
// cleanly remove it (demo reps, their leads, shifts, and stats) and leave the
// company's real data untouched.
//
// Auth (one of):
//   • gcloud ADC (easiest in Cloud Shell):  gcloud auth application-default login
//   • Service account key:                  --key /path/serviceAccountKey.json
//
// Usage:
//   node scripts/seed-demo-activity.mjs                       # lists companies, then exits
//   node scripts/seed-demo-activity.mjs --company "RMS"       # DRY RUN — prints the plan
//   node scripts/seed-demo-activity.mjs --company "RMS" --yes # actually seed
//   node scripts/seed-demo-activity.mjs --company "RMS" --wipe --yes   # remove demo data
//
// Options:
//   --companyId <id>   Target by id instead of name.
//   --admin <email>    Use this admin as the reps' manager (else first company admin).
//   --reps <n>         How many demo reps to create (default 5).
//   --password <pw>    Demo account password (default "KnockDemo123!").
//   --key <path>       Service-account JSON (else application-default creds).
//   --yes              Actually write (without it, dry run).
//   --wipe             Delete previously seeded demo data for the company.
// ============================================================================
import { initializeApp, applicationDefault, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync } from "node:fs";

const PROJECT_ID = "youtilityknock";
const SEED_TAG = "demo-activity";

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : null; };
const has = (name) => argv.includes(name);
const keyPath = flag("--key");
const companyIdArg = flag("--companyId");
const companyNameArg = flag("--company");
const adminEmailArg = flag("--admin");
const REPS = Math.max(1, Math.min(20, parseInt(flag("--reps") || "5", 10)));
const PASSWORD = flag("--password") || "KnockDemo123!";
const CONFIRMED = has("--yes");
const WIPE = has("--wipe");

// ── demo people + geography (Denver-ish, matches a Rocky Mountain footprint) ──
const REP_NAMES = [
  "Ava Carter", "Diego Morales", "Priya Patel", "Liam Nguyen", "Sofia Rossi",
  "Marcus Hill", "Emma Brooks", "Noah Kim", "Olivia Reed", "Ethan Cole",
];
const STREETS = ["Maple Ave", "Cedar St", "Birch Ln", "Pine St", "Aspen Way", "Elm Ct", "Oak Dr", "Spruce St", "Willow Rd", "Juniper Pl"];
const BASE = { lat: 39.7392, lng: -104.9903 }; // Denver, CO
// Disposition mix for a knock (weights need not sum to 1).
const DISPO_WEIGHTS = [
  ["not_home", 34], ["new", 10], ["not_home_2", 10], ["go_back", 8],
  ["not_interested", 12], ["pipeline", 12], ["appointment", 8], ["sold", 5], ["dnc", 1],
];
const CONVO = new Set(["pipeline", "appointment", "not_interested", "sold"]);

// ── season helpers (mirror youtilityknock-web/src/lib/season.ts) ─────────────────
function periodKey(kind, d = new Date()) {
  if (kind === "year") return `${d.getFullYear()}`;
  if (kind === "month") return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const ys = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((dt.getTime() - ys.getTime()) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(wk).padStart(2, "0")}`;
}
const seasonDocId = (uid, kind) => `${uid}__${kind[0].toUpperCase()}${periodKey(kind)}`;
function startOfWeek() { const d = new Date(); const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day); d.setHours(0, 0, 0, 0); return d.getTime(); }
function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }

// ── small RNG helpers ────────────────────────────────────────────────────────
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
function weighted(pairs) {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [v, w] of pairs) { if ((r -= w) <= 0) return v; }
  return pairs[0][0];
}

function initAdmin() {
  if (keyPath) {
    const svc = JSON.parse(readFileSync(keyPath, "utf8"));
    return initializeApp({ credential: cert(svc), projectId: svc.project_id || PROJECT_ID });
  }
  return initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
}

async function commitInChunks(db, ops) {
  for (let i = 0; i < ops.length; i += 450) {
    const batch = db.batch();
    for (const fn of ops.slice(i, i + 450)) fn(batch);
    await batch.commit();
  }
}

async function resolveCompany(db) {
  if (companyIdArg) {
    const snap = await db.doc(`companies/${companyIdArg}`).get();
    if (!snap.exists) throw new Error(`No company with id ${companyIdArg}`);
    return { id: snap.id, name: snap.data().name || "(unnamed)" };
  }
  if (companyNameArg) {
    const q = await db.collection("companies").where("name", "==", companyNameArg).limit(1).get();
    if (q.empty) throw new Error(`No company named "${companyNameArg}". Run with no flags to list companies.`);
    return { id: q.docs[0].id, name: q.docs[0].data().name };
  }
  return null;
}

async function listCompanies(db) {
  const snap = await db.collection("companies").get();
  console.log(`\nCompanies in ${PROJECT_ID}:`);
  if (snap.empty) console.log("  (none)");
  snap.docs.forEach((d) => console.log(`  ${d.id}  ·  ${d.data().name || "(unnamed)"}`));
  console.log(`\nRe-run with:  node scripts/seed-demo-activity.mjs --company "<name>"  (add --yes to write)\n`);
}

async function findAdminUid(db, companyId) {
  if (adminEmailArg) {
    const q = await db.collection("users").where("companyId", "==", companyId).where("email", "==", adminEmailArg).limit(1).get();
    if (!q.empty) return q.docs[0].id;
    console.warn(`⚠️  No user ${adminEmailArg} in this company; falling back to first admin.`);
  }
  const q = await db.collection("users").where("companyId", "==", companyId).where("role", "==", "admin").limit(1).get();
  return q.empty ? null : q.docs[0].id;
}

function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }

async function wipe(db, auth, companyId) {
  console.log(`\nWiping demo data for company ${companyId}…`);
  const repSnap = await db.collection("users").where("companyId", "==", companyId).where("seedTag", "==", SEED_TAG).get();
  const repIds = repSnap.docs.map((d) => d.id);
  const leadSnap = await db.collection("leads").where("companyId", "==", companyId).where("seedTag", "==", SEED_TAG).get();
  const shiftSnap = await db.collection("shifts").where("companyId", "==", companyId).where("seedTag", "==", SEED_TAG).get();
  console.log(`  ${repIds.length} demo reps · ${leadSnap.size} leads · ${shiftSnap.size} shifts`);
  if (!CONFIRMED) { console.log("  (dry run — add --yes to delete)\n"); return; }

  const ops = [];
  leadSnap.docs.forEach((d) => ops.push((b) => b.delete(d.ref)));
  shiftSnap.docs.forEach((d) => ops.push((b) => b.delete(d.ref)));
  for (const uid of repIds) {
    ops.push((b) => b.delete(db.doc(`users/${uid}`)));
    ops.push((b) => b.delete(db.doc(`publicProfiles/${uid}`)));
    ops.push((b) => b.delete(db.doc(`userStats/${uid}`)));
    for (const kind of ["week", "month", "year"]) ops.push((b) => b.delete(db.doc(`seasonStats/${seasonDocId(uid, kind)}`)));
  }
  await commitInChunks(db, ops);
  for (const uid of repIds) { try { await auth.deleteUser(uid); } catch { /* may not have an auth record */ } }
  console.log("✅ Demo data removed.\n");
}

async function ensureRep(db, auth, companyId, adminUid, name, i) {
  const email = `demo.${slug(name).split("-")[0]}.${i + 1}@${slug(companyNameArg || companyId)}.knockdemo.app`;
  let uid;
  try {
    uid = (await auth.createUser({ email, password: PASSWORD, displayName: name, emailVerified: true })).uid;
  } catch (e) {
    if (e.code === "auth/email-already-exists") { uid = (await auth.getUserByEmail(email)).uid; await auth.updateUser(uid, { password: PASSWORD, displayName: name }); }
    else throw e;
  }
  await auth.setCustomUserClaims(uid, { role: "user", companyId });
  await db.doc(`users/${uid}`).set({
    uid, email, displayName: name, role: "user", companyId, roleId: null, title: "Rep",
    teamId: null, managerId: adminUid || null, managerPath: adminUid ? [adminUid] : [],
    disabled: false, seedTag: SEED_TAG, createdAt: Date.now(), createdBy: "seed-demo-activity",
  }, { merge: true });
  await db.doc(`publicProfiles/${uid}`).set({ uid, displayName: name, photoURL: null, role: "user" }, { merge: true });
  return { uid, name, email };
}

// One rep's week of leads + shifts; returns the docs to write and the totals.
function buildActivity(rep, companyId, adminUid) {
  const weekStart = startOfWeek(), todayStart = startOfToday();
  const visibilityPath = adminUid ? [rep.uid, adminUid] : [rep.uid];
  const managerPath = adminUid ? [adminUid] : [];
  const weekly = randInt(55, 135); // doors this week
  const leads = [];
  const totals = { doors: 0, conv: 0, appt: 0, sales: 0 };
  let todayDoors = 0;

  for (let n = 0; n < weekly; n++) {
    // Spread across the days elapsed this week (incl. today).
    const daysElapsed = Math.floor((Date.now() - weekStart) / 86400000);
    const dayOffset = randInt(0, daysElapsed);
    const dayStart = weekStart + dayOffset * 86400000;
    const knockedAt = Math.min(Date.now() - 60000, dayStart + randInt(9 * 60, 19 * 60) * 60000); // 9a–7p
    const status = weighted(DISPO_WEIGHTS);
    const lat = BASE.lat + rand(-0.06, 0.06), lng = BASE.lng + rand(-0.08, 0.08);
    leads.push((b) => b.set(db.collection("leads").doc(), {
      companyId, status, assignedTo: rep.uid, createdBy: rep.uid, visibilityPath,
      verified: true, knockedAt, createdAt: knockedAt, updatedAt: knockedAt,
      address: `${randInt(100, 9999)} ${pick(STREETS)}`, city: "Denver", state: "CO", zip: "80202",
      ownerName: pick(["", "", "Resident", "J. Smith", "M. Johnson", "R. Garcia"]),
      lat, lng, seedTag: SEED_TAG,
    }));
    totals.doors++;
    if (CONVO.has(status)) totals.conv++;
    if (status === "appointment") totals.appt++;
    if (status === "sold") totals.sales++;
    if (knockedAt >= todayStart) todayDoors++;
  }

  // Shifts: an active one today for some reps (so "Who's working" lights up),
  // plus a couple of ended shifts earlier in the week.
  const shifts = [];
  const userName = rep.name;
  const liveNow = Math.random() < 0.55 && todayDoors > 0;
  if (liveNow) {
    shifts.push((b) => b.set(db.collection("shifts").doc(), {
      companyId, userId: rep.uid, userName, visibilityPath, status: "active",
      startAt: startOfToday() + randInt(8 * 60, 11 * 60) * 60000, doorsKnocked: todayDoors, seedTag: SEED_TAG,
    }));
  }
  for (let d = 1; d <= 2; d++) {
    const dayStart = startOfWeek() + (Math.max(0, Math.floor((Date.now() - startOfWeek()) / 86400000) - d)) * 86400000;
    const startAt = dayStart + 9 * 3600000;
    shifts.push((b) => b.set(db.collection("shifts").doc(), {
      companyId, userId: rep.uid, userName, visibilityPath, status: "ended",
      startAt, endAt: startAt + randInt(3, 7) * 3600000, doorsKnocked: randInt(15, 45), seedTag: SEED_TAG,
    }));
  }

  return { leads, shifts, totals, shiftCount: shifts.length };
}

let db; // set in main (used by buildActivity's db.collection refs)

async function main() {
  const app = initAdmin();
  const auth = getAuth(app);
  db = getFirestore(app);
  console.log(`Project: ${PROJECT_ID}`);

  const company = await resolveCompany(db);
  if (!company) { await listCompanies(db); return; }
  console.log(`Company: ${company.name} (${company.id})`);

  if (WIPE) { await wipe(db, auth, company.id); return; }

  const adminUid = await findAdminUid(db, company.id);
  console.log(adminUid ? `Reps will report to admin uid ${adminUid}` : "⚠️  No company admin found — reps will have no manager (Town Hall still works).");
  console.log(`Mode: ${CONFIRMED ? "WRITE" : "DRY RUN"} · ${REPS} demo reps\n`);

  if (!CONFIRMED) {
    console.log("Would create:");
    console.log(`  • ${REPS} demo rep accounts (password "${PASSWORD}")`);
    console.log("  • ~55–135 knocked leads each this week, with realistic dispositions");
    console.log("  • active + ended shifts, and userStats / seasonStats for the leaderboard");
    console.log("\nFirst, clears any prior demo-activity data for this company, then reseeds.");
    console.log("Re-run with --yes to write.\n");
    return;
  }

  // Idempotent: clear prior demo data first so re-runs don't accumulate.
  await wipe(db, auth, company.id);

  const reps = [];
  for (let i = 0; i < REPS; i++) reps.push(await ensureRep(db, auth, company.id, adminUid, REP_NAMES[i % REP_NAMES.length], i));
  console.log(`Created ${reps.length} demo reps.`);

  const allOps = [];
  let grand = { doors: 0, conv: 0, appt: 0, sales: 0, shifts: 0 };
  for (const rep of reps) {
    const a = buildActivity(rep, company.id, adminUid);
    allOps.push(...a.leads, ...a.shifts);
    grand.doors += a.totals.doors; grand.conv += a.totals.conv; grand.appt += a.totals.appt; grand.sales += a.totals.sales; grand.shifts += a.shiftCount;

    // Rolled-up stats (mirror bumpStats): all-time userStats + week/month/year seasonStats.
    const base = {
      uid: rep.uid, companyId: company.id, userName: rep.name, managerPath: adminUid ? [adminUid] : [],
      leadsCreated: a.totals.doors, doorsKnocked: a.totals.doors, appointments: a.totals.appt,
      sales: a.totals.sales, shifts: a.shiftCount, seedTag: SEED_TAG, updatedAt: Date.now(),
    };
    allOps.push((b) => b.set(db.doc(`userStats/${rep.uid}`), base, { merge: true }));
    for (const kind of ["week", "month", "year"]) {
      allOps.push((b) => b.set(db.doc(`seasonStats/${seasonDocId(rep.uid, kind)}`), { ...base, kind, period: periodKey(kind), joinedAt: Date.now() }, { merge: true }));
    }
  }
  await commitInChunks(db, allOps);

  console.log("\n✅ Seeded demo activity.");
  console.log(`   Doors: ${grand.doors} · Conversations: ${grand.conv} · Appts: ${grand.appt} · Closed: ${grand.sales} · Shifts: ${grand.shifts}`);
  console.log(`   Demo rep logins (password "${PASSWORD}"):`);
  reps.forEach((r) => console.log(`     ${r.email}`));
  console.log("\n   Open the admin console Town Hall, the rep dashboards, the map, and Who's Working — all populated.");
  console.log("   Remove it all later with:  node scripts/seed-demo-activity.mjs --company \"" + company.name + "\" --wipe --yes\n");
}

main().catch((e) => { console.error("\n❌ Failed:", e.message || e); process.exit(1); });
