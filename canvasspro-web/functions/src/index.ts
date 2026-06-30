import { onRequest, onCall, HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { onDocumentCreated, onDocumentWritten } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import Stripe from "stripe";
import * as crypto from "crypto";
import PDFDocument from "pdfkit";
import * as nodemailer from "nodemailer";
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";
import { tmpdir } from "os";
import { join } from "path";
import { writeFile, readFile, unlink } from "fs/promises";

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

// NREL (api.data.gov) — identifies the electric utility serving a lat/lng. Free
// key; DEMO_KEY works for light testing but is rate-limited.
const NREL = { key: process.env.NREL_API_KEY || "DEMO_KEY" };

// Google Maps — Street View + satellite imagery of the customer's actual home
// for the proposal hero (Static Maps, Street View, Geocoding APIs). Defaults to
// the platform's existing youtilityknock project key (the same public web key
// shipped in the app) so home imagery works for everyone out of the box; a
// super-admin can still override it with a dedicated key in config/api. NOTE:
// the Maps Static, Street View Static, and Geocoding APIs must be enabled on the
// project for this key, and the key must not be API-restricted to exclude them.
const GMAPS = { key: process.env.GOOGLE_MAPS_KEY || "AIzaSyAAfrLWkY_WS7yabCgW_WZJu973J5iGcBI" };

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
    if (typeof c.nrelKey === "string" && c.nrelKey) NREL.key = c.nrelKey;
    if (typeof c.googleMapsKey === "string" && c.googleMapsKey) GMAPS.key = c.googleMapsKey;
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

// ── Positions ────────────────────────────────────────────────────────────────
// A single structural Position per user drives the access tier, the setter /
// closer org-chart participation, and downline visibility. Managers derive the
// "manager" tier; setter/closer derive "user". Custom role titles still ride on
// top for display; this is the structural source of truth.
type Position = "admin" | "team_manager" | "closer_manager" | "setter_manager" | "closer" | "setter";
const POSITIONS: Position[] = ["admin", "team_manager", "closer_manager", "setter_manager", "closer", "setter"];
function isPosition(p: unknown): p is Position { return typeof p === "string" && (POSITIONS as string[]).includes(p); }
function tierForPosition(p: Position): Tier {
  if (p === "admin") return "admin";
  if (p === "team_manager" || p === "closer_manager" || p === "setter_manager") return "manager";
  return "user";
}
// Which org chart(s) the position participates in (gates assignability + chains).
function fnForPosition(p: Position): { isSetter: boolean; isCloser: boolean } {
  switch (p) {
    case "setter": return { isSetter: true, isCloser: false };
    case "closer": return { isSetter: false, isCloser: true };
    case "setter_manager": return { isSetter: true, isCloser: false };
    case "closer_manager": return { isSetter: false, isCloser: true };
    case "team_manager": return { isSetter: true, isCloser: true };
    case "admin": return { isSetter: false, isCloser: false };
  }
}

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

// An enterprise/org admin is the admin of any company that belongs to the org.
// Used for org-level self-service billing (view invoices/contract, change card).
async function authorizeForOrg(caller: Caller, orgId: string | undefined): Promise<string> {
  if (!orgId) throw new HttpsError("invalid-argument", "orgId is required.");
  if (caller.isSuper) return orgId;
  if (caller.role === "admin" && caller.companyId) {
    const company = (await db.doc(`companies/${caller.companyId}`).get()).data();
    if (company && company.organizationId === orgId) return orgId;
  }
  throw new HttpsError("permission-denied", "Not allowed to manage this organization.");
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

// The closer org chart is a SEPARATE chain from the setter one — walk it via
// closerManagerId / closerManagerPath so closer managers see closer production.
async function computeCloserManagerPath(closerManagerId: string | null | undefined): Promise<string[]> {
  if (!closerManagerId) return [];
  const snap = await db.doc(`users/${closerManagerId}`).get();
  if (!snap.exists) return [];
  const m = snap.data()!;
  return [closerManagerId, ...((m.closerManagerPath as string[]) || [])];
}

// Recompute managerPath for every user in a company and visibilityPath for
// every lead, from the current managerId links. Run after any reorg.
async function rebuildCompanyHierarchy(companyId: string) {
  const usersSnap = await db.collection("users").where("companyId", "==", companyId).get();
  const managerOf: Record<string, string | null> = {};
  const closerManagerOf: Record<string, string | null> = {};
  usersSnap.forEach((d) => {
    managerOf[d.id] = (d.data().managerId as string) ?? null;
    closerManagerOf[d.id] = (d.data().closerManagerId as string) ?? null;
  });

  // Walk up a chain for each user (cycle-guarded). One walker per org chart.
  const makeWalker = (parentOf: Record<string, string | null>) => {
    const cache: Record<string, string[]> = {};
    const walk = (uid: string, seen: Set<string> = new Set()): string[] => {
      if (cache[uid]) return cache[uid];
      const mgr = parentOf[uid];
      if (!mgr || seen.has(mgr)) return (cache[uid] = []);
      seen.add(mgr);
      return (cache[uid] = [mgr, ...walk(mgr, seen)]);
    };
    return walk;
  };
  const pathFor = makeWalker(managerOf); // setter chain
  const closerPathFor = makeWalker(closerManagerOf); // closer chain

  // Team managers see EVERYONE on the teams they manage (across both chains).
  // Map team → its managers, and each user → their team, then fold the team's
  // managers (and the managers' own up-chains) into every member's paths so the
  // existing visibilityPath rules automatically include team managers.
  const teamMgrsByTeam: Record<string, string[]> = {};
  const teamIdOf: Record<string, string | null> = {};
  usersSnap.forEach((d) => {
    teamIdOf[d.id] = (d.data().teamId as string) ?? null;
    const mt = d.data().managedTeamIds;
    if (Array.isArray(mt)) mt.forEach((t: string) => { (teamMgrsByTeam[t] ||= []).push(d.id); });
  });
  const teamMgrChain = (uid: string): string[] => {
    const t = teamIdOf[uid];
    if (!t || !teamMgrsByTeam[t]) return [];
    const out: string[] = [];
    for (const m of teamMgrsByTeam[t]) if (m !== uid) out.push(m, ...pathFor(m), ...closerPathFor(m));
    return out;
  };
  const fullPathFor = (uid: string) => Array.from(new Set([...pathFor(uid), ...teamMgrChain(uid)]));
  const fullCloserPathFor = (uid: string) => Array.from(new Set([...closerPathFor(uid), ...teamMgrChain(uid)]));

  let batch = db.batch();
  let ops = 0;
  const flush = async () => { if (ops) { await batch.commit(); batch = db.batch(); ops = 0; } };

  for (const d of usersSnap.docs) {
    batch.update(d.ref, { managerPath: fullPathFor(d.id), closerManagerPath: fullCloserPathFor(d.id) });
    if (++ops >= 450) await flush();
  }
  await flush();

  const leadsSnap = await db.collection("leads").where("companyId", "==", companyId).get();
  for (const d of leadsSnap.docs) {
    const owner = (d.data().assignedTo as string) || d.data().createdBy;
    batch.update(d.ref, { visibilityPath: [owner, ...fullPathFor(owner)] });
    if (++ops >= 450) await flush();
  }
  await flush();

  // Appointments are visible up BOTH chains: the closer's closer-managers and
  // the setter's setter-managers.
  const apptSnap = await db.collection("events").where("companyId", "==", companyId).where("closerUid", "!=", null).get().catch(() => null);
  if (apptSnap) {
    for (const d of apptSnap.docs) {
      const e = d.data();
      const closerUid = e.closerUid as string;
      const setterUid = (e.setterUid as string) || "";
      const vis = Array.from(new Set([
        closerUid, ...fullCloserPathFor(closerUid),
        ...(setterUid ? [setterUid, ...fullPathFor(setterUid)] : []),
      ]));
      batch.update(d.ref, { visibilityPath: vis });
      if (++ops >= 450) await flush();
    }
    await flush();
  }

  // Keep per-user stats roll-up reachable by the right managers.
  const statsSnap = await db.collection("userStats").where("companyId", "==", companyId).get();
  for (const d of statsSnap.docs) {
    batch.update(d.ref, { managerPath: fullPathFor(d.id), closerManagerPath: fullCloserPathFor(d.id) });
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
  const { companyId, name, email, password, tier, roleId, title, teamId, managerId, isSetter, isCloser, closerManagerId,
    position, managedTeamIds, canReassignAppointments } =
    request.data as {
      companyId?: string; name?: string; email?: string; password?: string;
      tier?: Tier; roleId?: string; title?: string; teamId?: string; managerId?: string;
      isSetter?: boolean; isCloser?: boolean; closerManagerId?: string | null;
      position?: Position; managedTeamIds?: string[]; canReassignAppointments?: boolean;
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
  // Position (structural) takes precedence: it drives the tier + setter/closer fn.
  let effSetter = isSetter === undefined ? true : !!isSetter;
  let effCloser = !!isCloser;
  const pos: Position | null = isPosition(position) ? position : null;
  if (pos) {
    baseTier = tierForPosition(pos);
    const fn = fnForPosition(pos);
    effSetter = fn.isSetter; effCloser = fn.isCloser;
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
  const closerManagerPath = await computeCloserManagerPath(closerManagerId);
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
    // Structural position + function flags + the closer org chart.
    position: pos || null,
    isSetter: effSetter,
    isCloser: effCloser,
    closerManagerId: closerManagerId || null,
    closerManagerPath,
    // A team manager can manage several teams (sees everyone in all of them).
    managedTeamIds: Array.isArray(managedTeamIds) ? managedTeamIds : [],
    canReassignAppointments: !!canReassignAppointments,
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

// ── Provider / legal identity (used on contracts + invoices) ─────────────────
// YoutilityKnock is the product; Sun Service is the legal entity behind it.
const PROVIDER_LEGAL_NAME = "Sun Service";
const PRODUCT_NAME = "YoutilityKnock";
const PRIVACY_URL = "https://youtilityknock.web.app/privacy";
const GOVERNING_LAW_STATE = "Utah";

export const inviteUser = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, name, email, tier, roleId, title, teamId, managerId, isSetter, isCloser, closerManagerId,
    position, managedTeamIds, canReassignAppointments } =
    request.data as {
      companyId?: string; name?: string; email?: string;
      tier?: Tier; roleId?: string; title?: string; teamId?: string; managerId?: string;
      isSetter?: boolean; isCloser?: boolean; closerManagerId?: string | null;
      position?: Position; managedTeamIds?: string[]; canReassignAppointments?: boolean;
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
  let effSetter = isSetter === undefined ? true : !!isSetter;
  let effCloser = !!isCloser;
  const pos: Position | null = isPosition(position) ? position : null;
  if (pos) {
    baseTier = tierForPosition(pos);
    const fn = fnForPosition(pos);
    effSetter = fn.isSetter; effCloser = fn.isCloser;
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
  const closerManagerPath = await computeCloserManagerPath(closerManagerId);
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
    position: pos || null,
    isSetter: effSetter,
    isCloser: effCloser,
    closerManagerId: closerManagerId || null,
    closerManagerPath,
    managedTeamIds: Array.isArray(managedTeamIds) ? managedTeamIds : [],
    canReassignAppointments: !!canReassignAppointments,
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
  const { companyId, name, parentTeamId, leadUserId, servicePermissions } = request.data as
    { companyId?: string; name?: string; parentTeamId?: string | null; leadUserId?: string; servicePermissions?: string[] };
  const company = authorizeForCompany(caller, companyId);
  if (!name?.trim()) throw new HttpsError("invalid-argument", "Team name required.");
  const ref = await db.collection(`companies/${company}/teams`).add({
    companyId: company, name: name.trim(),
    parentTeamId: parentTeamId || null, leadUserId: leadUserId || null,
    // Locked-baseline services granted to everyone on the team.
    servicePermissions: Array.isArray(servicePermissions) ? servicePermissions : [],
    createdAt: Date.now(),
  });
  return { ok: true, teamId: ref.id };
});

export const updateTeam = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, teamId, name, parentTeamId, leadUserId, servicePermissions } = request.data as
    { companyId?: string; teamId?: string; name?: string; parentTeamId?: string | null; leadUserId?: string; servicePermissions?: string[] };
  const company = authorizeForCompany(caller, companyId);
  if (!teamId) throw new HttpsError("invalid-argument", "teamId required.");
  const patch: Record<string, unknown> = {};
  if (name?.trim()) patch.name = name.trim();
  if (parentTeamId !== undefined) patch.parentTeamId = parentTeamId || null;
  if (leadUserId !== undefined) patch.leadUserId = leadUserId || null;
  if (servicePermissions !== undefined) patch.servicePermissions = Array.isArray(servicePermissions) ? servicePermissions : [];
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
  const { uid, roleId, teamId, managerId, closerManagerId, isSetter, isCloser,
    position, managedTeamIds, canReassignAppointments } = request.data as
    { uid?: string; roleId?: string; teamId?: string | null; managerId?: string | null;
      closerManagerId?: string | null; isSetter?: boolean; isCloser?: boolean;
      position?: Position; managedTeamIds?: string[]; canReassignAppointments?: boolean };
  if (!uid) throw new HttpsError("invalid-argument", "uid required.");
  const target = await authorizeForTargetUser(caller, uid);
  const company = target.companyId as string;

  if (managerId === uid) throw new HttpsError("invalid-argument", "A user can't report to themselves.");
  if (closerManagerId === uid) throw new HttpsError("invalid-argument", "A user can't report to themselves.");

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
  // Position drives the tier + setter/closer function (overrides any role tier).
  if (isPosition(position)) {
    const t = tierForPosition(position);
    const fn = fnForPosition(position);
    patch.position = position;
    patch.role = t;
    patch.isSetter = fn.isSetter;
    patch.isCloser = fn.isCloser;
    await getAuth().setCustomUserClaims(uid, {
      ...(await getAuth().getUser(uid)).customClaims,
      role: t,
    });
  }
  if (teamId !== undefined) patch.teamId = teamId || null;
  if (managerId !== undefined) patch.managerId = managerId || null;
  if (closerManagerId !== undefined) patch.closerManagerId = closerManagerId || null;
  // Explicit isSetter/isCloser only honored when no position was supplied.
  if (!isPosition(position) && isSetter !== undefined) patch.isSetter = !!isSetter;
  if (!isPosition(position) && isCloser !== undefined) patch.isCloser = !!isCloser;
  if (managedTeamIds !== undefined) patch.managedTeamIds = Array.isArray(managedTeamIds) ? managedTeamIds : [];
  if (canReassignAppointments !== undefined) patch.canReassignAppointments = !!canReassignAppointments;

  await db.doc(`users/${uid}`).set(patch, { merge: true });
  await rebuildCompanyHierarchy(company);
  logger.info(`Hierarchy updated for ${uid} in ${company} by ${caller.uid}`);
  return { ok: true };
});

// Set the per-position service permissions for a company ("services by role").
// Stored as companies/{id}.positionServices = { setter: [...], closer: [...], ... }.
export const setPositionServices = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, positionServices } = (request.data || {}) as
    { companyId?: string; positionServices?: Record<string, string[]> };
  const company = authorizeForCompany(caller, companyId);
  if (!positionServices || typeof positionServices !== "object") {
    throw new HttpsError("invalid-argument", "positionServices required.");
  }
  const clean: Record<string, string[]> = {};
  for (const p of POSITIONS) {
    const v = (positionServices as Record<string, unknown>)[p];
    if (Array.isArray(v)) clean[p] = v.filter((x) => typeof x === "string") as string[];
  }
  await db.doc(`companies/${company}`).set({ positionServices: clean, updatedAt: Date.now() }, { merge: true });
  return { ok: true };
});

// Reassign an appointment to a different closer. Allowed for a super-admin, a
// company admin, or a closer-manager who has the reassign permission AND already
// sees the appointment (it's in their downline). Refreshes the company's
// visibility paths so the new closer + their chain can see it.
export const reassignAppointment = onCall(async (request) => {
  const caller = await getCaller(request);
  const { eventId, closerUid } = (request.data || {}) as { eventId?: string; closerUid?: string };
  if (!eventId || !closerUid) throw new HttpsError("invalid-argument", "eventId and closerUid required.");
  const evRef = db.doc(`events/${eventId}`);
  const ev = (await evRef.get()).data();
  if (!ev) throw new HttpsError("not-found", "Appointment not found.");
  const company = ev.companyId as string;

  let allowed = caller.isSuper || (caller.role === "admin" && caller.companyId === company);
  if (!allowed) {
    const me = (await db.doc(`users/${caller.uid}`).get()).data() || {};
    const inDownline = Array.isArray(ev.visibilityPath) && (ev.visibilityPath as string[]).includes(caller.uid);
    allowed = !!me.canReassignAppointments && me.companyId === company && inDownline;
  }
  if (!allowed) throw new HttpsError("permission-denied", "Not allowed to reassign this appointment.");

  const newCloser = (await db.doc(`users/${closerUid}`).get()).data();
  if (!newCloser || newCloser.companyId !== company || !newCloser.isCloser) {
    throw new HttpsError("invalid-argument", "Pick a closer in this company.");
  }
  await evRef.set({ closerUid, updatedAt: Date.now() }, { merge: true });
  await rebuildCompanyHierarchy(company); // recompute appointment visibilityPath
  logger.info(`Appointment ${eventId} reassigned to ${closerUid} by ${caller.uid}`);
  return { ok: true };
});

