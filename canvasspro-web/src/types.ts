// Shared domain types used across the dashboard and (mirrored) in functions.

// System access tiers. Custom company roles are TITLES that map onto one of
// these base tiers (see CompanyRole.baseTier).
export type Role = "superadmin" | "admin" | "manager" | "user";

// How company appointments (that a rep didn't self-generate) get routed.
export type AssignmentMethod = "self_gen" | "round_robin" | "highest_production" | "manual";

export interface SchedulingSettings {
  apptMinLeadHours: number; // earliest bookable = now + this many hours
  apptMaxDaysOut: number; // latest bookable = now + this many days
  apptDurationMin: number; // appointment length, minutes
  bufferMin: number; // required gap between a rep's appointments, minutes
  assignment: AssignmentMethod; // routing for non-self-gen appointments
  timezone: string; // IANA tz the business hours are expressed in
  dayStartMin: number; // earliest time of day to book, minutes from midnight
  dayEndMin: number; // latest time of day to book, minutes from midnight
  workDays: number[]; // bookable weekdays, 0=Sun … 6=Sat
  slotMin: number; // booking granularity, minutes
}

export const DEFAULT_SCHEDULING: SchedulingSettings = {
  apptMinLeadHours: 1,
  apptMaxDaysOut: 30,
  apptDurationMin: 60,
  bufferMin: 0,
  assignment: "self_gen",
  timezone: "America/Denver",
  dayStartMin: 9 * 60, // 9:00 AM
  dayEndMin: 20 * 60, // 8:00 PM
  workDays: [1, 2, 3, 4, 5, 6], // Mon–Sat
  slotMin: 30,
};

export interface Company {
  id: string;
  name: string;
  plan?: string;
  planId?: string;
  status?: string;
  features?: string[]; // enabled feature keys from the plan (undefined = all on)
  maxUsers?: number;
  planPrice?: number;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  addons?: string[]; // e.g. ["knock"] when provisioned as a CRM add-on
  crmCompanyId?: string; // link to the company record in YoutilityCRM
  billingExempt?: boolean; // comped — full features, not charged
  scheduling?: SchedulingSettings;
  createdAt?: number;
}

// A rep's linked external calendars (status only — tokens live server-side).
export interface CalendarLink {
  connected: boolean;
  email?: string;
  connectedAt?: number;
}
export interface CalendarLinks {
  google?: CalendarLink;
  microsoft?: CalendarLink;
}

export interface LatLng {
  lat: number;
  lng: number;
}

// Per-company role/title. Every company is seeded with "Manager" and "User".
// Company admins add custom titles and order them via `rank` (higher = more
// senior). `baseTier` decides actual access (manager can see downstream, user
// is a leaf). Titles never grant admin/superadmin.
export interface CompanyRole {
  id: string;
  companyId: string;
  title: string;
  baseTier: "manager" | "user";
  rank: number;
  isDefault?: boolean;
  createdAt?: number;
}

export interface Team {
  id: string;
  companyId: string;
  name: string;
  leadUserId?: string; // the manager of this team
  parentTeamId?: string | null;
  createdAt?: number;
}

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  role: Role; // base access tier
  phone?: string; // for SMS notification fallback when offline
  calendar?: CalendarLinks; // linked external calendars (status)
  companyId: string;
  roleId?: string; // -> companies/{companyId}/roles/{roleId}
  title?: string; // denormalized role title for display
  teamId?: string;
  managerId?: string | null; // direct manager
  managerPath?: string[]; // ancestor uids, nearest first (excludes self)
  territoryIds?: string[];
  createdAt?: number;
  disabled?: boolean;
}

import type { LeadStatus } from "./lib/dispositions";
export type { LeadStatus };

// Homeowner / property data attached to a lead from public-records enrichment.
export interface LeadEnrichment {
  owners?: { name?: string; phones?: string[]; emails?: string[]; ageRange?: string }[];
  propertyType?: string;
  yearBuilt?: number | string;
  beds?: number | string;
  baths?: number | string;
  sqft?: number | string;
  lotSqft?: number | string;
  estValue?: number;
  equity?: number;
  ownerOccupied?: string;
  lastSalePrice?: number;
  lastSaleDate?: string;
  apn?: string;
  [k: string]: unknown;
}

