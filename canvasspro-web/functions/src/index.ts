import { onRequest, onCall, HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { onDocumentCreated, onDocumentWritten } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import Stripe from "stripe";
import * as crypto from "crypto";

initializeApp();
const db = getFirestore();

// A "trial" plan grants full access for a short window, then the account is
// paused (status → suspended) until they subscribe. No data is ever deleted, so
// a paying conversion picks up exactly where the trial left off.
const TRIAL_DAYS = 3;
const TRIAL_MS = TRIAL_DAYS * 86400000;
const isTrialPlan = (plan?: string) => (plan || "").trim().toLowerCase() === "trial";

const ATTOM = {
  baseUrl: process.env.ATTOM_API_URL || "https://api.gateway.attomdata.com/propertyapi/v1.0.0",
  key: process.env.ATTOM_API_KEY || "",
};

async function attomGet(path: string, params: Record<string, string | number | undefined>) {
  const url = new URL(ATTOM.baseUrl + path);
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== "") url.searchParams.set(k, String(v));
  });
  const res = await fetch(url.toString(), { headers: { apikey: ATTOM.key, Accept: "application/json" } });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

// ATTOM auth failures (expired / revoked / unentitled key) must NOT leak the
// raw provider JSON to the rep's screen. Translate 401/403 into a clean, typed
// error the client can render as a friendly banner and degrade around (keep
// cached + lead + mover pins). Other upstream errors pass through unchanged.
function sendAttomError(
  res: { status: (code: number) => { json: (body: unknown) => void } },
  status: number,
  json: any // eslint-disable-line @typescript-eslint/no-explicit-any
): void {
  if (status === 401 || status === 403) {
    logger.error("ATTOM auth rejected", {
      status,
      msg: json?.status?.msg ?? json?.Response?.status?.msg ?? "unknown",
    });
    res.status(502).json({ error: "Property data is temporarily unavailable.", code: "PROVIDER_AUTH" });
    return;
  }
  res.status(status).json(json);
}

// BatchData skip-tracing — owner phones/emails (ATTOM doesn't provide contact).
const BATCH = {
  baseUrl: process.env.BATCHDATA_API_URL || "https://api.batchdata.com",
  key: process.env.BATCHDATA_API_KEY || "",
  enabled: process.env.BATCHDATA_SKIPTRACE !== "0",
};

// Provider keys can be overridden from the super-admin screen (config/api),
// falling back to the env defaults. Refreshed at the top of each /api request.
async function refreshApiConfig(): Promise<void> {
  try {
    const snap = await db.doc("config/api").get();
    if (!snap.exists) return;
    const c = snap.data() as Record<string, unknown>;
    if (typeof c.attomKey === "string" && c.attomKey) ATTOM.key = c.attomKey;
    if (typeof c.attomUrl === "string" && c.attomUrl) ATTOM.baseUrl = c.attomUrl;
    if (typeof c.batchKey === "string" && c.batchKey) BATCH.key = c.batchKey;
    if (typeof c.batchUrl === "string" && c.batchUrl) BATCH.baseUrl = c.batchUrl;
    if (typeof c.batchEnabled === "boolean") BATCH.enabled = c.batchEnabled;
  } catch { /* keep env defaults */ }
}

async function batchSkipTrace(attomJson: any, address1: string, address2: string) {
  const p = attomJson?.property?.[0] || {};
  const o1 = p?.assessment?.owner?.owner1 || p?.owner?.owner1 || {};
  const addr = p?.address || {};
  const m = address2.match(/^(.*?),?\s*([A-Za-z]{2})\s*(\d{5})?/) || [];
  const first = String(o1.firstNameAndMi || o1.firstName || o1.firstname || "").trim().split(/\s+/)[0] || "";
  const last = o1.lastName || o1.lastname || "";
  const request: any = {
    propertyAddress: {
      street: addr.line1 || address1,
      city: addr.locality || (m[1] || "").trim(),
      state: addr.countrySubd || m[2] || "",
      zip: addr.postal1 || m[3] || "",
    },
  };
  if (first && last) request.name = { first, last };

  let httpStatus = 0;
  let bd: any = null;
  try {
    const res = await fetch(`${BATCH.baseUrl}/api/v1/property/skip-trace`, {
      method: "POST",
      headers: { Authorization: `Bearer ${BATCH.key}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ requests: [request] }),
    });
    httpStatus = res.status;
    bd = await res.json().catch(() => null);
  } catch (e: any) {
    return { phones: [], emails: [], debug: { error: e?.message || String(e), request } };
  }

  const persons =
    bd?.results?.persons || bd?.persons || bd?.results?.[0]?.persons || bd?.data?.persons || [];
  const p0 = persons[0] || {};
  const phones = (p0.phoneNumbers || p0.phones || [])
    .map((x: any) => (typeof x === "string" ? x : x.number || x.phone || x.phoneNumber))
    .filter(Boolean);
  const emails = (p0.emails || p0.email || [])
    .map((x: any) => (typeof x === "string" ? x : x.email))
    .filter(Boolean);
  // `debug` lets us inspect BatchData's real response shape via the Raw panel.
  return { phones, emails, debug: { httpStatus, response: bd, request } };
}

type Tier = "admin" | "manager" | "user";
const TIERS: Tier[] = ["admin", "manager", "user"];

interface Caller {
  uid: string;
  isSuper: boolean;
  role: string | null;
  companyId: string | null;
}

async function getCaller(request: CallableRequest): Promise<Caller> {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;
  const isSuper = request.auth.token.superAdmin === true;
  const snap = await db.doc(`users/${uid}`).get();
  const data = snap.data();
  return {
    uid,
    isSuper,
    role: (data?.role as string) ?? null,
    companyId: (data?.companyId as string) ?? null,
  };
}

// Super-admin (any company) or company admin (own company only).
function authorizeForCompany(caller: Caller, companyId: string | undefined): string {
  if (!companyId) throw new HttpsError("invalid-argument", "companyId is required.");
  if (caller.isSuper) return companyId;
  if (caller.role === "admin" && caller.companyId === companyId) return companyId;
  throw new HttpsError("permission-denied", "Not allowed to manage this company.");
}

async function authorizeForTargetUser(caller: Caller, targetUid: string) {
  if (caller.uid === targetUid && !caller.isSuper) {
    throw new HttpsError("permission-denied", "You can't change your own access.");
  }
  const snap = await db.doc(`users/${targetUid}`).get();
  if (!snap.exists) throw new HttpsError("not-found", "User not found.");
  const target = snap.data()!;
  if (caller.isSuper) return target;
  if (caller.role === "admin" && target.companyId === caller.companyId) {
    const claims = (await getAuth().getUser(targetUid)).customClaims || {};
    if (claims.superAdmin === true) {
      throw new HttpsError("permission-denied", "Cannot modify a super-admin.");
    }
    return target;
  }
  throw new HttpsError("permission-denied", "Not allowed to manage this user.");
}

// Compute a user's managerPath (ancestor uids, nearest first) from a managerId.
async function computeManagerPath(managerId: string | null | undefined): Promise<string[]> {
  if (!managerId) return [];
  const snap = await db.doc(`users/${managerId}`).get();
  if (!snap.exists) return [];
  const m = snap.data()!;
  return [managerId, ...((m.managerPath as string[]) || [])];
}

// Recompute managerPath for every user in a company and visibilityPath for
// every lead, from the current managerId links. Run after any reorg.
async function rebuildCompanyHierarchy(companyId: string) {
  const usersSnap = await db.collection("users").where("companyId", "==", companyId).get();
  const managerOf: Record<string, string | null> = {};
  usersSnap.forEach((d) => (managerOf[d.id] = (d.data().managerId as string) ?? null));

  // Walk up the chain for each user (cycle-guarded).
  const pathCache: Record<string, string[]> = {};
  function pathFor(uid: string, seen: Set<string> = new Set()): string[] {
    if (pathCache[uid]) return pathCache[uid];
    const mgr = managerOf[uid];
    if (!mgr || seen.has(mgr)) return (pathCache[uid] = []);
    seen.add(mgr);
    const p = [mgr, ...pathFor(mgr, seen)];
    return (pathCache[uid] = p);
  }

  let batch = db.batch();
  let ops = 0;
  const flush = async () => { if (ops) { await batch.commit(); batch = db.batch(); ops = 0; } };

  for (const d of usersSnap.docs) {
    batch.update(d.ref, { managerPath: pathFor(d.id) });
    if (++ops >= 450) await flush();
  }
  await flush();

  const leadsSnap = await db.collection("leads").where("companyId", "==", companyId).get();
  for (const d of leadsSnap.docs) {
    const owner = (d.data().assignedTo as string) || d.data().createdBy;
    batch.update(d.ref, { visibilityPath: [owner, ...pathFor(owner)] });
    if (++ops >= 450) await flush();
  }
  await flush();

  // Keep per-user stats roll-up reachable by the right managers.
  const statsSnap = await db.collection("userStats").where("companyId", "==", companyId).get();
  for (const d of statsSnap.docs) {
    batch.update(d.ref, { managerPath: pathFor(d.id) });
    if (++ops >= 450) await flush();
  }
  await flush();
}

// ───────────────────────────────────────────────────────────────────────────
// /api/property?address=  — single-home detail (owner + property + sale).
// /api/area?lat=&lng=&radius=  — every home in a radius (for map pins).
// Authenticated proxy to ATTOM Data (key stays server-side).
// ───────────────────────────────────────────────────────────────────────────
export const api = onRequest({ cors: true }, async (req, res) => {
  const isProperty = req.path.endsWith("/property") || req.path.endsWith("/knockstat");
  const isArea = req.path.endsWith("/area");
  const isMovers = req.path.endsWith("/movers");
  if (!isProperty && !isArea && !isMovers) { res.status(404).json({ error: "Not found" }); return; }

  const match = (req.headers.authorization || "").match(/^Bearer (.+)$/);
  if (!match) { res.status(401).json({ error: "Missing bearer token" }); return; }
  try { await getAuth().verifyIdToken(match[1]); }
  catch { res.status(401).json({ error: "Invalid token" }); return; }

  await refreshApiConfig(); // pick up super-admin key overrides

  if (!ATTOM.key) {
    logger.error("ATTOM_API_KEY not set");
    res.status(503).json({ error: "Property data not configured — set ATTOM_API_KEY" });
    return;
  }

  try {
    if (isMovers) {
      // Recent move-ins = homes that sold inside the lookback window. ATTOM's
      // sale snapshot returns every sale in a radius between two dates, which we
      // surface as "movers" pins on the map (newest = freshest door to knock).
      const lat = req.query.lat as string | undefined;
      const lng = req.query.lng as string | undefined;
      const radius = (req.query.radius as string | undefined) || "1"; // miles
      const days = Math.min(Math.max(parseInt((req.query.days as string) || "90", 10) || 90, 1), 366);
      if (!lat || !lng) { res.status(400).json({ error: "lat & lng required" }); return; }
      const fmt = (d: Date) =>
        `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
      const end = new Date();
      const start = new Date(end.getTime() - days * 86400000);
      const { ok, status, json } = await attomGet("/sale/snapshot", {
        latitude: lat,
        longitude: lng,
        radius,
        startsalesearchdate: fmt(start),
        endsalesearchdate: fmt(end),
        pagesize: 200,
      });
      if (!ok) { sendAttomError(res, status, json); return; }
      res.status(200).json(json);
      return;
    }

    if (isArea) {
      const lat = req.query.lat as string | undefined;
      const lng = req.query.lng as string | undefined;
      const radius = (req.query.radius as string | undefined) || "0.5"; // miles
      if (!lat || !lng) { res.status(400).json({ error: "lat & lng required" }); return; }
      const { ok, status, json } = await attomGet("/property/snapshot", {
        latitude: lat,
        longitude: lng,
        radius,
        pagesize: 200,
      });
      if (!ok) { sendAttomError(res, status, json); return; }
      res.status(200).json(json);
      return;
    }

    // Single-property detail (owner + property + sale).
    const address = (req.query.address as string | undefined)?.trim();
    if (!address) { res.status(400).json({ error: "address query param required" }); return; }
    const ci = address.indexOf(",");
    const address1 = ci > -1 ? address.slice(0, ci).trim() : address;
    const address2 = ci > -1 ? address.slice(ci + 1).trim() : "";
    const { ok, status, json } = await attomGet("/property/expandedprofile", { address1, address2 });
    if (!ok) { sendAttomError(res, status, json); return; }
    // Merge BatchData skip-trace (owner phones/emails) when configured.
    if (BATCH.enabled && BATCH.key) {
      try {
        const skip = await batchSkipTrace(json, address1, address2);
        (json as any)._skiptrace = { phones: skip.phones, emails: skip.emails };
        (json as any)._skiptrace_debug = skip.debug; // remove once mapping confirmed
      } catch (e) {
        logger.warn("BatchData skip-trace failed (continuing)", e);
      }
    }
    res.status(200).json(json);
  } catch (err) {
    logger.error("ATTOM request failed", err);
    res.status(502).json({ error: "Upstream request failed" });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// createCompany — super-admin only. Seeds default Manager + User roles and a
// top-level team so every company starts with the standard hierarchy.
// ───────────────────────────────────────────────────────────────────────────
export const createCompany = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
  const { name, plan } = request.data as { name?: string; plan?: string };
  if (!name?.trim()) throw new HttpsError("invalid-argument", "Company name required.");

  // A trial company starts in "trial" status with a 3-day countdown; a scheduled
  // job (trialExpiry) pauses it when the window elapses, keeping all its data.
  const trial = isTrialPlan(plan);
  const ref = await db.collection("companies").add({
    name: name.trim(), plan: plan || "standard",
    status: trial ? "trial" : "active",
    ...(trial ? { trialEndsAt: Date.now() + TRIAL_MS, trialExpired: false } : {}),
    createdAt: Date.now(), createdBy: caller.uid,
  });
  // Standard seed roles.
  const roles = ref.collection("roles");
  await roles.add({ companyId: ref.id, title: "Manager", baseTier: "manager", rank: 100, isDefault: true, createdAt: Date.now() });
  await roles.add({ companyId: ref.id, title: "User", baseTier: "user", rank: 10, isDefault: true, createdAt: Date.now() });
  await ref.collection("teams").add({ companyId: ref.id, name: "Company", parentTeamId: null, createdAt: Date.now() });

  logger.info(`Company ${ref.id} created by ${caller.uid}`);
  return { ok: true, companyId: ref.id };
});

// ───────────────────────────────────────────────────────────────────────────
// createUser — provisions an account with optional hierarchy placement.
// ───────────────────────────────────────────────────────────────────────────
export const createUser = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, name, email, password, tier, roleId, title, teamId, managerId } =
    request.data as {
      companyId?: string; name?: string; email?: string; password?: string;
      tier?: Tier; roleId?: string; title?: string; teamId?: string; managerId?: string;
    };
  const targetCompany = authorizeForCompany(caller, companyId);
  if (!email?.trim() || !password || password.length < 6) {
    throw new HttpsError("invalid-argument", "Valid email and 6+ char password required.");
  }

  // Resolve base tier + title from a custom role when provided.
  let baseTier: Tier = TIERS.includes(tier as Tier) ? (tier as Tier) : "user";
  let roleTitle = title || null;
  if (roleId) {
    const roleSnap = await db.doc(`companies/${targetCompany}/roles/${roleId}`).get();
    if (!roleSnap.exists) throw new HttpsError("invalid-argument", "Unknown role.");
    const r = roleSnap.data()!;
    baseTier = (r.baseTier as Tier) || "user";
    roleTitle = r.title;
  }
  // Only a super-admin may mint another company admin's peer? Company admins
  // can create up to 'admin' within their own company.
  if (baseTier === "admin" && !(caller.isSuper || caller.role === "admin")) {
    throw new HttpsError("permission-denied", "Not allowed to create an admin.");
  }

  let userRecord;
  try {
    userRecord = await getAuth().createUser({
      email: email.trim(), password, displayName: name?.trim() || email.split("@")[0],
    });
  } catch (err: any) {
    if (err?.code === "auth/email-already-exists") throw new HttpsError("already-exists", "That email is already in use.");
    throw new HttpsError("internal", err?.message || "Could not create user.");
  }

  const managerPath = await computeManagerPath(managerId);
  await getAuth().setCustomUserClaims(userRecord.uid, { role: baseTier, companyId: targetCompany });
  await db.doc(`users/${userRecord.uid}`).set({
    uid: userRecord.uid,
    email: userRecord.email,
    displayName: userRecord.displayName,
    role: baseTier,
    companyId: targetCompany,
    roleId: roleId || null,
    title: roleTitle,
    teamId: teamId || null,
    managerId: managerId || null,
    managerPath,
    disabled: false,
    createdAt: Date.now(),
    createdBy: caller.uid,
  });
  logger.info(`User ${userRecord.uid} created in ${targetCompany} by ${caller.uid}`);
  return { ok: true, uid: userRecord.uid };
});