// Set a user's function (setter / closer / both). Keeps isSetter + isCloser in
// sync; rebuilds the org charts so both chains stay consistent.
export const setUserFunction = onCall(async (request) => {
  const caller = await getCaller(request);
  const { uid, isSetter, isCloser } = (request.data || {}) as { uid?: string; isSetter?: boolean; isCloser?: boolean };
  if (!uid) throw new HttpsError("invalid-argument", "uid required.");
  const snap = await db.doc(`users/${uid}`).get();
  if (!snap.exists) throw new HttpsError("not-found", "User not found.");
  authorizeForCompany(caller, (snap.data() as any).companyId);
  await db.doc(`users/${uid}`).set({ isSetter: !!isSetter, isCloser: !!isCloser }, { merge: true });
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
  // SMTP (the platform's own-mailbox email — preferred over SendGrid).
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
  smtpFromName: string;
  sendgridKey: string;
  sendgridFrom: string;
  sendgridFromName: string;
  twilioSid: string;
  twilioToken: string;
  twilioFrom: string;
}

// Read provider config: Firestore (set via super-admin console) overrides env.
async function getNotifyConfig(): Promise<NotifyConfig> {
  let c: Record<string, any> = {};
  try {
    const snap = await db.doc("config/notifications").get();
    if (snap.exists) c = (snap.data() as Record<string, any>) || {};
  } catch (e) {
    logger.warn("getNotifyConfig read failed", e);
  }
  return {
    smtpHost: c.smtpHost || process.env.SMTP_HOST || "",
    smtpPort: Number(c.smtpPort) || 587,
    smtpSecure: c.smtpSecure === true,
    smtpUser: c.smtpUser || process.env.SMTP_USER || "",
    smtpPass: c.smtpPass || process.env.SMTP_PASS || "",
    smtpFrom: c.smtpFrom || "",
    smtpFromName: c.smtpFromName || "YoutilityKnock",
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

interface EmailAttachment { filename: string; content: string; type: string } // content = base64
// Send an email and return why it failed (so the console can show the real
// SendGrid error instead of a generic "couldn't send").
async function sendEmailDetailed(
  cfg: NotifyConfig, to: string, subject: string, text: string, attachments?: EmailAttachment[], html?: string
): Promise<{ ok: boolean; detail: string }> {
  if (!to) return { ok: false, detail: "No recipient email." };

  // Preferred: send through the platform's own mailbox over SMTP (no SendGrid).
  if (cfg.smtpHost && cfg.smtpUser && cfg.smtpPass && cfg.smtpFrom) {
    try {
      const transporter = nodemailer.createTransport({
        host: cfg.smtpHost,
        port: cfg.smtpPort || 587,
        secure: cfg.smtpSecure, // true = 465 (implicit TLS); false = 587 (STARTTLS)
        auth: { user: cfg.smtpUser, pass: cfg.smtpPass },
      });
      await transporter.sendMail({
        from: cfg.smtpFromName ? `"${cfg.smtpFromName}" <${cfg.smtpFrom}>` : cfg.smtpFrom,
        to, subject, text, ...(html ? { html } : {}),
        attachments: attachments?.map((a) => ({
          filename: a.filename, content: Buffer.from(a.content, "base64"), contentType: a.type,
        })),
      });
      return { ok: true, detail: "" };
    } catch (e: any) {
      logger.warn("SMTP send failed", e);
      return { ok: false, detail: (e?.message || "SMTP send failed.") + " — check the SMTP host/port, username, and app password under Notifications." };
    }
  }

  if (!cfg.sendgridKey || !cfg.sendgridFrom) {
    return { ok: false, detail: "Email isn't configured — add your SMTP mailbox (or SendGrid) under Notifications." };
  }
  try {
    const body: Record<string, unknown> = {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: cfg.sendgridFrom, name: cfg.sendgridFromName },
      subject,
      // SendGrid requires text/plain before text/html when both are present.
      content: html
        ? [{ type: "text/plain", value: text }, { type: "text/html", value: html }]
        : [{ type: "text/plain", value: text }],
    };
    if (attachments && attachments.length) {
      body.attachments = attachments.map((a) => ({
        content: a.content, filename: a.filename, type: a.type, disposition: "attachment",
      }));
    }
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.sendgridKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return { ok: true, detail: "" };
    const txt = await res.text().catch(() => "");
    logger.warn(`SendGrid ${res.status}: ${txt}`);
    let detail = `SendGrid error ${res.status}`;
    try { const j = JSON.parse(txt); if (j?.errors?.[0]?.message) detail = j.errors[0].message; } catch { /* keep generic */ }
    if (res.status === 401 || res.status === 403) {
      detail += " — check the API key, and that the From address is a verified sender in SendGrid.";
    }
    return { ok: false, detail };
  } catch (e: any) {
    logger.error("sendEmail failed", e);
    return { ok: false, detail: e?.message || "Email send failed." };
  }
}
async function sendEmail(
  cfg: NotifyConfig, to: string, subject: string, text: string, attachments?: EmailAttachment[]
): Promise<boolean> {
  return (await sendEmailDetailed(cfg, to, subject, text, attachments)).ok;
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
  const c = (snap.exists ? (snap.data() as Record<string, any>) : {}) || {};
  return {
    smtp: {
      configured: !!c.smtpHost && !!c.smtpUser && !!c.smtpPass && !!c.smtpFrom,
      host: c.smtpHost || "",
      port: Number(c.smtpPort) || 587,
      secure: c.smtpSecure === true,
      user: c.smtpUser || "",
      passMask: mask(c.smtpPass),
      from: c.smtpFrom || "",
      fromName: c.smtpFromName || "",
    },
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
  const d = (request.data || {}) as Record<string, any>;
  const update: Record<string, unknown> = { updatedAt: Date.now(), updatedBy: caller.uid };
  // SMTP (own-mailbox email). The password is a secret (blank = keep existing);
  // don't trim it — passwords/app-passwords can contain spaces.
  if (typeof d.smtpHost === "string") update.smtpHost = d.smtpHost.trim();
  if (d.smtpPort !== undefined && d.smtpPort !== "") update.smtpPort = Number(d.smtpPort) || 587;
  if (typeof d.smtpSecure === "boolean") update.smtpSecure = d.smtpSecure;
  if (typeof d.smtpUser === "string") update.smtpUser = d.smtpUser.trim();
  if (typeof d.smtpPass === "string" && d.smtpPass) update.smtpPass = d.smtpPass;
  if (typeof d.smtpFrom === "string") update.smtpFrom = d.smtpFrom.trim();
  if (typeof d.smtpFromName === "string") update.smtpFromName = d.smtpFromName.trim();
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
  if (provider === "smtp") {
    await ref.set({ smtpHost: "", smtpPort: "", smtpSecure: false, smtpUser: "", smtpPass: "", smtpFrom: "", smtpFromName: "" }, { merge: true });
  } else if (provider === "sendgrid") {
    await ref.set({ sendgridKey: "", sendgridFrom: "", sendgridFromName: "" }, { merge: true });
  } else if (provider === "twilio") {
    await ref.set({ twilioSid: "", twilioToken: "", twilioFrom: "" }, { merge: true });
  } else {
    throw new HttpsError("invalid-argument", "provider must be 'smtp', 'sendgrid' or 'twilio'.");
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
  closersEnabled: false,
  closerAssignment: "round_robin" as const,
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
    closersEnabled: !!scheduling.closersEnabled,
    closerAssignment: ["round_robin", "close_rate", "setter_select"].includes(String(scheduling.closerAssignment))
      ? String(scheduling.closerAssignment)
      : "round_robin",
  };
  await db.doc(`companies/${companyId}`).set({ scheduling: s }, { merge: true });
  return { ok: true, scheduling: s };
});

// Per-territory rollup: homes (total addressable homes inside the polygon, via
// ATTOM), completion (% worked) and success (% sold). Computed server-side so it
// isn't blocked by the per-lead read rules a blanket company query would trip
// for non-admins.
// ── Territory completion model ───────────────────────────────────────────────
// A home only counts toward completion by how thoroughly it was worked:
//   • appointment / sold / dnc → fully complete (1.0)
//   • not interested → half a door (0.5)
//   • not home → needs 3 knocks to be complete (knockCount/3, capped at 1.0)
//   • go back / pipeline / new → not complete until it becomes an appointment (0)
// Then the credit is scaled by whether the rep is PITCH-CERTIFIED: an
// uncertified rep's doors only count as a partial knock until they pass the AI
// pitch certification — so training is what unlocks full-credit canvassing.
const NOT_HOME_KNOCKS_FOR_COMPLETE = 3;
const UNCERTIFIED_DOOR_FACTOR = 0.5; // knocks by a not-yet-certified rep count half
const TERRITORY_COMPLETE_PCT = 80; // an area is "complete" at ≥80% credited
function leadDoorCredit(status: string, knockCount: number): number {
  switch (status) {
    case "appointment": case "sold": case "dnc": return 1;
    case "not_interested": return 0.5;
    case "not_home": case "not_home_2":
      return Math.min(Math.max(knockCount, 1), NOT_HOME_KNOCKS_FOR_COMPLETE) / NOT_HOME_KNOCKS_FOR_COMPLETE;
    default: return 0; // go_back, pipeline, new — incomplete until worked further
  }
}

type LatLng = { lat: number; lng: number };

// Coordinates can arrive as numbers OR numeric strings (Firestore round-trips,
// imported territories), so normalize every polygon to real numbers once —
// matching the Map's defensive Number() coercion — and drop any bad vertex.
// This guards arithmetic (string + number = concatenation) and `.toFixed`.
function normalizePoly(raw: unknown): LatLng[] {
  if (!Array.isArray(raw)) return [];
  const out: LatLng[] = [];
  for (const p of raw as Array<{ lat?: unknown; lng?: unknown }>) {
    const lat = Number(p?.lat);
    const lng = Number(p?.lng);
    if (isFinite(lat) && isFinite(lng)) out.push({ lat, lng });
  }
  return out;
}

// Centroid + a covering radius (miles) that encloses every polygon vertex, so a
// single ATTOM radius query around the centroid sweeps the whole territory.
function polyCentroidRadiusMi(poly: LatLng[]): { lat: number; lng: number; radiusMi: number } {
  const lat = poly.reduce((s, p) => s + p.lat, 0) / poly.length;
  const lng = poly.reduce((s, p) => s + p.lng, 0) / poly.length;
  const milesPerDegLat = 69.0;
  const milesPerDegLng = 69.0 * Math.cos((lat * Math.PI) / 180);
  let maxMi = 0;
  for (const p of poly) {
    const dy = (p.lat - lat) * milesPerDegLat;
    const dx = (p.lng - lng) * milesPerDegLng;
    maxMi = Math.max(maxMi, Math.hypot(dx, dy));
  }
  // Small buffer for rooftop-vs-parcel jitter; ATTOM caps radius, so clamp.
  return { lat, lng, radiusMi: Math.min(Math.max(maxMi + 0.05, 0.1), 5) };
}

// Total homes whose rooftop falls inside the polygon. Queries ATTOM's property
// snapshot around the covering circle, then filters to the exact polygon. Bounded
// by a shared page budget so one call can't run away on dense urban territories.
async function countHomesInPolygon(poly: LatLng[], budget: { pages: number }): Promise<number | null> {
  if (!ATTOM.key) return null;
  const { lat, lng, radiusMi } = polyCentroidRadiusMi(poly);
  const PAGE_SIZE = 200;
  const PER_TERR_MAX_PAGES = 12;
  let count = 0;
  let total = Infinity;
  for (let page = 1; page <= PER_TERR_MAX_PAGES && (page - 1) * PAGE_SIZE < total; page++) {
    if (budget.pages <= 0) return null; // out of budget → treat as unknown, retry next call
    budget.pages--;
    let json: any;
    try {
      const r = await attomGet("/property/snapshot", { latitude: lat, longitude: lng, radius: radiusMi, pagesize: PAGE_SIZE, page });
      if (!r.ok) return page === 1 ? null : count; // first-page failure = unknown
      json = r.json;
    } catch { return page === 1 ? null : count; }
    const list: any[] = Array.isArray(json?.property) ? json.property : [];
    total = Number(json?.status?.total ?? list.length);
    for (const p of list) {
      const loc = p.location || {};
      const a = p.address || {};
      const plat = Number(loc.latitude ?? a.latitude);
      const plng = Number(loc.longitude ?? a.longitude);
      if (!isFinite(plat) || !isFinite(plng)) continue;
      if (pinInPolygon({ lat: plat, lng: plng }, poly)) count++;
    }
    if (list.length < PAGE_SIZE) break;
  }
  return count;
}

// Cheap stable hash of a polygon so we only re-bill ATTOM when the shape changes.
function polyHash(poly: LatLng[]): string {
  return poly.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join("|");
}

export const getTerritoryStats = onCall({ timeoutSeconds: 180 }, async (request) => {
  const caller = await getCaller(request);
  const cid = (request.data || {}).companyId || caller.companyId;
  if (!cid) throw new HttpsError("invalid-argument", "companyId required.");
  if (!caller.isSuper && cid !== caller.companyId) throw new HttpsError("permission-denied", "Wrong company.");
  await refreshApiConfig(); // pick up super-admin ATTOM key override
  // Leads are never stamped with a territoryId, so bucket each lead into a
  // territory geometrically: test its lat/lng against every territory polygon.
  const [leadSnap, terrSnap, userSnap] = await Promise.all([
    db.collection("leads").where("companyId", "==", cid).get(),
    db.collection("territories").where("companyId", "==", cid).get(),
    db.collection("users").where("companyId", "==", cid).get(),
  ]);
  // Which reps have passed AI pitch certification → their doors count full credit.
  const certified: Record<string, boolean> = {};
  userSnap.forEach((d) => { certified[d.id] = (d.data() as any).pitchCertified === true; });
  const terrs = terrSnap.docs
    .map((d) => ({ id: d.id, ref: d.ref, data: d.data() as any, polygon: normalizePoly((d.data() as any).polygon) }))
    .filter((t) => t.polygon.length >= 3);
  // Bucket dispositioned leads by polygon and accumulate weighted door credit.
  // Coerce lead coords with Number() (they may be strings) so none are skipped.
  const agg: Record<string, { credit: number; sold: number; doors: number }> = {};
  leadSnap.forEach((d) => {
    const l = d.data() as any;
    const lat = Number(l.lat);
    const lng = Number(l.lng);
    if (!isFinite(lat) || !isFinite(lng)) return;
    const t = terrs.find((tt) => pinInPolygon({ lat, lng }, tt.polygon));
    if (!t) return;
    const a = (agg[t.id] ??= { credit: 0, sold: 0, doors: 0 });
    a.doors++;
    let credit = leadDoorCredit(l.status, Number(l.knockCount) || 1);
    // Until the rep is certified, their knocks only count as a partial door.
    if (credit > 0 && l.assignedTo && certified[l.assignedTo] !== true) credit *= UNCERTIFIED_DOOR_FACTOR;
    a.credit += credit;
    if (l.status === "sold") a.sold++;
  });
  // homes = total addressable homes in the polygon (ATTOM), cached on the
  // territory doc and only recomputed when the polygon shape changes. Each
  // territory is isolated so an ATTOM hiccup can never zero out the whole map.
  const budget = { pages: 40 }; // shared ATTOM page budget for this whole call
  const stats: Record<string, { homes: number; completion: number; success: number; complete: boolean; doors: number }> = {};
  for (const t of terrs) {
    const a = agg[t.id] || { credit: 0, sold: 0, doors: 0 };
    let homes: number | null = null;
    try {
      const hash = polyHash(t.polygon);
      if (typeof t.data.homesTotal === "number" && t.data.homesPolyHash === hash) {
        homes = t.data.homesTotal; // fresh cache for this exact shape
      } else {
        homes = await countHomesInPolygon(t.polygon, budget);
        if (homes != null) {
          try { await t.ref.set({ homesTotal: homes, homesPolyHash: hash, homesTotalAt: Date.now() }, { merge: true }); } catch { /* non-fatal */ }
        }
      }
    } catch (e) {
      logger.warn("territory homes count failed", { territory: t.id, err: String(e) });
    }
    // Completion = weighted door credit ÷ total homes. Fall back to the count of
    // dispositioned doors when ATTOM is unavailable/over budget.
    const denom = homes != null && homes > 0 ? homes : a.doors;
    const completion = denom ? Math.min(100, Math.round((a.credit / denom) * 100)) : 0;
    stats[t.id] = {
      homes: homes != null ? homes : a.doors,
      completion,
      success: denom ? Math.round((a.sold / denom) * 100) : 0,
      complete: completion >= TERRITORY_COMPLETE_PCT,
      doors: a.doors,
    };
  }
  return { stats };
});

// Company-level options (currently: how many territories one rep may hold).
export const setCompanyOptions = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, maxTerritoriesPerUser } = (request.data || {}) as { companyId?: string; maxTerritoriesPerUser?: number };
  authorizeForCompany(caller, companyId);
  const patch: Record<string, unknown> = { updatedAt: Date.now() };
  if (maxTerritoriesPerUser !== undefined) {
    patch.maxTerritoriesPerUser = Math.max(0, Math.floor(Number(maxTerritoriesPerUser) || 0));
  }
  await db.doc(`companies/${companyId}`).set(patch, { merge: true });
  return { ok: true };
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
    { calendar: { google: { connected: true, email, connectedAt: Date.now(), needsReauth: false, lastSyncError: "" } } },
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
    { calendar: { microsoft: { connected: true, email, connectedAt: Date.now(), needsReauth: false, lastSyncError: "" } } },
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

// Record the outcome of a calendar push on the user's connection summary, so a
// dead token or a rejected event surfaces in the app instead of failing
// silently. needsReauth=true means the stored refresh token is no longer valid
// (the #1 cause: a Google OAuth app left in "Testing" status, whose refresh
// tokens expire after 7 days) and the rep must reconnect.
async function recordCalendarSync(
  uid: string, provider: "google" | "microsoft",
  patch: { needsReauth?: boolean; lastSyncError?: string },
): Promise<void> {
  await db.doc(`users/${uid}`).set(
    { calendar: { [provider]: { ...patch, lastSyncAt: Date.now() } } },
    { merge: true },
  );
}

// Push an appointment to a rep's connected external calendars. Best-effort for
// the booking itself (a calendar hiccup never blocks an appointment), but the
// outcome is recorded so failures are visible and re-auth can be prompted.
async function pushExternalEvent(uid: string, ev: { title: string; address?: string; notes?: string; startMs: number; endMs: number }): Promise<void> {
  const tokSnap = await db.doc(`calendarTokens/${uid}`).get();
  if (!tokSnap.exists) return;
  const t = tokSnap.data() as { google?: { refreshToken?: string }; microsoft?: { refreshToken?: string } };
  const cfg = await getIntegrationConfig();
  const startISO = new Date(ev.startMs).toISOString();
  const endISO = new Date(ev.endMs).toISOString();
  // Stamp the company's timezone so the event shows at the right local time.
  let tz = "UTC";
  try {
    const companyId = (await db.doc(`users/${uid}`).get()).data()?.companyId as string | undefined;
    if (companyId) tz = (await companyScheduling(companyId)).timezone || "UTC";
  } catch { /* default UTC */ }

  if (t.google?.refreshToken && cfg.googleClientId) {
    try {
      const at = await googleAccessToken(t.google.refreshToken, cfg);
      if (!at) {
        // Refresh failed → the connection is dead; prompt the rep to reconnect.
        await recordCalendarSync(uid, "google", { needsReauth: true, lastSyncError: "Google sign-in expired — reconnect your calendar." });
      } else {
        const r = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
          method: "POST",
          headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            summary: ev.title,
            location: ev.address || "",
            description: ev.notes || "Booked via YoutilityKnock",
            start: { dateTime: startISO, timeZone: tz },
            end: { dateTime: endISO, timeZone: tz },
          }),
        });
        if (r.ok) await recordCalendarSync(uid, "google", { needsReauth: false, lastSyncError: "" });
        else {
          const body = await r.text().catch(() => "");
          logger.warn(`google event push failed (${r.status})`, body);
          await recordCalendarSync(uid, "google", { needsReauth: r.status === 401, lastSyncError: `Google Calendar rejected the event (${r.status}).` });
        }
      }
    } catch (e) {
      logger.warn("google event push failed", e);
      await recordCalendarSync(uid, "google", { lastSyncError: "Couldn't reach Google Calendar." });
    }
  }
  if (t.microsoft?.refreshToken && cfg.microsoftClientId) {
    try {
      const at = await microsoftAccessToken(t.microsoft.refreshToken, cfg);
      if (!at) {
        await recordCalendarSync(uid, "microsoft", { needsReauth: true, lastSyncError: "Outlook sign-in expired — reconnect your calendar." });
      } else {
        const r = await fetch("https://graph.microsoft.com/v1.0/me/events", {
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
        if (r.ok) await recordCalendarSync(uid, "microsoft", { needsReauth: false, lastSyncError: "" });
        else {
          const body = await r.text().catch(() => "");
          logger.warn(`microsoft event push failed (${r.status})`, body);
          await recordCalendarSync(uid, "microsoft", { needsReauth: r.status === 401, lastSyncError: `Outlook rejected the event (${r.status}).` });
        }
      }
    } catch (e) {
      logger.warn("microsoft event push failed", e);
      await recordCalendarSync(uid, "microsoft", { lastSyncError: "Couldn't reach Outlook." });
    }
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

// Given a list of candidate start times, return only the ones the rep is free
// for. The client generates the day's candidate slots (it knows business hours
// from company.scheduling); the server is needed only because the free/busy
// check also reads external-calendar busy from server-only tokens.
export const getFreeSlots = onCall(async (request) => {
  const caller = await getCaller(request);
  const { uid, durationMin, candidates } = (request.data || {}) as
    { uid?: string; durationMin?: number; candidates?: number[] };
  if (!Array.isArray(candidates) || !candidates.length) return { free: [] };
  const list = candidates.filter((n) => typeof n === "number" && isFinite(n)).slice(0, 64);
  const targetUid = uid || caller.uid;
  const sched = caller.companyId ? await companyScheduling(caller.companyId) : DEFAULT_SCHEDULING;
  const dur = (durationMin || sched.apptDurationMin) * 60 * 1000;
  const flags = await Promise.all(list.map((s) =>
    isUserFree(targetUid, s, s + dur, sched.bufferMin).catch(() => false)));
  return { free: list.filter((_, i) => flags[i]) };
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
// CLOSER WORKFLOW — setters book appointments that route to a closer; the
// closer dispositions them on-site. Sit % (setter) and close % (closer) roll up
// from the outcomes. Mirrors lib/closerDispositions.ts on the client.
// ════════════════════════════════════════════════════════════════════════════
const CLOSER_SIT_STATUSES = new Set([
  "pitched_pending", "pitched_not_interested", "pitched_failed_credit", "closed_won",
]);
const APPT_STATUS_LABEL: Record<string, string> = {
  scheduled: "Scheduled",
  pitched_pending: "Pitched — Pending",
  pitched_not_interested: "Pitched — Not Interested",
  pitched_failed_credit: "Pitched — Failed Credit",
  closed_won: "Closed / Won",
  no_show: "No Show",
  reschedule: "Reschedule",
  closer_no_show: "Closer No Show",
};

// Choose the closer for a new appointment per company policy.
async function pickCloser(companyId: string, sched: any, candidateUid?: string) {
  const usersSnap = await db.collection("users").where("companyId", "==", companyId).get();
  let closers = usersSnap.docs
    .map((u): { uid: string; [k: string]: any } => ({ uid: u.id, ...(u.data() as Record<string, any>) }))
    .filter((u) => u.disabled !== true && u.isCloser === true);
  if (closers.length === 0) {
    throw new HttpsError("failed-precondition", "No closers are set up for this company yet — turn a rep into a closer in Team settings.");
  }
  const method = sched.closerAssignment || "round_robin";
  if (method === "setter_select") {
    if (!candidateUid) throw new HttpsError("invalid-argument", "Pick a closer for this appointment.");
    const found = closers.find((c) => c.uid === candidateUid);
    if (!found) throw new HttpsError("failed-precondition", "That closer isn't available.");
    return found;
  }
  if (method === "close_rate") {
    const statsSnap = await db.collection("userStats").where("companyId", "==", companyId).get();
    const rate: Record<string, number> = {};
    statsSnap.forEach((s) => {
      const d = s.data() as any;
      const sits = Number(d.closerSits) || 0;
      rate[s.id] = sits > 0 ? (Number(d.closerCloses) || 0) / sits : 0;
    });
    closers = closers.sort((a, b) => (rate[b.uid] || 0) - (rate[a.uid] || 0) || a.uid.localeCompare(b.uid));
    return closers[0];
  }
  // round_robin among closers (stable order + a per-company cursor)
  closers = closers.sort((a, b) => a.uid.localeCompare(b.uid));
  const cur = Number((await db.doc(`companies/${companyId}`).get()).data()?.closerRrCursor) || 0;
  const chosen = closers[cur % closers.length];
  await db.doc(`companies/${companyId}`).set({ closerRrCursor: cur + 1 }, { merge: true });
  return chosen;
}

// A setter books an appointment that routes to a closer. Called from the
// disposition modal when the company has the closer workflow enabled.
export const createCloserAppointment = onCall(async (request) => {
  const caller = await getCaller(request);
  const d = (request.data || {}) as {
    companyId?: string; startAt?: number; durationMin?: number;
    title?: string; address?: string; name?: string; notes?: string;
    leadId?: string; candidateCloserUid?: string;
  };
  const companyId = d.companyId || caller.companyId || "";
  if (!companyId || (caller.companyId !== companyId && !caller.isSuper)) {
    throw new HttpsError("permission-denied", "Wrong company.");
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

  const setterSnap = await db.doc(`users/${caller.uid}`).get();
  const setter: { uid: string; [k: string]: any } = setterSnap.exists
    ? { uid: setterSnap.id, ...(setterSnap.data() as Record<string, any>) }
    : { uid: caller.uid, companyId };
  const closer = await pickCloser(companyId, sched, d.candidateCloserUid);

  // Appointments roll up BOTH org charts: the closer's closer-managers and the
  // setter's setter-managers.
  const setterPath = (setter.managerPath as string[]) || [];
  const closerPath = (closer.closerManagerPath as string[]) || [];
  const visibility = Array.from(new Set([closer.uid, ...closerPath, setter.uid, ...setterPath]));

  // Carry the area incentives the setter captured onto the appointment so the
  // closer has them in hand at the door.
  let incentives: any[] = [];
  let incentivesUtility: any = null;
  if (d.leadId) {
    try {
      const ld = (await db.doc(`leads/${d.leadId}`).get()).data() as any;
      if (ld && Array.isArray(ld.incentives)) { incentives = ld.incentives; incentivesUtility = ld.incentivesUtility || null; }
    } catch { /* non-fatal */ }
  }

  const ev = {
    companyId,
    userId: closer.uid, // the closer owns the calendar event
    userName: closer.displayName || "",
    type: "appointment",
    title: d.title || `Appointment${d.name ? ` — ${d.name}` : ""}`,
    address: d.address || "",
    leadId: d.leadId || null,
    incentives,
    incentivesUtility,
    startAt: d.startAt,
    endAt,
    durationMin: d.durationMin || sched.apptDurationMin,
    assignedBy: caller.uid,
    source: "assigned",
    notes: d.notes || "",
    setterUid: setter.uid,
    setterName: setter.displayName || "",
    closerUid: closer.uid,
    closerName: closer.displayName || "",
    apptStatus: "scheduled",
    visibilityPath: visibility,
    reminded: false,
    createdAt: now,
  };
  const ref = await db.collection("events").add(ev);

  // The setter's `appointments` stat is bumped client-side (same as before);
  // here we only tally the closer's incoming queue.
  await serverBumpStats(closer, { closerAppts: 1 });

  await pushExternalEvent(closer.uid, { title: ev.title, address: ev.address, notes: ev.notes, startMs: d.startAt, endMs: endAt });
  await notifyUser({
    userId: closer.uid, type: "event",
    title: "New appointment to close",
    body: [ev.title, new Date(d.startAt).toLocaleString()].filter(Boolean).join(" — "),
    link: "/app/closer",
  });

  return { ok: true, eventId: ref.id, closerUid: closer.uid, closerName: closer.displayName || "" };
});

// A closer records the outcome of an assigned appointment.
export const closerDisposition = onCall(async (request) => {
  const caller = await getCaller(request);
  const d = (request.data || {}) as {
    eventId?: string; status?: string; notes?: string;
    distanceFt?: number | null; verified?: boolean; followUpAt?: number;
  };
  if (!d.eventId) throw new HttpsError("invalid-argument", "eventId required.");
  if (!d.status || !APPT_STATUS_LABEL[d.status] || d.status === "scheduled" || d.status === "closer_no_show") {
    throw new HttpsError("invalid-argument", "Pick a valid disposition.");
  }
  if (!d.notes || !d.notes.trim()) {
    throw new HttpsError("invalid-argument", "Notes are required on every disposition.");
  }

  const evRef = db.doc(`events/${d.eventId}`);
  const evSnap = await evRef.get();
  if (!evSnap.exists) throw new HttpsError("not-found", "Appointment not found.");
  const ev = evSnap.data() as any;

  const isAssignedCloser = ev.closerUid === caller.uid;
  const isMgr = caller.isSuper || (caller.companyId === ev.companyId && (caller.role === "admin" || caller.role === "manager"));
  if (!isAssignedCloser && !isMgr) throw new HttpsError("permission-denied", "Not your appointment to disposition.");

  // Geofence: a disposition only counts at the home. Off-site → closer no show.
  const onSite = d.verified !== false;
  const finalStatus = onSite ? d.status : "closer_no_show";
  if (onSite && finalStatus === "pitched_pending" && !d.followUpAt) {
    throw new HttpsError("invalid-argument", "Pick a follow-up date to schedule the next appointment.");
  }
  const now = Date.now();

  await evRef.set({
    apptStatus: finalStatus,
    apptNotes: d.notes.trim(),
    dispositionedAt: now,
    dispositionDistanceFt: d.distanceFt ?? null,
    dispositionVerified: onSite,
    updatedAt: now,
  }, { merge: true });

  // Credit stats: a sit lifts both the setter's sit% and the closer's close%
  // denominator; a closed_won also lifts the closer's closes (+ sales).
  const closerUid = ev.closerUid || caller.uid;
  const setterUid = ev.setterUid || null;
  const [closerSnap, setterSnap] = await Promise.all([
    db.doc(`users/${closerUid}`).get(),
    setterUid ? db.doc(`users/${setterUid}`).get() : Promise.resolve(null as any),
  ]);
  const closer = closerSnap.exists ? { uid: closerSnap.id, ...(closerSnap.data() as any) } : { uid: closerUid, companyId: ev.companyId };
  const setter = setterSnap && setterSnap.exists ? { uid: setterSnap.id, ...(setterSnap.data() as any) } : null;

  if (CLOSER_SIT_STATUSES.has(finalStatus)) {
    await serverBumpStats(closer, { closerSits: 1 });
    if (setter) await serverBumpStats(setter, { sits: 1 });
  }
  if (finalStatus === "closed_won") {
    await serverBumpStats(closer, { closerCloses: 1, sales: 1 });
    if (ev.leadId) {
      await db.doc(`leads/${ev.leadId}`).set({ status: "sold", soldAt: now, updatedAt: now }, { merge: true }).catch(() => {});
    }
  }

  // pitched_pending / reschedule → schedule a follow-up appointment (same closer).
  let followUpId: string | null = null;
  if (onSite && (finalStatus === "pitched_pending" || finalStatus === "reschedule") && d.followUpAt) {
    const dur = (ev.durationMin || 60) * 60 * 1000;
    const fu = { ...ev };
    delete fu.id;
    Object.assign(fu, {
      startAt: d.followUpAt,
      endAt: d.followUpAt + dur,
      apptStatus: "scheduled",
      apptNotes: "",
      dispositionedAt: null,
      dispositionDistanceFt: null,
      dispositionVerified: null,
      followUpForEventId: d.eventId,
      reminded: false,
      createdAt: now,
    });
    const fuRef = await db.collection("events").add(fu);
    followUpId = fuRef.id;
    await notifyUser({ userId: closerUid, type: "event", title: "Follow-up scheduled", body: new Date(d.followUpAt).toLocaleString(), link: "/app/closer" });
  }

  // Alert the setter with the closer's notes — the communication loop.
  if (setterUid) {
    await notifyUser({
      userId: setterUid, type: "closer_update",
      title: `Your appt: ${APPT_STATUS_LABEL[finalStatus]}`,
      body: [ev.address, d.notes.trim()].filter(Boolean).join(" — "),
      link: "/app/schedule",
    });
  }

  // A closer no-show (dispositioned off-site) flags up to the closer's manager.
  if (finalStatus === "closer_no_show") {
    await serverBumpStats(closer, { closerNoShows: 1 });
    const mgr = Array.isArray((closer as any).closerManagerPath) ? (closer as any).closerManagerPath[0] : null;
    if (mgr) {
      await notifyUser({
        userId: mgr, type: "closer_no_show",
        title: "Closer no-show",
        body: `${(closer as any).displayName || "A closer"} dispositioned ${ev.address || "an appointment"} off-site (${d.distanceFt ?? "?"} ft away).`,
        link: "/app/closer",
      });
    }
  }

  return { ok: true, status: finalStatus, onSite, followUpId };
});

// Toggle whether a user can be assigned appointments as a closer.
export const setUserCloser = onCall(async (request) => {
  const caller = await getCaller(request);
  const { uid, isCloser } = (request.data || {}) as { uid?: string; isCloser?: boolean };
  if (!uid) throw new HttpsError("invalid-argument", "uid required.");
  const snap = await db.doc(`users/${uid}`).get();
  if (!snap.exists) throw new HttpsError("not-found", "User not found.");
  authorizeForCompany(caller, (snap.data() as any).companyId);
  await db.doc(`users/${uid}`).set({ isCloser: !!isCloser }, { merge: true });
  return { ok: true };
});

// List a company's closers (for the setter-select booking dropdown).
export const listClosers = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.companyId) throw new HttpsError("permission-denied", "No company.");
  const snap = await db.collection("users").where("companyId", "==", caller.companyId).get();
  const closers = snap.docs
    .map((dd): { uid: string; [k: string]: any } => ({ uid: dd.id, ...(dd.data() as Record<string, any>) }))
    .filter((u) => u.disabled !== true && u.isCloser === true)
    .map((u) => ({ uid: u.uid, name: u.displayName || u.email || "Closer" }));
  return { closers };
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
    nrelKey: NREL.key, googleMapsKey: GMAPS.key,
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
  if (typeof d.nrelKey === "string" && d.nrelKey.trim()) u.nrelKey = d.nrelKey.trim();
  if (typeof d.googleMapsKey === "string" && d.googleMapsKey.trim()) u.googleMapsKey = d.googleMapsKey.trim();
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
  const { orgId, name, billingContactName, billingEmail, enterprise, perCompanyFee, orgFee, monthlyOverride } =
    (request.data || {}) as {
      orgId?: string; name?: string; billingContactName?: string; billingEmail?: string;
      enterprise?: boolean; perCompanyFee?: number; orgFee?: number; monthlyOverride?: number;
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
  // Explicit monthly that overrides the computed total (0 = use computed).
  if (typeof monthlyOverride === "number" && isFinite(monthlyOverride)) u.monthlyOverride = Math.max(0, monthlyOverride);
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
// EMPLOYEE REPORTS — a manager/admin pulls one rep's detailed activity, and can
// "set a close" on the rep's behalf (which also credits the rep's stats).
// Authorization: super-admin, a company admin in the same company, or a manager
// the rep reports to (caller's uid is in the rep's managerPath).
// ════════════════════════════════════════════════════════════════════════════
const REPORT_CONVO = new Set(["pipeline", "appointment", "not_interested", "sold"]);
function rStartOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
function rStartOfWeek() { const d = new Date(); const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day); d.setHours(0, 0, 0, 0); return d.getTime(); }
function rStartOfMonth() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); }
const rKnock = (l: any) => l.knockedAt || l.createdAt || 0;
const rClose = (l: any) => l.soldAt || l.updatedAt || l.knockedAt || l.createdAt || 0;
function rFunnel(leads: any[], since: number) {
  // Doors/convos require on-site (verified) integrity; appointments and closes
  // are deliberate outcomes and count regardless of geofence. Closes count by
  // close date so a deal closed in the window counts even if knocked earlier.
  const onsite = (l: any) => l.verified !== false;
  const knocked = leads.filter((l) => rKnock(l) >= since);
  return {
    doors: knocked.filter(onsite).length,
    conv: knocked.filter((l) => onsite(l) && REPORT_CONVO.has(l.status)).length,
    appt: knocked.filter((l) => l.status === "appointment").length,
    closed: leads.filter((l) => l.status === "sold" && rClose(l) >= since).length,
  };
}

// Server-side season-period helpers (mirror canvasspro-web/src/lib/season.ts).
function rPeriodKey(kind: string, d = new Date()): string {
  if (kind === "year") return `${d.getFullYear()}`;
  if (kind === "month") return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const ys = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((dt.getTime() - ys.getTime()) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(wk).padStart(2, "0")}`;
}
const rSeasonDocId = (uid: string, kind: string) => `${uid}__${kind[0].toUpperCase()}${rPeriodKey(kind)}`;

// Credit a rep's rolled-up stats (server-side bumpStats; Admin SDK bypasses the
// "only the user writes their own stats" rule so a manager can set a close).
async function serverBumpStats(rep: any, deltas: Record<string, number>) {
  const inc: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(deltas)) inc[k] = FieldValue.increment(v);
  const base = {
    uid: rep.uid, companyId: rep.companyId, userName: rep.displayName || rep.email || "Rep",
    managerPath: rep.managerPath || [], closerManagerPath: rep.closerManagerPath || [],
    ...inc, updatedAt: Date.now(),
  };
  await Promise.all([
    db.doc(`userStats/${rep.uid}`).set(base, { merge: true }),
    ...["week", "month", "year"].map((kind) =>
      db.doc(`seasonStats/${rSeasonDocId(rep.uid, kind)}`).set(
        { ...base, kind, period: rPeriodKey(kind), joinedAt: rep.createdAt ?? null }, { merge: true })),
  ]);
}

// True if the caller may manage this rep (see their report / set closes).
function canManageRep(caller: Caller, rep: any): boolean {
  if (caller.isSuper) return true;
  if (caller.role === "admin" && caller.companyId === rep.companyId) return true;
  return Array.isArray(rep.managerPath) && rep.managerPath.includes(caller.uid);
}

export const getEmployeeReport = onCall(async (request) => {
  const caller = await getCaller(request);
  const { repUid } = (request.data || {}) as { repUid?: string };
  if (!repUid) throw new HttpsError("invalid-argument", "repUid required.");
  const repSnap = await db.doc(`users/${repUid}`).get();
  const rep = repSnap.exists ? { uid: repSnap.id, ...repSnap.data() } as any : null;
  if (!rep) throw new HttpsError("not-found", "Employee not found.");
  if (!canManageRep(caller, rep)) throw new HttpsError("permission-denied", "Not allowed to view this employee.");

  const [leadSnap, shiftSnap, statSnap, pitchSnap] = await Promise.all([
    db.collection("leads").where("companyId", "==", rep.companyId).where("assignedTo", "==", repUid).get(),
    db.collection("shifts").where("companyId", "==", rep.companyId).where("userId", "==", repUid).get(),
    db.doc(`userStats/${repUid}`).get(),
    db.collection("pitches").where("companyId", "==", rep.companyId).where("uid", "==", repUid).get(),
  ]);
  // Keep all leads; rFunnel applies the on-site rule per metric (doors/convos
  // require it, appointments/closes don't). Filtering here dropped off-site
  // closes, zeroing the close rate.
  const leads = leadSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as any);
  const shifts = shiftSnap.docs.map((d) => d.data() as any);
  const today = rStartOfToday(), week = rStartOfWeek(), month = rStartOfMonth();
  const shiftHrs = (since: number) => Math.round(
    shifts.filter((s) => (s.startAt || 0) >= since)
      .reduce((sum, s) => sum + ((s.endAt ?? Date.now()) - (s.startAt || 0)), 0) / 3600000 * 10) / 10;

  const pitches = pitchSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as any)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map((p) => ({
      id: p.id, address: p.address || "", createdAt: p.createdAt || 0, status: p.status,
      score: typeof p.score === "number" ? p.score : null,
      highlight: p.highlight || "", lowlight: p.lowlight || "", feedback: p.feedback || "",
    }));
  const scored = pitches.filter((p) => typeof p.score === "number");
  const best = scored.length ? scored.reduce((a, b) => (b.score! > a.score! ? b : a)) : null;
  const worst = scored.length ? scored.reduce((a, b) => (b.score! < a.score! ? b : a)) : null;

  const all = rFunnel(leads, 0);
  return {
    rep: { uid: rep.uid, displayName: rep.displayName || "", email: rep.email || "", title: rep.title || rep.role || "", role: rep.role || "" },
    funnel: { today: rFunnel(leads, today), week: rFunnel(leads, week), month: rFunnel(leads, month), all },
    stats: statSnap.exists ? statSnap.data() : {},
    // Lifetime totals derived from the SAME lead set as the funnel, so the
    // footer matches the ALL-TIME column (the userStats counters drift).
    lifetime: { sold: all.closed, appts: all.appt, doors: all.doors },
    shiftHours: { week: shiftHrs(week), month: shiftHrs(month) },
    leads: leads
      .sort((a, b) => rKnock(b) - rKnock(a))
      .slice(0, 200)
      .map((l) => ({ id: l.id, address: l.address || "", status: l.status, knockedAt: rKnock(l), soldAt: l.soldAt || null })),
    pitches: { recent: pitches.slice(0, 30), best, worst, count: pitches.length },
  };
});

// Set a close (or other disposition) on a lead on a rep's behalf, and credit
// the rep's stats. Manager/admin only, for reps they manage.
export const setLeadStatusForRep = onCall(async (request) => {
  const caller = await getCaller(request);
  const { leadId, status } = (request.data || {}) as { leadId?: string; status?: string };
  if (!leadId || !status) throw new HttpsError("invalid-argument", "leadId and status required.");
  const leadSnap = await db.doc(`leads/${leadId}`).get();
  const lead = leadSnap.exists ? leadSnap.data() as any : null;
  if (!lead) throw new HttpsError("not-found", "Lead not found.");
  const repSnap = await db.doc(`users/${lead.assignedTo}`).get();
  const rep = repSnap.exists ? { uid: repSnap.id, ...repSnap.data() } as any : null;
  if (!rep) throw new HttpsError("not-found", "Lead owner not found.");
  if (!canManageRep(caller, rep)) throw new HttpsError("permission-denied", "Not allowed to manage this employee's leads.");

  const now = Date.now();
  const prev = lead.status;
  const patch: Record<string, unknown> = { status, updatedAt: now };
  if (status === "sold") patch.soldAt = now;
  await db.doc(`leads/${leadId}`).set(patch, { merge: true });
  // Credit the rep's stats for newly-set closes / appointments (don't double-count).
  if (status === "sold" && prev !== "sold") await serverBumpStats(rep, { sales: 1 });
  else if (status === "appointment" && prev !== "appointment") await serverBumpStats(rep, { appointments: 1 });
  return { ok: true, repUid: rep.uid };
});

// ════════════════════════════════════════════════════════════════════════════
// PITCH AI — when a rep's pitch recording lands, transcribe it (Google
// Speech-to-Text) and grade it (Claude), writing the score + coaching feedback
// back onto the pitch doc. Keys live in config/ai (set in the super-admin
// console). No keys → the pitch is marked "error" with a hint, nothing crashes.
// ════════════════════════════════════════════════════════════════════════════
const PITCH_CERT_PASS = 80; // a certification pitch scoring ≥ this certifies the rep
async function readAiConfig() {
  const c = ((await db.doc("config/ai").get()).data() as Record<string, string>) || {};
  return {
    googleSttKey: c.googleSttKey || process.env.GOOGLE_STT_KEY || "",
    anthropicKey: c.anthropicKey || process.env.ANTHROPIC_API_KEY || "",
    anthropicModel: c.anthropicModel || "claude-sonnet-4-6",
  };
}

// General-purpose Claude text call for the training/coaching features (role-play,
// success plans, territory education). Reuses the same key/model as pitch grading.
async function claudeText(system: string, messages: Array<{ role: string; content: string }>, maxTokens = 900): Promise<string> {
  const cfg = await readAiConfig();
  if (!cfg.anthropicKey) throw new HttpsError("failed-precondition", "AI coaching isn't configured yet — ask your admin to add an Anthropic key.");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": cfg.anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: cfg.anthropicModel, max_tokens: maxTokens, system, messages }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpsError("internal", json?.error?.message || `Claude failed (${res.status})`);
  return (json.content?.[0]?.text as string) || "";
}

// Transcode any browser recording (webm/opus on Android/desktop, mp4/aac on
// iOS) to mono 16 kHz FLAC, which Google STT reliably ingests. ffmpeg also lets
// us send the audio inline so the transcriber never reads from the bucket.
async function transcodeToFlac(input: Buffer, ext: string): Promise<Buffer> {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const inPath = join(tmpdir(), `pitch_${stamp}.${ext || "webm"}`);
  const outPath = join(tmpdir(), `pitch_${stamp}.flac`);
  await writeFile(inPath, input);
  try {
    await new Promise<void>((resolve, reject) => {
      const p = spawn(ffmpegPath as string, ["-y", "-i", inPath, "-ac", "1", "-ar", "16000", "-c:a", "flac", outPath]);
      let err = "";
      p.stderr.on("data", (d) => { err += d.toString(); });
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error("ffmpeg failed: " + err.slice(-300)))));
    });
    return await readFile(outPath);
  } finally {
    await Promise.all([unlink(inPath).catch(() => {}), unlink(outPath).catch(() => {})]);
  }
}

// Transcribe FLAC audio (sent inline) via Google STT longRunningRecognize.
async function transcribeFlac(flacB64: string, key: string): Promise<string> {
  const start = await fetch(`https://speech.googleapis.com/v1/speech:longrunningrecognize?key=${key}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      config: { encoding: "FLAC", sampleRateHertz: 16000, languageCode: "en-US", enableAutomaticPunctuation: true },
      audio: { content: flacB64 },
    }),
  });
  const startJson: any = await start.json().catch(() => ({}));
  if (!start.ok) throw new Error(startJson?.error?.message || `STT start failed (${start.status})`);
  const opName = startJson.name;
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const op: any = await (await fetch(`https://speech.googleapis.com/v1/operations/${opName}?key=${key}`)).json().catch(() => ({}));
    if (op.done) {
      if (op.error) throw new Error(op.error.message);
      return ((op.response?.results) || []).map((r: any) => r.alternatives?.[0]?.transcript || "").join(" ").trim();
    }
  }
  throw new Error("Transcription timed out.");
}

