import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Capacitor } from "@capacitor/core";
import { Geolocation } from "@capacitor/geolocation";
import { collection, doc, getDocs, query, setDoc, where } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { DISP_COLOR } from "../lib/dispositions";
import type { Lead } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// GL map (MapLibre) — STAGE 1, opt-in via ?map=gl.
//
// This is the ground-up replacement for the Leaflet map, built on MapLibre GL so
// two-finger rotation keeps every pin pixel-perfect (the GPU re-projects markers
// each frame — no smear, unlike Leaflet + markercluster). It ships behind a flag
// so the live Leaflet map is untouched for reps until this is proven.
//
// Stage 1 = engine + satellite imagery + rotation + your live location + the
// worked lead pins. Still to port in later stages: gray ATTOM home pins
// (clustered GeoJSON), movers, solar, live team, filters, the draw-area tool,
// and long-press-to-knock. Those are intentionally not here yet.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CENTER: [number, number] = [-111.91, 40.34]; // [lng, lat]
const MAX_ZOOM = 21;
const HOUSE_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="#fff"><path d="M12 3 3 10.5h2.4V21h5.1v-6h3v6h5.1V10.5H21z"/></svg>';

function validCoord(lat: unknown, lng: unknown): [number, number] | null {
  const la = Number(lat), ln = Number(lng);
  if (!isFinite(la) || !isFinite(ln)) return null;
  if (la === 0 && ln === 0) return null;
  if (Math.abs(la) > 90 || Math.abs(ln) > 180) return null;
  return [la, ln];
}

// Google hybrid (lyrs=y = imagery + roads/labels), the reps' default base — crisp
// native tiles to z21. Sub-domains mt0–3 spread the tile load.
const BASE_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    sat: {
      type: "raster",
      tiles: ["mt0", "mt1", "mt2", "mt3"].map((s) => `https://${s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}`),
      tileSize: 256,
      maxzoom: 21,
      attribution: "© Google",
    },
  },
  layers: [{ id: "sat", type: "raster", source: "sat" }],
};