// ───────────────────────────────────────────────────────────────────────────
// inviteUser — provisions an account and emails a magic sign-in link. The
// invitee clicks it, is signed in, and is prompted to set their own password.
// No temp password to share.
// ───────────────────────────────────────────────────────────────────────────
const APP_URL = process.env.APP_URL || "https://youtilityknock.web.app";

export const inviteUser = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, name, email, tier, roleId, title, teamId, managerId } =
    request.data as {
      companyId?: string; name?: string; email?: string;
      tier?: Tier; roleId?: string; title?: string; teamId?: string; managerId?: string;
    };
  const targetCompany = authorizeForCompany(caller, companyId);
  if (!email?.trim()) throw new HttpsError("invalid-argument", "A valid email is required.");

  let baseTier: Tier = TIERS.includes(tier as Tier) ? (tier as Tier) : "user";
  let roleTitle = title || null;
  if (roleId) {
    const roleSnap = await db.doc(`companies/${targetCompany}/roles/${roleId}`).get();
    if (!roleSnap.exists) throw new HttpsError("invalid-argument", "Unknown role.");
    const r = roleSnap.data()!;
    baseTier = (r.baseTier as Tier) || "user";
    roleTitle = r.title;
  }
  if (baseTier === "admin" && !(caller.isSuper || caller.role === "admin")) {
    throw new HttpsError("permission-denied", "Not allowed to create an admin.");
  }

  // Random throwaway password — the invitee sets their own on first sign-in.
  const tempPw = "Yk-" + Math.random().toString(36).slice(2, 10) + "A9!";
  let userRecord;
  try {
    userRecord = await getAuth().createUser({
      email: email.trim(), password: tempPw, displayName: name?.trim() || email.split("@")[0],
    });
  } catch (err: any) {
    if (err?.code === "auth/email-already-exists") throw new HttpsError("already-exists", "That email is already in use.");
    throw new HttpsError("internal", err?.message || "Could not create user.");
  }

  const managerPath = await computeManagerPath(managerId);
  await getAuth().setCustomUserClaims(userRecord.uid, { role: baseTier, companyId: targetCompany });
  await db.doc(`users/${userRecord.uid}`).set({
    uid: userRecord.uid,
    email: userRecord.email,
    displayName: userRecord.displayName,
    role: baseTier,
    companyId: targetCompany,
    roleId: roleId || null,
    title: roleTitle,
    teamId: teamId || null,
    managerId: managerId || null,
    managerPath,
    disabled: false,
    invitePending: true,
    createdAt: Date.now(),
    createdBy: caller.uid,
  });

  // Magic sign-in link → app login (which forces a set-password step).
  let link = "";
  try {
    link = await getAuth().generateSignInWithEmailLink(email.trim(), {
      url: `${APP_URL}/app/login?invite=1`,
      handleCodeInApp: true,
    });
  } catch (err: any) {
    throw new HttpsError("internal", err?.message || "Could not generate invite link.");
  }

  // Email it (best-effort — needs SendGrid configured).
  let emailed = false;
  try {
    const cfg = await getNotifyConfig();
    const companyName = (await db.doc(`companies/${targetCompany}`).get()).data()?.name || "your team";
    emailed = await sendEmail(
      cfg,
      email.trim(),
      "You're invited to YoutilityKnock",
      `Hi ${name || "there"},\n\nYou've been added to ${companyName} on YoutilityKnock.\n\n` +
        `Tap to sign in and set your password:\n${link}\n\n` +
        `This link signs you in directly, then asks you to create a password. ` +
        `If you didn't expect this, you can ignore it.`
    );
  } catch (e) {
    logger.warn("invite email send failed", e);
  }

  logger.info(`User ${userRecord.uid} invited to ${targetCompany} by ${caller.uid} (emailed=${emailed})`);
  return { ok: true, uid: userRecord.uid, inviteLink: link, emailed };
});

// ───────────────────────────────────────────────────────────────────────────
// Company role catalog (titles on a base tier). Company admin / super-admin.
// ───────────────────────────────────────────────────────────────────────────
export const createRole = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, title, baseTier, rank } = request.data as
    { companyId?: string; title?: string; baseTier?: "manager" | "user"; rank?: number };
  const company = authorizeForCompany(caller, companyId);
  if (!title?.trim()) throw new HttpsError("invalid-argument", "Title required.");
  const tier = baseTier === "manager" ? "manager" : "user";
  const ref = await db.collection(`companies/${company}/roles`).add({
    companyId: company, title: title.trim(), baseTier: tier,
    rank: typeof rank === "number" ? rank : 50, isDefault: false, createdAt: Date.now(),
  });
  return { ok: true, roleId: ref.id };
});

export const updateRole = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, roleId, title, baseTier, rank } = request.data as
    { companyId?: string; roleId?: string; title?: string; baseTier?: "manager" | "user"; rank?: number };
  const company = authorizeForCompany(caller, companyId);
  if (!roleId) throw new HttpsError("invalid-argument", "roleId required.");
  const patch: Record<string, unknown> = {};
  if (title?.trim()) patch.title = title.trim();
  if (baseTier === "manager" || baseTier === "user") patch.baseTier = baseTier;
  if (typeof rank === "number") patch.rank = rank;
  await db.doc(`companies/${company}/roles/${roleId}`).set(patch, { merge: true });
  return { ok: true };
});

export const deleteRole = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, roleId } = request.data as { companyId?: string; roleId?: string };
  const company = authorizeForCompany(caller, companyId);
  if (!roleId) throw new HttpsError("invalid-argument", "roleId required.");
  const snap = await db.doc(`companies/${company}/roles/${roleId}`).get();
  if (snap.data()?.isDefault) throw new HttpsError("failed-precondition", "Cannot delete a default role.");
  await snap.ref.delete();
  return { ok: true };
});

// ───────────────────────────────────────────────────────────────────────────
// Teams.
// ───────────────────────────────────────────────────────────────────────────
export const createTeam = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, name, parentTeamId, leadUserId } = request.data as
    { companyId?: string; name?: string; parentTeamId?: string | null; leadUserId?: string };
  const company = authorizeForCompany(caller, companyId);
  if (!name?.trim()) throw new HttpsError("invalid-argument", "Team name required.");
  const ref = await db.collection(`companies/${company}/teams`).add({
    companyId: company, name: name.trim(),
    parentTeamId: parentTeamId || null, leadUserId: leadUserId || null, createdAt: Date.now(),
  });
  return { ok: true, teamId: ref.id };
});

export const updateTeam = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, teamId, name, parentTeamId, leadUserId } = request.data as
    { companyId?: string; teamId?: string; name?: string; parentTeamId?: string | null; leadUserId?: string };
  const company = authorizeForCompany(caller, companyId);
  if (!teamId) throw new HttpsError("invalid-argument", "teamId required.");
  const patch: Record<string, unknown> = {};
  if (name?.trim()) patch.name = name.trim();
  if (parentTeamId !== undefined) patch.parentTeamId = parentTeamId || null;
  if (leadUserId !== undefined) patch.leadUserId = leadUserId || null;
  await db.doc(`companies/${company}/teams/${teamId}`).set(patch, { merge: true });
  return { ok: true };
});

export const deleteTeam = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, teamId } = request.data as { companyId?: string; teamId?: string };
  const company = authorizeForCompany(caller, companyId);
  if (!teamId) throw new HttpsError("invalid-argument", "teamId required.");
  await db.doc(`companies/${company}/teams/${teamId}`).delete();
  return { ok: true };
});

// ───────────────────────────────────────────────────────────────────────────
// assignUserHierarchy — set a user's role/title/team/manager, then rebuild the
// company's managerPath + lead visibilityPath so downstream visibility is exact.
// ───────────────────────────────────────────────────────────────────────────
export const assignUserHierarchy = onCall(async (request) => {
  const caller = await getCaller(request);
  const { uid, roleId, teamId, managerId } = request.data as
    { uid?: string; roleId?: string; teamId?: string | null; managerId?: string | null };
  if (!uid) throw new HttpsError("invalid-argument", "uid required.");
  const target = await authorizeForTargetUser(caller, uid);
  const company = target.companyId as string;

  if (managerId === uid) throw new HttpsError("invalid-argument", "A user can't report to themselves.");

  const patch: Record<string, unknown> = {};
  if (roleId !== undefined) {
    if (roleId) {
      const roleSnap = await db.doc(`companies/${company}/roles/${roleId}`).get();
      if (!roleSnap.exists) throw new HttpsError("invalid-argument", "Unknown role.");
      const r = roleSnap.data()!;
      patch.roleId = roleId;
      patch.title = r.title;
      patch.role = r.baseTier; // base tier follows the assigned role
      await getAuth().setCustomUserClaims(uid, {
        ...(await getAuth().getUser(uid)).customClaims,
        role: r.baseTier,
      });
    } else {
      patch.roleId = null;
    }
  }
  if (teamId !== undefined) patch.teamId = teamId || null;
  if (managerId !== undefined) patch.managerId = managerId || null;

  await db.doc(`users/${uid}`).set(patch, { merge: true });
  await rebuildCompanyHierarchy(company);
  logger.info(`Hierarchy updated for ${uid} in ${company} by ${caller.uid}`);
  return { ok: true };
});

// ───────────────────────────────────────────────────────────────────────────
// setUserRole / setUserDisabled (base-tier changes + enable/disable).
// ───────────────────────────────────────────────────────────────────────────
export const setUserRole = onCall(async (request) => {
  const caller = await getCaller(request);
  const { uid, role } = request.data as { uid?: string; role?: Tier };
  if (!uid || !TIERS.includes(role as Tier)) throw new HttpsError("invalid-argument", "uid and a valid tier are required.");
  await authorizeForTargetUser(caller, uid);
  const existing = (await getAuth().getUser(uid)).customClaims || {};
  await getAuth().setCustomUserClaims(uid, { ...existing, role });
  await db.doc(`users/${uid}`).set({ role }, { merge: true });
  return { ok: true };
});

export const setUserDisabled = onCall(async (request) => {
  const caller = await getCaller(request);
  const { uid, disabled } = request.data as { uid?: string; disabled?: boolean };
  if (!uid || typeof disabled !== "boolean") throw new HttpsError("invalid-argument", "uid and disabled flag required.");
  await authorizeForTargetUser(caller, uid);
  await getAuth().updateUser(uid, { disabled });
  if (disabled) await getAuth().revokeRefreshTokens(uid);
  await db.doc(`users/${uid}`).set(
    { disabled, disabledAt: disabled ? Date.now() : FieldValue.delete() }, { merge: true });
  return { ok: true };
});

// ───────────────────────────────────────────────────────────────────────────
// impersonate — SUPER-ADMIN mirror. Returns a custom token that signs the
// caller in AS the target user (full act-as) and writes an audit log.
// ───────────────────────────────────────────────────────────────────────────
export const impersonate = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
  const { targetUid } = request.data as { targetUid?: string };
  if (!targetUid) throw new HttpsError("invalid-argument", "targetUid required.");

  const targetSnap = await db.doc(`users/${targetUid}`).get();
  if (!targetSnap.exists) throw new HttpsError("not-found", "Target user not found.");
  const target = targetSnap.data()!;

  const log = await db.collection("impersonationLogs").add({
    superUid: caller.uid,
    targetUid,
    targetEmail: target.email || null,
    targetCompanyId: target.companyId || null,
    startedAt: Date.now(),
  });

  // developerClaims are non-reserved; flags the session as an impersonation.
  const token = await getAuth().createCustomToken(targetUid, {
    impersonatedBy: caller.uid,
    impersonationLogId: log.id,
  });
  logger.warn(`IMPERSONATION: ${caller.uid} -> ${targetUid} (log ${log.id})`);
  return { ok: true, token, logId: log.id, targetEmail: target.email || null };
});

// ════════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS — in-app + email + SMS fallback for chat / DMs / scheduler.
//
// Delivery policy (per the product spec):
//   • An in-app notification doc is ALWAYS written (drives the bell + badge and
//     becomes a native push once the mobile apps ship).
//   • If the recipient is currently OFFLINE (no presence heartbeat in the last
//     ONLINE_WINDOW_MS), we ALSO send email (SendGrid) and SMS (Twilio) so they
//     hear about it before the apps are live.
// Provider keys come from the super-admin console (Firestore config/notifications),
// falling back to env vars. Absent keys → email/SMS skipped, no error, so the
// core app works without them configured.
// ════════════════════════════════════════════════════════════════════════════

interface NotifyConfig {
  sendgridKey: string;
  sendgridFrom: string;
  sendgridFromName: string;
  twilioSid: string;
  twilioToken: string;
  twilioFrom: string;
}

// Read provider config: Firestore (set via super-admin console) overrides env.
async function getNotifyConfig(): Promise<NotifyConfig> {
  let c: Record<string, string> = {};
  try {
    const snap = await db.doc("config/notifications").get();
    if (snap.exists) c = (snap.data() as Record<string, string>) || {};
  } catch (e) {
    logger.warn("getNotifyConfig read failed", e);
  }
  return {
    sendgridKey: c.sendgridKey || process.env.SENDGRID_API_KEY || "",
    sendgridFrom: c.sendgridFrom || process.env.SENDGRID_FROM || "",
    sendgridFromName: c.sendgridFromName || process.env.SENDGRID_FROM_NAME || "YoutilityKnock",
    twilioSid: c.twilioSid || process.env.TWILIO_ACCOUNT_SID || "",
    twilioToken: c.twilioToken || process.env.TWILIO_AUTH_TOKEN || "",
    twilioFrom: c.twilioFrom || process.env.TWILIO_FROM || "",
  };
}

// A user is considered "online" if their presence doc was touched this recently.
const ONLINE_WINDOW_MS = 90 * 1000;

async function sendEmail(cfg: NotifyConfig, to: string, subject: string, text: string): Promise<boolean> {
  if (!cfg.sendgridKey || !cfg.sendgridFrom || !to) return false;
  try {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.sendgridKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: cfg.sendgridFrom, name: cfg.sendgridFromName },
        subject,
        content: [{ type: "text/plain", value: text }],
      }),
    });
    if (!res.ok) logger.warn(`SendGrid ${res.status}: ${await res.text().catch(() => "")}`);
    return res.ok;
  } catch (e) {
    logger.error("sendEmail failed", e);
    return false;
  }
}