// Grade a pitch transcript with Claude. Returns score + highlight/lowlight/feedback.
async function claudeGradePitch(transcript: string, key: string, model: string): Promise<any> {
  const prompt =
    "You are an expert door-to-door sales coach. Analyze this rep's pitch transcript and reply with ONLY a JSON object " +
    `(no prose) of the form {"score": <integer 0-100>, "highlight": "<the strongest moment / what worked, 1-2 sentences>", ` +
    `"lowlight": "<the weakest moment / what to improve, 1-2 sentences>", "feedback": "<2-3 sentence coaching summary addressed to the rep>"}.\n\nTranscript:\n` +
    transcript;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 700, messages: [{ role: "user", content: prompt }] }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || `Claude failed (${res.status})`);
  const text = (json.content?.[0]?.text as string) || "";
  const m = text.match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : { score: null, feedback: text.slice(0, 500) }; }
  catch { return { score: null, feedback: text.slice(0, 500) }; }
}

export const onPitchCreated = onDocumentCreated(
  { document: "pitches/{id}", timeoutSeconds: 540, memory: "512MiB" },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const p = snap.data() as any;
    if (p.status !== "recorded" || !p.audioPath) return;
    const cfg = await readAiConfig();
    if (!cfg.googleSttKey || !cfg.anthropicKey) {
      await snap.ref.set({ status: "error", feedback: "AI isn't configured — add Google STT + Anthropic keys in the admin console." }, { merge: true });
      return;
    }
    await snap.ref.set({ status: "analyzing" }, { merge: true });
    try {
      // Download with the function's own credentials (no "anonymous" GCS read),
      // transcode to FLAC (handles iOS mp4/aac + Android webm), transcribe inline.
      const [audio] = await getStorage().bucket().file(p.audioPath).download();
      const ext = (p.audioPath.split(".").pop() || "webm").toLowerCase();
      const flac = await transcodeToFlac(audio, ext);
      const transcript = await transcribeFlac(flac.toString("base64"), cfg.googleSttKey);
      if (!transcript) {
        await snap.ref.set({ status: "analyzed", transcript: "", feedback: "No clear speech was detected in this recording.", analyzedAt: Date.now() }, { merge: true });
        return;
      }
      const a = await claudeGradePitch(transcript, cfg.anthropicKey, cfg.anthropicModel);
      await snap.ref.set({
        status: "analyzed", transcript,
        score: typeof a.score === "number" ? a.score : null,
        highlight: a.highlight || "", lowlight: a.lowlight || "", feedback: a.feedback || "",
        analyzedAt: Date.now(),
      }, { merge: true });
      // A passing certification pitch unlocks full-credit canvassing for the rep.
      if (p.kind === "certification" && typeof a.score === "number" && a.score >= PITCH_CERT_PASS && p.uid) {
        await db.doc(`users/${p.uid}`).set(
          { pitchCertified: true, pitchCertScore: a.score, pitchCertifiedAt: Date.now(), pitchCertPitchId: snap.id },
          { merge: true }
        );
      }
    } catch (e: any) {
      logger.error("onPitchCreated failed", e);
      await snap.ref.set({ status: "error", feedback: (e?.message || "Analysis failed.").slice(0, 300) }, { merge: true });
    }
  }
);