export default function MapGL() {
  const { profile, role, companyId } = useAuth();
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const youMarker = useRef<maplibregl.Marker | null>(null);
  const leadMarkers = useRef<maplibregl.Marker[]>([]);
  const myLoc = useRef<[number, number] | null>(null); // [lng, lat]
  const watchId = useRef<string | null>(null);
  const lastPub = useRef(0);
  const [ready, setReady] = useState(false);

  // ── Map init ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: elRef.current,
      style: BASE_STYLE,
      center: DEFAULT_CENTER,
      zoom: 14,
      maxZoom: MAX_ZOOM,
      // Rotation on, tilt off — a flat, north-optional canvassing map. This is the
      // whole point: pinch-twist rotates and pins stay locked.
      dragRotate: true,
      pitchWithRotate: false,
      maxPitch: 0,
      attributionControl: { compact: true },
    });
    mapRef.current = map;

    // Compass (click to reset north) + zoom (+/− on web only — pinch on native).
    map.addControl(
      new maplibregl.NavigationControl({ showZoom: !Capacitor.isNativePlatform(), showCompass: true, visualizePitch: false }),
      "top-right"
    );
    map.on("load", () => setReady(true));

    return () => { map.remove(); mapRef.current = null; };
  }, []);

  // ── Your live location ──────────────────────────────────────────────────────
  function setYou(lng: number, lat: number) {
    const map = mapRef.current;
    if (!map) return;
    if (youMarker.current) youMarker.current.setLngLat([lng, lat]);
    else {
      const el = document.createElement("div");
      el.className = "mgl-you";
      youMarker.current = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map);
    }
    publishLocation(lat, lng);
  }
  function publishLocation(lat: number, lng: number) {
    if (!profile || !companyId) return;
    const now = Date.now();
    if (now - lastPub.current < 20_000) return;
    lastPub.current = now;
    void setDoc(doc(db, "presence", profile.uid), {
      lat, lng, locationAt: now, lastSeen: now, companyId, name: profile.displayName || "",
    }, { merge: true }).catch(() => {});
  }
  async function recenter() {
    const map = mapRef.current;
    if (!map) return;
    let loc = myLoc.current;
    if (!loc) {
      try {
        const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 8000 });
        loc = [pos.coords.longitude, pos.coords.latitude];
        myLoc.current = loc;
        setYou(loc[0], loc[1]);
      } catch { return; }
    }
    map.flyTo({ center: loc, zoom: Math.max(map.getZoom(), 18) });
  }
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Initial fix + recenter.
        const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 8000 });
        if (cancelled) return;
        myLoc.current = [pos.coords.longitude, pos.coords.latitude];
        setYou(pos.coords.longitude, pos.coords.latitude);
        mapRef.current?.jumpTo({ center: myLoc.current, zoom: 17 });
        watchId.current = await Geolocation.watchPosition({ enableHighAccuracy: true, timeout: 10000 }, (p) => {
          if (!p) return;
          myLoc.current = [p.coords.longitude, p.coords.latitude];
          setYou(p.coords.longitude, p.coords.latitude);
        });
      } catch { /* location unavailable — map just won't follow */ }
    })();
    return () => {
      cancelled = true;
      if (watchId.current) { void Geolocation.clearWatch({ id: watchId.current }); watchId.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Lead pins (worked doors) ────────────────────────────────────────────────
  useEffect(() => {
    if (!ready || !companyId || !profile) return;
    let cancelled = false;
    (async () => {
      const base = collection(db, "leads");
      const q =
        role === "admin"
          ? query(base, where("companyId", "==", companyId))
          : query(base, where("companyId", "==", companyId), where("visibilityPath", "array-contains", profile.uid));
      const snap = await getDocs(q);
      if (cancelled) return;
      const map = mapRef.current;
      if (!map) return;
      leadMarkers.current.forEach((m) => m.remove());
      leadMarkers.current = [];
      snap.docs.forEach((d) => {
        const lead = { id: d.id, ...(d.data() as Omit<Lead, "id">) };
        if (lead.deleted) return;
        const c = validCoord(lead.lat, lead.lng);
        if (!c) return;
        const el = document.createElement("div");
        el.className = "home-pin";
        el.innerHTML = `<span style="background:${DISP_COLOR[lead.status] || "#94A3B8"}">${HOUSE_SVG}</span>`;
        const marker = new maplibregl.Marker({ element: el }).setLngLat([c[1], c[0]]).addTo(map);
        marker.getElement().addEventListener("click", (ev) => {
          ev.stopPropagation();
          new maplibregl.Popup({ offset: 16 })
            .setLngLat([c[1], c[0]])
            .setHTML(`<div style="font:600 13px system-ui;color:#0f1727">${(lead.address || "Home").replace(/</g, "&lt;")}</div><div style="font:12px system-ui;color:#475569;text-transform:capitalize">${(lead.status || "").replace(/_/g, " ")}</div>`)
            .addTo(map);
        });
        leadMarkers.current.push(marker);
      });
    })();
    return () => { cancelled = true; };
  }, [ready, companyId, profile, role]);

  return (
    <div className="map-screen">
      <div ref={elRef} className="map-canvas-full" />
      {/* Recenter-to-me (compass built into the nav control resets north). */}
      <div className="map-overlay map-tl">
        <button className="map-fab" onClick={() => void recenter()} aria-label="Recenter on me" title="Recenter on my location">🧭</button>
      </div>
      <div className="map-overlay" style={{ top: 12, left: "50%", transform: "translateX(-50%)" }}>
        <span className="pill" style={{ fontSize: 11, opacity: 0.85 }}>GL map (beta) · pinch-twist to rotate</span>
      </div>
    </div>
  );
}