async function sendSms(cfg: NotifyConfig, to: string, body: string): Promise<boolean> {
  if (!cfg.twilioSid || !cfg.twilioToken || !cfg.twilioFrom || !to) return false;
  try {
    const form = new URLSearchParams({ To: to, From: cfg.twilioFrom, Body: body });
    const auth = Buffer.from(`${cfg.twilioSid}:${cfg.twilioToken}`).toString("base64");
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.twilioSid}/Messages.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!res.ok) logger.warn(`Twilio ${res.status}: ${await res.text().catch(() => "")}`);
    return res.ok;
  } catch (e) {
    logger.error("sendSms failed", e);
    return false;
  }
}

async function isOnline(uid: string): Promise<boolean> {
  try {
    const snap = await db.doc(`presence/${uid}`).get();
    const last = snap.exists ? Number(snap.data()?.lastSeen || 0) : 0;
    return Date.now() - last < ONLINE_WINDOW_MS;
  } catch {
    return false;
  }
}

interface NotifyOpts {
  userId: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
}

// Write the in-app notification, then email + SMS the user iff they're offline.
async function notifyUser(opts: NotifyOpts): Promise<void> {
  const { userId, type, title, body = "", link = "" } = opts;
  await db.collection("notifications").add({
    userId,
    type,
    title,
    body,
    link,
    read: false,
    createdAt: Date.now(),
  });

  if (await isOnline(userId)) return; // in-app/push is enough when they're active

  const userSnap = await db.doc(`users/${userId}`).get();
  if (!userSnap.exists) return;
  const u = userSnap.data()!;
  const cfg = await getNotifyConfig();
  const line = body ? `${title}\n\n${body}` : title;
  await Promise.all([
    u.email ? sendEmail(cfg, u.email, `YoutilityKnock — ${title}`, line) : Promise.resolve(false),
    u.phone ? sendSms(cfg, u.phone, line) : Promise.resolve(false),
  ]);
}

// ════════════════════════════════════════════════════════════════════════════
// requestDemo — public (unauthenticated) demo request from the marketing site.
// ----------------------------------------------------------------------------
// Anyone on the landing page can submit the "Request a Demo" form. We:
//   • Store the request in `demoRequests` so it shows up in the super-admin
//     portal (admin.html → Demo Requests tab).
//   • Email EVERY super-admin (users with superAdmin:true) so they hear about
//     it immediately, regardless of whether they're online.
// Exposed at /demo-request via a Hosting rewrite (same-origin, no CORS needed),
// but cors:true is set so it also works if called cross-origin.
// ════════════════════════════════════════════════════════════════════════════
const DEMO_FIELDS = ["fname", "lname", "company", "title", "email", "phone", "teamsize", "industry", "message"] as const;

export const requestDemo = onRequest({ cors: true }, async (req, res) => {
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  // Accept either parsed JSON or a raw/form body.
  const raw = (typeof req.body === "string" ? safeJson(req.body) : req.body) || {};
  const data: Record<string, string> = {};
  for (const k of DEMO_FIELDS) {
    const v = raw[k];
    data[k] = typeof v === "string" ? v.trim().slice(0, 2000) : "";
  }

  // Minimal validation — mirror the required fields on the form.
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email);
  if (!data.fname || !data.lname || !data.company || !emailOk || !data.teamsize) {
    res.status(400).json({ error: "Missing or invalid required fields." });
    return;
  }

  const fullName = `${data.fname} ${data.lname}`.trim();
  const record = {
    ...data,
    name: fullName,
    status: "new",
    createdAt: Date.now(),
    source: "landing-page",
    userAgent: String(req.headers["user-agent"] || "").slice(0, 300),
  };

  try {
    const ref = await db.collection("demoRequests").add(record);

    // Email every super-admin. Don't fail the request if email isn't configured —
    // the record is already saved and visible in the portal.
    try {
      const supers = await db.collection("users").where("superAdmin", "==", true).get();
      const recipients = supers.docs
        .map((d) => String(d.data()?.email || "").trim())
        .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
      if (recipients.length) {
        const cfg = await getNotifyConfig();
        const subject = `New demo request — ${data.company}`;
        const body = [
          `A new demo request just came in from the YoutilityKnock landing page.`,
          ``,
          `Name:       ${fullName}`,
          `Company:    ${data.company}`,
          data.title ? `Role:       ${data.title}` : "",
          `Email:      ${data.email}`,
          data.phone ? `Phone:      ${data.phone}` : "",
          `Team size:  ${data.teamsize}`,
          data.industry ? `Industry:   ${data.industry}` : "",
          data.message ? `\nChallenge:\n${data.message}` : "",
          ``,
          `Open the Super Admin portal → Demo Requests to follow up.`,
        ].filter((l) => l !== "").join("\n");
        await Promise.all(recipients.map((to) => sendEmail(cfg, to, subject, body)));
      } else {
        logger.warn("requestDemo: no super-admin recipients found to email");
      }
    } catch (e) {
      logger.error("requestDemo: notifying super-admins failed (request was saved)", e);
    }

    res.status(200).json({ ok: true, id: ref.id });
  } catch (err) {
    logger.error("requestDemo failed", err);
    res.status(500).json({ error: "Could not submit request. Please try again." });
  }
});

function safeJson(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}

// ── trigger: new company-channel chat message → notify the rest of the company
export const onChatMessage = onDocumentCreated("chat/{messageId}", async (event) => {
  const msg = event.data?.data();
  if (!msg?.companyId) return;
  const preview = msg.text ? String(msg.text).slice(0, 140) : msg.imageUrl ? "📷 Photo" : "";
  const members = await db.collection("users").where("companyId", "==", msg.companyId).get();
  await Promise.all(
    members.docs
      .filter((d) => d.id !== msg.userId && d.data()?.disabled !== true)
      .map((d) =>
        notifyUser({
          userId: d.id,
          type: "chat",
          title: `${msg.userName || "Teammate"} in Team Chat`,
          body: preview,
          link: "/app/chat",
        })
      )
  );
});

// ── trigger: new DM → notify the other member(s) of that channel
export const onDmMessage = onDocumentCreated("dms/{channelId}/messages/{messageId}", async (event) => {
  const msg = event.data?.data();
  const channelId = event.params.channelId;
  if (!msg) return;
  const chanSnap = await db.doc(`dms/${channelId}`).get();
  const members: string[] = chanSnap.exists ? chanSnap.data()?.members || [] : [];
  const preview = msg.text ? String(msg.text).slice(0, 140) : msg.imageUrl ? "📷 Photo" : "";
  await Promise.all(
    members
      .filter((m) => m !== msg.userId)
      .map((m) =>
        notifyUser({
          userId: m,
          type: "dm",
          title: `New message from ${msg.userName || "a teammate"}`,
          body: preview,
          link: "/app/chat",
        })
      )
  );
});

// ── scheduled: remind owners of upcoming events (appointments/go-backs/follow-ups)
// Runs every 15 min; fires once per event when it falls inside the next 30-min
// window. `reminded` flag guards against double-sends.
export const eventReminders = onSchedule("every 15 minutes", async () => {
  const now = Date.now();
  const windowEnd = now + 30 * 60 * 1000;
  const due = await db
    .collection("events")
    .where("startAt", ">=", now)
    .where("startAt", "<=", windowEnd)
    .get();
  await Promise.all(
    due.docs
      .filter((d) => d.data()?.reminded !== true)
      .map(async (d) => {
        const ev = d.data();
        const when = new Date(ev.startAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        const label =
          ev.type === "appointment" ? "Appointment" : ev.type === "go_back" ? "Go-back" : "Follow-up";
        await notifyUser({
          userId: ev.userId,
          type: "event",
          title: `${label} at ${when}`,
          body: [ev.title, ev.address].filter(Boolean).join(" — "),
          link: "/app/schedule",
        });
        await d.ref.update({ reminded: true });
      })
  );
});

// ── super-admin: notification provider config (SendGrid / Twilio) ────────────
// Secrets live in Firestore config/notifications, readable ONLY by Cloud
// Functions (rules deny client access). getNotificationConfig returns a MASKED
// view (configured flags + non-secret fields) so the console can show status
// without ever shipping the keys back to the browser.
function mask(v?: string): string {
  if (!v) return "";
  return v.length <= 4 ? "••••" : "••••" + v.slice(-4);
}

export const getNotificationConfig = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
  const snap = await db.doc("config/notifications").get();
  const c = (snap.exists ? (snap.data() as Record<string, string>) : {}) || {};
  return {
    sendgrid: {
      configured: !!c.sendgridKey,
      keyMask: mask(c.sendgridKey),
      from: c.sendgridFrom || "",
      fromName: c.sendgridFromName || "",
    },
    twilio: {
      configured: !!c.twilioSid && !!c.twilioToken,
      sidMask: mask(c.twilioSid),
      tokenMask: mask(c.twilioToken),
      from: c.twilioFrom || "",
    },
  };
});

export const setNotificationConfig = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
  const d = (request.data || {}) as Record<string, string>;
  const update: Record<string, unknown> = { updatedAt: Date.now(), updatedBy: caller.uid };
  // Secrets: only overwrite when a non-empty value is supplied (blank = keep
  // existing). Non-secret fields are always set from the payload.
  if (typeof d.sendgridKey === "string" && d.sendgridKey.trim()) update.sendgridKey = d.sendgridKey.trim();
  if (typeof d.sendgridFrom === "string") update.sendgridFrom = d.sendgridFrom.trim();
  if (typeof d.sendgridFromName === "string") update.sendgridFromName = d.sendgridFromName.trim();
  if (typeof d.twilioSid === "string" && d.twilioSid.trim()) update.twilioSid = d.twilioSid.trim();
  if (typeof d.twilioToken === "string" && d.twilioToken.trim()) update.twilioToken = d.twilioToken.trim();
  if (typeof d.twilioFrom === "string") update.twilioFrom = d.twilioFrom.trim();
  await db.doc("config/notifications").set(update, { merge: true });
  logger.info(`notification config updated by ${caller.uid}`);
  return { ok: true };
});

// Clear a single provider's stored secrets (super-admin only).
export const clearNotificationProvider = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
  const { provider } = (request.data || {}) as { provider?: string };
  const ref = db.doc("config/notifications");
  if (provider === "sendgrid") {
    await ref.set({ sendgridKey: "", sendgridFrom: "", sendgridFromName: "" }, { merge: true });
  } else if (provider === "twilio") {
    await ref.set({ twilioSid: "", twilioToken: "", twilioFrom: "" }, { merge: true });
  } else {
    throw new HttpsError("invalid-argument", "provider must be 'sendgrid' or 'twilio'.");
  }
  return { ok: true };
});

// ════════════════════════════════════════════════════════════════════════════
// SCHEDULING — company settings, self-service profile, calendar sync, and
// availability-aware assignment.
// ════════════════════════════════════════════════════════════════════════════

const DEFAULT_SCHEDULING = {
  apptMinLeadHours: 1,
  apptMaxDaysOut: 30,
  apptDurationMin: 60,
  bufferMin: 0,
  assignment: "self_gen" as const,
  timezone: "America/Denver",
  dayStartMin: 9 * 60,
  dayEndMin: 20 * 60,
  workDays: [1, 2, 3, 4, 5, 6],
  slotMin: 30,
};

// Weekday (0=Sun) + minutes-from-midnight of a timestamp in a given IANA tz.
function localParts(ms: number, tz: string): { dow: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz || "America/Denver",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const wd: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let dow = 0, hh = 0, mm = 0;
  for (const p of parts) {
    if (p.type === "weekday") dow = wd[p.value] ?? 0;
    else if (p.type === "hour") hh = parseInt(p.value, 10) % 24;
    else if (p.type === "minute") mm = parseInt(p.value, 10);
  }
  return { dow, minutes: hh * 60 + mm };
}

function withinBusinessHours(ms: number, sched: any): boolean {
  const { dow, minutes } = localParts(ms, sched.timezone);
  if (Array.isArray(sched.workDays) && sched.workDays.length && !sched.workDays.includes(dow)) return false;
  return minutes >= (sched.dayStartMin ?? 0) && minutes <= (sched.dayEndMin ?? 1440);
}

// ── company admin: scheduling settings (min/max window, duration, routing) ───
export const setCompanySettings = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, scheduling } = (request.data || {}) as {
    companyId?: string;
    scheduling?: Record<string, unknown>;
  };
  authorizeForCompany(caller, companyId);
  if (!scheduling) throw new HttpsError("invalid-argument", "scheduling is required.");
  const days = Array.isArray(scheduling.workDays)
    ? (scheduling.workDays as unknown[]).map((n) => Number(n)).filter((n) => n >= 0 && n <= 6)
    : DEFAULT_SCHEDULING.workDays;
  const s = {
    apptMinLeadHours: Math.max(0, Number(scheduling.apptMinLeadHours) || DEFAULT_SCHEDULING.apptMinLeadHours),
    apptMaxDaysOut: Math.max(1, Number(scheduling.apptMaxDaysOut) || DEFAULT_SCHEDULING.apptMaxDaysOut),
    apptDurationMin: Math.max(5, Number(scheduling.apptDurationMin) || DEFAULT_SCHEDULING.apptDurationMin),
    bufferMin: Math.max(0, Number(scheduling.bufferMin) || 0),
    assignment: ["self_gen", "round_robin", "highest_production", "manual"].includes(String(scheduling.assignment))
      ? String(scheduling.assignment)
      : "self_gen",
    timezone: String(scheduling.timezone || DEFAULT_SCHEDULING.timezone),
    dayStartMin: Math.min(1439, Math.max(0, Number(scheduling.dayStartMin) ?? DEFAULT_SCHEDULING.dayStartMin)),
    dayEndMin: Math.min(1440, Math.max(0, Number(scheduling.dayEndMin) ?? DEFAULT_SCHEDULING.dayEndMin)),
    workDays: days.length ? days : DEFAULT_SCHEDULING.workDays,
    slotMin: Math.max(5, Number(scheduling.slotMin) || DEFAULT_SCHEDULING.slotMin),
  };
  await db.doc(`companies/${companyId}`).set({ scheduling: s }, { merge: true });
  return { ok: true, scheduling: s };
});

// ── self-service: a user sets their own phone (calendar handled via OAuth) ───
export const setMyProfile = onCall(async (request) => {
  const caller = await getCaller(request);
  const { phone, displayName, email } = (request.data || {}) as { phone?: string; displayName?: string; email?: string };
  const update: Record<string, unknown> = {};
  if (typeof phone === "string") {
    const trimmed = phone.trim();
    // Light E.164-ish normalization for the SMS fallback.
    update.phone = trimmed ? (trimmed.startsWith("+") ? trimmed : trimmed.replace(/[^\d]/g, "").replace(/^/, "+1").slice(0, 12)) : "";
  }
  if (typeof displayName === "string" && displayName.trim()) update.displayName = displayName.trim();
  if (typeof email === "string" && email.trim()) update.email = email.trim(); // keep users doc in sync with auth email
  if (Object.keys(update).length === 0) throw new HttpsError("invalid-argument", "Nothing to update.");
  await db.doc(`users/${caller.uid}`).set(update, { merge: true });
  if (typeof update.displayName === "string") {
    try { await getAuth().updateUser(caller.uid, { displayName: update.displayName as string }); } catch { /* non-fatal */ }
  }
  return { ok: true, ...update };
});