// Super-admin: AI provider keys (Google STT + Anthropic) for pitch coaching.
export const getAiConfig = onCall(async (request) => {
  const caller = await getCaller(request);
  requireSuper(caller);
  const c = ((await db.doc("config/ai").get()).data() as Record<string, string>) || {};
  return {
    stt: { configured: !!c.googleSttKey, keyMask: mask(c.googleSttKey) },
    anthropic: { configured: !!c.anthropicKey, keyMask: mask(c.anthropicKey), model: c.anthropicModel || "claude-sonnet-4-6" },
  };
});

export const setAiConfig = onCall(async (request) => {
  const caller = await getCaller(request);
  requireSuper(caller);
  const d = (request.data || {}) as Record<string, string>;
  const update: Record<string, unknown> = { updatedAt: Date.now(), updatedBy: caller.uid };
  if (typeof d.googleSttKey === "string" && d.googleSttKey.trim()) update.googleSttKey = d.googleSttKey.trim();
  if (typeof d.anthropicKey === "string" && d.anthropicKey.trim()) update.anthropicKey = d.anthropicKey.trim();
  if (typeof d.anthropicModel === "string" && d.anthropicModel.trim()) update.anthropicModel = d.anthropicModel.trim();
  await db.doc("config/ai").set(update, { merge: true });
  return { ok: true };
});

// ════════════════════════════════════════════════════════════════════════════
// TRAINING — AI homeowner role-play, personalized success plan, and a
// data-driven recommended territory. All reuse the pitch-coaching Claude key.
// ════════════════════════════════════════════════════════════════════════════

// A stay-in-character skeptical homeowner the rep can practice pitching against.
export const aiHomeowner = onCall(async (request) => {
  await getCaller(request); // any signed-in rep may practice
  const { messages, persona } = (request.data || {}) as { messages?: Array<{ role: string; content: string }>; persona?: string };
  const history = (Array.isArray(messages) ? messages : []).slice(-20).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content || "").slice(0, 2000),
  }));
  if (history.length === 0) history.push({ role: "user", content: "(The rep knocks on your door.)" });
  const system =
    `You are role-playing as a SKEPTICAL HOMEOWNER who just opened the door to a door-to-door ${persona || "solar"} sales rep. ` +
    "Stay fully in character as the homeowner for the entire conversation. Be realistic: start guarded and raise the common objections " +
    "(no time, not interested, already got quotes, my spouse decides, I don't trust door knockers, too expensive). If the rep listens, " +
    "builds value and handles objections well, gradually warm up; if they're pushy, vague or salesy, stay cold. Keep each reply to 1-3 " +
    "conversational sentences. No narration, no stage directions, never break character, never say you are an AI.";
  const reply = await claudeText(system, history, 300);
  return { reply: reply.trim() };
});

// Personalized study guide + succession plan built from the rep's own door data
// (notes, not-interested patterns) and recent pitch coaching.
export const getSuccessPlan = onCall(async (request) => {
  const caller = await getCaller(request);
  const repUid = ((request.data || {}) as { repUid?: string }).repUid || caller.uid;
  const repSnap = await db.doc(`users/${repUid}`).get();
  const rep = repSnap.exists ? ({ uid: repSnap.id, ...repSnap.data() } as any) : null;
  if (!rep) throw new HttpsError("not-found", "Rep not found.");
  if (repUid !== caller.uid && !canManageRep(caller, rep)) throw new HttpsError("permission-denied", "Not allowed.");
  const [leadSnap, pitchSnap] = await Promise.all([
    db.collection("leads").where("assignedTo", "==", repUid).get(),
    db.collection("pitches").where("uid", "==", repUid).get(),
  ]);
  const leads = leadSnap.docs.map((d) => d.data() as any);
  const counts: Record<string, number> = {};
  for (const l of leads) counts[l.status] = (counts[l.status] || 0) + 1;
  const niNotes = leads.filter((l) => l.status === "not_interested" && l.notes).slice(0, 25).map((l) => String(l.notes).slice(0, 200));
  const otherNotes = leads.filter((l) => l.notes && l.status !== "not_interested").slice(0, 30).map((l) => `[${l.status}] ${String(l.notes).slice(0, 160)}`);
  const pitchFb = pitchSnap.docs.map((d) => d.data() as any).filter((p) => p.status === "analyzed")
    .slice(0, 10).map((p) => `score ${p.score}: ${p.lowlight || p.feedback || ""}`.slice(0, 220));
  const system =
    "You are an elite door-to-door sales coach. Build a concrete, personalized improvement plan for this rep from their real field data. " +
    'Reply with ONLY a JSON object (no prose) of the form {"summary":"<2-3 sentence read on where they are>",' +
    '"focusAreas":["<3-5 short focus areas>"],"studyGuide":["<5-7 specific study/practice items>"],' +
    '"successionPlan":["<ordered steps to level up over the next few weeks>"],' +
    '"objectionScripts":[{"objection":"<a real objection they hit>","response":"<a crisp rebuttal to practice>"}]}.';
  const user =
    `Rep: ${rep.displayName || "rep"}. Disposition counts: ${JSON.stringify(counts)}.\n` +
    `NOT-INTERESTED notes (reduce these):\n${niNotes.join("\n") || "(none)"}\n\n` +
    `Other door notes:\n${otherNotes.join("\n") || "(none)"}\n\n` +
    `Recent AI pitch coaching:\n${pitchFb.join("\n") || "(none)"}`;
  const text = await claudeText(system, [{ role: "user", content: user }], 1600);
  const m = text.match(/\{[\s\S]*\}/);
  let plan: any;
  try { plan = m ? JSON.parse(m[0]) : { summary: text.slice(0, 800) }; }
  catch { plan = { summary: text.slice(0, 800) }; }
  return { plan, certified: rep.pitchCertified === true, certScore: rep.pitchCertScore ?? null, stats: counts };
});

// Manager tool: from a rep's worked areas, recommend a new "pre-drawn" area
// modeled on their best converter, plus AI coaching on what to replicate.
export const recommendTerritory = onCall(async (request) => {
  const caller = await getCaller(request);
  const { repUid } = (request.data || {}) as { repUid?: string };
  if (!repUid) throw new HttpsError("invalid-argument", "repUid required.");
  const repSnap = await db.doc(`users/${repUid}`).get();
  const rep = repSnap.exists ? ({ uid: repSnap.id, ...repSnap.data() } as any) : null;
  if (!rep) throw new HttpsError("not-found", "Rep not found.");
  if (!canManageRep(caller, rep)) throw new HttpsError("permission-denied", "Not allowed to manage this rep.");
  const cid = rep.companyId;
  const [terrSnap, leadSnap] = await Promise.all([
    db.collection("territories").where("companyId", "==", cid).get(),
    db.collection("leads").where("companyId", "==", cid).get(),
  ]);
  const repTerrs = terrSnap.docs
    .map((d) => ({ id: d.id, data: d.data() as any, polygon: normalizePoly((d.data() as any).polygon) }))
    .filter((t) => t.data.assignedTo === repUid && t.polygon.length >= 3);
  if (repTerrs.length === 0) throw new HttpsError("failed-precondition", "This rep has no drawn areas to learn from yet.");
  const leads = leadSnap.docs.map((d) => d.data() as any);
  const scored = repTerrs.map((t) => {
    let doors = 0, sold = 0, appt = 0; const notes: string[] = [];
    for (const l of leads) {
      const lat = Number(l.lat), lng = Number(l.lng);
      if (!isFinite(lat) || !isFinite(lng) || !pinInPolygon({ lat, lng }, t.polygon)) continue;
      doors++;
      if (l.status === "sold") sold++;
      if (l.status === "appointment") appt++;
      if (l.notes) notes.push(`[${l.status}] ${String(l.notes).slice(0, 160)}`);
    }
    return { t, doors, sold, appt, success: doors ? sold / doors : 0, notes };
  }).filter((s) => s.doors > 0).sort((a, b) => b.success - a.success);
  if (scored.length === 0) throw new HttpsError("failed-precondition", "Not enough door data to recommend an area yet.");
  const best = scored[0], worst = scored[scored.length - 1];
  // Pre-draw an adjacent untouched block: clone the best polygon shifted east by
  // its own width so the manager gets a ready-to-assign area near the winner.
  const lngs = best.t.polygon.map((p) => p.lng);
  const width = Math.max(...lngs) - Math.min(...lngs) || 0.003;
  const polygon = best.t.polygon.map((p) => ({ lat: p.lat, lng: p.lng + width }));
  let education = `Replicate "${best.t.data.name}" — it converted ${Math.round(best.success * 100)}% (${best.sold} sold / ${best.doors} doors).`;
  try {
    const sys = "You are a door-to-door sales coach addressing a manager. In 3-4 short sentences, explain what made this rep's best area convert and exactly what to replicate, plus one thing to avoid from their weakest area. Plain text only, no preamble.";
    const out = await claudeText(sys, [{ role: "user", content:
      `Best area "${best.t.data.name}": ${Math.round(best.success * 100)}% success (${best.sold}/${best.doors}).\nNotes:\n${best.notes.slice(0, 25).join("\n") || "(none)"}\n\n` +
      `Weakest area "${worst.t.data.name}": ${Math.round(worst.success * 100)}% success.\nNotes:\n${worst.notes.slice(0, 15).join("\n") || "(none)"}` }], 500);
    if (out.trim()) education = out.trim();
  } catch (e) { logger.warn("recommendTerritory education failed", e); }
  return {
    recommendation: {
      name: `Like ${best.t.data.name} — for ${rep.displayName || "rep"}`,
      polygon, basedOnTerritoryId: best.t.id, basedOnName: best.t.data.name,
      successRate: Math.round(best.success * 100), doors: best.doors, sold: best.sold,
      rationale: `Modeled on the rep's best area "${best.t.data.name}" (${Math.round(best.success * 100)}% success).`,
      education,
    },
  };
});

// Rep-facing: propose a new area for a manager to approve. Reps can't write
// territories directly (rules block it), so this runs with admin credentials and
// files the area as a pending proposal assigned to the proposing rep.
export const proposeTerritory = onCall(async (request) => {
  const caller = await getCaller(request);
  if (!caller.companyId) throw new HttpsError("failed-precondition", "No company on your account.");
  const { name, description, polygon, color } = (request.data || {}) as { name?: string; description?: string; polygon?: unknown; color?: string };
  if (!name || !String(name).trim()) throw new HttpsError("invalid-argument", "An area name is required.");
  const me = ((await db.doc(`users/${caller.uid}`).get()).data() as any) || {};
  const poly = normalizePoly(polygon);
  const ref = await db.collection("territories").add({
    name: String(name).trim(),
    description: description ? String(description).trim() : null,
    color: color || "#0EA5E9",
    companyId: caller.companyId,
    managerId: me.managerId || null,
    proposedBy: caller.uid,
    assignedTo: caller.uid,
    assignedToName: me.displayName || me.email || null,
    polygon: poly.length >= 3 ? poly : null,
    status: "pending",
    createdAt: Date.now(),
  });
  const mgr = (me.managerPath || [])[0];
  if (mgr) {
    try {
      await db.collection("notifications").add({
        userId: mgr, type: "territory_proposal",
        title: `${me.displayName || me.email || "A rep"} proposed an area`,
        body: String(name).trim(), link: "/territories", read: false, createdAt: Date.now(),
      });
    } catch { /* non-fatal */ }
  }
  return { ok: true, id: ref.id };
});

// Battery proposal — turn the deterministic sizing numbers into a warm,
// homeowner-facing narrative the closer can read or include in the proposal.
// Best-effort: if AI isn't configured the client just falls back to the numbers.
export const batteryProposalSummary = onCall(async (request) => {
  await getCaller(request);
  const d = (request.data || {}) as {
    customerName?: string; bill?: any; load?: any; solar?: any;
    recommendation?: any; goal?: string; backupDays?: number;
  };
  const rec = d.recommendation || {};
  const prod = rec.product || {};
  const system = `You are a top residential battery-storage consultant writing a short, persuasive but honest proposal summary for a homeowner. Plain text, warm and clear, no markdown headers, 4-6 short sentences. Explain what the recommended battery does for THEM (backup of their essentials, ${d.goal === "savings" ? "savings on their bill" : d.goal === "both" ? "backup plus bill savings" : "whole-home backup peace of mind"}), reference their actual numbers, and end with a confident next step. Don't invent prices.`;
  const user =
    `Homeowner: ${d.customerName || "the homeowner"}.\n` +
    `Bill: ~${d.bill?.monthlyKWh ?? "?"} kWh/mo, ~$${d.bill?.monthlyCost ?? "?"}/mo at $${d.bill?.ratePerKWh ?? "?"}/kWh.\n` +
    `Existing solar: ${d.solar?.hasSolar ? `${d.solar?.systemKwDc || "?"} kW` : "none"}.\n` +
    `Backup load: ${d.load?.dailyKWh ?? "?"} kWh/day, ${d.load?.continuousKW ?? "?"} kW continuous, ${d.load?.peakKW ?? "?"} kW surge.\n` +
    `Recommended: ${rec.units || 1}× ${prod.brand || ""} ${prod.model || ""} = ${rec.totalUsableKWh ?? "?"} kWh usable, ${rec.totalContinuousKW ?? "?"} kW continuous, covering ~${rec.backupDaysAchieved ?? "?"} days of their essentials. Goal: ${d.goal || "backup"} for ${d.backupDays || 1} day(s).`;
  try {
    const text = await claudeText(system, [{ role: "user", content: user }], 600);
    return { summary: text.trim() };
  } catch (e: any) {
    // Surface a typed, non-fatal signal so the UI degrades to the raw numbers.
    return { summary: "", error: e?.message || "AI summary unavailable." };
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ENERGY INCENTIVES — auto-discover local / AHJ / utility battery+solar
// incentives for an address. Identifies the electric utility via NREL, then uses
// Claude WITH LIVE WEB SEARCH to find current programs with real source links +
// dates. Cached per area so we don't re-bill the AI for every lookup. (No ITC.)
// ════════════════════════════════════════════════════════════════════════════
function escHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

// Claude with the server-side web_search tool. Returns the answer text plus the
// real citation URLs the model used (our verification links). Falls back to a
// knowledge-only call if web search isn't enabled on the key/model.
async function claudeWebResearch(system: string, prompt: string, maxTokens = 2500): Promise<{ text: string; sources: Array<{ url: string; title: string }>; usedWeb: boolean }> {
  const cfg = await readAiConfig();
  if (!cfg.anthropicKey) throw new HttpsError("failed-precondition", "AI isn't configured — add an Anthropic key in the admin console.");
  const headers = { "x-api-key": cfg.anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" };
  const base = { model: cfg.anthropicModel, max_tokens: maxTokens, system, messages: [{ role: "user", content: prompt }] };
  let usedWeb = true;
  let res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers,
    body: JSON.stringify({ ...base, tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }] }),
  });
  let json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    logger.warn("web_search unavailable, falling back to knowledge-only", json?.error?.message);
    usedWeb = false;
    res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify(base) });
    json = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpsError("internal", json?.error?.message || `Claude failed (${res.status})`);
  }
  const blocks: any[] = Array.isArray(json.content) ? json.content : [];
  let text = "";
  const sources: Array<{ url: string; title: string }> = [];
  const seen = new Set<string>();
  for (const b of blocks) {
    if (b.type === "text") {
      text += b.text || "";
      for (const c of (b.citations || [])) {
        if (c?.url && !seen.has(c.url)) { seen.add(c.url); sources.push({ url: c.url, title: c.title || c.url }); }
      }
    }
  }
  return { text, sources, usedWeb };
}

// Real electric-utility identification for a coordinate (NREL utility_rates v3).
async function nrelUtility(lat: number, lng: number): Promise<{ name: string; rate: number | null } | null> {
  try {
    const url = `https://developer.nrel.gov/api/utility_rates/v3.json?api_key=${encodeURIComponent(NREL.key)}&lat=${lat}&lon=${lng}`;
    const res = await fetch(url);
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) return null;
    const o = j.outputs || {};
    const name = o.utility_name || (Array.isArray(o.utility_info) ? o.utility_info[0]?.utility_name : "") || "";
    const rate = typeof o.residential === "number" && o.residential > 0 ? o.residential : null;
    return name || rate != null ? { name: name || "", rate } : null;
  } catch { return null; }
}

const INCENTIVE_CACHE_TTL = 30 * 86400000; // 30 days — incentives change slowly
function incentiveAreaKey(d: { zip?: string; state?: string; lat?: number; lng?: number }): string {
  if (d.zip && /^\d{5}$/.test(String(d.zip))) return `z_${d.zip}`;
  if (typeof d.lat === "number" && typeof d.lng === "number") return `g_${d.lat.toFixed(2)}_${d.lng.toFixed(2)}`;
  if (d.state) return `s_${String(d.state).toLowerCase().replace(/[^a-z]/g, "")}`;
  return "unknown";
}

export const getAreaIncentives = onCall({ timeoutSeconds: 120 }, async (request) => {
  const caller = await getCaller(request);
  const d = (request.data || {}) as { lat?: number; lng?: number; address?: string; city?: string; state?: string; zip?: string; refresh?: boolean };
  await refreshApiConfig();
  const key = incentiveAreaKey(d);
  const ref = db.doc(`incentiveCache/${key}`);
  if (!d.refresh) {
    const cached = await ref.get();
    if (cached.exists) {
      const c = cached.data() as any;
      if (c.generatedAt && Date.now() - c.generatedAt < INCENTIVE_CACHE_TTL) return { ...c, cacheId: key, cached: true };
    }
  }
  let utility: { name: string; rate: number | null } | null = null;
  if (typeof d.lat === "number" && typeof d.lng === "number") utility = await nrelUtility(d.lat, d.lng);
  const loc = [d.address, d.city, d.state, d.zip].filter(Boolean).join(", ") || `${d.lat ?? "?"},${d.lng ?? "?"}`;
  const today = new Date().toISOString().slice(0, 10);
  const system =
    `You are a home solar + battery incentives researcher. Use web search to find CURRENT (as of ${today}) financial incentives for installing HOME BATTERY / energy storage (and rooftop solar) at the given U.S. location: electric-utility rebates, state programs, county/city/AHJ incentives, SGIP-style storage rebates, performance/demand-response or VPP payments, and property/sales-tax exemptions. EXCLUDE the federal ITC entirely (assume it is gone). Only include programs you can source from an official utility or government page. Reply with ONLY a JSON array (no prose).`;
  const utilLine = utility?.name ? `The electric utility serving this address is ${utility.name}. ` : "";
  const prompt =
    `Location: ${loc}. ${utilLine}\n` +
    `Return a JSON array (max 6, most valuable first) of: {"name","administrator","level":"utility|state|county|city|ahj|other","type":"rebate|tax|performance|financing|exemption","amount":"<human readable e.g. $0.25/Wh up to $5,000>","estValueUsd":<number estimate for a typical single-battery home install, or null>,"startDate":"<ISO/text/null>","endDate":"<ISO/text/'ongoing'>","url":"<official source URL>","summary":"<1-2 sentences>"}. If none, return [].`;
  let incentives: any[] = [];
  let sources: Array<{ url: string; title: string }> = [];
  let usedWeb = false;
  try {
    const r = await claudeWebResearch(system, prompt, 3000);
    usedWeb = r.usedWeb; sources = r.sources;
    const m = r.text.match(/\[[\s\S]*\]/);
    if (m) incentives = JSON.parse(m[0]);
  } catch (e) {
    logger.warn("incentive research failed", e);
  }
  const report = {
    location: loc, state: d.state || null, zip: d.zip || null,
    utility: utility || null,
    incentives: Array.isArray(incentives) ? incentives.slice(0, 8) : [],
    sources, usedWeb, generatedAt: Date.now(), generatedBy: caller.uid,
  };
  try { await ref.set(report, { merge: true }); } catch (e) { logger.warn("incentive cache write", e); }
  return { ...report, cacheId: key, cached: false };
});

// Email the discovered incentives (with dates + verification links) to the
// homeowner as proof the programs are real — the closer/setter's trust builder.
export const emailIncentivesToHomeowner = onCall(async (request) => {
  await getCaller(request);
  const d = (request.data || {}) as { to?: string; customerName?: string; address?: string; incentives?: any[]; utility?: { name?: string }; companyName?: string };
  if (!d.to || !/.+@.+\..+/.test(d.to)) throw new HttpsError("invalid-argument", "A valid homeowner email is required.");
  const items = Array.isArray(d.incentives) ? d.incentives : [];
  const rows = items.map((i) => {
    const dates = [i.startDate, i.endDate].filter(Boolean).join(" – ") || "see source";
    return `<tr><td style="padding:10px;border-bottom:1px solid #eee">` +
      `<strong>${escHtml(i.name)}</strong><br>` +
      `<span style="color:#555">${escHtml(i.administrator || "")}${i.type ? " · " + escHtml(i.type) : ""}</span><br>` +
      `${escHtml(i.summary || "")}<br>` +
      `<span style="color:#555">Amount: ${escHtml(i.amount || "—")} · Dates: ${escHtml(dates)}</span>` +
      `${i.url ? `<br><a href="${escHtml(i.url)}">Verify at the official source →</a>` : ""}</td></tr>`;
  }).join("");
  const html =
    `<div style="font-family:system-ui,Arial,sans-serif;max-width:620px;color:#111">` +
    `<h2>Energy incentives for your home</h2>` +
    `${d.address ? `<p style="color:#555">${escHtml(d.address)}</p>` : ""}` +
    `${d.utility?.name ? `<p>Electric utility: <strong>${escHtml(d.utility.name)}</strong></p>` : ""}` +
    `<table style="width:100%;border-collapse:collapse">${rows || "<tr><td>No specific programs were found for your area yet — your rep can follow up.</td></tr>"}</table>` +
    `<p style="color:#777;font-size:12px;margin-top:16px">These programs are gathered from public/official sources and can change — please confirm current terms at each linked source${d.companyName ? `, or ask your ${escHtml(d.companyName)} rep` : ""}.</p></div>`;
  const text = items.map((i) => `• ${i.name} (${i.administrator || ""}) — ${i.amount || ""} — ${[i.startDate, i.endDate].filter(Boolean).join(" to ")} — ${i.url || ""}`).join("\n") || "No specific programs found yet.";
  const cfg = await getNotifyConfig();
  const r = await sendEmailDetailed(cfg, d.to, "Energy incentives for your home", text, undefined, html);
  if (!r.ok) throw new HttpsError("failed-precondition", r.detail);
  return { ok: true };
});