export interface Lead {
  id: string;
  address: string;
  city?: string;
  state?: string;
  zip?: string;
  lat?: number;
  lng?: number;
  ownerName?: string;
  phone?: string;
  email?: string;
  status: LeadStatus;
  notes?: string;
  photoHomeUrl?: string; // photo of the front of the home
  photoBillUrl?: string; // photo of the utility bill
  enriched?: boolean;
  enrichedAt?: number;
  enrichment?: LeadEnrichment;
  // Geofencing: a knock only counts toward stats if the rep was on-site.
  verified?: boolean;
  distanceFt?: number;
  knockedAt?: number;
  companyId: string;
  territoryId?: string;
  assignedTo?: string; // uid (owner)
  // Owner + every manager above them (owner first). Drives downstream
  // visibility: a manager sees a lead iff their uid is in this array.
  visibilityPath: string[];
  createdBy: string; // uid
  createdAt: number;
  updatedAt: number;
}

export interface Territory {
  id: string;
  name: string;
  description?: string;
  color?: string;
  companyId: string;
  managerId?: string; // uid
  assignedTo?: string | null; // uid of the rep this area is assigned to
  assignedToName?: string | null; // denormalized name for display
  polygon?: LatLng[]; // map boundary
  createdAt: number;
}

export interface Shift {
  id: string;
  companyId: string;
  userId: string;
  userName?: string;
  visibilityPath: string[]; // [owner, ...managers]
  status: "active" | "ended";
  startAt: number;
  endAt?: number;
  doorsKnocked?: number;
  notes?: string;
}

export interface UserStats {
  uid: string;
  companyId: string;
  userName?: string;
  managerPath: string[]; // ancestors, for downstream roll-up
  leadsCreated?: number;
  appointments?: number;
  sales?: number;
  doorsKnocked?: number;
  shifts?: number;
  updatedAt?: number;
  // Present on seasonStats docs (resetting week/month/year buckets).
  period?: string;
  kind?: "week" | "month" | "year";
  joinedAt?: number | null;
}

export interface ChatMessage {
  id: string;
  companyId?: string;
  channelId?: string;
  userId: string;
  userName: string;
  text?: string;
  imageUrl?: string;
  createdAt: number;
}

export interface DmChannel {
  id: string;
  members: string[];
  memberNames: Record<string, string>;
  lastMessage?: string;
  lastAt?: number;
}

export type EventType = "appointment" | "go_back" | "follow_up";

export interface ScheduleEvent {
  id: string;
  companyId: string;
  userId: string;
  userName?: string;
  type: EventType;
  title: string;
  address?: string;
  leadId?: string;
  startAt: number;
  endAt?: number;
  durationMin?: number;
  assignedBy?: string; // uid of the admin/manager who routed this (if not self-gen)
  source?: "self_gen" | "assigned";
  notes?: string;
  visibilityPath: string[];
  createdAt: number;
}

export interface AppNotification {
  id: string;
  userId: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
  read?: boolean;
  createdAt: number;
}

// ── Rewards (admin-created incentives) ───────────────────────────────────────
export type RewardKind = "benchmark" | "store"; // auto-unlock at a target vs. redeem with points
export type RewardAudience = "individual" | "team";
export type RewardMetric = "points" | "doors" | "conversations" | "appointments" | "sales";
export type RewardPeriod = "weekly" | "monthly" | "alltime";

export interface Reward {
  id: string;
  companyId: string;
  name: string;
  description?: string;
  imageUrl?: string;
  kind: RewardKind;
  audience: RewardAudience;
  metric: RewardMetric; // what's measured (benchmark) or the currency (store = points)
  period: RewardPeriod; // window for an individual benchmark
  target: number; // threshold to unlock (benchmark) OR points cost (store)
  active?: boolean;
  createdAt: number;
  createdBy: string;
}

export interface Redemption {
  id: string;
  companyId: string;
  rewardId: string;
  rewardName: string;
  userId: string;
  userName: string;
  status: "requested" | "fulfilled";
  createdAt: number;
}

// ---- Knockstat normalized property record (ported from canvass-pro.html) ----

export interface Person {
  name: string;
  role?: string;
  entityType?: string;
  ageRange?: string;
  gender?: string;
  maritalStatus?: string;
  lengthOfResidence?: number | string;
  phones: string[];
  emails: string[];
  mailingAddress?: string;
  address?: string;
}

export interface PropertyRecord {
  address: {
    line1?: string;
    city?: string;
    state?: string;
    zip?: string;
    lat?: number | string;
    lon?: number | string;
  };
  property: Record<string, unknown>;
  valuation: Record<string, unknown>;
  ownership: { occupancy?: string | null; lengthOfOwnership?: unknown };
  owners: Person[];
  occupants: Person[];
  mortgage: Record<string, unknown>;
  sale: Record<string, unknown>;
  listing: Record<string, unknown>;
  tax: Record<string, unknown>;
  demographics: Record<string, unknown>;
  hazards: Record<string, unknown>;
  ids: Record<string, unknown>;
}