// ── integration credentials (OAuth client id/secret) — super-admin only ──────
interface IntegrationConfig {
  googleClientId: string;
  googleClientSecret: string;
  microsoftClientId: string;
  microsoftClientSecret: string;
  microsoftTenant: string;
}
async function getIntegrationConfig(): Promise<IntegrationConfig> {
  let c: Record<string, string> = {};
  try {
    const snap = await db.doc("config/integrations").get();
    if (snap.exists) c = (snap.data() as Record<string, string>) || {};
  } catch (e) {
    logger.warn("getIntegrationConfig failed", e);
  }
  return {
    googleClientId: c.googleClientId || process.env.GOOGLE_CLIENT_ID || "",
    googleClientSecret: c.googleClientSecret || process.env.GOOGLE_CLIENT_SECRET || "",
    microsoftClientId: c.microsoftClientId || process.env.MS_CLIENT_ID || "",
    microsoftClientSecret: c.microsoftClientSecret || process.env.MS_CLIENT_SECRET || "",
    microsoftTenant: c.microsoftTenant || process.env.MS_TENANT || "common",
  };
}

// Public (non-secret) integration config — any signed-in user, so the client
// can launch the OAuth flow with the right client IDs.
export const getIntegrationPublicConfig = onCall(async (request) => {
  await getCaller(request);
  const c = await getIntegrationConfig();
  return {
    google: { clientId: c.googleClientId, configured: !!c.googleClientId && !!c.googleClientSecret },
    microsoft: {
      clientId: c.microsoftClientId,
      tenant: c.microsoftTenant,
      configured: !!c.microsoftClientId && !!c.microsoftClientSecret,
    },
  };
});

export const setIntegrationConfig = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
  const d = (request.data || {}) as Record<string, string>;
  const update: Record<string, unknown> = { updatedAt: Date.now(), updatedBy: caller.uid };
  if (typeof d.googleClientId === "string") update.googleClientId = d.googleClientId.trim();
  if (typeof d.googleClientSecret === "string" && d.googleClientSecret.trim()) update.googleClientSecret = d.googleClientSecret.trim();
  if (typeof d.microsoftClientId === "string") update.microsoftClientId = d.microsoftClientId.trim();
  if (typeof d.microsoftClientSecret === "string" && d.microsoftClientSecret.trim()) update.microsoftClientSecret = d.microsoftClientSecret.trim();
  if (typeof d.microsoftTenant === "string") update.microsoftTenant = d.microsoftTenant.trim() || "common";
  await db.doc("config/integrations").set(update, { merge: true });
  return { ok: true };
});

// ── calendar OAuth: exchange an auth code for an offline refresh token ───────
// Tokens are stored in calendarTokens/{uid} (server-only); only a connection
// summary lands on the user doc.
export const connectGoogleCalendar = onCall(async (request) => {
  const caller = await getCaller(request);
  const { code, redirectUri } = (request.data || {}) as { code?: string; redirectUri?: string };
  if (!code || !redirectUri) throw new HttpsError("invalid-argument", "code & redirectUri required.");
  const cfg = await getIntegrationConfig();
  if (!cfg.googleClientId || !cfg.googleClientSecret) {
    throw new HttpsError("failed-precondition", "Google integration not configured by the platform admin.");
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: cfg.googleClientId,
      client_secret: cfg.googleClientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  });
  const tok = (await res.json().catch(() => ({}))) as Record<string, string>;
  if (!res.ok || !tok.refresh_token) {
    logger.error("Google token exchange failed", tok);
    throw new HttpsError("internal", "Google sign-in failed. Make sure offline access is granted.");
  }
  let email = "";
  try {
    const u = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    email = ((await u.json()) as { email?: string }).email || "";
  } catch { /* non-fatal */ }
  await db.doc(`calendarTokens/${caller.uid}`).set({ google: { refreshToken: tok.refresh_token } }, { merge: true });
  await db.doc(`users/${caller.uid}`).set(
    { calendar: { google: { connected: true, email, connectedAt: Date.now() } } },
    { merge: true }
  );
  return { ok: true, email };
});

export const connectMicrosoftCalendar = onCall(async (request) => {
  const caller = await getCaller(request);
  const { code, redirectUri } = (request.data || {}) as { code?: string; redirectUri?: string };
  if (!code || !redirectUri) throw new HttpsError("invalid-argument", "code & redirectUri required.");
  const cfg = await getIntegrationConfig();
  if (!cfg.microsoftClientId || !cfg.microsoftClientSecret) {
    throw new HttpsError("failed-precondition", "Microsoft integration not configured by the platform admin.");
  }
  const res = await fetch(`https://login.microsoftonline.com/${cfg.microsoftTenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: cfg.microsoftClientId,
      client_secret: cfg.microsoftClientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      scope: "offline_access Calendars.ReadWrite User.Read",
    }).toString(),
  });
  const tok = (await res.json().catch(() => ({}))) as Record<string, string>;
  if (!res.ok || !tok.refresh_token) {
    logger.error("Microsoft token exchange failed", tok);
    throw new HttpsError("internal", "Microsoft sign-in failed.");
  }
  let email = "";
  try {
    const u = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    const me = (await u.json()) as { mail?: string; userPrincipalName?: string };
    email = me.mail || me.userPrincipalName || "";
  } catch { /* non-fatal */ }
  await db.doc(`calendarTokens/${caller.uid}`).set({ microsoft: { refreshToken: tok.refresh_token } }, { merge: true });
  await db.doc(`users/${caller.uid}`).set(
    { calendar: { microsoft: { connected: true, email, connectedAt: Date.now() } } },
    { merge: true }
  );
  return { ok: true, email };
});

export const disconnectCalendar = onCall(async (request) => {
  const caller = await getCaller(request);
  const { provider } = (request.data || {}) as { provider?: string };
  if (provider !== "google" && provider !== "microsoft") {
    throw new HttpsError("invalid-argument", "provider must be 'google' or 'microsoft'.");
  }
  await db.doc(`calendarTokens/${caller.uid}`).set({ [provider]: FieldValue.delete() }, { merge: true });
  await db.doc(`users/${caller.uid}`).set(
    { calendar: { [provider]: { connected: false } } },
    { merge: true }
  );
  return { ok: true };
});

// ── external free/busy ───────────────────────────────────────────────────────
type Interval = { start: number; end: number };

async function googleAccessToken(refreshToken: string, cfg: IntegrationConfig): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.googleClientId,
      client_secret: cfg.googleClientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, string>;
  return j.access_token || "";
}

async function microsoftAccessToken(refreshToken: string, cfg: IntegrationConfig): Promise<string> {
  const res = await fetch(`https://login.microsoftonline.com/${cfg.microsoftTenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.microsoftClientId,
      client_secret: cfg.microsoftClientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      scope: "offline_access Calendars.ReadWrite User.Read",
    }).toString(),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, string>;
  return j.access_token || "";
}

// Busy intervals from a rep's connected external calendars over [startMs,endMs].
async function externalBusy(uid: string, startMs: number, endMs: number): Promise<Interval[]> {
  const tokSnap = await db.doc(`calendarTokens/${uid}`).get();
  if (!tokSnap.exists) return [];
  const t = tokSnap.data() as { google?: { refreshToken?: string }; microsoft?: { refreshToken?: string } };
  const cfg = await getIntegrationConfig();
  const out: Interval[] = [];
  const timeMin = new Date(startMs).toISOString();
  const timeMax = new Date(endMs).toISOString();

  if (t.google?.refreshToken && cfg.googleClientId) {
    try {
      const at = await googleAccessToken(t.google.refreshToken, cfg);
      if (at) {
        const r = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
          method: "POST",
          headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json" },
          body: JSON.stringify({ timeMin, timeMax, items: [{ id: "primary" }] }),
        });
        const j = (await r.json().catch(() => ({}))) as any;
        for (const b of j?.calendars?.primary?.busy || []) {
          out.push({ start: Date.parse(b.start), end: Date.parse(b.end) });
        }
      }
    } catch (e) { logger.warn("google freebusy failed", e); }
  }

  if (t.microsoft?.refreshToken && cfg.microsoftClientId) {
    try {
      const at = await microsoftAccessToken(t.microsoft.refreshToken, cfg);
      if (at) {
        const url = `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${encodeURIComponent(timeMin)}&endDateTime=${encodeURIComponent(timeMax)}&$select=start,end,showAs&$top=100`;
        const r = await fetch(url, { headers: { Authorization: `Bearer ${at}`, Prefer: 'outlook.timezone="UTC"' } });
        const j = (await r.json().catch(() => ({}))) as any;
        for (const ev of j?.value || []) {
          if (ev.showAs === "free") continue;
          out.push({ start: Date.parse(ev.start?.dateTime + "Z"), end: Date.parse(ev.end?.dateTime + "Z") });
        }
      }
    } catch (e) { logger.warn("microsoft calendarView failed", e); }
  }
  return out.filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end));
}

const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;

// Is a rep free for [startMs,endMs] (± buffer): no app appointment and no
// external busy block overlaps.
async function isUserFree(uid: string, startMs: number, endMs: number, bufferMin: number): Promise<boolean> {
  const buf = bufferMin * 60 * 1000;
  const win: Interval = { start: startMs - buf, end: endMs + buf };

  // Internal appointments (events) for this user.
  const evSnap = await db.collection("events").where("userId", "==", uid).where("startAt", "<=", win.end).get();
  for (const d of evSnap.docs) {
    const ev = d.data();
    const s = Number(ev.startAt);
    const e = Number(ev.endAt) || s + (Number(ev.durationMin) || 60) * 60 * 1000;
    if (overlaps(win, { start: s, end: e })) return false;
  }

  // External calendars.
  const busy = await externalBusy(uid, win.start, win.end);
  return !busy.some((b) => overlaps(win, b));
}

// Push an appointment to a rep's connected external calendars (best-effort).
async function pushExternalEvent(uid: string, ev: { title: string; address?: string; notes?: string; startMs: number; endMs: number }): Promise<void> {
  const tokSnap = await db.doc(`calendarTokens/${uid}`).get();
  if (!tokSnap.exists) return;
  const t = tokSnap.data() as { google?: { refreshToken?: string }; microsoft?: { refreshToken?: string } };
  const cfg = await getIntegrationConfig();
  const startISO = new Date(ev.startMs).toISOString();
  const endISO = new Date(ev.endMs).toISOString();

  if (t.google?.refreshToken && cfg.googleClientId) {
    try {
      const at = await googleAccessToken(t.google.refreshToken, cfg);
      if (at) {
        await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
          method: "POST",
          headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            summary: ev.title,
            location: ev.address || "",
            description: ev.notes || "Booked via YoutilityKnock",
            start: { dateTime: startISO },
            end: { dateTime: endISO },
          }),
        });
      }
    } catch (e) { logger.warn("google event push failed", e); }
  }
  if (t.microsoft?.refreshToken && cfg.microsoftClientId) {
    try {
      const at = await microsoftAccessToken(t.microsoft.refreshToken, cfg);
      if (at) {
        await fetch("https://graph.microsoft.com/v1.0/me/events", {
          method: "POST",
          headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            subject: ev.title,
            location: { displayName: ev.address || "" },
            body: { contentType: "text", content: ev.notes || "Booked via YoutilityKnock" },
            start: { dateTime: startISO, timeZone: "UTC" },
            end: { dateTime: endISO, timeZone: "UTC" },
          }),
        });
      }
    } catch (e) { logger.warn("microsoft event push failed", e); }
  }
}

// ── availability + assignment ────────────────────────────────────────────────
async function companyScheduling(companyId: string) {
  const snap = await db.doc(`companies/${companyId}`).get();
  const s = (snap.exists ? snap.data()?.scheduling : null) || {};
  return { ...DEFAULT_SCHEDULING, ...s };
}

// Check whether a given rep (or the caller) is free for a slot.
export const checkAvailability = onCall(async (request) => {
  const caller = await getCaller(request);
  const { uid, startAt, durationMin } = (request.data || {}) as { uid?: string; startAt?: number; durationMin?: number };
  const targetUid = uid || caller.uid;
  if (!startAt) throw new HttpsError("invalid-argument", "startAt required.");
  const sched = caller.companyId ? await companyScheduling(caller.companyId) : DEFAULT_SCHEDULING;
  const dur = (durationMin || sched.apptDurationMin) * 60 * 1000;
  const free = await isUserFree(targetUid, startAt, startAt + dur, sched.bufferMin);
  return { free };
});

// Route a (non-self-gen) appointment to an available rep per company policy.
export const assignAppointment = onCall(async (request) => {
  const caller = await getCaller(request);
  const d = (request.data || {}) as {
    companyId?: string;
    startAt?: number;
    durationMin?: number;
    title?: string;
    address?: string;
    name?: string;
    notes?: string;
    leadId?: string;
    candidateUid?: string; // for manual
    pushExternal?: boolean;
  };
  const companyId = d.companyId || caller.companyId || "";
  if (!companyId || caller.companyId !== companyId) {
    if (!caller.isSuper) throw new HttpsError("permission-denied", "Wrong company.");
  }
  if (!d.startAt) throw new HttpsError("invalid-argument", "startAt required.");

  const sched = await companyScheduling(companyId);
  const now = Date.now();
  const minAt = now + sched.apptMinLeadHours * 3600 * 1000;
  const maxAt = now + sched.apptMaxDaysOut * 86400 * 1000;
  if (d.startAt < minAt) throw new HttpsError("failed-precondition", `Too soon — needs ${sched.apptMinLeadHours}h lead time.`);
  if (d.startAt > maxAt) throw new HttpsError("failed-precondition", `Too far out — max ${sched.apptMaxDaysOut} days.`);
  if (!withinBusinessHours(d.startAt, sched)) throw new HttpsError("failed-precondition", "Outside the company's booking hours/days.");

  const dur = (d.durationMin || sched.apptDurationMin) * 60 * 1000;
  const endAt = d.startAt + dur;

  // Candidate reps: enabled company members (managers + users).
  const usersSnap = await db.collection("users").where("companyId", "==", companyId).get();
  const candidates: Array<{ uid: string; [k: string]: any }> = usersSnap.docs
    .map((u): { uid: string; [k: string]: any } => ({ uid: u.id, ...(u.data() as Record<string, any>) }))
    .filter((u) => u.disabled !== true && (u.role === "user" || u.role === "manager"));

  // Keep only those actually free at the slot.
  const freeFlags = await Promise.all(candidates.map((c) => isUserFree(c.uid, d.startAt!, endAt, sched.bufferMin)));
  let pool = candidates.filter((_, i) => freeFlags[i]);
  if (pool.length === 0) throw new HttpsError("failed-precondition", "No rep is available at that time.");

  let chosen = pool[0];
  if (sched.assignment === "manual") {
    if (!d.candidateUid) throw new HttpsError("invalid-argument", "Manual assignment needs candidateUid.");
    const found = pool.find((p) => p.uid === d.candidateUid);
    if (!found) throw new HttpsError("failed-precondition", "Chosen rep isn't available then.");
    chosen = found;
  } else if (sched.assignment === "highest_production") {
    const statsSnap = await db.collection("userStats").where("companyId", "==", companyId).get();
    const sales: Record<string, number> = {};
    statsSnap.forEach((s) => (sales[s.id] = Number(s.data().sales) || 0));
    pool = pool.sort((a, b) => (sales[b.uid] || 0) - (sales[a.uid] || 0));
    chosen = pool[0];
  } else if (sched.assignment === "round_robin") {
    pool = pool.sort((a, b) => a.uid.localeCompare(b.uid));
    const cur = Number((await db.doc(`companies/${companyId}`).get()).data()?.rrCursor) || 0;
    chosen = pool[cur % pool.length];
    await db.doc(`companies/${companyId}`).set({ rrCursor: cur + 1 }, { merge: true });
  } else {
    // self_gen: assign to the caller if they're in the pool, else first free.
    chosen = pool.find((p) => p.uid === caller.uid) || pool[0];
  }

  const managerPath = (chosen.managerPath as string[]) || [];
  const ev = {
    companyId,
    userId: chosen.uid,
    userName: chosen.displayName || "",
    type: "appointment",
    title: d.title || `Appointment${d.name ? ` — ${d.name}` : ""}`,
    address: d.address || "",
    leadId: d.leadId || null,
    startAt: d.startAt,
    endAt,
    durationMin: d.durationMin || sched.apptDurationMin,
    assignedBy: caller.uid,
    source: "assigned",
    notes: d.notes || "",
    visibilityPath: [chosen.uid, ...managerPath],
    reminded: false,
    createdAt: now,
  };
  const ref = await db.collection("events").add(ev);

  if (d.pushExternal !== false) {
    await pushExternalEvent(chosen.uid, { title: ev.title, address: ev.address, notes: ev.notes, startMs: d.startAt, endMs: endAt });
  }
  await notifyUser({
    userId: chosen.uid,
    type: "event",
    title: `New appointment assigned`,
    body: [ev.title, new Date(d.startAt).toLocaleString()].filter(Boolean).join(" — "),
    link: "/app/schedule",
  });

  return { ok: true, eventId: ref.id, assignedTo: chosen.uid, assignedName: chosen.displayName || "" };
});