// Save the interactive proposal and email the homeowner a link to open it. The
// interactive experience can't live inside an email, so we persist the proposal
// under an unguessable id and send a link to the live, no-login viewer plus an
// HTML summary fallback.
export const emailProposalToHomeowner = onCall(async (request) => {
  const caller = await getCaller(request);
  const d = (request.data || {}) as { to?: string; payload?: Record<string, any> };
  if (!d.to || !/.+@.+\..+/.test(d.to)) throw new HttpsError("invalid-argument", "A valid homeowner email is required.");
  const payload: Record<string, any> = { ...(d.payload || {}) };
  // A home-photo data URI can be hundreds of KB — drop it so the saved doc stays
  // comfortably under Firestore's 1 MB limit (the viewer falls back to the scene).
  if (typeof payload.homeImage === "string" && payload.homeImage.length > 300_000) delete payload.homeImage;

  const id = crypto.randomUUID().replace(/-/g, "");
  await db.doc(`sharedProposals/${id}`).set({
    payload, to: d.to, companyId: caller.companyId || payload.companyId || null,
    closerUid: caller.uid, createdAt: Date.now(),
  });
  const url = `${APP_URL}/app/?pid=${id}`;

  const money = (n: any) => (typeof n === "number" && isFinite(n) ? `$${Math.round(n).toLocaleString()}` : "—");
  const rec = payload.recommendation as any;
  const roi = payload.roi as any;
  const first = payload.customerName ? String(payload.customerName).split(" ")[0] : "there";
  const company = payload.companyName ? escHtml(payload.companyName) : "";
  const incs = Array.isArray(payload.incentives) ? payload.incentives.slice(0, 6) : [];

  const roiRows = roi
    ? `<table style="width:100%;border-collapse:collapse;margin:14px 0"><tr>` +
      `<td style="padding:10px 12px;background:#f5f3fb;border-radius:8px"><div style="font-size:20px;font-weight:700;color:#6d28d9">${money(roi.netCost)}</div><div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.04em">Net cost after incentives</div></td>` +
      `<td style="width:10px"></td>` +
      `<td style="padding:10px 12px;background:#f5f3fb;border-radius:8px"><div style="font-size:20px;font-weight:700;color:#0a7d33">${money(roi.monthlySavings)}/mo</div><div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.04em">Estimated monthly savings</div></td>` +
      `</tr></table>`
    : "";
  const incRows = incs.length
    ? `<div style="margin-top:14px"><div style="font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:#888;margin-bottom:6px">Incentives you may qualify for</div>` +
      incs.map((i: any) => `<div style="padding:6px 0;border-bottom:1px solid #eee"><strong>${escHtml(i.name)}</strong>${i.amount ? ` — ${escHtml(i.amount)}` : ""}${i.url ? ` · <a href="${escHtml(i.url)}" style="color:#7c3aed">verify</a>` : ""}</div>`).join("") +
      `</div>`
    : "";

  const html =
    `<div style="font-family:system-ui,Arial,sans-serif;max-width:600px;margin:0 auto;color:#111">` +
    `<div style="background:linear-gradient(135deg,#1a1030,#0a0712);border-radius:16px;padding:26px 24px;color:#fff">` +
      `<div style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#a78bfa">Your Energy Future${company ? ` · ${company}` : ""}</div>` +
      `<h1 style="margin:8px 0 4px;font-size:25px">Hi ${escHtml(first)}, your proposal is ready</h1>` +
      `${rec ? `<div style="color:#cfc7e2;font-size:14px">Recommended: <strong>${escHtml(String(rec.units))}× ${escHtml(rec.brand)} ${escHtml(rec.model)}</strong> · ${escHtml(String(rec.totalUsableKWh))} kWh usable · ~${escHtml(String(rec.backupDaysAchieved))} day backup</div>` : ""}` +
    `</div>` +
    `${roiRows}` +
    `<div style="text-align:center;margin:22px 0">` +
      `<a href="${url}" style="display:inline-block;background:#7c3aed;color:#fff;text-decoration:none;font-weight:600;font-size:16px;padding:14px 28px;border-radius:999px">▶ View your interactive proposal</a>` +
      `<div style="font-size:12px;color:#999;margin-top:8px">Tap to explore your home as a living energy system — solar, battery, backup &amp; savings.</div>` +
    `</div>` +
    `${incRows}` +
    `<p style="color:#999;font-size:12px;margin-top:20px">This link opens an interactive presentation${company ? ` from ${company}` : ""}. Figures are estimates for discussion and can change with final design and current incentive terms.</p>` +
    `</div>`;

  const text =
    `Hi ${first}, your energy proposal is ready.\n` +
    (rec ? `Recommended: ${rec.units}x ${rec.brand} ${rec.model} (${rec.totalUsableKWh} kWh usable, ~${rec.backupDaysAchieved} day backup).\n` : "") +
    (roi ? `Net cost after incentives: ${money(roi.netCost)} · Est. monthly savings: ${money(roi.monthlySavings)}.\n` : "") +
    `\nView your interactive proposal: ${url}\n`;

  const subject = `${payload.companyName ? payload.companyName + " — " : ""}Your interactive energy proposal`;
  const cfg = await getNotifyConfig();
  const r = await sendEmailDetailed(cfg, d.to, subject, text, undefined, html);
  if (!r.ok) throw new HttpsError("failed-precondition", r.detail);
  return { ok: true, url };
});

// Public (no auth): fetch a shared proposal payload by its unguessable id so the
// homeowner can open the interactive proposal from the emailed link.
export const getSharedProposal = onCall(async (request) => {
  const id = String(((request.data || {}) as { id?: string }).id || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 64);
  if (!id) throw new HttpsError("invalid-argument", "Missing proposal id.");
  const snap = await db.doc(`sharedProposals/${id}`).get();
  if (!snap.exists) throw new HttpsError("not-found", "This proposal link is no longer available.");
  const data = snap.data() || {};
  return { payload: data.payload || {} };
});

// ─── Battery purchase & installation agreement (e-sign + auto-close) ──────────
const money$ = (n: any) => (typeof n === "number" && isFinite(n) ? `$${Math.round(n).toLocaleString()}` : "—");
const agDate = (ms: number) => new Date(ms || Date.now()).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

// The standard agreement body as ordered sections. Used for both the on-screen
// (HTML) sign page and the PDF. installerName is left blank for the company to
// fill from the admin portal. NOTE: a standard template — have it reviewed by
// counsel for your jurisdiction.
function agreementSections(a: Record<string, any>): Array<{ h: string; body: string }> {
  const b = a.battery || {};
  const pay = a.payment || {};
  const sys = `${b.units || 1}× ${b.brand || ""} ${b.model || ""}`.trim();
  const specs = [
    b.totalUsableKWh ? `${b.totalUsableKWh} kWh usable` : "",
    b.totalContinuousKW ? `${b.totalContinuousKW} kW continuous` : "",
    b.backupDaysAchieved ? `~${b.backupDaysAchieved}-day backup` : "",
    b.chemistry ? `${b.chemistry} chemistry` : "",
  ].filter(Boolean).join(" · ");
  const installer = a.installerName || "______________________________ (to be completed by Seller)";
  const company = a.companyName || "Seller";

  let paymentBody: string;
  if (pay.method === "finance" && pay.finance) {
    const f = pay.finance;
    paymentBody =
      `Buyer elects to FINANCE the System. The total cash price is ${money$(pay.systemPrice)}. ` +
      `Financing is provided through ${f.lender || "the Seller's lending partner (Sungage Financial)"} under the ` +
      `"${f.name || "selected"}" plan: approximately ${money$(f.monthly)} per month, ${(Number(f.apr) * 100 || 0).toFixed(2)}% APR, ${f.termYears || 20}-year term` +
      `${f.escalator ? `, with a ${(f.escalator * 100).toFixed(1)}% annual payment escalator` : ""}` +
      `${f.deferred ? `, including a deferred-payment period` : ""}. ` +
      `Payment figures are estimates; the final rate, payment, and terms are set by the lender on credit approval and the executed lender loan documents control.`;
  } else {
    const c = pay.cash || {};
    const balance = typeof c.balance === "number" ? c.balance : Math.max(0, (pay.systemPrice || 0) - (c.depositUsd || 0));
    paymentBody =
      `Buyer elects to pay CASH. The total price is ${money$(pay.systemPrice || c.cashPrice)}. ` +
      `A deposit of ${money$(c.depositUsd)} is paid upon execution to reserve pricing and the installation schedule (fully credited to the total). ` +
      `The remaining balance of ${money$(balance)} is due upon completion of installation per the following schedule: ` +
      `(a) the deposit at signing; and (b) the balance upon substantial completion and passing of the required inspection.`;
  }

  return [
    { h: "1. Parties", body: `This Battery Purchase & Installation Agreement ("Agreement") is entered into between ${company} ("Seller"/"Installer") and ${a.customerName || "the homeowner"} ("Buyer") for the property at ${a.address || "the address on file"}.` },
    { h: "2. The System", body: `Seller will furnish and install: ${sys}${specs ? ` — ${specs}` : ""}, together with all balance-of-system components, mounting, and electrical work required for a complete, code-compliant battery energy storage installation ("System").` },
    { h: "3. Purchase Price & Payment", body: paymentBody },
    { h: "4. Scope of Work & Standard Installation", body: `Seller will perform a standard installation: mounting the equipment, electrical interconnection to the home's panel/backup loads, commissioning, and configuration of monitoring. Work is performed to the manufacturer's specifications and applicable electrical code. Non-standard work (e.g., main-panel upgrades, trenching, structural modifications, or additional circuits) discovered at site survey may require a written change order and price adjustment.` },
    { h: "5. Permits, Inspection & Interconnection", body: `Seller will obtain the permits required for the installation and coordinate the authority-having-jurisdiction inspection and any required utility interconnection approval. Installation timelines depend on permit and utility processing outside Seller's control.` },
    { h: "6. Warranties", body: `Manufacturer warranty: the battery and equipment carry the manufacturer's limited warranty (approximately ${b.warrantyYears || 10} years for the selected product), per the manufacturer's terms. Workmanship/Installation warranty: Seller warrants its installation workmanship against defects for the company's standard workmanship period. Warranties exclude damage from misuse, alteration, acts of nature, or work by others. This is a summary; the manufacturer and Seller written warranties control.` },
    { h: "7. Site Survey & Final Design", body: `This Agreement is based on the information available at signing and is subject to a site survey and final engineering. If the survey reveals conditions that materially change scope or cost, Seller will present a change order; Buyer may approve it or cancel for a refund of amounts paid less any non-recoverable costs already incurred.` },
    { h: "8. Right to Cancel", body: `Buyer may cancel this Agreement for any reason by written notice delivered within three (3) business days after signing and receive a full refund of any deposit, in accordance with applicable law.` },
    { h: "9. Limitation of Liability", body: `To the maximum extent permitted by law, Seller's total liability arising out of or relating to this Agreement will not exceed the total price paid by Buyer. Neither party is liable for indirect, incidental, special, or consequential damages.` },
    { h: "10. Entire Agreement & Governing Law", body: `This Agreement, together with any executed lender loan documents and written change orders, is the entire agreement between the parties. It is governed by the laws of the state in which the property is located. If any provision is unenforceable, the remainder stays in effect.` },
    { h: "Installer", body: `Installer / contractor of record: ${installer}. License #: ____________________.` },
  ];
}

function buildAgreementPdf(a: Record<string, any>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 56, size: "LETTER" });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const dateStr = agDate(a.createdAt || Date.now());
    doc.fontSize(19).fillColor("#6d28d9").text(a.companyName || "Battery Agreement");
    doc.fillColor("#000").fontSize(14).text("Battery Purchase & Installation Agreement").moveDown(0.2);
    doc.fontSize(10).fillColor("#555").text(`Date: ${dateStr}`);
    if (a.reference) doc.text(`Agreement ref: ${a.reference}`);
    doc.fillColor("#000").fontSize(11).moveDown(0.6);

    for (const s of agreementSections(a)) {
      doc.moveDown(0.5).fontSize(12).fillColor("#2a1e55").text(s.h).moveDown(0.1).fillColor("#000").fontSize(10).text(s.body);
    }

    // Signature block — stamped if e-signed.
    doc.moveDown(1.2).fontSize(12).fillColor("#2a1e55").text("Acceptance").fillColor("#000").fontSize(10).moveDown(0.3);
    doc.text("By signing below, Buyer agrees to the terms of this Agreement.");
    doc.moveDown(1);
    if (a.signedName) {
      try {
        if (typeof a.signatureDataUrl === "string" && a.signatureDataUrl.startsWith("data:image")) {
          const b64 = a.signatureDataUrl.split(",")[1];
          doc.image(Buffer.from(b64, "base64"), { width: 200 });
        }
      } catch { /* ignore bad signature image */ }
      doc.fillColor("#2a1e55").text(`Signed electronically by: ${a.signedName}`).fillColor("#000");
      doc.text(`Date: ${agDate(a.signedAt || Date.now())}`);
      if (a.signedIp) doc.fontSize(8).fillColor("#888").text(`IP: ${a.signedIp}`).fillColor("#000").fontSize(10);
    } else {
      doc.text("Buyer signature: ________________________________");
      doc.moveDown(0.6);
      doc.text(`Printed name: ${a.customerName || "________________________________"}`);
      doc.moveDown(0.6);
      doc.text("Date: ________________________________");
    }
    doc.moveDown(1.2);
    doc.text(`Seller: ${a.companyName || ""}    By: ____________________________   (${a.closerName || "Sales representative"})`);

    doc.end();
  });
}

// Closer creates the agreement from the proposal + chosen payment. Returns a
// sign link for on-device signing or to email the customer.
export const createBatteryAgreement = onCall(async (request) => {
  const caller = await getCaller(request);
  const d = (request.data || {}) as Record<string, any>;
  const companyId = caller.companyId || d.companyId || null;
  const company = companyId ? (await db.doc(`companies/${companyId}`).get()).data() || {} : {};
  const id = crypto.randomUUID().replace(/-/g, "");
  const token = crypto.randomBytes(16).toString("hex");
  const now = Date.now();
  const agreement = {
    customerName: String(d.customerName || "").slice(0, 200),
    customerEmail: String(d.customerEmail || "").slice(0, 200),
    address: String(d.address || "").slice(0, 300),
    companyId,
    companyName: company.name || d.companyName || "",
    closerUid: caller.uid,
    closerName: String(d.closerName || "").slice(0, 200),
    leadId: d.leadId || null,
    eventId: d.eventId || null,
    battery: d.battery || {},
    payment: d.payment || {},
    installerName: company.agreementInstallerName || "",
    templateUrl: company.agreementTemplateUrl || "",
    ccEmails: Array.isArray(company.agreementCcEmails) ? company.agreementCcEmails : [],
    reference: id.slice(0, 8).toUpperCase(),
    signToken: token,
    status: "sent",
    signedName: "",
    signedAt: 0,
    createdAt: now,
  };
  await db.doc(`battery_agreements/${id}`).set(agreement);
  const signUrl = `${APP_URL}/app/?agreement=${id}&t=${token}`;

  // Optionally email the customer the sign link.
  if (d.delivery === "email" && agreement.customerEmail && /.+@.+\..+/.test(agreement.customerEmail)) {
    const first = agreement.customerName.split(" ")[0] || "there";
    const html =
      `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111">` +
      `<h2>Your battery agreement is ready to sign</h2>` +
      `<p>Hi ${escHtml(first)}, please review and sign your Battery Purchase &amp; Installation Agreement${agreement.companyName ? ` with ${escHtml(agreement.companyName)}` : ""}.</p>` +
      `<p style="text-align:center;margin:22px 0"><a href="${signUrl}" style="display:inline-block;background:#7c3aed;color:#fff;text-decoration:none;font-weight:600;padding:13px 26px;border-radius:999px">Review &amp; sign →</a></p>` +
      `<p style="color:#999;font-size:12px">If you didn't request this, you can ignore this email.</p></div>`;
    const cfg = await getNotifyConfig();
    await sendEmailDetailed(cfg, agreement.customerEmail, "Sign your battery agreement", `Review and sign: ${signUrl}`, undefined, html);
  }
  return { ok: true, id, token, signUrl };
});

// Public (no auth): load an agreement for the sign page by id + token.
export const getBatteryAgreement = onCall(async (request) => {
  const d = (request.data || {}) as { id?: string; t?: string };
  const id = String(d.id || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 64);
  const snap = id ? await db.doc(`battery_agreements/${id}`).get() : null;
  if (!snap || !snap.exists) throw new HttpsError("not-found", "This agreement link is no longer available.");
  const a = snap.data() as Record<string, any>;
  if (!d.t || d.t !== a.signToken) throw new HttpsError("permission-denied", "Invalid agreement link.");
  return {
    customerName: a.customerName, address: a.address, companyName: a.companyName,
    battery: a.battery, payment: a.payment, reference: a.reference,
    sections: agreementSections(a), templateUrl: a.templateUrl || "",
    status: a.status, signedName: a.signedName || "", signedAt: a.signedAt || 0,
  };
});

