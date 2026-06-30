import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Geolocation } from "@capacitor/geolocation";
import { auth } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { useNav } from "../components/NavContext";
import { lookupMovers, parseMovers, type MoverHome } from "../lib/knockstat";
import {
  MOVER_BUCKETS,
  MOVER_DAYS,
  moverIcon,
  moverColor,
  moverPopupHtml,
  daysAgo,
} from "../lib/movers";
import type { LatLng } from "../types";

const DEFAULT_CENTER: [number, number] = [40.34, -111.91];
const ROAM_THRESHOLD_M = 700; // reload movers once the map drifts ~0.43 mi
const PIN_CAP = 800; // accumulate up to this many mover pins, then reset

function validCoord(lat: unknown, lng: unknown): [number, number] | null {
  const la = Number(lat);
  const ln = Number(lng);
  if (!isFinite(la) || !isFinite(ln)) return null;
  if (la === 0 && ln === 0) return null;
  if (Math.abs(la) > 90 || Math.abs(ln) > 180) return null;
  return [la, ln];
}

export default function MoversPage() {
  const { profile, companyId } = useAuth();
  const { openNav } = useNav();
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const moverLayer = useRef<L.LayerGroup>(L.layerGroup());
  const keys = useRef<Set<string>>(new Set()); // dedupe accumulated pins
  const lastLoadCenter = useRef<L.LatLng | null>(null);
  const loadingRef = useRef(false);
  const roamTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const youMarker = useRef<L.CircleMarker | null>(null);
  const watchId = useRef<string | null>(null);

  const [status, setStatus] = useState("Loading movers…");
  const [loading, setLoading] = useState(false);
  const [count, setCount] = useState(0);

  function addMover(m: MoverHome): boolean {
    const c = validCoord(m.lat, m.lng);
    if (!c) return false;
    const d = daysAgo(m.saleDate);
    const color = moverColor(d);
    if (!color) return false; // older than 90 days — not a mover
    const key = `${c[0].toFixed(5)},${c[1].toFixed(5)}`;
    if (keys.current.has(key)) return false;
    keys.current.add(key);
    L.marker(c, { icon: moverIcon(color) })
      .bindPopup(moverPopupHtml(m))
      .addTo(moverLayer.current);
    return true;
  }

  // Pull recent move-ins (last 90 days) around a center and drop pins.
  async function fetchMovers(center: LatLng) {
    const token = await auth.currentUser!.getIdToken();
    const raw = await lookupMovers(center.lat, center.lng, 1, MOVER_DAYS, token);
    parseMovers(raw).forEach((m) => addMover(m));
  }

  // Manual / initial load around the rep (or the current map center).
  async function loadMovers() {
    const map = mapRef.current;
    if (!map || !profile) return;
    setLoading(true);
    moverLayer.current.clearLayers();
    keys.current.clear();
    try {
      const c = { lat: map.getCenter().lat, lng: map.getCenter().lng };
      await fetchMovers(c);
      lastLoadCenter.current = L.latLng(c.lat, c.lng);
      const n = moverLayer.current.getLayers().length;
      setCount(n);
      setStatus(n ? `${n} move-in${n === 1 ? "" : "s"} in the last ${MOVER_DAYS} days` : `No move-ins in the last ${MOVER_DAYS} days here`);
    } catch (e: any) {
      setStatus("Could not load movers: " + (e?.message || ""));
    } finally {
      setLoading(false);
    }
  }

  // Auto-load as the map pans/walks past the threshold — accumulate, capped.
  async function autoRoam() {
    const map = mapRef.current;
    if (!map || !profile || loadingRef.current) return;
    const ctr = map.getCenter();
    if (lastLoadCenter.current && ctr.distanceTo(lastLoadCenter.current) < ROAM_THRESHOLD_M) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      if (moverLayer.current.getLayers().length > PIN_CAP) {
        moverLayer.current.clearLayers();
        keys.current.clear();
      }
      await fetchMovers({ lat: ctr.lat, lng: ctr.lng });
      lastLoadCenter.current = ctr;
      const n = moverLayer.current.getLayers().length;
      setCount(n);
      setStatus(`${n} move-in${n === 1 ? "" : "s"} loaded · keep moving`);
    } catch {
      /* silent — keep what's already shown */
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }

  function setYou(lat: number, lng: number) {
    if (youMarker.current) youMarker.current.setLatLng([lat, lng]);
    else if (mapRef.current) {
      youMarker.current = L.circleMarker([lat, lng], {
        radius: 7, color: "#fff", weight: 3, fillColor: "#0EA5E9", fillOpacity: 1,
      }).addTo(mapRef.current).bindTooltip("You");
    }
  }

  // ── Init ────────────────────────────────────────────────────────────────────
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
    const hybrid = L.layerGroup([satellite, labels]);
    const street = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" });

    const map = L.map(elRef.current, { center: DEFAULT_CENTER, zoom: 14, maxZoom: 21, layers: [hybrid], zoomControl: false });
    L.control.zoom({ position: "topright" }).addTo(map);
    L.control.layers({ "Esri satellite": hybrid, Street: street }, undefined, { position: "topright" }).addTo(map);
    moverLayer.current.addTo(map);
    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 120);

    map.on("moveend", () => {
      if (roamTimer.current) clearTimeout(roamTimer.current);
      roamTimer.current = setTimeout(() => void autoRoam(), 700);
    });

    (async () => {
      try {
        const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 8000 });
        map.setView([pos.coords.latitude, pos.coords.longitude], 16);
        setYou(pos.coords.latitude, pos.coords.longitude);
      } catch {
        /* location denied — stay on default center */
      }
      await loadMovers();
    })();

    return () => {
      if (roamTimer.current) clearTimeout(roamTimer.current);
      if (watchId.current) { Geolocation.clearWatch({ id: watchId.current }).catch(() => {}); watchId.current = null; }
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, profile]);

  return (
    <div className="map-screen">
      <div ref={elRef} className="map-canvas-full" />

      {/* Top-left: menu + refresh */}
      <div className="map-overlay map-tl">
        <button className="map-fab" onClick={openNav} aria-label="Menu">☰</button>
        <button className="map-fab" onClick={loadMovers} disabled={loading} aria-label="Refresh movers" title="Refresh movers">
          {loading ? "…" : "⟳"}
        </button>
      </div>

      {/* Status pill */}
      {status && <div className="map-status-pill">{status}</div>}

      {/* Legend: color = how recently they moved in (last 90 days) */}
      <div className="movers-legend">
        <div className="ml-title">New move-ins{count ? ` · ${count}` : ""}</div>
        {MOVER_BUCKETS.map((b) => (
          <div key={b.max} className="ml-row">
            <span className="ml-dot" style={{ background: b.color }} />
            {b.label}
          </div>
        ))}
      </div>
    </div>
  );
}