// ════════════════════════════════════════════════════════════════════════════
// WEEKLY SEASON RECAP — every Friday evening, post a hype recap to each
// company's Team Chat: top 3 by points + the biggest climber vs. last week.
// Mirrors the client points model (lib/points.ts).
// ════════════════════════════════════════════════════════════════════════════
const STAT_PTS = { door: 1, lead: 3, appointment: 20, sale: 100, shift: 25 };
function pointsOf(s: any): number {
  return (
    (Number(s.doorsKnocked) || 0) * STAT_PTS.door +
    (Number(s.leadsCreated) || 0) * STAT_PTS.lead +
    (Number(s.appointments) || 0) * STAT_PTS.appointment +
    (Number(s.sales) || 0) * STAT_PTS.sale +
    (Number(s.shifts) || 0) * STAT_PTS.shift
  );
}

// ISO-week key matching the client (lib/season.ts) so the recap reads the same
// weekly bucket the leaderboard shows.
function isoWeekKey(d: Date): string {
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const ys = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((dt.getTime() - ys.getTime()) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(wk).padStart(2, "0")}`;
}

async function weekPoints(companyId: string, weekKey: string): Promise<Map<string, { name: string; points: number }>> {
  const snap = await db.collection("seasonStats")
    .where("companyId", "==", companyId).where("period", "==", weekKey).get();
  const m = new Map<string, { name: string; points: number }>();
  snap.forEach((d) => {
    const s = d.data();
    m.set(s.uid || d.id, { name: (s.userName as string) || "Rep", points: pointsOf(s) });
  });
  return m;
}

export const weeklyRecap = onSchedule({ schedule: "0 17 * * 5", timeZone: "America/Denver" }, async () => {
  const thisWeek = isoWeekKey(new Date());
  const lastWeek = isoWeekKey(new Date(Date.now() - 7 * 86400000));
  const companies = await db.collection("companies").get();

  for (const co of companies.docs) {
    const companyId = co.id;
    const cur = await weekPoints(companyId, thisWeek);
    const top = [...cur.entries()]
      .map(([uid, v]) => ({ uid, ...v }))
      .filter((t) => t.points > 0)
      .sort((a, b) => b.points - a.points)
      .slice(0, 3);
    if (!top.length) continue;

    // Most improved vs. last week's bucket.
    const prev = await weekPoints(companyId, lastWeek);
    let climber: { name: string; delta: number } | null = null;
    for (const [uid, v] of cur.entries()) {
      const delta = v.points - (prev.get(uid)?.points || 0);
      if (delta > 0 && (!climber || delta > climber.delta)) climber = { name: v.name, delta };
    }

    const medals = ["🥇", "🥈", "🥉"];
    let msg = "🏆 Weekly Recap — the board resets, fresh season starts now!\n\nThis week's top performers:\n";
    top.forEach((t, i) => { msg += `${medals[i]} ${t.name} — ${t.points.toLocaleString()} pts\n`; });
    if (climber) msg += `\n🚀 Most improved: ${climber.name} (+${climber.delta.toLocaleString()} pts vs last week)`;
    msg += "\n\nNew week, clean slate — let's get out there and run it back! 💪";

    await db.collection("chat").add({
      companyId, userId: "system", userName: "🏆 Weekly Recap", text: msg, createdAt: Date.now(),
    });
    logger.info(`weekly recap posted for ${companyId}`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// PLATFORM ADMIN — provider keys (ATTOM/BatchData), Stripe billing config, and
// company plan assignment. Super-admin only.
// ════════════════════════════════════════════════════════════════════════════

// Show the keys actually in use (config override, else env) so the operator can
// see "our keys" in the super-admin screen.
export const getApiKeys = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
  await refreshApiConfig();
  return {
    attomKey: ATTOM.key, attomUrl: ATTOM.baseUrl,
    batchKey: BATCH.key, batchUrl: BATCH.baseUrl, batchEnabled: BATCH.enabled,
  };
});

export const setApiKeys = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
  const d = (request.data || {}) as Record<string, unknown>;
  const u: Record<string, unknown> = { updatedAt: Date.now(), updatedBy: caller.uid };
  if (typeof d.attomKey === "string" && d.attomKey.trim()) u.attomKey = d.attomKey.trim();
  if (typeof d.attomUrl === "string") u.attomUrl = (d.attomUrl as string).trim();
  if (typeof d.batchKey === "string" && d.batchKey.trim()) u.batchKey = d.batchKey.trim();
  if (typeof d.batchUrl === "string") u.batchUrl = (d.batchUrl as string).trim();
  if (typeof d.batchEnabled === "boolean") u.batchEnabled = d.batchEnabled;
  await db.doc("config/api").set(u, { merge: true });
  return { ok: true };
});

// Which gateway charges companies: "stripe" (default) or "square". The whole
// platform uses one active provider at a time; the super-admin picks it here.
function billingProvider(c: Record<string, unknown>): "stripe" | "square" {
  return c.provider === "square" ? "square" : "stripe";
}

// Super-admin: choose the active payment provider.
export const setBillingProvider = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
  const { provider } = (request.data || {}) as { provider?: string };
  if (provider !== "stripe" && provider !== "square") {
    throw new HttpsError("invalid-argument", "provider must be 'stripe' or 'square'.");
  }
  await db.doc("config/billing").set({ provider, updatedAt: Date.now(), updatedBy: caller.uid }, { merge: true });
  return { ok: true };
});

// Stripe keys — publishable is shown; secret + webhook are masked.
export const getStripeConfig = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
  const c = ((await db.doc("config/billing").get()).data() as Record<string, string>) || {};
  return {
    provider: billingProvider(c),
    publishableKey: c.stripePublishableKey || "",
    secretConfigured: !!c.stripeSecretKey,
    secretMask: mask(c.stripeSecretKey),
    webhookConfigured: !!c.stripeWebhookSecret,
  };
});

export const setStripeConfig = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
  const d = (request.data || {}) as Record<string, string>;
  const u: Record<string, unknown> = { updatedAt: Date.now(), updatedBy: caller.uid };
  if (typeof d.publishableKey === "string") u.stripePublishableKey = d.publishableKey.trim();
  if (typeof d.secretKey === "string" && d.secretKey.trim()) u.stripeSecretKey = d.secretKey.trim();
  if (typeof d.webhookSecret === "string" && d.webhookSecret.trim()) u.stripeWebhookSecret = d.webhookSecret.trim();
  await db.doc("config/billing").set(u, { merge: true });
  return { ok: true };
});

// Square keys — application/location IDs are shown; access token + webhook key
// are masked. `environment` is "sandbox" (testing) or "production" (live money).
export const getSquareConfig = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
  const c = ((await db.doc("config/billing").get()).data() as Record<string, string>) || {};
  return {
    provider: billingProvider(c),
    environment: c.squareEnvironment === "production" ? "production" : "sandbox",
    applicationId: c.squareApplicationId || "",
    locationId: c.squareLocationId || "",
    accessTokenConfigured: !!c.squareAccessToken,
    accessTokenMask: mask(c.squareAccessToken),
    webhookConfigured: !!c.squareWebhookSignatureKey,
  };
});

export const setSquareConfig = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
  const d = (request.data || {}) as Record<string, string>;
  const u: Record<string, unknown> = { updatedAt: Date.now(), updatedBy: caller.uid };
  if (d.environment === "production" || d.environment === "sandbox") u.squareEnvironment = d.environment;
  if (typeof d.applicationId === "string") u.squareApplicationId = d.applicationId.trim();
  if (typeof d.locationId === "string") u.squareLocationId = d.locationId.trim();
  if (typeof d.accessToken === "string" && d.accessToken.trim()) u.squareAccessToken = d.accessToken.trim();
  if (typeof d.webhookSignatureKey === "string" && d.webhookSignatureKey.trim()) u.squareWebhookSignatureKey = d.webhookSignatureKey.trim();
  await db.doc("config/billing").set(u, { merge: true });
  return { ok: true };
});

// Assign / change a company's subscription plan + status.
export const setCompanyPlan = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
  const { companyId, plan, status, billingExempt, features, planPrice } = (request.data || {}) as {
    companyId?: string; plan?: string; status?: string; billingExempt?: boolean;
    features?: string[]; planPrice?: number;
  };
  if (!companyId) throw new HttpsError("invalid-argument", "companyId required.");
  const u: Record<string, unknown> = { updatedAt: Date.now() };
  if (typeof status === "string") u.status = status;
  if (typeof billingExempt === "boolean") u.billingExempt = billingExempt;
  if (typeof plan === "string") {
    u.plan = plan;
    if (isTrialPlan(plan)) {
      // Put the company on a 3-day trial with full access. Keep an in-progress
      // trial's existing end date; otherwise start a fresh window. Trial wins as
      // the status unless the admin explicitly set one in the same change.
      const cur = (await db.doc(`companies/${companyId}`).get()).data() || {};
      const curEnd = Number(cur.trialEndsAt) || 0;
      u.trialEndsAt = curEnd > Date.now() ? curEnd : Date.now() + TRIAL_MS;
      u.trialExpired = false;
      if (typeof status !== "string") u.status = "trial";
      // Trial = the full product: drop any feature restriction (undefined = all on).
      u.features = FieldValue.delete();
    }
    // Copy the plan's feature set + limits onto the company so the app can gate.
    const ps = await db.collection("plans").where("name", "==", plan).limit(1).get();
    if (!ps.empty) {
      const p = ps.docs[0].data();
      u.planId = ps.docs[0].id;
      u.features = Array.isArray(p.features) ? p.features : [];
      u.maxUsers = Number(p.maxUsers) || 0;
      // Two-part pricing: base fee (covers includedUsers) + perUserPrice each extra.
      const baseFee = Number(p.baseFee ?? p.priceMonthly) || 0;
      const includedUsers = Number(p.includedUsers) || 0;
      const perUserPrice = Number(p.perUserPrice) || 0;
      u.baseFee = baseFee;
      u.includedUsers = includedUsers;
      u.perUserPrice = perUserPrice;
      // Effective monthly = base + overage based on the current active head-count.
      const us = await db.collection("users").where("companyId", "==", companyId).get();
      const activeUsers = us.docs.filter((d) => !d.data().disabled).length;
      const extra = Math.max(0, activeUsers - includedUsers);
      u.planPrice = baseFee + extra * perUserPrice;
    }
  }
  // Per-company overrides (applied after any plan copy so admin toggles win):
  // turn individual services on/off and set a custom price for this company.
  if (Array.isArray(features)) u.features = features.filter((x) => typeof x === "string");
  if (typeof planPrice === "number" && isFinite(planPrice)) u.planPrice = planPrice;
  await db.doc(`companies/${companyId}`).set(u, { merge: true });
  return { ok: true };
});

// Who the bill is addressed to + where it's sent. Super-admins set it for any
// company; a company admin may set it for their own company.
export const setCompanyBilling = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, billingContactName, billingEmail } = (request.data || {}) as {
    companyId?: string; billingContactName?: string; billingEmail?: string;
  };
  const cid = authorizeForCompany(caller, companyId);
  const email = (billingEmail || "").trim();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new HttpsError("invalid-argument", "Enter a valid billing email.");
  }
  await db.doc(`companies/${cid}`).set({
    billingContactName: (billingContactName || "").trim(),
    billingEmail: email,
    updatedAt: Date.now(),
  }, { merge: true });
  return { ok: true };
});

// ════════════════════════════════════════════════════════════════════════════
// ORGANIZATIONS — a parent grouping over multiple company tenants (e.g. a
// franchise/dealer). Enterprise billing adds a per-company fee on every company
// in the org PLUS one org-wide fee. Locking an org for non-payment locks every
// company under it (reusing the per-company billingHold gate). Super-admin only.
// ════════════════════════════════════════════════════════════════════════════
const ENTERPRISE_COMPANY_FEE = 500; // added per company in an enterprise org
const ENTERPRISE_ORG_FEE = 85; // added once for the whole organization

function requireSuper(caller: Caller) {
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
}

export const createOrganization = onCall(async (request) => {
  const caller = await getCaller(request);
  requireSuper(caller);
  const name = String((request.data || {}).name || "").trim();
  if (!name) throw new HttpsError("invalid-argument", "Organization name required.");
  const ref = await db.collection("organizations").add({
    name, enterprise: false,
    perCompanyFee: ENTERPRISE_COMPANY_FEE, orgFee: ENTERPRISE_ORG_FEE,
    billingContactName: "", billingEmail: "",
    status: "active", billingHold: false, pastDueSince: 0,
    createdAt: Date.now(), updatedAt: Date.now(),
  });
  return { ok: true, orgId: ref.id };
});

export const setOrganization = onCall(async (request) => {
  const caller = await getCaller(request);
  requireSuper(caller);
  const { orgId, name, billingContactName, billingEmail, enterprise, perCompanyFee, orgFee } =
    (request.data || {}) as {
      orgId?: string; name?: string; billingContactName?: string; billingEmail?: string;
      enterprise?: boolean; perCompanyFee?: number; orgFee?: number;
    };
  if (!orgId) throw new HttpsError("invalid-argument", "orgId required.");
  const email = (billingEmail || "").trim();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new HttpsError("invalid-argument", "Enter a valid billing email.");
  }
  const u: Record<string, unknown> = { updatedAt: Date.now() };
  if (typeof name === "string") u.name = name.trim();
  if (typeof billingContactName === "string") u.billingContactName = billingContactName.trim();
  if (typeof billingEmail === "string") u.billingEmail = email;
  if (typeof enterprise === "boolean") u.enterprise = enterprise;
  if (typeof perCompanyFee === "number" && isFinite(perCompanyFee)) u.perCompanyFee = Math.max(0, perCompanyFee);
  if (typeof orgFee === "number" && isFinite(orgFee)) u.orgFee = Math.max(0, orgFee);
  await db.doc(`organizations/${orgId}`).set(u, { merge: true });
  return { ok: true };
});

export const assignCompanyToOrg = onCall(async (request) => {
  const caller = await getCaller(request);
  requireSuper(caller);
  const { companyId, orgId } = (request.data || {}) as { companyId?: string; orgId?: string | null };
  if (!companyId) throw new HttpsError("invalid-argument", "companyId required.");
  if (orgId) {
    const org = await db.doc(`organizations/${orgId}`).get();
    if (!org.exists) throw new HttpsError("not-found", "Organization not found.");
    await db.doc(`companies/${companyId}`).set({ organizationId: orgId, updatedAt: Date.now() }, { merge: true });
  } else {
    await db.doc(`companies/${companyId}`).set({ organizationId: FieldValue.delete(), updatedAt: Date.now() }, { merge: true });
  }
  return { ok: true };
});

// Lock (or unlock) an organization for non-payment. Locking suspends every
// company under it — the per-company billingHold gate then shows the
// "contact your administrator for payment" message. "Due on receipt" = lock
// immediately; unlock once the org pays.
export const setOrgLock = onCall(async (request) => {
  const caller = await getCaller(request);
  requireSuper(caller);
  const { orgId, locked } = (request.data || {}) as { orgId?: string; locked?: boolean };
  if (!orgId) throw new HttpsError("invalid-argument", "orgId required.");
  const now = Date.now();
  const orgPatch = locked
    ? { status: "suspended", billingHold: true, pastDueSince: now, updatedAt: now }
    : { status: "active", billingHold: false, pastDueSince: 0, updatedAt: now };
  await db.doc(`organizations/${orgId}`).set(orgPatch, { merge: true });
  const companies = await db.collection("companies").where("organizationId", "==", orgId).get();
  const batch = db.batch();
  companies.docs.forEach((d) => batch.set(d.ref, orgPatch, { merge: true }));
  await batch.commit();
  return { ok: true, companies: companies.size };
});

// ════════════════════════════════════════════════════════════════════════════
// STRIPE BILLING — checkout, billing portal, and a webhook that flips a
// company's status from the live subscription state. Keys live in config/billing
// (set in the super-admin screen).
// ════════════════════════════════════════════════════════════════════════════
async function stripeClient() {
  const c = ((await db.doc("config/billing").get()).data() as Record<string, string>) || {};
  if (!c.stripeSecretKey) throw new HttpsError("failed-precondition", "Stripe isn't configured. Add keys in the admin console.");
  return new Stripe(c.stripeSecretKey);
}

// Map a Stripe subscription status → our company status vocabulary.
function mapSubStatus(s: string): string {
  switch (s) {
    case "active": return "active";
    case "trialing": return "trial";
    case "past_due": case "unpaid": return "past_due";
    case "canceled": case "incomplete_expired": return "suspended";
    default: return "trial";
  }
}

// ── Billing helpers: mirror Stripe invoices + notify company admins ──────────
const BILLING_INTERVAL_DAYS = 30;

async function companyAdminEmails(companyId: string): Promise<string[]> {
  try {
    const s = await db.collection("users").where("companyId", "==", companyId).where("role", "==", "admin").get();
    return s.docs.map((d) => (d.data().email as string) || "").filter(Boolean);
  } catch { return []; }
}

// Upsert a Stripe invoice into invoices/{id} so it shows in-app (AR + profiles).
async function mirrorInvoice(inv: any): Promise<{ companyId: string } | null> {
  let companyId: string | null = inv?.subscription_details?.metadata?.companyId || inv?.metadata?.companyId || null;
  let companyName = "";
  if (companyId) {
    companyName = (await db.doc(`companies/${companyId}`).get()).data()?.name || "";
  } else if (inv?.customer) {
    const s = await db.collection("companies").where("stripeCustomerId", "==", inv.customer).limit(1).get();
    if (!s.empty) { companyId = s.docs[0].id; companyName = s.docs[0].data().name || ""; }
  }
  if (!companyId) return null;
  const lines = ((inv.lines && inv.lines.data) || []).map((l: any) => ({
    description: l.description || "Subscription", amount: l.amount,
  }));
  await db.doc(`invoices/${inv.id}`).set({
    stripeInvoiceId: inv.id, companyId, companyName,
    number: inv.number || "", status: inv.status || "open",
    amountDue: inv.amount_due ?? 0, amountPaid: inv.amount_paid ?? 0, currency: inv.currency || "usd",
    created: (inv.created || 0) * 1000,
    dueDate: inv.due_date ? inv.due_date * 1000 : (inv.next_payment_attempt ? inv.next_payment_attempt * 1000 : null),
    periodStart: inv.period_start ? inv.period_start * 1000 : null,
    periodEnd: inv.period_end ? inv.period_end * 1000 : null,
    hostedInvoiceUrl: inv.hosted_invoice_url || "", invoicePdf: inv.invoice_pdf || "",
    lines, updatedAt: Date.now(),
  }, { merge: true });
  return { companyId };
}

// Start a Checkout session for a company + plan; returns the hosted URL.
export const createCheckoutSession = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, planId } = (request.data || {}) as { companyId?: string; planId?: string };
  authorizeForCompany(caller, companyId);
  if (!planId) throw new HttpsError("invalid-argument", "planId required.");
  const planSnap = await db.doc(`plans/${planId}`).get();
  if (!planSnap.exists) throw new HttpsError("not-found", "Plan not found.");
  const plan = planSnap.data()!;
  if (!plan.stripePriceId) throw new HttpsError("failed-precondition", `Plan "${plan.name}" has no Stripe Price ID.`);
  const company = (await db.doc(`companies/${companyId}`).get()).data() || {};
  const stripe = await stripeClient();
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: plan.stripePriceId as string, quantity: 1 }],
    customer: (company.stripeCustomerId as string) || undefined,
    success_url: `${APP_URL}/admin.html?billing=success`,
    cancel_url: `${APP_URL}/admin.html?billing=cancel`,
    metadata: { companyId: companyId!, planId, planName: (plan.name as string) || "" },
    subscription_data: { metadata: { companyId: companyId!, planId } },
  });
  return { url: session.url };
});

// Open the Stripe billing portal for an already-subscribed company.
export const createBillingPortalSession = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId } = (request.data || {}) as { companyId?: string };
  authorizeForCompany(caller, companyId);
  const company = (await db.doc(`companies/${companyId}`).get()).data() || {};
  if (!company.stripeCustomerId) throw new HttpsError("failed-precondition", "No subscription yet for this company.");
  const stripe = await stripeClient();
  const session = await stripe.billingPortal.sessions.create({
    customer: company.stripeCustomerId as string,
    return_url: `${APP_URL}/admin.html`,
  });
  return { url: session.url };
});

// Stripe webhook (Hosting rewrites /stripe/** here). Verifies the signature and
// syncs the company's subscription state. Configure the URL + signing secret in
// the Stripe Dashboard, then paste the signing secret in the admin console.
export const stripeWebhook = onRequest({ cors: false }, async (req, res) => {
  const c = ((await db.doc("config/billing").get()).data() as Record<string, string>) || {};
  if (!c.stripeSecretKey || !c.stripeWebhookSecret) { res.status(503).send("Stripe not configured"); return; }
  const stripe = new Stripe(c.stripeSecretKey);
  let event: { type: string; data: { object: any } };
  try {
    const sig = req.headers["stripe-signature"] as string;
    event = stripe.webhooks.constructEvent((req as unknown as { rawBody: Buffer }).rawBody, sig, c.stripeWebhookSecret);
  } catch (e: any) {
    logger.warn("Stripe webhook signature failed", e?.message);
    res.status(400).send(`Webhook Error: ${e?.message}`);
    return;
  }

  try {
    const obj = event.data.object as any;
    if (event.type === "checkout.session.completed") {
      const companyId = obj.metadata?.companyId;
      if (companyId) {
        const u: Record<string, unknown> = {
          stripeCustomerId: obj.customer, stripeSubscriptionId: obj.subscription,
          status: "active", trialEndsAt: 0, trialExpired: false, updatedAt: Date.now(),
        };
        const planId = obj.metadata?.planId;
        if (planId) {
          const p = await db.doc(`plans/${planId}`).get();
          if (p.exists) {
            const pd = p.data()!;
            u.plan = pd.name; u.planId = planId;
            u.features = Array.isArray(pd.features) ? pd.features : [];
            u.maxUsers = Number(pd.maxUsers) || 0;
            u.planPrice = Number(pd.priceMonthly) || 0;
          }
        }
        await db.doc(`companies/${companyId}`).set(u, { merge: true });
      }
    } else if (event.type.startsWith("customer.subscription.")) {
      const status = mapSubStatus(obj.status);
      const patch: Record<string, unknown> = { status, updatedAt: Date.now() };
      if (obj.current_period_end) patch.nextBillingAt = obj.current_period_end * 1000;
      const companyId = obj.metadata?.companyId;
      if (companyId) {
        await db.doc(`companies/${companyId}`).set(patch, { merge: true });
      } else if (obj.customer) {
        const snap = await db.collection("companies").where("stripeCustomerId", "==", obj.customer).limit(1).get();
        if (!snap.empty) await snap.docs[0].ref.set(patch, { merge: true });
      }
    } else if (event.type.startsWith("invoice.")) {
      // Mirror every invoice for in-app viewing, and drive dunning / reactivation.
      const res2 = await mirrorInvoice(obj);
      if (res2) {
        const ref = db.doc(`companies/${res2.companyId}`);
        if (event.type === "invoice.payment_failed") {
          const c = (await ref.get()).data() || {};
          const patch: Record<string, unknown> = { status: "past_due", updatedAt: Date.now() };
          if (!c.pastDueSince) patch.pastDueSince = Date.now(); // start the 3-day grace clock
          await ref.set(patch, { merge: true });
          const cfg = await getNotifyConfig();
          const amt = ((obj.amount_due || 0) / 100).toFixed(2);
          for (const to of await companyAdminEmails(res2.companyId)) {
            await sendEmail(cfg, to, "Payment failed — action needed",
              `We couldn't process your YoutilityKnock payment of $${amt}. Please update the card on file to avoid interruption — your account will be paused if payment isn't received within 3 days.${obj.hosted_invoice_url ? "\n\nPay now: " + obj.hosted_invoice_url : ""}`);
          }
        } else if (event.type === "invoice.paid" || event.type === "invoice.payment_succeeded") {
          const patch: Record<string, unknown> = { status: "active", pastDueSince: 0, billingHold: false, updatedAt: Date.now() };
          const periodEnd = obj.lines?.data?.[0]?.period?.end;
          if (periodEnd) patch.nextBillingAt = periodEnd * 1000;
          await ref.set(patch, { merge: true });
        }
      }
    }
    res.json({ received: true });
  } catch (e: any) {
    logger.error("Stripe webhook handler error", e);
    res.status(500).send("handler error");
  }
});

// Public config for the embedded card field (any authed company admin/super).
// Returns the active provider plus only the non-secret keys that the browser
// SDK needs (Stripe publishable key, or Square app/location id + environment).
export const getBillingPublicConfig = onCall(async (request) => {
  await getCaller(request);
  const c = ((await db.doc("config/billing").get()).data() as Record<string, string>) || {};
  return {
    provider: billingProvider(c),
    publishableKey: c.stripePublishableKey || "",
    square: {
      environment: c.squareEnvironment === "production" ? "production" : "sandbox",
      applicationId: c.squareApplicationId || "",
      locationId: c.squareLocationId || "",
    },
  };
});

// List invoices for in-app viewing: super-admin sees all (optionally filtered to
// one company); a company admin sees only their own. Read via the admin SDK so
// it doesn't depend on Firestore-rules deployment.
export const listInvoices = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId } = (request.data || {}) as { companyId?: string };
  let q: FirebaseFirestore.Query = db.collection("invoices");
  if (caller.isSuper) {
    if (companyId) q = q.where("companyId", "==", companyId);
  } else {
    if (caller.role !== "admin" || !caller.companyId) throw new HttpsError("permission-denied", "Company admins only.");
    if (companyId && companyId !== caller.companyId) throw new HttpsError("permission-denied", "Not allowed.");
    q = q.where("companyId", "==", caller.companyId);
  }
  const snap = await q.get();
  const invoices = snap.docs
    .map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) }))
    .sort((a: any, b: any) => (b.created || 0) - (a.created || 0));
  return { invoices };
});

// Ensure a Stripe customer + start a SetupIntent so the embedded card field can
// save a card on file for this company.
export const createSetupIntent = onCall(async (request) => {
  const caller = await getCaller(request);
  const companyId = authorizeForCompany(caller, (request.data || {}).companyId);
  const stripe = await stripeClient();
  const ref = db.doc(`companies/${companyId}`);
  const company = (await ref.get()).data() || {};
  let customerId = company.stripeCustomerId as string | undefined;
  if (!customerId) {
    const cust = await stripe.customers.create({ name: (company.name as string) || companyId, metadata: { companyId } });
    customerId = cust.id;
    await ref.set({ stripeCustomerId: customerId, updatedAt: Date.now() }, { merge: true });
  }
  const si = await stripe.setupIntents.create({ customer: customerId, usage: "off_session", metadata: { companyId } });
  return { clientSecret: si.client_secret };
});

// After the card is confirmed client-side: set it as the default, store the
// brand/last4, and (re)start the 30-day subscription priced from the company's
// effective monthly price. The first charge runs immediately.
export const saveCardAndSubscribe = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId: cid, paymentMethodId } = (request.data || {}) as { companyId?: string; paymentMethodId?: string };
  const companyId = authorizeForCompany(caller, cid);
  if (!paymentMethodId) throw new HttpsError("invalid-argument", "paymentMethodId required.");
  const stripe = await stripeClient();
  const ref = db.doc(`companies/${companyId}`);
  const company = (await ref.get()).data() || {};
  const customerId = company.stripeCustomerId as string;
  if (!customerId) throw new HttpsError("failed-precondition", "No customer yet — call createSetupIntent first.");
  await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId }).catch(() => {});
  await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: paymentMethodId } });
  const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
  const card = (pm as any).card || {};
  const update: Record<string, unknown> = { cardBrand: card.brand || "", cardLast4: card.last4 || "", updatedAt: Date.now() };
  // Charge the company's effective monthly price every 30 days from now.
  const cents = Math.round((Number(company.planPrice) || 0) * 100);
  if (!company.billingExempt && cents > 0) {
    const subId = company.stripeSubscriptionId as string | undefined;
    if (subId) {
      await stripe.subscriptions.update(subId, { default_payment_method: paymentMethodId });
    } else {
      const product = await stripe.products.create({
        name: `YoutilityKnock — ${company.plan || "Subscription"}`,
        metadata: { companyId },
      });
      const sub = await stripe.subscriptions.create({
        customer: customerId,
        default_payment_method: paymentMethodId,
        items: [{ price_data: {
          currency: "usd",
          product: product.id,
          unit_amount: cents,
          recurring: { interval: "day", interval_count: BILLING_INTERVAL_DAYS },
        } }],
        metadata: { companyId },
      });
      update.stripeSubscriptionId = sub.id;
      if ((sub as any).current_period_end) update.nextBillingAt = (sub as any).current_period_end * 1000;
      update.status = "active"; update.pastDueSince = 0; update.billingHold = false;
    }
  }
  await ref.set(update, { merge: true });
  return { ok: true, brand: update.cardBrand, last4: update.cardLast4 };
});

// Re-email an invoice to the company's admins (with the pay/view link).
export const emailInvoice = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId: cid, invoiceId } = (request.data || {}) as { companyId?: string; invoiceId?: string };
  const companyId = authorizeForCompany(caller, cid);
  if (!invoiceId) throw new HttpsError("invalid-argument", "invoiceId required.");
  const inv = (await db.doc(`invoices/${invoiceId}`).get()).data();
  if (!inv || inv.companyId !== companyId) throw new HttpsError("not-found", "Invoice not found.");
  // Prefer the explicit billing contact; fall back to the company's admins.
  const company = (await db.doc(`companies/${companyId}`).get()).data() || {};
  const billingEmail = ((company.billingEmail as string) || "").trim();
  const contactName = ((company.billingContactName as string) || "").trim();
  const emails = billingEmail ? [billingEmail] : await companyAdminEmails(companyId);
  if (!emails.length) throw new HttpsError("failed-precondition", "No billing email or company admin email on file.");
  const cfg = await getNotifyConfig();
  const amt = ((inv.amountDue || 0) / 100).toFixed(2);
  const link = inv.hostedInvoiceUrl || inv.invoicePdf || "";
  const greeting = contactName ? `Hi ${contactName},\n\n` : "";
  let sent = 0;
  for (const to of emails) {
    if (await sendEmail(cfg, to, `Invoice ${inv.number || ""} — $${amt}`,
      `${greeting}Your YoutilityKnock invoice ${inv.number || ""} for $${amt} is ${inv.status}.${link ? "\n\nView / pay: " + link : ""}`)) sent++;
  }
  return { ok: true, sent };
});

// ════════════════════════════════════════════════════════════════════════════
// SQUARE BILLING — the alternative to Stripe. Square has no "metered recurring
// for an arbitrary amount" primitive that fits per-company pricing, so instead
// we save a card on file (tokenized in the browser by the Square Web Payments
// SDK), charge the effective monthly price immediately, and let a daily cron
// re-charge it every 30 days. Status sync + dunning reuse the same fields and
// the same billingDunning job as Stripe. Keys live in config/billing.
// ════════════════════════════════════════════════════════════════════════════
const SQUARE_VERSION = "2025-01-23"; // Square API version pin

async function squareCfg() {
  const c = ((await db.doc("config/billing").get()).data() as Record<string, string>) || {};
  if (!c.squareAccessToken) throw new HttpsError("failed-precondition", "Square isn't configured. Add keys in the admin console.");
  const production = c.squareEnvironment === "production";
  return {
    token: c.squareAccessToken,
    locationId: c.squareLocationId || "",
    base: production ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com",
  };
}

// Thin REST wrapper (Square's Node SDK churns its types; the codebase already
// talks to ATTOM/SendGrid/Twilio over fetch, so we do the same here).
async function squareApi(cfg: { token: string; base: string }, path: string, body?: unknown) {
  const res = await fetch(cfg.base + path, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${cfg.token}`,
      "Square-Version": SQUARE_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json?.errors?.[0]?.detail || `Square API ${res.status}`;
    throw new HttpsError("internal", detail);
  }
  return json;
}