// Public (no auth): record the signature, email the signed copy to everyone,
// notify the company, mark the appointment closed/won, and record the sale.
export const signBatteryAgreement = onCall(async (request) => {
  const d = (request.data || {}) as { id?: string; t?: string; name?: string; signatureDataUrl?: string };
  const id = String(d.id || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 64);
  const ref = id ? db.doc(`battery_agreements/${id}`) : null;
  const snap = ref ? await ref.get() : null;
  if (!ref || !snap || !snap.exists) throw new HttpsError("not-found", "Agreement not found.");
  const a = snap.data() as Record<string, any>;
  if (!d.t || d.t !== a.signToken) throw new HttpsError("permission-denied", "Invalid agreement link.");
  if (a.status === "signed") return { ok: true, alreadySigned: true };
  const name = String(d.name || "").trim();
  if (!name) throw new HttpsError("invalid-argument", "Please type your full name to sign.");

  const now = Date.now();
  const sig = typeof d.signatureDataUrl === "string" && d.signatureDataUrl.startsWith("data:image") ? d.signatureDataUrl.slice(0, 400_000) : "";
  const ip = (request.rawRequest?.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || "";
  const signed = { ...a, signedName: name, signedAt: now, signedIp: ip, signatureDataUrl: sig, status: "signed" };
  await ref.set({ signedName: name, signedAt: now, signedIp: ip, signatureDataUrl: sig, status: "signed", updatedAt: now }, { merge: true });

  // Build the signed PDF once.
  let pdf: Buffer | null = null;
  try { pdf = await buildAgreementPdf(signed); } catch (e) { logger.warn("agreement pdf failed", e); }
  const attachments = pdf ? [{ filename: `Battery-Agreement-${a.reference}.pdf`, content: pdf.toString("base64"), type: "application/pdf" }] : undefined;

  // Recipients: customer + closer + company admins/managers + configured CCs.
  const recipients = new Set<string>();
  if (a.customerEmail) recipients.add(a.customerEmail);
  (a.ccEmails || []).forEach((e: string) => { if (e) recipients.add(e); });
  try {
    const closer = a.closerUid ? (await db.doc(`users/${a.closerUid}`).get()).data() : null;
    if (closer?.email) recipients.add(closer.email);
    if (a.companyId) {
      const mgrs = await db.collection("users").where("companyId", "==", a.companyId).where("role", "in", ["admin", "manager"]).get();
      mgrs.forEach((u) => { const e = (u.data() as any).email; if (e) recipients.add(e); });
    }
  } catch (e) { logger.warn("agreement recipients lookup failed", e); }

  const cfg = await getNotifyConfig();
  const subject = `Signed battery agreement — ${a.customerName || ""} (${a.reference})`;
  const html =
    `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111">` +
    `<h2>Agreement signed ✅</h2>` +
    `<p><strong>${escHtml(a.customerName || "")}</strong> signed the Battery Purchase &amp; Installation Agreement${a.companyName ? ` with ${escHtml(a.companyName)}` : ""} on ${agDate(now)}.</p>` +
    `<p>${escHtml(a.address || "")}</p>` +
    `<p>A copy of the signed agreement is attached.</p></div>`;
  for (const to of recipients) {
    try { await sendEmailDetailed(cfg, to, subject, `${a.customerName} signed the agreement (${a.reference}).`, attachments, html); } catch (e) { logger.warn(`agreement email to ${to} failed`, e); }
  }

  // Record the sale.
  try {
    await db.doc(`soldCustomers/${id}`).set({
      agreementId: id, companyId: a.companyId, closerUid: a.closerUid, customerName: a.customerName,
      customerEmail: a.customerEmail, address: a.address, battery: a.battery, payment: a.payment,
      leadId: a.leadId, eventId: a.eventId, reference: a.reference, signedName: name, signedAt: now,
      status: "sold", createdAt: now,
    }, { merge: true });
  } catch (e) { logger.warn("soldCustomers write failed", e); }

  // Auto-disposition the appointment as Closed / Won.
  if (a.eventId) {
    try {
      await db.doc(`events/${a.eventId}`).set({
        apptStatus: "closed_won",
        apptNotes: `Battery agreement signed by ${name} (ref ${a.reference}).`,
        dispositionedAt: now, agreementId: id, updatedAt: now,
      }, { merge: true });
    } catch (e) { logger.warn("auto-disposition failed", e); }
  }
  if (a.leadId) {
    try { await db.doc(`leads/${a.leadId}`).set({ status: "sold", soldAt: now, agreementId: id }, { merge: true }); } catch { /* best effort */ }
  }

  return { ok: true };
});

// Sold projects for the field app. Reps see only their own (bullet summary);
// admins/managers see the whole company with full survey detail.
export const listMyProjects = onCall(async (request) => {
  const caller = await getCaller(request);
  const isMgr = caller.isSuper || caller.role === "admin" || caller.role === "manager";
  if (!caller.companyId && !caller.isSuper) return { items: [], isManager: false };
  let q: FirebaseFirestore.Query = db.collection("soldCustomers");
  if (isMgr) q = q.where("companyId", "==", caller.companyId);
  else q = q.where("closerUid", "==", caller.uid);
  let snap;
  try { snap = await q.get(); } catch (e) { logger.warn("listMyProjects query failed", e); return { items: [], isManager: isMgr }; }
  const items = snap.docs.map((doc) => {
    const x = doc.data() as Record<string, any>;
    const bat = x.battery || {};
    const pay = x.payment || {};
    const base = {
      id: doc.id,
      customerName: x.customerName || "",
      address: x.address || "",
      battery: `${bat.units || 1}× ${bat.brand || ""} ${bat.model || ""}`.trim(),
      batteryProductId: bat.productId || "",
      paymentMethod: pay.method || "",
      reference: x.reference || "",
      status: x.surveyStatus || "needs_survey",
      signedAt: x.signedAt || 0,
      submittedAt: x.surveySubmittedAt || 0,
    };
    // Admin/manager (and the PM portal) get the full record.
    return isMgr
      ? {
          ...base,
          customerEmail: x.customerEmail || "",
          signedName: x.signedName || "",
          payment: pay,
          batteryDetail: bat,
          survey: x.survey || null,
          placement: x.placement || [],
          surveyNotes: x.surveyNotes || "",
          surveyScheduledFor: x.surveyScheduledFor || 0,
          pmStatus: x.pmStatus || "",
          pmNotes: x.pmNotes || "",
          installerName: x.installerName || "",
          installDate: x.installDate || 0,
        }
      : base;
  });
  items.sort((a, b) => (b.signedAt || 0) - (a.signedAt || 0));
  return { items, isManager: isMgr };
});

// A rep submits the placement photos + site survey for a sold project; notify
// the company's project managers/admins for review.
export const submitProjectSurvey = onCall(async (request) => {
  const caller = await getCaller(request);
  const d = (request.data || {}) as {
    projectId?: string;
    placement?: Array<{ url?: string; note?: string }>;
    survey?: { photos?: Record<string, string>; checklist?: Record<string, boolean> };
    notes?: string;
  };
  const id = String(d.projectId || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 64);
  if (!id) throw new HttpsError("invalid-argument", "Missing project id.");
  const ref = db.doc(`soldCustomers/${id}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Project not found.");
  const proj = snap.data() as Record<string, any>;
  const isMgr = caller.isSuper || (caller.companyId === proj.companyId && (caller.role === "admin" || caller.role === "manager"));
  if (proj.closerUid !== caller.uid && !isMgr) throw new HttpsError("permission-denied", "Not your project.");

  const placement = (Array.isArray(d.placement) ? d.placement : [])
    .slice(0, 3)
    .map((p) => ({ url: String(p?.url || "").slice(0, 800), note: String(p?.note || "").slice(0, 300) }))
    .filter((p) => p.url);
  const photos: Record<string, string> = {};
  for (const [k, v] of Object.entries(d.survey?.photos || {})) {
    if (typeof v === "string" && v) photos[k.slice(0, 40)] = v.slice(0, 800);
  }
  const checklist: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(d.survey?.checklist || {})) checklist[k.slice(0, 40)] = !!v;

  const now = Date.now();
  await ref.set({
    placement,
    survey: { photos, checklist },
    surveyNotes: String(d.notes || "").slice(0, 2000),
    surveyStatus: "submitted_for_review",
    surveySubmittedAt: now,
    surveySubmittedBy: caller.uid,
    updatedAt: now,
  }, { merge: true });

  // Notify the company's PMs/admins.
  try {
    const recipients = new Set<string>();
    (proj.ccEmails || []).forEach((e: string) => { if (e) recipients.add(e); });
    if (proj.companyId) {
      const mgrs = await db.collection("users").where("companyId", "==", proj.companyId).where("role", "in", ["admin", "manager"]).get();
      mgrs.forEach((u) => { const e = (u.data() as any).email; if (e) recipients.add(e); });
    }
    if (recipients.size) {
      const cfg = await getNotifyConfig();
      const subject = `Site survey submitted — ${proj.customerName || ""} (${proj.reference || id.slice(0, 8)})`;
      const html =
        `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111">` +
        `<h2>Site survey ready for review</h2>` +
        `<p><strong>${escHtml(proj.customerName || "")}</strong> — ${escHtml(proj.address || "")}</p>` +
        `<p>${placement.length} placement photo(s) and ${Object.keys(photos).length} survey photo(s) submitted by the sales rep. Open the admin portal to review and schedule.</p></div>`;
      for (const to of recipients) {
        try { await sendEmailDetailed(cfg, to, subject, `${proj.customerName} site survey submitted for review.`, undefined, html); } catch { /* best effort */ }
      }
    }
  } catch (e) { logger.warn("survey notify failed", e); }

  return { ok: true };
});

// Schedule the site survey for later instead of doing it now. Saves the AR
// placement photos already taken, creates a site-survey calendar event for the
// rep, and notifies the company.
export const scheduleSiteSurvey = onCall(async (request) => {
  const caller = await getCaller(request);
  const d = (request.data || {}) as {
    projectId?: string;
    startAt?: number;
    placement?: Array<{ url?: string; note?: string }>;
    notes?: string;
  };
  const id = String(d.projectId || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 64);
  if (!id) throw new HttpsError("invalid-argument", "Missing project id.");
  if (!d.startAt || d.startAt < Date.now() - 86400000) throw new HttpsError("invalid-argument", "Pick a valid date/time.");
  const ref = db.doc(`soldCustomers/${id}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Project not found.");
  const proj = snap.data() as Record<string, any>;
  const isMgr = caller.isSuper || (caller.companyId === proj.companyId && (caller.role === "admin" || caller.role === "manager"));
  if (proj.closerUid !== caller.uid && !isMgr) throw new HttpsError("permission-denied", "Not your project.");

  const placement = (Array.isArray(d.placement) ? d.placement : [])
    .slice(0, 3)
    .map((p) => ({ url: String(p?.url || "").slice(0, 800), note: String(p?.note || "").slice(0, 300) }))
    .filter((p) => p.url);

  const now = Date.now();
  const me = (await db.doc(`users/${caller.uid}`).get()).data() as any || {};
  const visibility = Array.from(new Set([caller.uid, ...((me.managerPath as string[]) || []), ...((me.closerManagerPath as string[]) || [])]));
  const ev = {
    companyId: proj.companyId || caller.companyId || "",
    userId: caller.uid,
    userName: me.displayName || me.email || "",
    type: "site_survey",
    title: `Site survey — ${proj.customerName || ""}`.trim(),
    address: proj.address || "",
    leadId: proj.leadId || null,
    projectId: id,
    customerName: proj.customerName || "",
    startAt: d.startAt,
    endAt: d.startAt + 60 * 60 * 1000,
    durationMin: 60,
    source: "site_survey",
    notes: String(d.notes || "").slice(0, 2000),
    apptStatus: "scheduled",
    visibilityPath: visibility,
    reminded: false,
    createdAt: now,
  };
  const evRef = await db.collection("events").add(ev);

  await ref.set({
    placement,
    surveyNotes: String(d.notes || "").slice(0, 2000),
    surveyStatus: "survey_scheduled",
    surveyScheduledFor: d.startAt,
    surveyEventId: evRef.id,
    updatedAt: now,
  }, { merge: true });

  // Notify PMs/admins.
  try {
    const recipients = new Set<string>();
    (proj.ccEmails || []).forEach((e: string) => { if (e) recipients.add(e); });
    if (proj.companyId) {
      const mgrs = await db.collection("users").where("companyId", "==", proj.companyId).where("role", "in", ["admin", "manager"]).get();
      mgrs.forEach((u) => { const e = (u.data() as any).email; if (e) recipients.add(e); });
    }
    if (recipients.size) {
      const cfg = await getNotifyConfig();
      const when = agDate(d.startAt);
      const subject = `Site survey scheduled — ${proj.customerName || ""} (${proj.reference || id.slice(0, 8)})`;
      const html = `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111"><h2>Site survey scheduled</h2><p><strong>${escHtml(proj.customerName || "")}</strong> — ${escHtml(proj.address || "")}</p><p>Scheduled for <strong>${escHtml(when)}</strong>. ${placement.length} placement photo(s) already captured.</p></div>`;
      for (const to of recipients) { try { await sendEmailDetailed(cfg, to, subject, `Site survey for ${proj.customerName} scheduled ${when}.`, undefined, html); } catch { /* best effort */ } }
    }
  } catch (e) { logger.warn("schedule notify failed", e); }

  return { ok: true };
});

// PM portal: advance a project through the install pipeline. Manager/admin only.
const PM_STAGES = ["review", "approved", "permitting", "scheduled", "installed", "on_hold"];
export const updateProjectStatus = onCall(async (request) => {
  const caller = await getCaller(request);
  const d = (request.data || {}) as { projectId?: string; pmStatus?: string; pmNotes?: string; installerName?: string; installDate?: number };
  const id = String(d.projectId || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 64);
  if (!id) throw new HttpsError("invalid-argument", "Missing project id.");
  const ref = db.doc(`soldCustomers/${id}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Project not found.");
  const proj = snap.data() as Record<string, any>;
  const isMgr = caller.isSuper || (caller.companyId === proj.companyId && (caller.role === "admin" || caller.role === "manager"));
  if (!isMgr) throw new HttpsError("permission-denied", "Project-management access required.");

  const now = Date.now();
  const patch: Record<string, unknown> = { updatedAt: now };
  if (d.pmStatus !== undefined) {
    const s = String(d.pmStatus || "");
    if (s && !PM_STAGES.includes(s)) throw new HttpsError("invalid-argument", "Unknown stage.");
    patch.pmStatus = s;
    patch.pmStatusAt = now;
  }
  if (d.pmNotes !== undefined) patch.pmNotes = String(d.pmNotes || "").slice(0, 4000);
  if (d.installerName !== undefined) patch.installerName = String(d.installerName || "").slice(0, 200);
  if (d.installDate !== undefined) patch.installDate = Math.max(0, Number(d.installDate) || 0);
  await ref.set(patch, { merge: true });

  // Let the rep know when the stage changes.
  if (d.pmStatus && proj.closerUid) {
    try {
      const closer = (await db.doc(`users/${proj.closerUid}`).get()).data() as any;
      if (closer?.email) {
        const cfg = await getNotifyConfig();
        const label = String(d.pmStatus).replace(/_/g, " ");
        await sendEmailDetailed(cfg, closer.email, `Project update — ${proj.customerName || ""}`, `Your deal ${proj.customerName || ""} (${proj.reference || ""}) is now: ${label}.`, undefined,
          `<div style="font-family:system-ui,Arial,sans-serif"><p>Your deal <strong>${escHtml(proj.customerName || "")}</strong> (${escHtml(proj.reference || "")}) is now: <strong>${escHtml(label)}</strong>.</p>${d.installDate ? `<p>Install date: <strong>${escHtml(agDate(Number(d.installDate)))}</strong></p>` : ""}</div>`);
      }
    } catch (e) { logger.warn("pm status notify failed", e); }
  }
  return { ok: true };
});

// Admin: set company-wide battery pricing (price + install adder per product).
export const setBatteryPricing = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, pricing, offered, depositUsd, depositPct, sungageApplyUrl, agreementInstallerName, agreementCcEmails, agreementTemplateUrl } = (request.data || {}) as {
    companyId?: string;
    pricing?: Record<string, { price?: number; adder?: number }>;
    offered?: string[];
    depositUsd?: number;
    depositPct?: number;
    sungageApplyUrl?: string;
    agreementInstallerName?: string;
    agreementCcEmails?: string[];
    agreementTemplateUrl?: string;
  };
  authorizeForCompany(caller, companyId);
  const clean: Record<string, { price: number; adder: number }> = {};
  for (const [pid, v] of Object.entries(pricing || {})) {
    const price = Math.max(0, Number(v?.price) || 0);
    const adder = Math.max(0, Number(v?.adder) || 0);
    if (price > 0 || adder > 0) clean[pid] = { price, adder };
  }
  const patch: Record<string, unknown> = { batteryPricing: clean, batteryPricingUpdatedAt: Date.now() };
  // Which products the company offers its reps. Only stored when provided so we
  // can treat "unset" as "offer everything" for existing companies.
  if (Array.isArray(offered)) patch.batteryOffered = offered.filter((x) => typeof x === "string").slice(0, 50);
  // Proposal pricing-slide settings (only written when provided).
  if (depositUsd !== undefined) patch.batteryDepositUsd = Math.max(0, Math.round(Number(depositUsd) || 0));
  if (depositPct !== undefined) patch.batteryDepositPct = Math.max(0, Math.min(100, Number(depositPct) || 0));
  if (sungageApplyUrl !== undefined) patch.sungageApplyUrl = String(sungageApplyUrl || "").trim().slice(0, 600);
  if (agreementInstallerName !== undefined) patch.agreementInstallerName = String(agreementInstallerName || "").trim().slice(0, 200);
  if (agreementTemplateUrl !== undefined) patch.agreementTemplateUrl = String(agreementTemplateUrl || "").trim().slice(0, 600);
  if (agreementCcEmails !== undefined) {
    patch.agreementCcEmails = (Array.isArray(agreementCcEmails) ? agreementCcEmails : [])
      .map((e) => String(e || "").trim()).filter((e) => /.+@.+\..+/.test(e)).slice(0, 20);
  }
  await db.doc(`companies/${companyId}`).set(patch, { merge: true });
  return { ok: true };
});

// Analyze an uploaded utility bill or solar-production document (image or PDF)
// with Claude vision and return structured numbers for the battery tool.
export const analyzeEnergyDocument = onCall({ timeoutSeconds: 120 }, async (request) => {
  await getCaller(request);
  const { base64, mediaType, kind } = (request.data || {}) as { base64?: string; mediaType?: string; kind?: "bill" | "solar" };
  if (!base64 || !mediaType) throw new HttpsError("invalid-argument", "A file (base64 + mediaType) is required.");
  // ~7MB raw → ~9.5MB base64; keep within the callable payload ceiling.
  if (base64.length > 9_500_000) throw new HttpsError("invalid-argument", "File too large — please upload one under 7 MB.");
  const cfg = await readAiConfig();
  if (!cfg.anthropicKey) throw new HttpsError("failed-precondition", "Document analysis isn't configured — ask your admin to add an Anthropic key.");
  const isPdf = mediaType === "application/pdf";
  const fileBlock = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
    : { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } };
  const ask = kind === "solar"
    ? 'This is a solar-monitoring screenshot or report. Extract the PV system + production info. Reply with ONLY a JSON object (no prose): {"systemKwDc":<number|null>,"annualProductionKWh":<number|null>,"monthlyProductionKWh":<number|null>,"inverterBrand":<string|null>,"notes":"<what you saw / caveats>"}.'
    : 'This is a residential electricity (utility) bill. Extract usage + cost. Reply with ONLY a JSON object (no prose): {"monthlyKWh":<number|null>,"monthlyCost":<number|null>,"ratePerKWh":<number|null>,"utilityName":<string|null>,"billingDays":<number|null>,"notes":"<what you saw / caveats>"}. If the bill shows a billing period other than a month, still report the monthly figures (normalize to ~30 days).';
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": cfg.anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: cfg.anthropicModel, max_tokens: 700,
      messages: [{ role: "user", content: [fileBlock, { type: "text", text: ask }] }],
    }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpsError("internal", json?.error?.message || `Document analysis failed (${res.status})`);
  const text = (Array.isArray(json.content) ? json.content : []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  const m = text.match(/\{[\s\S]*\}/);
  let data: any = {};
  try { data = m ? JSON.parse(m[0]) : {}; } catch { data = {}; }
  return { kind: kind || "bill", data };
});

// Real imagery of the customer's home for the proposal hero — Street View (if the
// address has coverage) with a satellite/aerial fallback. Images are returned as
// base64 data URIs so the Google Maps key never leaves the server.
export const getHomeImagery = onCall({ timeoutSeconds: 60 }, async (request) => {
  await getCaller(request);
  let { lat, lng } = (request.data || {}) as { lat?: number; lng?: number };
  const { address } = (request.data || {}) as { address?: string };
  await refreshApiConfig();
  if (!GMAPS.key) throw new HttpsError("failed-precondition", "Home imagery isn't configured — ask your admin to add a Google Maps API key.");
  const key = GMAPS.key;
  // Geocode the address when we don't already have coordinates.
  if ((typeof lat !== "number" || typeof lng !== "number") && address) {
    try {
      const g: any = await (await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`)).json();
      const loc = g?.results?.[0]?.geometry?.location;
      if (loc) { lat = loc.lat; lng = loc.lng; }
    } catch (e) { logger.warn("geocode failed", e); }
  }
  if (typeof lat !== "number" || typeof lng !== "number") throw new HttpsError("invalid-argument", "Need an address or coordinates.");
  const fetchImg = async (url: string): Promise<string | null> => {
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      const ct = r.headers.get("content-type") || "image/jpeg";
      if (!ct.startsWith("image/")) return null; // Google returns JSON on error
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 1500) return null; // tiny = "no imagery" placeholder
      return `data:${ct};base64,${buf.toString("base64")}`;
    } catch { return null; }
  };
  // Street View coverage check first (avoids the gray "no image" tile).
  let hasStreetView = false;
  try {
    const meta: any = await (await fetch(`https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&source=outdoor&key=${key}`)).json();
    hasStreetView = meta?.status === "OK";
  } catch { /* fall back to satellite */ }
  const [streetView, satellite] = await Promise.all([
    hasStreetView ? fetchImg(`https://maps.googleapis.com/maps/api/streetview?size=640x360&location=${lat},${lng}&fov=78&pitch=8&source=outdoor&key=${key}`) : Promise.resolve(null),
    fetchImg(`https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=20&size=640x360&maptype=satellite&key=${key}`),
  ]);
  return { streetView, satellite, hasStreetView: !!streetView, lat, lng };
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
  const { companyId, orgId } = (request.data || {}) as { companyId?: string; orgId?: string };
  let q: FirebaseFirestore.Query = db.collection("invoices");
  if (orgId) {
    // Org/enterprise admins (and super) can list their organization's invoices.
    await authorizeForOrg(caller, orgId);
    q = q.where("organizationId", "==", orgId);
  } else if (caller.isSuper) {
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
// Build a per-plan service agreement PDF (returned as a Buffer) for the
// customer to sign and return. Parameterized by the company's plan + price and,
// for enterprise orgs, the per-company / org-wide fees.
function buildContractPdf(opts: {
  companyName: string; contactName: string; plan: string; monthly: number;
  enterprise: boolean; perCompanyFee: number; orgFee: number; dateStr: string;
  referenceNumber?: string;
  // When the customer has e-signed (sign-then-pay), stamp the acceptance block.
  signedName?: string; signedDateStr?: string;
  // When the Provider (super-admin) has counter-signed, stamp that block too.
  providerSignedName?: string; providerSignedDateStr?: string;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 56, size: "LETTER" });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const H = (t: string) => doc.moveDown(0.7).fontSize(13).fillColor("#0b2a44").text(t).moveDown(0.15).fillColor("#000").fontSize(11);
    doc.fontSize(20).fillColor("#0EA5E9").text(PRODUCT_NAME);
    doc.fillColor("#666").fontSize(9).text(`a product of ${PROVIDER_LEGAL_NAME}`);
    doc.fillColor("#000").fontSize(14).text("Service Agreement").moveDown(0.2);
    doc.fontSize(10).fillColor("#555").text(`Date: ${opts.dateStr}`);
    if (opts.referenceNumber) doc.fillColor("#555").text(`Agreement ref: ${opts.referenceNumber}`);
    doc.fillColor("#000").fontSize(11).moveDown(0.8);

    doc.text(`This Service Agreement ("Agreement") is between ${PROVIDER_LEGAL_NAME}, provider of the ${PRODUCT_NAME} platform ("Provider"), and ${opts.companyName} ("Customer").`);

    H("1. Service & Plan");
    doc.text(`Provider will make the ${PRODUCT_NAME} platform available to Customer under the "${opts.plan}" plan at $${opts.monthly} per month.`);
    if (opts.enterprise) {
      doc.text(`Enterprise terms apply: an additional $${opts.perCompanyFee} per company and $${opts.orgFee} per organization, per month.`);
    }

    H("2. Recurring Billing & Cancellation");
    doc.text(`This is a recurring monthly fee. The plan covers up to 100 users across all of Customer's organizations; each additional user beyond 100 is billed at $85 per user, per month. The card on file is automatically charged on a 30-day cycle based on the companies and users on the account. Customer must provide written notice of cancellation at least 30 days in advance; charges already billed for the then-current cycle are non-refundable.`);

    H("3. Billing — Due on Receipt");
    doc.text("Invoices are due on receipt. If an invoice is not paid, Provider may suspend access to the platform until payment is received. Suspension does not delete Customer data.");

    H("4. Term & Termination");
    doc.text("This Agreement continues month-to-month until terminated by either party with written notice as described in Section 2. Provider may suspend or terminate the service for non-payment.");

    H("5. Data");
    doc.text(`Customer owns its data. Provider stores and processes it solely to provide the service, in accordance with the Privacy Policy at ${PRIVACY_URL}.`);

    H("6. Limitation of Liability");
    doc.text(`To the maximum extent permitted by law, Provider's total liability arising out of or related to this Agreement will not exceed the amounts paid by Customer to Provider in the three (3) months preceding the claim. Neither party will be liable for indirect, incidental, special, or consequential damages. The service is provided "as is" without warranties of any kind.`);

    H("7. Governing Law");
    doc.text(`This Agreement is governed by the laws of the State of ${GOVERNING_LAW_STATE}, without regard to its conflict-of-laws rules. The parties consent to the exclusive jurisdiction of the state and federal courts located in ${GOVERNING_LAW_STATE}.`);

    H("8. Acceptance");
    doc.text("This Agreement is executed by the Provider first and then by the Customer. By signing below, each party agrees to the terms of this Agreement.");

    // Provider counter-signature (executed first) — stamped if signed.
    doc.moveDown(1.4);
    doc.text(`Provider: ${PROVIDER_LEGAL_NAME}`);
    doc.moveDown(1);
    if (opts.providerSignedName) {
      doc.fillColor("#0b2a44").text(`Signed electronically by: ${opts.providerSignedName}`).fillColor("#000");
      doc.moveDown(0.5);
      doc.text(`Date: ${opts.providerSignedDateStr || opts.dateStr}`);
    } else {
      doc.text("Signature: ________________________________");
      doc.moveDown(0.7);
      doc.text("Date: ________________________________");
    }

    // Customer signature — stamped if e-signed, otherwise a blank line to sign.
    doc.moveDown(1.4);
    doc.text(`Customer: ${opts.companyName}`);
    doc.moveDown(1);
    if (opts.signedName) {
      doc.fillColor("#0b2a44").text(`Signed electronically by: ${opts.signedName}`).fillColor("#000");
      doc.moveDown(0.5);
      doc.text(`Date: ${opts.signedDateStr || opts.dateStr}`);
    } else {
      doc.text("Signature: ________________________________");
      doc.moveDown(0.7);
      doc.text(`Printed name: ${opts.contactName || "________________________________"}`);
      doc.moveDown(0.7);
      doc.text("Date: ________________________________");
    }

    doc.end();
  });
}

