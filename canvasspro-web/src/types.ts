// Shared domain types used across the dashboard and (mirrored) in functions.

export type Role = "admin" | "manager" | "rep";

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  role: Role;
  territoryIds?: string[];
  createdAt?: number;
  disabled?: boolean;
}

export type LeadStatus =
  | "new"
  | "contacted"
  | "appointment"
  | "not_home"
  | "not_interested"
  | "sold";

export interface Lead {
  id: string;
  address: string;
  city?: string;
  state?: string;
  zip?: string;
  lat?: number;
  lon?: number;
  ownerName?: string;
  phone?: string;
  email?: string;
  status: LeadStatus;
  notes?: string;
  territoryId?: string;
  assignedTo?: string; // uid
  createdBy: string; // uid
  createdAt: number;
  updatedAt: number;
}

export interface Territory {
  id: string;
  name: string;
  description?: string;
  color?: string;
  managerId?: string; // uid
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