// Mirror a completed Square payment into invoices/{id} so it shows in the same
// in-app AR / invoice views Stripe payments use.
async function mirrorSquarePayment(companyId: string, payment: any): Promise<void> {
  const companyName = (await db.doc(`companies/${companyId}`).get()).data()?.name || "";
  const cents = payment?.amount_money?.amount ?? 0;
  const paid = payment?.status === "COMPLETED";
  await db.doc(`invoices/${payment.id}`).set({
    squarePaymentId: payment.id, companyId, companyName,
    number: payment.receipt_number || "",
    status: paid ? "paid" : (payment.status || "open").toLowerCase(),
    amountDue: cents, amountPaid: paid ? cents : 0,
    currency: (payment?.amount_money?.currency || "USD").toLowerCase(),
    created: payment.created_at ? new Date(payment.created_at).getTime() : Date.now(),
    hostedInvoiceUrl: payment.receipt_url || "", invoicePdf: payment.receipt_url || "",
    lines: [{ description: "YoutilityKnock subscription", amount: cents }],
    updatedAt: Date.now(),
  }, { merge: true });
}

// Charge a company's saved Square card for its effective monthly price. Advances
// the 30-day clock + records the invoice on success; marks it past_due on
// failure (billingDunning then pauses it after the 3-day grace window).
async function runSquareCharge(companyId: string): Promise<{ ok: boolean; error?: string }> {
  const ref = db.doc(`companies/${companyId}`);
  const company = (await ref.get()).data() || {};
  const cents = Math.round((Number(company.planPrice) || 0) * 100);
  if (company.billingExempt || cents <= 0) return { ok: true };
  const cardId = company.squareCardId as string | undefined;
  const customerId = company.squareCustomerId as string | undefined;
  if (!cardId || !customerId) return { ok: false, error: "No card on file." };
  const cfg = await squareCfg();
  try {
    const { payment } = await squareApi(cfg, "/v2/payments", {
      idempotency_key: crypto.randomUUID(),
      source_id: cardId,
      customer_id: customerId,
      location_id: cfg.locationId || undefined,
      amount_money: { amount: cents, currency: "USD" },
      note: `YoutilityKnock — ${company.plan || "Subscription"}`,
    });
    await mirrorSquarePayment(companyId, payment);
    await ref.set({
      status: "active", pastDueSince: 0, billingHold: false,
      nextBillingAt: Date.now() + BILLING_INTERVAL_DAYS * 86400000, updatedAt: Date.now(),
    }, { merge: true });
    return { ok: true };
  } catch (e: any) {
    const patch: Record<string, unknown> = { status: "past_due", updatedAt: Date.now() };
    if (!company.pastDueSince) patch.pastDueSince = Date.now();
    await ref.set(patch, { merge: true });
    const cfgN = await getNotifyConfig();
    for (const to of await companyAdminEmails(companyId)) {
      await sendEmail(cfgN, to, "Payment failed — action needed",
        `We couldn't process your YoutilityKnock payment. Please update the card on file to avoid interruption — your account will be paused if payment isn't received within 3 days.`);
    }
    return { ok: false, error: e?.message || "Charge failed." };
  }
}