// Build the company's per-plan service agreement PDF (with enterprise terms if
// the company is in an enterprise org). Shared by the invoice email + preview.
// `sig` stamps the acceptance block once the customer has e-signed.
interface ContractSig {
  referenceNumber?: string;
  signedName?: string; signedAt?: number;
  providerSignedName?: string; providerSignedAt?: number;
}
const contractDateFmt = (ms: number) => new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

async function buildCompanyContractPdf(companyId: string, opts?: ContractSig): Promise<Buffer> {
  const company = (await db.doc(`companies/${companyId}`).get()).data() || {};
  let enterprise = false, perCompanyFee = 0, orgFee = 0;
  if (company.organizationId) {
    const org = (await db.doc(`organizations/${company.organizationId}`).get()).data();
    if (org && org.enterprise) {
      enterprise = true;
      perCompanyFee = Number(org.perCompanyFee) || 0;
      orgFee = Number(org.orgFee) || 0;
    }
  }
  return buildContractPdf({
    companyName: (company.name as string) || "Customer",
    contactName: ((company.billingContactName as string) || "").trim(),
    plan: (company.plan as string) || "Standard",
    monthly: Number(company.planPrice) || 0,
    enterprise, perCompanyFee, orgFee,
    dateStr: contractDateFmt(Date.now()),
    referenceNumber: opts?.referenceNumber,
    signedName: opts?.signedName,
    signedDateStr: opts?.signedAt ? contractDateFmt(opts.signedAt) : undefined,
    providerSignedName: opts?.providerSignedName,
    providerSignedDateStr: opts?.providerSignedAt ? contractDateFmt(opts.providerSignedAt) : undefined,
  });
}

// Build a printable invoice PDF (itemized) for attaching to the invoice email
// and downloading from the console. Works for company- and org-scoped invoices.
function buildInvoicePdf(inv: Record<string, any>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 56, size: "LETTER" });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const money = (cents: number) => "$" + ((cents || 0) / 100).toFixed(2);
    const dateFmt = (ms: number) => new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

    doc.fontSize(20).fillColor("#0EA5E9").text(PRODUCT_NAME);
    doc.fillColor("#666").fontSize(9).text(`a product of ${PROVIDER_LEGAL_NAME}`).moveDown(0.6);
    doc.fillColor("#000").fontSize(16).text("Invoice");
    doc.fontSize(10).fillColor("#555")
      .text(`Invoice #: ${inv.number || inv.id || ""}`)
      .text(`Date: ${dateFmt(inv.created || Date.now())}`)
      .text(`Due: ${inv.dueDate ? dateFmt(inv.dueDate) : "On receipt"}`)
      .text(`Status: ${inv.status || "open"}`);
    doc.moveDown(0.6).fillColor("#000").fontSize(11)
      .text(`From: ${PROVIDER_LEGAL_NAME}`)
      .text(`Bill to: ${inv.companyName || ""}`);

    // Line-items table.
    doc.moveDown(1);
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const amountX = right - 90;
    doc.fontSize(10).fillColor("#0b2a44")
      .text("Description", left, doc.y, { continued: true })
      .text("Amount", amountX, doc.y, { align: "right" });
    doc.moveTo(left, doc.y + 2).lineTo(right, doc.y + 2).strokeColor("#cccccc").stroke();
    doc.moveDown(0.5).fillColor("#000").fontSize(11);
    const lines: Array<{ description?: string; amount?: number }> =
      Array.isArray(inv.lines) && inv.lines.length ? inv.lines : [{ description: "Subscription", amount: inv.amountDue }];
    for (const l of lines) {
      const y = doc.y;
      doc.text(l.description || "Item", left, y, { width: amountX - left - 10 });
      doc.text(money(l.amount || 0), amountX, y, { align: "right" });
      doc.moveDown(0.3);
    }
    doc.moveTo(left, doc.y + 2).lineTo(right, doc.y + 2).strokeColor("#cccccc").stroke();
    doc.moveDown(0.5);
    const ty = doc.y;
    doc.fontSize(13).fillColor("#0b2a44")
      .text("Total due", left, ty, { continued: true })
      .text(money(inv.amountDue || 0), amountX, ty, { align: "right" });

    doc.moveDown(2).fontSize(9).fillColor("#888")
      .text("Payment is due on receipt. A signed service agreement is required before payment.");
    doc.end();
  });
}

// All admin emails across the companies in an organization (org-invoice fallback
// when no org billing email is on file).
async function orgAdminEmails(orgId: string): Promise<string[]> {
  const members = await db.collection("companies").where("organizationId", "==", orgId).get();
  const all: string[] = [];
  for (const d of members.docs) all.push(...await companyAdminEmails(d.id));
  return Array.from(new Set(all));
}

// The organization's monthly amount: the super-admin's explicit override
// (organizations/{id}.monthlyOverride, in dollars) when set, otherwise the
// computed sum of member companies + enterprise fees.
function computeOrgMonthly(org: Record<string, any>, memberCount: number, memberPlanTotal: number): number {
  const override = Number(org.monthlyOverride) || 0;
  if (override > 0) return override;
  if (!org.enterprise) return memberPlanTotal;
  return memberPlanTotal + memberCount * (Number(org.perCompanyFee) || 0) + (Number(org.orgFee) || 0);
}

// Build the service agreement for an organization (single agreement covering the
// whole org). Stamped with the e-signatures once accepted.
async function buildOrgContractPdf(orgId: string, opts?: ContractSig): Promise<Buffer> {
  const org = (await db.doc(`organizations/${orgId}`).get()).data() || {};
  const members = await db.collection("companies").where("organizationId", "==", orgId).get();
  const base = members.docs.reduce((s, d) => s + (Number(d.data().planPrice) || 0), 0);
  const monthly = computeOrgMonthly(org, members.size, base);
  return buildContractPdf({
    companyName: (org.name as string) || "Organization",
    contactName: ((org.billingContactName as string) || "").trim(),
    plan: "Organization", monthly,
    enterprise: !!org.enterprise,
    perCompanyFee: Number(org.perCompanyFee) || 0,
    orgFee: Number(org.orgFee) || 0,
    dateStr: contractDateFmt(Date.now()),
    referenceNumber: opts?.referenceNumber,
    signedName: opts?.signedName,
    signedDateStr: opts?.signedAt ? contractDateFmt(opts.signedAt) : undefined,
    providerSignedName: opts?.providerSignedName,
    providerSignedDateStr: opts?.providerSignedAt ? contractDateFmt(opts.providerSignedAt) : undefined,
  });
}

// Pick the right contract (company- or org-scoped) for an invoice, carrying
// whatever signatures have been recorded so far.
async function buildContractForInvoice(inv: Record<string, any>): Promise<Buffer> {
  const sig: ContractSig = {
    referenceNumber: inv.number,
    signedName: inv.signedName, signedAt: inv.signedAt,
    providerSignedName: inv.providerSignedName, providerSignedAt: inv.providerSignedAt,
  };
  return inv.organizationId
    ? buildOrgContractPdf(inv.organizationId, sig)
    : buildCompanyContractPdf(inv.companyId, sig);
}

// HTML body for an invoice email. The primary CTA routes through the sign page
// (sign-then-pay) so the customer e-signs the agreement before paying.
function invoiceEmailHtml(opts: {
  contactName: string; billedTo: string; number: string; amt: string;
  lines: Array<{ description?: string; amount?: number }>; signUrl: string;
}): string {
  const money = (c: number) => "$" + ((c || 0) / 100).toFixed(2);
  const rows = opts.lines.map((l) =>
    `<tr><td style="padding:6px 0;border-bottom:1px solid #eee;">${escEmail(l.description || "Item")}</td>`+
    `<td style="padding:6px 0;border-bottom:1px solid #eee;text-align:right;">${money(l.amount || 0)}</td></tr>`).join("");
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:560px;margin:0 auto;">
    <div style="font-size:22px;font-weight:700;color:#0EA5E9;">${PRODUCT_NAME}</div>
    <div style="font-size:11px;color:#888;margin-bottom:16px;">a product of ${PROVIDER_LEGAL_NAME}</div>
    <p>${opts.contactName ? "Hi " + escEmail(opts.contactName) + "," : "Hello,"}</p>
    <p>Your ${PRODUCT_NAME} invoice <strong>${escEmail(opts.number)}</strong> for <strong>${opts.amt}</strong> is ready.</p>
    <table style="width:100%;border-collapse:collapse;margin:14px 0;font-size:14px;">${rows}
      <tr><td style="padding:8px 0;font-weight:700;">Total due</td>
      <td style="padding:8px 0;font-weight:700;text-align:right;">${opts.amt}</td></tr></table>
    <p style="margin:20px 0;">
      <a href="${escEmail(opts.signUrl)}" style="background:#0EA5E9;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block;">Review, sign &amp; pay</a>
    </p>
    <p style="color:#555;font-size:13px;">You'll review and electronically sign the service agreement, then pay securely. Payment is due on receipt.</p>
    <p style="color:#888;font-size:12px;margin-top:24px;">Billed to: ${escEmail(opts.billedTo)}</p>
  </div>`;
}
// Minimal HTML-escape for values interpolated into the email body.
function escEmail(s: string): string {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

// Every super-admin's email (the YoutilityKnock "Provider" side).
async function superAdminEmails(): Promise<string[]> {
  const snap = await db.collection("users").where("superAdmin", "==", true).get();
  return Array.from(new Set(snap.docs
    .map((d) => String(d.data()?.email || "").trim())
    .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))));
}

// Stage 1 of two-stage signing: email the Provider (super-admins) a link to
// counter-sign the agreement first. Once they sign, the customer is emailed.
async function sendProviderSignEmail(invoiceId: string): Promise<{ sent: number; error: string }> {
  const inv = (await db.doc(`invoices/${invoiceId}`).get()).data();
  if (!inv) throw new HttpsError("not-found", "Invoice not found.");
  const emails = await superAdminEmails();
  if (!emails.length) return { sent: 0, error: "No super-admin email on file to sign as Provider." };
  const cfg = await getNotifyConfig();
  const amt = "$" + ((inv.amountDue || 0) / 100).toFixed(2);
  const signUrl = `${APP_URL}/sign?inv=${invoiceId}&t=${inv.providerSignToken}&role=provider`;
  const attachments: EmailAttachment[] = [];
  try {
    const pdf = await buildContractForInvoice({ id: invoiceId, ...inv });
    attachments.push({ filename: `${PRODUCT_NAME}-Service-Agreement.pdf`, content: pdf.toString("base64"), type: "application/pdf" });
  } catch (e) { logger.warn("provider contract pdf failed", e); }
  const text = `Action needed: counter-sign the ${PRODUCT_NAME} service agreement for ${inv.companyName || ""} (invoice ${inv.number || ""}, ${amt}).`+
    `\n\nSign as Provider here — the customer is emailed automatically once you sign:\n${signUrl}`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:560px;margin:0 auto;">
    <div style="font-size:22px;font-weight:700;color:#0EA5E9;">${PRODUCT_NAME}</div>
    <div style="font-size:11px;color:#888;margin-bottom:16px;">a product of ${PROVIDER_LEGAL_NAME}</div>
    <p>Counter-sign the service agreement for <strong>${escEmail(inv.companyName || "")}</strong> (invoice ${escEmail(inv.number || "")}, ${amt}).</p>
    <p style="margin:20px 0;"><a href="${escEmail(signUrl)}" style="background:#0EA5E9;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block;">Sign as Provider</a></p>
    <p style="color:#555;font-size:13px;">The customer is automatically emailed to review, sign, and pay once you've signed.</p>
  </div>`;
  let sent = 0, lastError = "";
  for (const to of emails) {
    const r = await sendEmailDetailed(cfg, to, `Sign required — agreement for ${inv.companyName || ""} (${inv.number || ""})`, text, attachments, html);
    if (r.ok) sent++; else lastError = r.detail;
  }
  return { sent, error: sent ? "" : lastError };
}

// Stage 3: once both parties have signed, email the fully-executed agreement to
// everyone — the customer/org billing contact AND every super-admin.
async function sendSignedCopyToAllParties(invoiceId: string): Promise<void> {
  const inv = (await db.doc(`invoices/${invoiceId}`).get()).data();
  if (!inv) return;
  const cfg = await getNotifyConfig();
  const recipients = new Set<string>(await superAdminEmails());
  if (inv.organizationId) {
    const org = (await db.doc(`organizations/${inv.organizationId}`).get()).data() || {};
    const e = ((org.billingEmail as string) || "").trim();
    if (e) recipients.add(e); else (await orgAdminEmails(inv.organizationId)).forEach((x) => recipients.add(x));
  } else {
    const company = (await db.doc(`companies/${inv.companyId}`).get()).data() || {};
    const e = ((company.billingEmail as string) || "").trim();
    if (e) recipients.add(e); else (await companyAdminEmails(inv.companyId)).forEach((x) => recipients.add(x));
  }
  if (!recipients.size) return;
  const attachments: EmailAttachment[] = [];
  try {
    const pdf = await buildContractForInvoice({ id: invoiceId, ...inv });
    attachments.push({ filename: `${PRODUCT_NAME}-Signed-Agreement-${inv.number || invoiceId}.pdf`, content: pdf.toString("base64"), type: "application/pdf" });
  } catch (e) { logger.warn("signed copy pdf failed", e); }
  const text = `The ${PRODUCT_NAME} service agreement for ${inv.companyName || ""} (ref ${inv.number || ""}) is now fully signed by both parties. A copy is attached for your records.`;
  for (const to of recipients) {
    await sendEmailDetailed(cfg, to, `Signed agreement — ${inv.companyName || ""} (${inv.number || ""})`, text, attachments);
  }
}

// Email an invoice (with the service agreement + a printable invoice PDF
// attached) to the billing contact. Works for company- and org-scoped invoices.
// Shared by the emailInvoice callable, createInvoice, and createOrgInvoice.
async function sendInvoiceEmail(invoiceId: string, includeContract: boolean): Promise<{ sent: number; contractAttached: boolean; error: string }> {
  const inv = (await db.doc(`invoices/${invoiceId}`).get()).data();
  if (!inv) throw new HttpsError("not-found", "Invoice not found.");

  // Resolve recipient(s): prefer the explicit billing email, then admins.
  let billingEmail = "", contactName = "", billedTo = (inv.companyName as string) || "";
  let emails: string[] = [];
  if (inv.organizationId) {
    const org = (await db.doc(`organizations/${inv.organizationId}`).get()).data() || {};
    billingEmail = ((org.billingEmail as string) || "").trim();
    contactName = ((org.billingContactName as string) || "").trim();
    billedTo = (org.name as string) || billedTo;
    emails = billingEmail ? [billingEmail] : await orgAdminEmails(inv.organizationId);
  } else {
    const company = (await db.doc(`companies/${inv.companyId}`).get()).data() || {};
    billingEmail = ((company.billingEmail as string) || "").trim();
    contactName = ((company.billingContactName as string) || "").trim();
    billedTo = (company.name as string) || billedTo;
    emails = billingEmail ? [billingEmail] : await companyAdminEmails(inv.companyId);
  }
  if (!emails.length) throw new HttpsError("failed-precondition", "No billing email or admin email on file.");

  const cfg = await getNotifyConfig();
  const amt = "$" + ((inv.amountDue || 0) / 100).toFixed(2);
  const lines: Array<{ description?: string; amount?: number }> =
    Array.isArray(inv.lines) && inv.lines.length ? inv.lines : [{ description: "Subscription", amount: inv.amountDue }];
  const signUrl = inv.signToken
    ? `${APP_URL}/sign?inv=${invoiceId}&t=${inv.signToken}`
    : (inv.payUrl || inv.hostedInvoiceUrl || "");

  // Attachments: printable invoice + the service agreement (default on).
  const attachments: EmailAttachment[] = [];
  try {
    const invPdf = await buildInvoicePdf({ id: invoiceId, ...inv });
    attachments.push({ filename: `Invoice-${inv.number || invoiceId}.pdf`, content: invPdf.toString("base64"), type: "application/pdf" });
  } catch (e) { logger.warn("invoice pdf build failed", e); }
  let contractAttached = false;
  if (includeContract) {
    try {
      const pdf = await buildContractForInvoice({ id: invoiceId, ...inv });
      attachments.push({ filename: `${PRODUCT_NAME}-Service-Agreement.pdf`, content: pdf.toString("base64"), type: "application/pdf" });
      contractAttached = true;
    } catch (e) { logger.warn("contract pdf build failed", e); }
  }

  const greeting = contactName ? `Hi ${contactName},\n\n` : "";
  const textBody = `${greeting}Your ${PRODUCT_NAME} invoice ${inv.number || ""} for ${amt} is ready.`+
    `${signUrl ? "\n\nReview, sign & pay: " + signUrl : ""}`+
    `${contractAttached ? "\n\nThe service agreement is attached — you'll sign it before payment." : ""}`;
  const htmlBody = invoiceEmailHtml({ contactName, billedTo, number: (inv.number as string) || "", amt, lines, signUrl });

  let sent = 0, lastError = "";
  for (const to of emails) {
    const r = await sendEmailDetailed(cfg, to, `Invoice ${inv.number || ""} — ${amt}`, textBody, attachments, htmlBody);
    if (r.ok) sent++; else lastError = r.detail;
  }
  return { sent, contractAttached, error: sent ? "" : lastError };
}

export const emailInvoice = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId: cid, invoiceId, includeContract } =
    (request.data || {}) as { companyId?: string; invoiceId?: string; includeContract?: boolean };
  if (!invoiceId) throw new HttpsError("invalid-argument", "invoiceId required.");
  const inv = (await db.doc(`invoices/${invoiceId}`).get()).data();
  if (!inv) throw new HttpsError("not-found", "Invoice not found.");
  // Org invoices are super-admin only; company invoices follow the company gate.
  if (inv.organizationId) requireSuper(caller);
  else authorizeForCompany(caller, inv.companyId || cid);
  // While the Provider hasn't counter-signed yet, re-email goes to the Provider;
  // afterward it goes to the customer (sign-then-pay).
  if (inv.signStage === "awaiting_provider") {
    const r = await sendProviderSignEmail(invoiceId);
    return { ok: true, sent: r.sent, stage: "awaiting_provider", error: r.error };
  }
  return { ok: true, ...(await sendInvoiceEmail(invoiceId, includeContract !== false)) };
});

// Provider (super-admin) counter-signs from the console. Records the signature,
// advances the stage, and triggers the customer's sign-then-pay email.
export const providerSignInvoice = onCall(async (request) => {
  const caller = await getCaller(request);
  requireSuper(caller);
  const { invoiceId, name } = (request.data || {}) as { invoiceId?: string; name?: string };
  if (!invoiceId) throw new HttpsError("invalid-argument", "invoiceId required.");
  const signerName = String(name || "").trim();
  if (signerName.length < 2) throw new HttpsError("invalid-argument", "Enter your full name to sign.");
  const ref = db.doc(`invoices/${invoiceId}`);
  const inv = (await ref.get()).data();
  if (!inv) throw new HttpsError("not-found", "Invoice not found.");
  const now = Date.now();
  if (!inv.providerSignedAt) {
    await ref.set({ providerSignedAt: now, providerSignedName: signerName, signStage: "awaiting_customer", updatedAt: now }, { merge: true });
  }
  // Now email the customer to review, sign & pay.
  let emailResult = { sent: 0, contractAttached: false, error: "" };
  try { emailResult = await sendInvoiceEmail(invoiceId, true); }
  catch (e: any) { emailResult.error = e?.message || "Email send failed."; logger.warn("providerSign customer email failed", e); }
  return { ok: true, ...emailResult };
});

