import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { addDoc, collection, doc, getDocs, query, updateDoc, where } from "firebase/firestore";
import { Geolocation } from "@capacitor/geolocation";
import { db, auth } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { DISPOSITIONS, DISP_COLOR } from "../lib/dispositions";
import {
  lookupAddress,
  normalizeKnockstatResponse,
  buildEnrichment,
  lookupArea,
  parseAreaProperties,
} from "../lib/knockstat";
import { bumpStats } from "../lib/stats";
import type { Lead, Territory, LatLng, LeadStatus, LeadEnrichment } from "../types";

const DEFAULT_CENTER: [number, number] = [40.34, -111.91];
const PIN_ZOOM = 13;

const HOUSE_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="#fff"><path d="M12 3 3 10.5h2.4V21h5.1v-6h3v6h5.1V10.5H21z"/></svg>';

function homeIcon(color: string): L.DivIcon {
  return L.divIcon({
    className: "home-pin",
    html: `<span style="background:${color}">${HOUSE_SVG}</span>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

// Disposition target: a home (no leadId yet) or an existing lead being updated.
interface Dispo {
  leadId?: string;
  address: string;
  lat: number;
  lng: number;
  status: LeadStatus;
  name: string;
  phone: string;
  email: string;
  notes: string;
  enrichment?: LeadEnrichment;
  summary?: string;
  enriching: boolean;
}

export default function MapPage() {
  const { profile, role, companyId } = useAuth();
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const pinsLayer = useRef<L.LayerGroup>(L.layerGroup());
  const homesLayer = useRef<L.LayerGroup>(L.layerGroup());
  const territoryLayer = useRef<L.LayerGroup>(L.layerGroup());
  const myLoc = useRef<LatLng | null>(null);
  const drawPts = useRef<LatLng[]>([]);
  const drawLayer = useRef<L.Polygon | null>(null);
  const modeRef = useRef<"view" | "draw">("view");

  const [status, setStatus] = useState("Loading map…");
  const [mode, setMode] = useState<"view" | "draw">("view");
  const [loadingHomes, setLoadingHomes] = useState(false);
  const [dispo, setDispo] = useState<Dispo | null>(null);
  const [saving, setSaving] = useState(false);
  modeRef.current = mode;

  const canDraw = role === "admin" || role === "manager";

  // ── Open the disposition card for a home/lead, then auto-pull owner data ────
  function openDispo(d: Partial<Dispo> & { address: string; lat: number; lng: number }) {
    const target: Dispo = {
      status: "new",
      name: "",
      phone: "",
      email: "",
      notes: "",
      enriching: !d.enrichment,
      ...d,
    };
    setDispo(target);
    if (!d.enrichment) void doEnrich(target);
  }

  async function doEnrich(target: Dispo) {
    try {
      const token = await auth.currentUser!.getIdToken();
      const raw = await lookupAddress(target.address, token);
      const rec = normalizeKnockstatResponse(raw);
      const { ownerName, phone, email, enrichment } = buildEnrichment(rec);
      const summary = [
        enrichment.propertyType,
        enrichment.beds != null ? `${enrichment.beds}bd` : null,
        enrichment.baths != null ? `${enrichment.baths}ba` : null,
        enrichment.sqft != null ? `${Number(enrichment.sqft).toLocaleString()} sqft` : null,
        enrichment.estValue ? `$${Number(enrichment.estValue).toLocaleString()}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      setDispo((cur) =>
        cur && cur.address === target.address
          ? {
              ...cur,
              name: cur.name || ownerName || "",
              phone: cur.phone || phone || "",
              email: cur.email || email || "",
              enrichment,
              summary,
              enriching: false,
            }
          : cur
      );
    } catch {
      setDispo((cur) => (cur ? { ...cur, enriching: false } : cur));
    }
  }

  async function saveDispo() {
    if (!profile || !companyId || !dispo) return;
    setSaving(true);
    try {
      const now = Date.now();
      const contact = {
        ownerName: dispo.name || null,
        phone: dispo.phone || null,
        email: dispo.email || null,
        notes: dispo.notes || null,
        status: dispo.status,
        enrichment: dispo.enrichment ?? null,
        enriched: !!dispo.enrichment,
        updatedAt: now,
      };
      if (dispo.leadId) {
        await updateDoc(doc(db, "leads", dispo.leadId), contact);
      } else {
        await addDoc(collection(db, "leads"), {
          ...contact,
          address: dispo.address,
          lat: dispo.lat,
          lng: dispo.lng,
          companyId,
          assignedTo: profile.uid,
          visibilityPath: [profile.uid, ...(profile.managerPath ?? [])],
          createdBy: profile.uid,
          createdAt: now,
        });
      }
      if (dispo.status === "appointment") void bumpStats(profile, { appointments: 1 });
      else if (dispo.status === "sold") void bumpStats(profile, { sales: 1 });
      setDispo(null);
      await buildPins();
    } catch (e: any) {
      setStatus("Could not save: " + (e?.message || ""));
    } finally {
      setSaving(false);
    }
  }

  // ── Pins ────────────────────────────────────────────────────────────────────
  function refreshPinVisibility() {
    const map = mapRef.current;
    if (!map) return;
    const show = map.getZoom() >= PIN_ZOOM;
    [pinsLayer.current, homesLayer.current].forEach((layer) => {
      if (show && !map.hasLayer(layer)) map.addLayer(layer);
      else if (!show && map.hasLayer(layer)) map.removeLayer(layer);
    });
  }

  async function fetchLeads(): Promise<Lead[]> {
    if (!companyId || !profile) return [];
    const base = collection(db, "leads");
    const q =
      role === "admin"
        ? query(base, where("companyId", "==", companyId))
        : query(base, where("companyId", "==", companyId), where("visibilityPath", "array-contains", profile.uid));
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Lead, "id">) }));
  }

  async function buildPins() {
    pinsLayer.current.clearLayers();
    const leads = await fetchLeads();
    let plotted = 0;
    leads.forEach((lead) => {
      if (lead.lat == null || lead.lng == null) return;
      const m = L.marker([lead.lat, lead.lng], { icon: homeIcon(DISP_COLOR[lead.status] || "#94A3B8") });
      m.on("click", () =>
        openDispo({
          leadId: lead.id,
          address: lead.address,
          lat: lead.lat!,
          lng: lead.lng!,
          status: lead.status,
          name: lead.ownerName || "",
          phone: lead.phone || "",
          email: lead.email || "",
          notes: lead.notes || "",
          enrichment: lead.enrichment,
        })
      );
      pinsLayer.current.addLayer(m);
      plotted++;
    });
    setStatus(`${plotted} lead pin${plotted === 1 ? "" : "s"}`);
    refreshPinVisibility();
  }

  async function buildTerritories() {
    territoryLayer.current.clearLayers();
    if (!companyId) return;
    const snap = await getDocs(query(collection(db, "territories"), where("companyId", "==", companyId)));
    snap.forEach((d) => {
      const t = { id: d.id, ...(d.data() as Omit<Territory, "id">) };
      if (!t.polygon || t.polygon.length < 3) return;
      L.polygon(
        t.polygon.map((p) => [p.lat, p.lng] as [number, number]),
        { color: t.color || "#34D399", weight: 2, fillOpacity: 0.1 }
      )
        .bindTooltip(t.name)
        .addTo(territoryLayer.current);
    });
  }

  async function loadHomes() {
    const map = mapRef.current;
    if (!map || !profile) return;
    setLoadingHomes(true);
    setStatus("Loading homes in view…");
    try {
      const c = map.getCenter();
      const ne = map.getBounds().getNorthEast();
      const miles = Math.min(map.distance(c, ne) / 1609.34, 1);
      const token = await auth.currentUser!.getIdToken();
      const raw = await lookupArea(c.lat, c.lng, Math.max(0.1, +miles.toFixed(2)), token);
      const homes = parseAreaProperties(raw);
      homesLayer.current.clearLayers();
      homes.forEach((h) => {
        const m = L.marker([h.lat, h.lng], { icon: homeIcon("#475569") });
        m.on("click", () => openDispo({ address: h.address, lat: h.lat, lng: h.lng }));
        homesLayer.current.addLayer(m);
      });
      setStatus(`${homes.length} homes in view — tap a house to disposition`);
      refreshPinVisibility();
    } catch (e: any) {
      setStatus("Could not load homes: " + (e?.message || ""));
    } finally {
      setLoadingHomes(false);
    }
  }

  // ── Init map ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!companyId || !profile || !elRef.current || mapRef.current) return;

    const satellite = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19, attribution: "Tiles © Esri — Maxar, Earthstar Geographics" }
    );
    const labels = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19 }
    );
    const street = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" });
    const hybrid = L.layerGroup([satellite, labels]);

    const map = L.map(elRef.current, { center: DEFAULT_CENTER, zoom: 14, layers: [hybrid] });
    L.control.layers({ Satellite: satellite, Hybrid: hybrid, Street: street }).addTo(map);
    territoryLayer.current.addTo(map);
    homesLayer.current.addTo(map);
    mapRef.current = map;
    map.on("zoomend", refreshPinVisibility);

    map.on("click", (e: L.LeafletMouseEvent) => {
      if (modeRef.current !== "draw") return;
      drawPts.current.push({ lat: e.latlng.lat, lng: e.latlng.lng });
      if (drawLayer.current) drawLayer.current.remove();
      drawLayer.current = L.polygon(
        drawPts.current.map((p) => [p.lat, p.lng] as [number, number]),
        { color: "#38BDF8", weight: 2, fillOpacity: 0.15 }
      ).addTo(map);
    });

    (async () => {
      try {
        const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 8000 });
        myLoc.current = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        map.setView([myLoc.current.lat, myLoc.current.lng], 17);
        L.circleMarker([myLoc.current.lat, myLoc.current.lng], {
          radius: 7,
          color: "#fff",
          weight: 3,
          fillColor: "#0EA5E9",
          fillOpacity: 1,
        })
          .addTo(map)
          .bindTooltip("You");
      } catch {
        /* location denied */
      }
      await buildTerritories();
      await buildPins();
    })();

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, profile, role]);

  // Draw mode finish/cancel
  async function finishDraw() {
    if (drawPts.current.length < 3) {
      setStatus("Tap at least 3 points to make an area.");
      return;
    }
    const name = window.prompt("Name this territory:");
    if (name && companyId && profile) {
      try {
        await addDoc(collection(db, "territories"), {
          companyId,
          name: name.trim(),
          color: "#34D399",
          polygon: drawPts.current,
          managerId: profile.uid,
          createdAt: Date.now(),
        });
        await buildTerritories();
        setStatus(`Territory “${name.trim()}” saved`);
      } catch (e: any) {
        setStatus("Could not save: " + (e?.message || ""));
      }
    }
    cancelDraw();
  }
  function cancelDraw() {
    drawPts.current = [];
    if (drawLayer.current) {
      drawLayer.current.remove();
      drawLayer.current = null;
    }
    setMode("view");
  }

  return (
    <div className="page-body">
      <div className="page-head row">
        <div>
          <h1>Map</h1>
          <p className="page-sub">{status}</p>
        </div>
        <div className="filter-bar">
          <button className="chip-btn" onClick={loadHomes} disabled={loadingHomes}>
            {loadingHomes ? "Loading…" : "⌂ Load homes"}
          </button>
          {canDraw && (
            <button className={"chip-btn" + (mode === "draw" ? " active" : "")} onClick={() => setMode(mode === "draw" ? "view" : "draw")}>
              ✏ Draw area
            </button>
          )}
        </div>
      </div>

      {mode === "draw" && (
        <div className="card route-bar">
          <span className="muted">Tap the map to drop area corners, then save.</span>
          <div className="row">
            <button className="btn sm" onClick={cancelDraw}>Cancel</button>
            <button className="btn primary sm" onClick={finishDraw}>Save area</button>
          </div>
        </div>
      )}

      <div ref={elRef} className="map-canvas" />

      <div className="map-legend">
        {DISPOSITIONS.map((d) => (
          <span key={d.value} className="legend-item">
            <span className="legend-dot" style={{ background: d.color }} /> {d.label}
          </span>
        ))}
        <span className="legend-item muted">· tap a house to disposition · pins at zoom {PIN_ZOOM}+</span>
      </div>

      {/* ── Log Disposition card ─────────────────────────────────────────── */}
      {dispo && (
        <div className="modal-overlay" onClick={() => setDispo(null)}>
          <div className="dispo-card" onClick={(e) => e.stopPropagation()}>
            <div className="dispo-head">
              <div>
                <h3>Log Disposition</h3>
                <div className="muted small">{dispo.address}</div>
              </div>
              <button className="dispo-x" onClick={() => setDispo(null)}>✕</button>
            </div>

            <div className="field-label">Disposition</div>
            <div className="dispo-grid">
              {DISPOSITIONS.map((d) => (
                <button
                  key={d.value}
                  type="button"
                  className={"dispo-pill" + (dispo.status === d.value ? " active" : "")}
                  style={{
                    borderColor: d.color,
                    ...(dispo.status === d.value ? { background: d.color, color: "#06121f" } : {}),
                  }}
                  onClick={() => setDispo({ ...dispo, status: d.value })}
                >
                  {d.label}
                </button>
              ))}
            </div>

            {dispo.summary && <div className="muted small dispo-summary">{dispo.summary}</div>}

            <label className="field">
              <span>Address</span>
              <input value={dispo.address} onChange={(e) => setDispo({ ...dispo, address: e.target.value })} />
            </label>
            <div className="grid-2">
              <label className="field">
                <span>Name {dispo.enriching && <em className="muted">· looking up…</em>}</span>
                <input
                  value={dispo.name}
                  placeholder="Full name"
                  onChange={(e) => setDispo({ ...dispo, name: e.target.value })}
                />
              </label>
              <label className="field">
                <span>Phone</span>
                <input
                  value={dispo.phone}
                  placeholder="(555) 000-0000"
                  onChange={(e) => setDispo({ ...dispo, phone: e.target.value })}
                />
              </label>
            </div>
            <label className="field">
              <span>Email</span>
              <input
                value={dispo.email}
                placeholder="email@example.com"
                onChange={(e) => setDispo({ ...dispo, email: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Notes</span>
              <textarea
                rows={2}
                value={dispo.notes}
                placeholder="Add notes…"
                onChange={(e) => setDispo({ ...dispo, notes: e.target.value })}
              />
            </label>

            <div className="dispo-foot">
              <span className="muted small mono">
                {dispo.lat.toFixed(5)}, {dispo.lng.toFixed(5)}
              </span>
              <div className="row">
                <button className="btn ghost sm" onClick={() => setDispo(null)}>Cancel</button>
                <button className="btn primary sm" onClick={saveDispo} disabled={saving}>
                  {saving ? "Saving…" : dispo.leadId ? "Save" : "Add Lead"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