// Save a Square card on file (token from the browser Web Payments SDK) and, if
// billing isn't already running, take the first monthly charge to start it.
export const squareSaveCardAndSubscribe = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId: cid, sourceId } = (request.data || {}) as { companyId?: string; sourceId?: string };
  const companyId = authorizeForCompany(caller, cid);
  if (!sourceId) throw new HttpsError("invalid-argument", "sourceId (card token) required.");
  const cfg = await squareCfg();
  const ref = db.doc(`companies/${companyId}`);
  const company = (await ref.get()).data() || {};

  // Ensure a Square customer for this company.
  let customerId = company.squareCustomerId as string | undefined;
  if (!customerId) {
    const { customer } = await squareApi(cfg, "/v2/customers", {
      idempotency_key: crypto.randomUUID(),
      company_name: (company.name as string) || companyId,
      reference_id: companyId,
    });
    customerId = customer.id;
    await ref.set({ squareCustomerId: customerId, updatedAt: Date.now() }, { merge: true });
  }

  // Store the card on file.
  const { card } = await squareApi(cfg, "/v2/cards", {
    idempotency_key: crypto.randomUUID(),
    source_id: sourceId,
    card: { customer_id: customerId },
  });
  const hadBilling = !!company.squareCardId && (Number(company.nextBillingAt) || 0) > Date.now();
  await ref.set({
    squareCardId: card.id,
    cardBrand: card.card_brand || "", cardLast4: card.last_4 || "",
    updatedAt: Date.now(),
  }, { merge: true });

  // Start the cycle with an immediate charge unless billing is already active.
  const cents = Math.round((Number(company.planPrice) || 0) * 100);
  if (!company.billingExempt && cents > 0 && !hadBilling) {
    const r = await runSquareCharge(companyId);
    if (!r.ok) throw new HttpsError("internal", r.error || "Could not take first payment.");
  }
  return { ok: true, brand: card.card_brand || "", last4: card.last_4 || "" };
});

// Daily Square recurring charge: re-bill each Square company when its 30-day
// clock comes due. (Stripe companies are billed by Stripe's own subscriptions.)
export const squareBillingCron = onSchedule("every 24 hours", async () => {
  const c = ((await db.doc("config/billing").get()).data() as Record<string, string>) || {};
  if (billingProvider(c) !== "square") return; // only when Square is the active gateway
  const now = Date.now();
  const snap = await db.collection("companies").where("squareCardId", ">", "").get();
  for (const d of snap.docs) {
    const co = d.data();
    if (co.billingExempt || co.status === "suspended") continue;
    if ((Number(co.nextBillingAt) || 0) > now) continue; // not due yet
    await runSquareCharge(d.id);
  }
});

// Square webhook (Hosting rewrites /square/** here). Verifies the HMAC-SHA256
// signature, then mirrors payments + keeps the company status in sync.
export const squareWebhook = onRequest({ cors: false }, async (req, res) => {
  const c = ((await db.doc("config/billing").get()).data() as Record<string, string>) || {};
  const key = c.squareWebhookSignatureKey;
  if (!key) { res.status(503).send("Square not configured"); return; }
  const raw = (req as unknown as { rawBody: Buffer }).rawBody?.toString("utf8") || "";
  const sig = req.headers["x-square-hmacsha256-signature"] as string;
  const expected = crypto.createHmac("sha256", key).update(`${APP_URL}/square/webhook` + raw).digest("base64");
  if (!sig || sig !== expected) { res.status(400).send("bad signature"); return; }

  try {
    const event = JSON.parse(raw || "{}");
    const payment = event?.data?.object?.payment;
    if (payment?.customer_id) {
      const snap = await db.collection("companies").where("squareCustomerId", "==", payment.customer_id).limit(1).get();
      if (!snap.empty) {
        const companyId = snap.docs[0].id;
        await mirrorSquarePayment(companyId, payment);
        if (payment.status === "COMPLETED") {
          await snap.docs[0].ref.set({ status: "active", pastDueSince: 0, billingHold: false, updatedAt: Date.now() }, { merge: true });
        }
      }
    }
    res.json({ received: true });
  } catch (e: any) {
    logger.error("Square webhook handler error", e);
    res.status(500).send("handler error");
  }
});

// Daily dunning: pause companies still unpaid 3 days after a failed charge.
export const billingDunning = onSchedule("every 24 hours", async () => {
  const cutoff = Date.now() - 3 * 86400000;
  const snap = await db.collection("companies").where("pastDueSince", ">", 0).get();
  const cfg = await getNotifyConfig();
  for (const d of snap.docs) {
    const c = d.data();
    if (c.billingHold || c.status === "suspended") continue;
    if ((c.pastDueSince as number) > cutoff) continue; // still inside the 3-day grace window
    await d.ref.set({ status: "suspended", billingHold: true, updatedAt: Date.now() }, { merge: true });
    for (const to of await companyAdminEmails(d.id)) {
      await sendEmail(cfg, to, "Account paused — payment overdue",
        `Your YoutilityKnock account has been paused because payment is more than 3 days overdue. Update the card on file to restore access immediately.`);
    }
  }
});

// ───────────────────────────────────────────────────────────────────────────
// trialExpiry — pause companies whose 3-day trial has elapsed. Suspending only
// gates access; every lead, shift, and setting they entered is preserved, so
// subscribing later resumes them exactly where they left off.
// ───────────────────────────────────────────────────────────────────────────
export const trialExpiry = onSchedule("every 1 hours", async () => {
  const now = Date.now();
  const snap = await db.collection("companies").where("status", "==", "trial").get();
  const cfg = await getNotifyConfig();
  for (const d of snap.docs) {
    const c = d.data();
    const end = Number(c.trialEndsAt) || 0;
    if (!end || end > now) continue; // still inside the trial window
    await d.ref.set({ status: "suspended", trialExpired: true, updatedAt: now }, { merge: true });
    for (const to of await companyAdminEmails(d.id)) {
      await sendEmail(cfg, to, "Trial ended — account paused",
        `Your YoutilityKnock ${TRIAL_DAYS}-day trial has ended, so the account is now paused. All of your data is saved — subscribe to a plan to pick up right where you left off.`);
    }
  }
});

// ════════════════════════════════════════════════════════════════════════════
// YOUTILITYCRM INTEGRATION — provision a Knock company as a CRM add-on, sync
// leads + appointments + customer data both ways, and keep schedules linked.
//
// The link is configured PER COMPANY (crmLinks/{companyId}): each tenant in the
// CRM has its own company login, so each gets its own 4 settings —
//   enabled · crmCompanyId · webhookUrl (Knock→CRM) · apiSecret.
// External calls send the company's secret in the `x-crm-secret` header.
// A single global "master" secret (config/crm.apiSecret) authenticates the
// /provision bootstrap (run before any company exists) and is accepted as a
// fallback. Hosting rewrites /crm/** here.
// ════════════════════════════════════════════════════════════════════════════
async function crmMasterSecret(): Promise<string> {
  const c = ((await db.doc("config/crm").get()).data() as Record<string, string>) || {};
  return c.apiSecret || "";
}

// Master provisioning key (super-admin only) — the CRM↔Knock platform key.
export const getCrmConfig = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
  const secret = await crmMasterSecret();
  return { secretConfigured: !!secret, secretMask: mask(secret) };
});

export const setCrmConfig = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.isSuper) throw new HttpsError("permission-denied", "Super-admins only.");
  const d = (request.data || {}) as Record<string, string>;
  const u: Record<string, unknown> = { updatedAt: Date.now() };
  if (typeof d.apiSecret === "string" && d.apiSecret.trim()) u.apiSecret = d.apiSecret.trim();
  await db.doc("config/crm").set(u, { merge: true });
  return { ok: true };
});

// ── Per-company CRM link (the config fields) ─────────────────────────────────
interface CompanyCrm { enabled: boolean; crmCompanyId: string; webhookUrl: string; appointmentWebhookUrl: string; apiSecret: string; }
async function companyCrm(companyId: string): Promise<CompanyCrm> {
  const c = ((await db.doc(`crmLinks/${companyId}`).get()).data() as Record<string, any>) || {};
  return {
    enabled: !!c.enabled,
    crmCompanyId: c.crmCompanyId || "",
    webhookUrl: c.webhookUrl || "",
    appointmentWebhookUrl: c.appointmentWebhookUrl || "",
    apiSecret: c.apiSecret || "",
  };
}

// Read one company's link (super-admin, or that company's own admin).
export const getCompanyCrm = onCall(async (request) => {
  const caller = await getCaller(request);
  const companyId = authorizeForCompany(caller, (request.data || {}).companyId);
  const c = await companyCrm(companyId);
  return {
    enabled: c.enabled, crmCompanyId: c.crmCompanyId,
    webhookUrl: c.webhookUrl, appointmentWebhookUrl: c.appointmentWebhookUrl,
    secretConfigured: !!c.apiSecret, secretMask: mask(c.apiSecret),
  };
});

// Save one company's link. Mirrors non-secret fields onto the company doc so
// the app/console can see CRM status without reading the server-only secret.
export const setCompanyCrm = onCall(async (request) => {
  const caller = await getCaller(request);
  const d = (request.data || {}) as Record<string, any>;
  const companyId = authorizeForCompany(caller, d.companyId);
  const u: Record<string, unknown> = { companyId, updatedAt: Date.now() };
  if (typeof d.enabled === "boolean") u.enabled = d.enabled;
  if (typeof d.crmCompanyId === "string") u.crmCompanyId = d.crmCompanyId.trim();
  if (typeof d.webhookUrl === "string") u.webhookUrl = d.webhookUrl.trim();
  if (typeof d.appointmentWebhookUrl === "string") u.appointmentWebhookUrl = d.appointmentWebhookUrl.trim();
  if (typeof d.apiSecret === "string" && d.apiSecret.trim()) u.apiSecret = d.apiSecret.trim();
  await db.doc(`crmLinks/${companyId}`).set(u, { merge: true });
  const mirror: Record<string, unknown> = {};
  if ("enabled" in u) mirror.crmEnabled = u.enabled;
  if ("crmCompanyId" in u) mirror.crmCompanyId = (u.crmCompanyId as string) || null;
  if (Object.keys(mirror).length) await db.doc(`companies/${companyId}`).set(mirror, { merge: true });
  return { ok: true };
});

