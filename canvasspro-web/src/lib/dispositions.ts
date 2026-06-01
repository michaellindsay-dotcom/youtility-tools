// Canvassing dispositions — the single source of truth for status values,
// labels, and colors used across the Leads list, Map pins, and Dashboard.
export const DISPOSITIONS = [
  { value: "new", label: "New", color: "#38BDF8" },
  { value: "not_home", label: "Not Home", color: "#F59E0B" },
  { value: "go_back", label: "Go Back", color: "#FBBF24" },
  { value: "contacted", label: "Contacted", color: "#A78BFA" },
  { value: "interested", label: "Interested", color: "#22D3EE" },
  { value: "appointment", label: "Appointment", color: "#34D399" },
  { value: "not_interested", label: "Not Interested", color: "#F87171" },
  { value: "sold", label: "Sold", color: "#22C55E" },
  { value: "dnc", label: "Do Not Contact", color: "#64748B" },
] as const;

export type LeadStatus = (typeof DISPOSITIONS)[number]["value"];

export const DISP_LABEL: Record<string, string> = Object.fromEntries(
  DISPOSITIONS.map((d) => [d.value, d.label])
);
export const DISP_COLOR: Record<string, string> = Object.fromEntries(
  DISPOSITIONS.map((d) => [d.value, d.color])
);