// Create a manual invoice (super-admin) and, by default, email it with the
// service-agreement contract attached. "Due on receipt"; optionally lock the
// company immediately until it's paid.
export const createInvoice = onCall(async (request) => {
  const caller = await getCaller(request);
  requireSuper(caller);
  const { companyId, amount, description, lines: rawLines, lockUntilPaid, send } = (request.data || {}) as {
    companyId?: string; amount?: number; description?: string;
    lines?: Array<{ description?: string; amount?: number }>; lockUntilPaid?: boolean; send?: boolean;
  };
  if (!companyId) throw new HttpsError("invalid-argument", "companyId required.");
  const company = (await db.doc(`companies/${companyId}`).get()).data() || {};
  // Companies that belong to an organization are billed through the org — block
  // standalone invoicing here so charges aren't duplicated.
  if (company.organizationId) {
    throw new HttpsError("failed-precondition", "This company is billed through its organization. Invoice the organization instead.");
  }

  // Accept either an explicit line-item array or a single amount + description.
  const cleanLines = Array.isArray(rawLines)
    ? rawLines
        .map((l) => ({ description: String(l.description || "").trim() || "YoutilityKnock services", amount: Math.round(Number(l.amount) * 100) }))
        .filter((l) => isFinite(l.amount) && l.amount > 0)
    : [];
  let lineItems: Array<{ description: string; amount: number }>;
  if (cleanLines.length) {
    lineItems = cleanLines;
  } else {
    const dollars = Number(amount);
    if (!isFinite(dollars) || dollars <= 0) throw new HttpsError("invalid-argument", "Enter an amount greater than 0.");
    lineItems = [{ description: (description || "").trim() || "YoutilityKnock services", amount: Math.round(dollars * 100) }];
  }
  const cents = lineItems.reduce((s, l) => s + l.amount, 0);

  const now = Date.now();
  const ref = db.collection("invoices").doc();
  const number = `INV-${now.toString(36).toUpperCase()}`;
  const signToken = crypto.randomBytes(16).toString("hex");
  const providerSignToken = crypto.randomBytes(16).toString("hex");
  await ref.set({
    companyId, companyName: (company.name as string) || "",
    number,
    status: "open", manual: true,
    amountDue: cents, amountPaid: 0, currency: "usd",
    created: now, dueDate: now, // due on receipt
    lines: lineItems,
    lockUntilPaid: !!lockUntilPaid,
    // Two-stage signing: Provider counter-signs first, then the customer.
    signStage: "awaiting_provider",
    signToken, signedAt: 0, signedName: "",
    providerSignToken, providerSignedAt: 0, providerSignedName: "",
    updatedAt: now,
  });
  // Generate a Square hosted payment link so the customer can pay online. If
  // Square isn't configured this returns "" and the invoice just has no link.
  const payUrl = await squarePaymentLink(cents, `${number} — ${(company.name as string) || "YoutilityKnock"}`);
  if (payUrl) await ref.set({ payUrl, hostedInvoiceUrl: payUrl, updatedAt: Date.now() }, { merge: true });
  // Due on receipt → optionally lock the account immediately until paid.
  if (lockUntilPaid) {
    await db.doc(`companies/${companyId}`).set(
      { status: "suspended", billingHold: true, pastDueSince: now, updatedAt: now }, { merge: true });
  }
  // Stage 1: email the Provider (super-admins) to counter-sign first. The
  // customer email goes out automatically once the Provider signs.
  let providerEmail = { sent: 0, error: "" };
  if (send !== false) {
    try { providerEmail = await sendProviderSignEmail(ref.id); }
    catch (e: any) { providerEmail.error = e?.message || "Email send failed."; logger.warn("createInvoice provider send failed", e); }
  }
  return { ok: true, invoiceId: ref.id, payUrl, stage: "awaiting_provider", sent: providerEmail.sent, error: providerEmail.error };
});

// Create an invoice for an ORGANIZATION (super-admin). Itemizes one line per
// member company (its monthly + the enterprise per-company fee) plus the org
// fee, then sign-then-pay emails the org's billing contact. Locking cascades to
// every company under the org.
export const createOrgInvoice = onCall(async (request) => {
  const caller = await getCaller(request);
  requireSuper(caller);
  const { orgId, description, lockUntilPaid, send } = (request.data || {}) as {
    orgId?: string; description?: string; lockUntilPaid?: boolean; send?: boolean;
  };
  if (!orgId) throw new HttpsError("invalid-argument", "orgId required.");
  const org = (await db.doc(`organizations/${orgId}`).get()).data();
  if (!org) throw new HttpsError("not-found", "Organization not found.");
  const members = await db.collection("companies").where("organizationId", "==", orgId).get();
  if (members.empty) throw new HttpsError("failed-precondition", "This organization has no companies to bill.");

  const enterprise = !!org.enterprise;
  const perCompanyFee = Number(org.perCompanyFee) || 0;
  const orgFee = Number(org.orgFee) || 0;
  const override = Number(org.monthlyOverride) || 0;
  const lines: Array<{ description: string; amount: number }> = [];
  if (override > 0) {
    // Flat organization monthly the super-admin entered — bill that exact amount.
    lines.push({ description: "Organization monthly plan (up to 100 users)", amount: Math.round(override * 100) });
  } else {
    members.docs.forEach((d) => {
      const co = d.data();
      const base = Number(co.planPrice) || 0;
      const each = enterprise ? base + perCompanyFee : base;
      lines.push({ description: `${(co.name as string) || d.id}${enterprise ? " (incl. per-company fee)" : ""}`, amount: Math.round(each * 100) });
    });
    if (enterprise && orgFee > 0) lines.push({ description: "Organization fee", amount: Math.round(orgFee * 100) });
  }
  if (description && description.trim()) lines.push({ description: description.trim(), amount: 0 });
  const cents = lines.reduce((s, l) => s + l.amount, 0);
  if (cents <= 0) throw new HttpsError("invalid-argument", "Organization total is $0 — set a monthly amount, plan prices, or fees first.");

  const now = Date.now();
  const ref = db.collection("invoices").doc();
  const number = `ORG-${now.toString(36).toUpperCase()}`;
  const signToken = crypto.randomBytes(16).toString("hex");
  const providerSignToken = crypto.randomBytes(16).toString("hex");
  await ref.set({
    organizationId: orgId, companyName: (org.name as string) || "",
    number, status: "open", manual: true,
    amountDue: cents, amountPaid: 0, currency: "usd",
    created: now, dueDate: now,
    lines, lockUntilPaid: !!lockUntilPaid,
    signStage: "awaiting_provider",
    signToken, signedAt: 0, signedName: "",
    providerSignToken, providerSignedAt: 0, providerSignedName: "",
    updatedAt: now,
  });
  const payUrl = await squarePaymentLink(cents, `${number} — ${(org.name as string) || "Organization"}`);
  if (payUrl) await ref.set({ payUrl, hostedInvoiceUrl: payUrl, updatedAt: Date.now() }, { merge: true });
  // Lock the whole org (and every member company) until paid.
  if (lockUntilPaid) {
    const patch = { status: "suspended", billingHold: true, pastDueSince: now, updatedAt: now };
    await db.doc(`organizations/${orgId}`).set(patch, { merge: true });
    const batch = db.batch();
    members.docs.forEach((d) => batch.set(d.ref, patch, { merge: true }));
    await batch.commit();
  }
  // Stage 1: Provider counter-signs first; customer email auto-sends after.
  let providerEmail = { sent: 0, error: "" };
  if (send !== false) {
    try { providerEmail = await sendProviderSignEmail(ref.id); }
    catch (e: any) { providerEmail.error = e?.message || "Email send failed."; logger.warn("createOrgInvoice provider send failed", e); }
  }
  return { ok: true, invoiceId: ref.id, payUrl, stage: "awaiting_provider", sent: providerEmail.sent, error: providerEmail.error };
});

// Build the company's (or an org's) service-agreement PDF and return it (base64)
// so the super-admin console can preview/download it without relying on email.
export const getContractPdf = onCall(async (request) => {
  const caller = await getCaller(request);
  const { companyId, orgId } = (request.data || {}) as { companyId?: string; orgId?: string };
  let pdf: Buffer;
  if (orgId) {
    await authorizeForOrg(caller, orgId);
    pdf = await buildOrgContractPdf(orgId);
  } else {
    pdf = await buildCompanyContractPdf(authorizeForCompany(caller, companyId));
  }
  return { filename: `${PRODUCT_NAME}-Service-Agreement.pdf`, base64: pdf.toString("base64") };
});

// Lift a due-on-receipt lock once an invoice is paid — cascades to every member
// company for an org invoice. Shared by markInvoicePaid + the sign/pay flow.
async function unlockInvoiceTarget(inv: Record<string, any>): Promise<void> {
  if (!inv.lockUntilPaid) return;
  const now = Date.now();
  const patch = { status: "active", billingHold: false, pastDueSince: 0, updatedAt: now };
  if (inv.organizationId) {
    await db.doc(`organizations/${inv.organizationId}`).set(patch, { merge: true });
    const members = await db.collection("companies").where("organizationId", "==", inv.organizationId).get();
    const batch = db.batch();
    members.docs.forEach((d) => batch.set(d.ref, patch, { merge: true }));
    await batch.commit();
  } else if (inv.companyId) {
    await db.doc(`companies/${inv.companyId}`).set(patch, { merge: true });
  }
}

// Mark an invoice paid (super-admin). If it locked the account/org (due on
// receipt), unlock it.
export const markInvoicePaid = onCall(async (request) => {
  const caller = await getCaller(request);
  requireSuper(caller);
  const { invoiceId } = (request.data || {}) as { invoiceId?: string };
  if (!invoiceId) throw new HttpsError("invalid-argument", "invoiceId required.");
  const ref = db.doc(`invoices/${invoiceId}`);
  const inv = (await ref.get()).data();
  if (!inv) throw new HttpsError("not-found", "Invoice not found.");
  const now = Date.now();
  await ref.set({ status: "paid", amountPaid: inv.amountDue || 0, updatedAt: now }, { merge: true });
  await unlockInvoiceTarget(inv);
  return { ok: true };
});

// ── Two-stage sign-then-pay: public endpoint behind /sign-api/** (no login). ──
// The Provider (super-admin) counter-signs FIRST via ?role=provider using the
// providerSignToken; that auto-emails the customer, who then signs with the
// customer signToken before the pay link unlocks. The token decides the role.
//   GET  /sign-api/<id>?t=<token>           → summary + role + signed state
//   GET  /sign-api/<id>/contract?t=<token>  → the service-agreement PDF
//   POST /sign-api/<id>  { t, name }        → record signature for that role
export const invoiceSign = onRequest({ cors: true }, async (req, res) => {
  try {
    // Path may arrive with or without the "/sign-api" rewrite prefix.
    const parts = req.path.split("/").filter(Boolean).filter((p) => p !== "sign-api");
    const invoiceId = parts[0] || "";
    const wantContract = parts[parts.length - 1] === "contract";
    const token = String((req.method === "POST" ? (req.body?.t ?? req.query.t) : req.query.t) || "");
    if (!invoiceId) { res.status(400).json({ error: "Missing invoice id." }); return; }
    const ref = db.doc(`invoices/${invoiceId}`);
    const inv = (await ref.get()).data();
    if (!inv) { res.status(404).json({ error: "Invoice not found." }); return; }
    // Identify the signer by which token matches.
    const role = token && token === inv.providerSignToken ? "provider"
      : token && token === inv.signToken ? "customer" : "";
    if (!role) { res.status(404).json({ error: "Invoice not found." }); return; }

    if (wantContract) {
      const pdf = await buildContractForInvoice({ id: invoiceId, ...inv });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${PRODUCT_NAME}-Service-Agreement.pdf"`);
      res.status(200).send(pdf);
      return;
    }

    const providerSigned = !!inv.providerSignedAt;
    const customerSigned = !!inv.signedAt;
    // The customer can only act once the Provider has signed.
    const customerReady = providerSigned;
    const summary = {
      role, number: inv.number || "", companyName: inv.companyName || "",
      amountDue: inv.amountDue || 0, currency: inv.currency || "usd",
      status: inv.status || "open",
      lines: Array.isArray(inv.lines) ? inv.lines : [],
      providerSigned, providerSignedName: inv.providerSignedName || "",
      customerSigned, signedName: inv.signedName || "",
      // For the customer view: whether it's their turn yet.
      ready: role === "provider" ? true : customerReady,
      signed: role === "provider" ? providerSigned : customerSigned,
      // Pay link only revealed to the customer after they've signed.
      payUrl: (role === "customer" && customerSigned) ? (inv.payUrl || inv.hostedInvoiceUrl || "") : "",
      governingLaw: GOVERNING_LAW_STATE, provider: PROVIDER_LEGAL_NAME, product: PRODUCT_NAME,
    };

    if (req.method === "GET") { res.status(200).json(summary); return; }

    if (req.method === "POST") {
      const name = String(req.body?.name || "").trim();
      if (name.length < 2) { res.status(400).json({ error: "Type your full name to sign." }); return; }
      const now = Date.now();
      const ip = (req.headers["x-forwarded-for"] as string || "").split(",")[0].trim() || req.ip || "";

      if (role === "provider") {
        if (!inv.providerSignedAt) {
          await ref.set({ providerSignedAt: now, providerSignedName: name, providerSignedIp: ip, signStage: "awaiting_customer", updatedAt: now }, { merge: true });
          // Provider just signed → email the customer to review, sign & pay.
          try { await sendInvoiceEmail(invoiceId, true); }
          catch (e) { logger.warn("provider-sign customer email failed", e); }
        }
        res.status(200).json({ ok: true, role, signed: true, signedName: inv.providerSignedName || name });
        return;
      }

      // role === "customer": the Provider must have signed first.
      if (!inv.providerSignedAt) { res.status(409).json({ error: "This agreement is awaiting the provider's signature. Please try again shortly." }); return; }
      if (!inv.signedAt) {
        await ref.set({ signedAt: now, signedName: name, signedIp: ip, signStage: "fully_signed", updatedAt: now }, { merge: true });
        // Fully signed → email the executed copy to all parties.
        try { await sendSignedCopyToAllParties(invoiceId); }
        catch (e) { logger.warn("signed-copy email failed", e); }
      }
      const payUrl = inv.payUrl || inv.hostedInvoiceUrl || "";
      res.status(200).json({ ok: true, role, signed: true, signedName: inv.signedName || name, payUrl });
      return;
    }
    res.status(405).json({ error: "Method not allowed." });
  } catch (e: any) {
    logger.error("invoiceSign error", e);
    res.status(500).json({ error: "Server error." });
  }
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

// Create a Square hosted payment link for a one-off amount (manual invoices).
// Returns the pay URL, or "" if Square isn't configured / the call fails.
async function squarePaymentLink(amountCents: number, name: string): Promise<string> {
  let cfg;
  try { cfg = await squareCfg(); } catch { return ""; } // Square not configured
  if (!cfg.locationId) { logger.warn("square payment link: no locationId configured"); return ""; }
  try {
    const json = await squareApi(cfg, "/v2/online-checkout/payment-links", {
      idempotency_key: crypto.randomUUID(),
      quick_pay: {
        name: name.slice(0, 255),
        price_money: { amount: amountCents, currency: "USD" },
        location_id: cfg.locationId,
      },
    });
    return json?.payment_link?.url || "";
  } catch (e) {
    logger.warn("square payment link failed", e);
    return "";
  }
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

// ── Organization-level Square recurring ───────────────────────────────────
// An org can keep its own card on file and be auto-billed its monthly (the
// super-admin's override, else the computed total) every 30 days — the same
// model as a company, but charged once for the whole org.
async function orgMonthlyCents(orgId: string): Promise<number> {
  const org = (await db.doc(`organizations/${orgId}`).get()).data() || {};
  const members = await db.collection("companies").where("organizationId", "==", orgId).get();
  const base = members.docs.reduce((s, d) => s + (Number(d.data().planPrice) || 0), 0);
  return Math.round(computeOrgMonthly(org, members.size, base) * 100);
}

// Mirror an org Square payment into invoices/{paymentId} (org-scoped).
async function mirrorSquareOrgPayment(orgId: string, payment: any): Promise<void> {
  const orgName = (await db.doc(`organizations/${orgId}`).get()).data()?.name || "";
  const cents = payment?.amount_money?.amount ?? 0;
  const paid = payment?.status === "COMPLETED";
  await db.doc(`invoices/${payment.id}`).set({
    squarePaymentId: payment.id, organizationId: orgId, companyName: orgName,
    number: payment.receipt_number || "",
    status: paid ? "paid" : (payment.status || "open").toLowerCase(),
    amountDue: cents, amountPaid: paid ? cents : 0,
    currency: (payment?.amount_money?.currency || "USD").toLowerCase(),
    created: payment.created_at ? new Date(payment.created_at).getTime() : Date.now(),
    hostedInvoiceUrl: payment.receipt_url || "", invoicePdf: payment.receipt_url || "",
    lines: [{ description: "YoutilityKnock — organization monthly", amount: cents }],
    updatedAt: Date.now(),
  }, { merge: true });
}

// Charge an org's saved card for its monthly; advance the 30-day clock + unlock
// on success, mark past_due (and the whole org) on failure.
async function runSquareChargeOrg(orgId: string): Promise<{ ok: boolean; error?: string }> {
  const ref = db.doc(`organizations/${orgId}`);
  const org = (await ref.get()).data() || {};
  const cents = await orgMonthlyCents(orgId);
  if (org.billingExempt || cents <= 0) return { ok: true };
  const cardId = org.squareCardId as string | undefined;
  const customerId = org.squareCustomerId as string | undefined;
  if (!cardId || !customerId) return { ok: false, error: "No card on file." };
  const cfg = await squareCfg();
  try {
    const { payment } = await squareApi(cfg, "/v2/payments", {
      idempotency_key: crypto.randomUUID(),
      source_id: cardId, customer_id: customerId,
      location_id: cfg.locationId || undefined,
      amount_money: { amount: cents, currency: "USD" },
      note: `YoutilityKnock — ${(org.name as string) || "Organization"} monthly`,
    });
    await mirrorSquareOrgPayment(orgId, payment);
    const now = Date.now();
    const patch = { status: "active", pastDueSince: 0, billingHold: false, nextBillingAt: now + BILLING_INTERVAL_DAYS * 86400000, updatedAt: now };
    await ref.set(patch, { merge: true });
    // Lift any hold on member companies too.
    const members = await db.collection("companies").where("organizationId", "==", orgId).get();
    const batch = db.batch();
    members.docs.forEach((d) => batch.set(d.ref, { status: "active", billingHold: false, pastDueSince: 0, updatedAt: now }, { merge: true }));
    await batch.commit();
    return { ok: true };
  } catch (e: any) {
    const patch: Record<string, unknown> = { status: "past_due", updatedAt: Date.now() };
    if (!org.pastDueSince) patch.pastDueSince = Date.now();
    await ref.set(patch, { merge: true });
    return { ok: false, error: e?.message || "Charge failed." };
  }
}

// Save an org's card on file and start its 30-day recurring billing.
export const squareSaveOrgCardAndSubscribe = onCall(async (request) => {
  const caller = await getCaller(request);
  const { orgId, sourceId } = (request.data || {}) as { orgId?: string; sourceId?: string };
  await authorizeForOrg(caller, orgId); // super OR an admin of a member company
  if (!orgId) throw new HttpsError("invalid-argument", "orgId required.");
  if (!sourceId) throw new HttpsError("invalid-argument", "sourceId (card token) required.");
  const cfg = await squareCfg();
  const ref = db.doc(`organizations/${orgId}`);
  const org = (await ref.get()).data();
  if (!org) throw new HttpsError("not-found", "Organization not found.");

  let customerId = org.squareCustomerId as string | undefined;
  if (!customerId) {
    const { customer } = await squareApi(cfg, "/v2/customers", {
      idempotency_key: crypto.randomUUID(),
      company_name: (org.name as string) || orgId,
      reference_id: `org:${orgId}`,
    });
    customerId = customer.id;
    await ref.set({ squareCustomerId: customerId, updatedAt: Date.now() }, { merge: true });
  }
  const { card } = await squareApi(cfg, "/v2/cards", {
    idempotency_key: crypto.randomUUID(),
    source_id: sourceId,
    card: { customer_id: customerId },
  });
  const hadBilling = !!org.squareCardId && (Number(org.nextBillingAt) || 0) > Date.now();
  await ref.set({
    squareCardId: card.id, cardBrand: card.card_brand || "", cardLast4: card.last_4 || "",
    updatedAt: Date.now(),
  }, { merge: true });

  const cents = await orgMonthlyCents(orgId);
  if (!org.billingExempt && cents > 0 && !hadBilling) {
    const r = await runSquareChargeOrg(orgId);
    if (!r.ok) throw new HttpsError("internal", r.error || "Could not take first payment.");
  }
  return { ok: true, brand: card.card_brand || "", last4: card.last_4 || "" };
});

// Daily Square recurring charge: re-bill each Square company AND organization
// when its 30-day clock comes due. (Stripe is billed by Stripe's subscriptions.)
export const squareBillingCron = onSchedule("every 24 hours", async () => {
  const c = ((await db.doc("config/billing").get()).data() as Record<string, string>) || {};
  if (billingProvider(c) !== "square") return; // only when Square is the active gateway
  const now = Date.now();
  const snap = await db.collection("companies").where("squareCardId", ">", "").get();
  for (const d of snap.docs) {
    const co = d.data();
    if (co.billingExempt || co.status === "suspended") continue;
    // A company billed through its org is charged by the org, not individually.
    if (co.organizationId) continue;
    if ((Number(co.nextBillingAt) || 0) > now) continue; // not due yet
    await runSquareCharge(d.id);
  }
  // Organizations with their own card on file.
  const orgSnap = await db.collection("organizations").where("squareCardId", ">", "").get();
  for (const d of orgSnap.docs) {
    const org = d.data();
    if (org.billingExempt || org.status === "suspended") continue;
    if ((Number(org.nextBillingAt) || 0) > now) continue;
    await runSquareChargeOrg(d.id);
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
      } else {
        // Not a company — it may be an organization's own card.
        const orgSnap = await db.collection("organizations").where("squareCustomerId", "==", payment.customer_id).limit(1).get();
        if (!orgSnap.empty) {
          const orgId = orgSnap.docs[0].id;
          await mirrorSquareOrgPayment(orgId, payment);
          if (payment.status === "COMPLETED") {
            await orgSnap.docs[0].ref.set({ status: "active", pastDueSince: 0, billingHold: false, updatedAt: Date.now() }, { merge: true });
          }
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

// Block CRM data access for a company that's locked. A billing lock (unpaid /
// dunning hold / expired trial) returns 402 with the payment message the linked
// CRM should show; a plain admin suspension returns 403. Returns true if it
// sent a blocking response (caller should `return`).
async function crmCompanyAccessBlocked(companyId: string, res: any): Promise<boolean> {
  const c = (await db.doc(`companies/${companyId}`).get()).data();
  if (!c) return false; // unknown company → let the normal handler respond
  const status = String(c.status || "active").toLowerCase();
  const billingLocked = Boolean(c.billingHold || c.trialExpired || c.pastDueSince || status === "past_due");
  if (billingLocked) {
    res.status(402).json({ error: "Please contact your administrator for payment to reactivate your account.", code: "PAYMENT_REQUIRED" });
    return true;
  }
  if (status === "suspended" || status === "inactive") {
    res.status(403).json({ error: "This account is inactive. Please contact your system administrator.", code: "ACCOUNT_INACTIVE" });
    return true;
  }
  return false;
}

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
      if (await crmCompanyAccessBlocked(companyId, res)) return;
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
      if (await crmCompanyAccessBlocked(companyId, res)) return;

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