// Authenticate a CRM request: prefer the company's own secret, fall back to the
// global master key (covers the provision bootstrap before a company exists).
async function crmAuth(sent: string, companyId?: string): Promise<boolean> {
  if (!sent) return false;
  if (companyId) {
    const link = await companyCrm(companyId);
    if (link.apiSecret && sent === link.apiSecret) return true;
  }
  const master = await crmMasterSecret();
  return !!master && sent === master;
}

// Push a changed lead / appointment to that company's CRM webhook (best-effort).
// Leads and appointments have separate endpoints in the CRM add-on.
async function pushToCrm(kind: "lead" | "event" | "reward", companyId: string, id: string, data: any) {
  if (data?._syncedFrom === "crm") return; // came from the CRM — don't echo back
  const link = await companyCrm(companyId);
  if (!link.enabled) return; // sync paused
  const url = kind === "event"
    ? (link.appointmentWebhookUrl || link.webhookUrl)
    : link.webhookUrl; // rewards/contests ride the main webhook
  if (!url) return; // no endpoint configured for this kind
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-crm-secret": link.apiSecret },
      body: JSON.stringify({ type: kind, companyId, crmCompanyId: link.crmCompanyId, id, data }),
    });
  } catch (e) { logger.warn(`pushToCrm ${kind} failed`, e); }
}

export const onLeadSync = onDocumentWritten("leads/{id}", async (event) => {
  const after = event.data?.after?.data();
  if (!after?.companyId) return;
  await pushToCrm("lead", after.companyId, event.params.id, after);
});

export const onEventSync = onDocumentWritten("events/{id}", async (event) => {
  const after = event.data?.after?.data();
  if (!after?.companyId) return;
  await pushToCrm("event", after.companyId, event.params.id, after);
});

// Rewards & contests sync to the CRM in real time (and skip CRM-originated ones
// so the two dashboards stay in sync without looping).
export const onRewardSync = onDocumentWritten("companies/{cid}/rewards/{rid}", async (event) => {
  const after = event.data?.after?.data();
  if (!after) return; // deletion — leave the CRM copy to its own lifecycle
  await pushToCrm("reward", event.params.cid, event.params.rid, after);
});

// ── Solar Scanner pins (CRM → field app) ─────────────────────────────────────
// The CRM pushes its solar-scanner pins here (POST /crm/solar-pins) and the
// field map reads them back through getSolarPins. A plain pin marks a home the
// scanner mailed/texted/emailed; `hot` marks one where the homeowner engaged
// (scanned the postcard QR / clicked the SMS or email link) — the 🔥 hot lead.
// Visibility: admins, managers and super-admins see every pin; a rep sees only
// pins that fall inside a territory assigned to them.
function pinInPolygon(pt: { lat: number; lng: number }, poly: Array<{ lat: number; lng: number }>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].lng, yi = poly[i].lat, xj = poly[j].lng, yj = poly[j].lat;
    const hit = yi > pt.lat !== yj > pt.lat && pt.lng < ((xj - xi) * (pt.lat - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

export const getSolarPins = onCall(async (request) => {
  const caller = await getCaller(request);
  const companyId = ((request.data || {}) as { companyId?: string }).companyId || caller.companyId;
  if (!companyId) throw new HttpsError("invalid-argument", "companyId is required.");
  if (!caller.isSuper && caller.companyId !== companyId) {
    throw new HttpsError("permission-denied", "Not allowed to read this company.");
  }
  const snap = await db.collection("companies").doc(companyId).collection("solarPins").get();
  let pins = (snap.docs.map((d) => ({ id: d.id, ...d.data() })) as Array<Record<string, any>>)
    .filter((p) => typeof p.lat === "number" && typeof p.lng === "number");

  // Admins / managers / super-admins see every pin. A rep sees only the pins
  // inside a territory assigned to them (assignedTo === uid, or legacy
  // territoryIds membership for unassigned-but-listed areas).
  const seeAll = caller.isSuper || caller.role === "admin" || caller.role === "manager";
  if (!seeAll) {
    const [tSnap, uSnap] = await Promise.all([
      db.collection("territories").where("companyId", "==", companyId).get(),
      db.doc(`users/${caller.uid}`).get(),
    ]);
    const myIds: string[] = (uSnap.data()?.territoryIds as string[]) || [];
    const mine = (tSnap.docs.map((d) => ({ id: d.id, ...d.data() })) as Array<Record<string, any>>)
      .filter((t) => Array.isArray(t.polygon) && t.polygon.length >= 3)
      .filter((t) => (t.assignedTo ? t.assignedTo === caller.uid : myIds.includes(t.id)));
    pins = pins.filter((p) => mine.some((t) => pinInPolygon({ lat: p.lat, lng: p.lng }, t.polygon)));
  }
  return { pins };
});

// ── /crm/** router (provision · export · ingest) ─────────────────────────────
export const crmApi = onRequest({ cors: true }, async (req, res) => {
  const sent = req.get("x-crm-secret") || "";
  const path = req.path;
  try {
    // ── Provision a Knock company (the add-on toggle) ──
    if (req.method === "POST" && path.endsWith("/provision")) {
      // Bootstrap runs before the company exists → master key only.
      if (!(await crmAuth(sent))) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { name, crmCompanyId, adminEmail, adminName, plan, webhookUrl, appointmentWebhookUrl, apiSecret } =
        (req.body || {}) as Record<string, string>;
      if (!name || !adminEmail) { res.status(400).json({ error: "name and adminEmail required" }); return; }

      // Reuse an existing linked company if this CRM company was already provisioned.
      const existing = crmCompanyId
        ? await db.collection("companies").where("crmCompanyId", "==", crmCompanyId).limit(1).get()
        : null;
      let companyId: string;
      if (existing && !existing.empty) {
        companyId = existing.docs[0].id;
      } else {
        const ref = await db.collection("companies").add({
          name, plan: plan || "knock", status: "active", addons: ["knock"],
          crmCompanyId: crmCompanyId || null, crmEnabled: true, createdAt: Date.now(), createdBy: "crm",
        });
        companyId = ref.id;
        const roles = ref.collection("roles");
        await roles.add({ companyId, title: "Manager", baseTier: "manager", rank: 100, isDefault: true, createdAt: Date.now() });
        await roles.add({ companyId, title: "User", baseTier: "user", rank: 10, isDefault: true, createdAt: Date.now() });
        await ref.collection("teams").add({ companyId, name: "Company", parentTeamId: null, createdAt: Date.now() });
      }

      // Establish this company's own CRM link. Use the secret the CRM sent, or
      // mint one and hand it back so the CRM can store it for future calls.
      const companySecret = (apiSecret && apiSecret.trim()) ||
        "yk_" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      await db.doc(`crmLinks/${companyId}`).set({
        companyId, enabled: true, crmCompanyId: crmCompanyId || "",
        webhookUrl: (webhookUrl || "").trim(), appointmentWebhookUrl: (appointmentWebhookUrl || "").trim(),
        apiSecret: companySecret, updatedAt: Date.now(),
      }, { merge: true });

      // Create the company admin (or reuse), then a magic sign-in link.
      let uid: string;
      try {
        const u = await getAuth().getUserByEmail(adminEmail);
        uid = u.uid;
      } catch {
        const u = await getAuth().createUser({
          email: adminEmail, password: "Yk-" + Math.random().toString(36).slice(2, 10) + "A9!",
          displayName: adminName || adminEmail.split("@")[0],
        });
        uid = u.uid;
      }
      await getAuth().setCustomUserClaims(uid, { role: "admin", companyId });
      await db.doc(`users/${uid}`).set({
        uid, email: adminEmail, displayName: adminName || adminEmail.split("@")[0],
        role: "admin", companyId, managerPath: [], disabled: false, createdAt: Date.now(), createdBy: "crm",
      }, { merge: true });

      let inviteLink = "";
      try {
        inviteLink = await getAuth().generateSignInWithEmailLink(adminEmail, { url: `${APP_URL}/app/login?invite=1`, handleCodeInApp: true });
      } catch (e) { logger.warn("provision invite link failed", e); }

      res.json({ ok: true, companyId, adminEmail, apiSecret: companySecret, inviteLink, appUrl: `${APP_URL}/app` });
      return;
    }

    // ── Export a company's leads + appointments + users (CRM pull) ──
    if (req.method === "GET" && path.endsWith("/export")) {
      const companyId = req.query.companyId as string;
      if (!companyId) { res.status(400).json({ error: "companyId required" }); return; }
      if (!(await crmAuth(sent, companyId))) { res.status(401).json({ error: "Unauthorized" }); return; }
      const [company, usersSnap, leadsSnap, eventsSnap, rewardsSnap, statsSnap] = await Promise.all([
        db.doc(`companies/${companyId}`).get(),
        db.collection("users").where("companyId", "==", companyId).get(),
        db.collection("leads").where("companyId", "==", companyId).get(),
        db.collection("events").where("companyId", "==", companyId).get(),
        db.collection("companies").doc(companyId).collection("rewards").get(),
        db.collection("userStats").where("companyId", "==", companyId).get(),
      ]);
      // Leaderboard = company head-to-head ranking, sorted by closes then appts.
      const leaderboard = statsSnap.docs
        .map((d) => ({ uid: d.id, ...d.data() }) as Record<string, any>)
        .sort((a, b) => (b.sales || 0) - (a.sales || 0) || (b.appointments || 0) - (a.appointments || 0))
        .map((r, i) => ({ rank: i + 1, ...r }));
      res.json({
        company: company.exists ? { id: company.id, ...company.data() } : null,
        users: usersSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
        leads: leadsSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
        appointments: eventsSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
        rewards: rewardsSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
        leaderboard,
      });
      return;
    }

    // ── Ingest / upsert a lead OR reward/contest from the CRM (push into Knock) ──
    if (req.method === "POST" && path.endsWith("/ingest")) {
      const { companyId, lead, reward } = (req.body || {}) as { companyId?: string; lead?: any; reward?: any };
      if (!companyId || (!lead && !reward)) { res.status(400).json({ error: "companyId and lead or reward required" }); return; }
      if (!(await crmAuth(sent, companyId))) { res.status(401).json({ error: "Unauthorized" }); return; }

      // Reward / contest from the CRM → companies/{id}/rewards so reps see it in-app.
      if (reward) {
        const now = Date.now();
        const data: Record<string, unknown> = {
          companyId,
          name: reward.name || "Reward",
          description: reward.description || "",
          imageUrl: reward.imageUrl || "",
          kind: reward.kind === "store" ? "store" : "benchmark",
          audience: reward.audience === "team" ? "team" : "individual",
          metric: reward.kind === "store" ? "points" : (reward.metric || "sales"),
          period: reward.period || "monthly",
          target: Number(reward.target) || 1,
          active: reward.active !== false,
          startsAt: Number(reward.startsAt) || 0,
          expiresAt: Number(reward.expiresAt) || 0,
          crmRewardId: reward.crmRewardId || null,
          _syncedFrom: "crm", updatedAt: now,
        };
        const col = db.collection("companies").doc(companyId).collection("rewards");
        let existingR = null;
        if (reward.crmRewardId) {
          const q = await col.where("crmRewardId", "==", reward.crmRewardId).limit(1).get();
          if (!q.empty) existingR = q.docs[0];
        }
        let rid: string;
        if (existingR) { await existingR.ref.set(data, { merge: true }); rid = existingR.id; }
        else { const ref = await col.add({ ...data, createdAt: now, createdBy: "crm" }); rid = ref.id; }
        res.json({ ok: true, rewardId: rid });
        return;
      }
      // Default owner = a company admin, so the lead is visible in the app.
      const adminSnap = await db.collection("users").where("companyId", "==", companyId).where("role", "==", "admin").limit(1).get();
      const ownerUid = adminSnap.empty ? null : adminSnap.docs[0].id;
      const now = Date.now();
      const fields: any = {
        companyId, address: lead.address || "", city: lead.city || null, state: lead.state || null, zip: lead.zip || null,
        ownerName: lead.ownerName || lead.name || null, phone: lead.phone || null, email: lead.email || null,
        status: lead.status || "new", notes: lead.notes || null,
        lat: typeof lead.lat === "number" ? lead.lat : null, lng: typeof lead.lng === "number" ? lead.lng : null,
        crmLeadId: lead.crmLeadId || null, _syncedFrom: "crm",
        assignedTo: ownerUid, visibilityPath: ownerUid ? [ownerUid] : [], createdBy: ownerUid || "crm", updatedAt: now,
      };
      // Upsert by crmLeadId when provided.
      let existing = null;
      if (lead.crmLeadId) {
        const q = await db.collection("leads").where("companyId", "==", companyId).where("crmLeadId", "==", lead.crmLeadId).limit(1).get();
        if (!q.empty) existing = q.docs[0];
      }
      let id: string;
      if (existing) { await existing.ref.set(fields, { merge: true }); id = existing.id; }
      else { const ref = await db.collection("leads").add({ ...fields, createdAt: now }); id = ref.id; }
      res.json({ ok: true, leadId: id });
      return;
    }

    // ── Upsert solar-scanner pins from the CRM (push into the field map) ──
    if (req.method === "POST" && path.endsWith("/solar-pins")) {
      const { companyId, pins } = (req.body || {}) as { companyId?: string; pins?: any[] };
      if (!companyId || !Array.isArray(pins)) { res.status(400).json({ error: "companyId and pins[] required" }); return; }
      if (!(await crmAuth(sent, companyId))) { res.status(401).json({ error: "Unauthorized" }); return; }
      const col = db.collection("companies").doc(companyId).collection("solarPins");
      const now = Date.now();
      let upserted = 0;
      // Firestore caps a batch at 500 writes — chunk to stay well under it.
      for (let i = 0; i < pins.length; i += 400) {
        const batch = db.batch();
        for (const p of pins.slice(i, i + 400)) {
          if (typeof p?.lat !== "number" || typeof p?.lng !== "number") continue;
          const id = String(p.id || `${p.scanId}_${p.resultIdx}`).replace(/[^\w-]/g, "_");
          batch.set(col.doc(id), {
            companyId,
            scanId: p.scanId ?? null,
            resultIdx: typeof p.resultIdx === "number" ? p.resultIdx : null,
            lat: p.lat, lng: p.lng,
            address: p.address || "",
            ownerName: p.ownerName || "",
            // Outreach sent — powers the "Mailed/Texted/Emailed on <date>" popup.
            mailedAt: p.mailedAt ?? null,
            smsAt: p.smsAt ?? null,
            emailAt: p.emailAt ?? null,
            hot: !!p.hotLead,
            hotSource: p.hotLeadSource || "",
            hotAt: p.hotLeadAt ?? null,
            crmContactId: p.contactId ?? null,
            _syncedFrom: "crm", updatedAt: now,
          }, { merge: true });
          upserted++;
        }
        await batch.commit();
      }
      res.json({ ok: true, upserted });
      return;
    }

    res.status(404).json({ error: "Unknown CRM endpoint" });
  } catch (e: any) {
    logger.error("crmApi error", e);
    res.status(500).json({ error: e?.message || "internal" });
  }
});
