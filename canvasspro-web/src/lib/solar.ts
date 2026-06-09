// Solar Scanner pins on the field map.
//
// The CRM pushes its solar-scanner pins into Firestore (companies/{id}/solarPins
// via POST /crm/solar-pins); we read them back through the `getSolarPins`
// callable, which enforces visibility server-side (admins/managers see all; a
// rep sees only pins inside a territory assigned to them).
//
// A plain ☀️ pin marks a home the scanner mailed/texted/emailed. It flips to a
// 🔥 flame the moment the homeowner engages (scans the postcard QR or clicks the
// SMS / email link) — a hot lead worth knocking now.

import L from "leaflet";
import { httpsCallable } from "firebase/functions";
import { functions } from "../firebase";

export interface SolarPin {
  id: string;
  lat: number;
  lng: number;
  address?: string;
  ownerName?: string;
  hot?: boolean;
  hotSource?: string; // qr | sms | email
  hotAt?: number | string | null;
  crmContactId?: string | null;
}

export function solarIcon(hot: boolean): L.DivIcon {
  return L.divIcon({
    className: hot ? "solar-pin solar-pin--hot" : "solar-pin",
    html: hot
      ? `<span style="font-size:24px;line-height:1;filter:drop-shadow(0 1px 3px rgba(0,0,0,.7))">🔥</span>`
      : `<span style="font-size:20px;line-height:1;opacity:.92;filter:drop-shadow(0 1px 2px rgba(0,0,0,.6))">☀️</span>`,
    iconSize: hot ? [26, 26] : [22, 22],
    iconAnchor: hot ? [13, 13] : [11, 11],
    popupAnchor: [0, -12],
  });
}

export function solarPopupHtml(p: SolarPin): string {
  const line2 = p.hot
    ? `🔥 Hot lead${p.hotSource ? ` — ${p.hotSource === "qr" ? "scanned QR code" : p.hotSource === "sms" ? "clicked text link" : "clicked email link"}` : ""}`
    : "Solar outreach sent — no engagement yet";
  return `<div style="min-width:160px"><strong>${p.ownerName || "Homeowner"}</strong><br>` +
    `<span style="color:#555">${p.address || ""}</span><br>` +
    `<span style="color:${p.hot ? "#ea580c" : "#64748b"};font-weight:600">${line2}</span></div>`;
}

// Fetch this company's solar pins, already visibility-filtered for the caller.
export async function fetchSolarPins(companyId: string): Promise<SolarPin[]> {
  const call = httpsCallable<{ companyId: string }, { pins: SolarPin[] }>(functions, "getSolarPins");
  const res = await call({ companyId });
  return (res.data?.pins || []).filter(
    (p) => typeof p.lat === "number" && typeof p.lng === "number"
  );
}
