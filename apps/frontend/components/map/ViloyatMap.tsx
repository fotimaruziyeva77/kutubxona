"use client";

import { useEffect, useRef, useState } from "react";
import { riColor, riLabel } from "@/lib/map/map-color";

/**
 * Plan 05-06-fix audit-MEDIUM — defense-in-depth HTML escape for any string
 * interpolated into Leaflet's bindTooltip/bindPopup HTML envelopes.
 *
 * The current GeoJSON ships with safe vendored viloyat names. This guard
 * prevents a future PR that switches to DB-backed or operator-edited names
 * from silently re-opening XSS in the choropleth tooltips.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * ViloyatMap — Leaflet.js choropleth (Plan 05-06 MAP-01 + MAP-03).
 *
 * Replaces the previous per-province dot renderer with L.geoJSON polygons.
 * Plan 05-06 grep gate enforces zero references to the old marker API in
 * this file (regression guard for the choropleth rewrite).
 *
 * Data flow:
 *   - On mount: fetch the simplified GeoJSON committed by Plan 05-01
 *     at /geojson/uzbekistan-viloyats.geojson (14 features, each with
 *     properties.code in "01".."14" + properties.name).
 *   - When geoData AND props.data are both available: L.geoJSON(...)
 *     renders polygons. `style` callback resolves color via
 *     riColor(feature.properties.code → matched data row).
 *   - onEachFeature wires click + hover handlers + bindTooltip.
 *
 * Server-side render boundary preserved by the parent
 * (stats/page.tsx uses `dynamic(() => ..., { ssr: false })`).
 */

export type ViloyatMapData = {
  viloyatId: string;
  name: string;
  /** Kept on the shape for backwards compatibility with the stats grid view;
   * choropleth ignores these. */
  lat?: number;
  lon?: number;
  /** Feature.properties.code from the GeoJSON ("01".."14"). When provided,
   * used for direct lookup. Falls back to slug-style matching otherwise. */
  code?: string;
  readingIndex: number;
  libraries: number;
  users: number;
};

type Props = {
  data: ViloyatMapData[];
  onSelect?: (viloyat: ViloyatMapData) => void;
  height?: string;
};

type GeoFeatureCollection = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: { type: "Polygon" | "MultiPolygon"; coordinates: unknown };
    properties: { code: string; name: string; [k: string]: unknown };
  }>;
};

export default function ViloyatMap({ data, onSelect, height = "480px" }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const geoLayerRef = useRef<import("leaflet").GeoJSON | null>(null);
  const [geoData, setGeoData] = useState<GeoFeatureCollection | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);

  // Fetch the static GeoJSON once on mount — Cache-Control immutable
  // serves it from CDN (Plan 05-01 build script enforces <100KB gzip).
  useEffect(() => {
    let cancelled = false;
    fetch("/geojson/uzbekistan-viloyats.geojson")
      .then((r) => {
        if (!r.ok) throw new Error(`GeoJSON fetch ${r.status}`);
        return r.json();
      })
      .then((j: GeoFeatureCollection) => {
        if (!cancelled) setGeoData(j);
      })
      .catch((e: unknown) => {
        // eslint-disable-next-line no-console
        console.error("[ViloyatMap] GeoJSON fetch failed", e);
        if (!cancelled) setGeoError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Build a quick lookup: code → data row. Plan 05-02 fix B passes the real
  // Prisma cuid as viloyatId, so we match on `code` if the consumer set it,
  // otherwise fall back to name-prefix matching (defensive).
  function lookupViloyat(code: string): ViloyatMapData | undefined {
    return (
      data.find((d) => d.code === code) ??
      data.find((d) => d.viloyatId === code)
    );
  }

  useEffect(() => {
    if (!containerRef.current) return;
    if (mapRef.current) return; // Qayta yaratmaslik

    let map: import("leaflet").Map;

    (async () => {
      const L = (await import("leaflet")).default;

      // Inject Leaflet CSS once.
      if (!document.querySelector("link[data-leaflet]")) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
        link.setAttribute("data-leaflet", "true");
        document.head.appendChild(link);
      }

      map = L.map(containerRef.current!, {
        center: [41.3, 63.5],
        zoom: 6,
        zoomControl: true,
        attributionControl: false,
      });
      mapRef.current = map;

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 10,
        minZoom: 5,
      }).addTo(map);

      // Plan 05-06 MAP-03 — legend updated for the 5-tier choropleth bucket
      // shared with riColor / riLabel (CLAUDE.md §VI.4 thresholds).
      const legend = new (L.Control.extend({
        onAdd() {
          const div = L.DomUtil.create("div");
          div.style.cssText =
            "background:white;padding:8px 12px;border-radius:8px;font-size:12px;line-height:1.8;box-shadow:0 1px 4px rgba(0,0,0,0.2)";
          div.innerHTML = `
            <strong>Reading Index</strong><br/>
            <span style="color:#16a34a">■</span> 80–100 A'lo<br/>
            <span style="color:#eab308">■</span> 60–79  Yaxshi<br/>
            <span style="color:#f59e0b">■</span> 40–59  O'rta<br/>
            <span style="color:#dc2626">■</span> 0–39   Past<br/>
            <span style="color:#9ca3af">■</span> Ma'lumot yo'q
          `;
          return div;
        },
      }))({ position: "bottomright" });
      legend.addTo(map);
    })();

    return () => {
      geoLayerRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Render the L.geoJSON layer once both map + geoData are ready, and when
  // props.data changes (so RI updates re-paint).
  useEffect(() => {
    if (!geoData) return;
    if (!mapRef.current) return;
    const map = mapRef.current;

    let cancelled = false;
    (async () => {
      const L = (await import("leaflet")).default;
      if (cancelled) return;

      // Remove previous layer if data changed.
      if (geoLayerRef.current) {
        map.removeLayer(geoLayerRef.current);
        geoLayerRef.current = null;
      }

      const geoLayer = L.geoJSON(geoData as unknown as GeoJSON.FeatureCollection, {
        style: (feature) => {
          const code = (feature?.properties as { code?: string } | undefined)?.code ?? "";
          const v = lookupViloyat(code);
          return {
            fillColor: riColor(v?.readingIndex),
            weight: 1.5,
            opacity: 1,
            color: "white",
            fillOpacity: 0.75,
          };
        },
        onEachFeature: (feature, layer) => {
          const code = (feature.properties as { code: string }).code;
          const name = (feature.properties as { name: string }).name;
          const v = lookupViloyat(code);

          const riText = v
            ? `${v.readingIndex.toFixed(1)} (${riLabel(v.readingIndex)})`
            : riLabel(null);
          const libCount = v?.libraries ?? 0;
          const userCount = v?.users ?? 0;

          // Plan 05-06-fix audit-MEDIUM — escape all interpolated strings.
          // Today feature.properties.name comes from a static vendored asset
          // (Plan 05-01) with no HTML metacharacters, but a future PR that
          // sources names from DB, translates them, or merges operator-edited
          // boundaries would silently re-open XSS. Escape unconditionally.
          const safeName = escapeHtml(name);
          const safeRiText = escapeHtml(riText);
          const safeLibCount = escapeHtml(String(libCount));
          const safeUserCount = escapeHtml(userCount.toLocaleString());

          (layer as import("leaflet").Layer).bindTooltip(
            // Leaflet tooltip/popup — XOM HTML satri, React emas: bu yerga
            // lucide komponentini qo'yib bo'lmaydi, shuning uchun belgilar
            // o'rniga oddiy so'z yorliqlari ishlatiladi.
            `<div style="font-family:sans-serif;font-size:13px;line-height:1.6">
              <strong>${safeName}</strong><br/>
              RI: <b>${safeRiText}</b>
            </div>`,
            { direction: "top", permanent: false }
          );

          (layer as import("leaflet").Layer).bindPopup(
            `<div style="font-family:sans-serif;font-size:13px;line-height:1.6">
              <strong>${safeName}</strong><br/>
              RI: <b>${safeRiText}</b><br/>
              Kutubxona: ${safeLibCount}<br/>
              Kitobxon: ${safeUserCount}
            </div>`
          );

          (layer as import("leaflet").Layer).on({
            click: () => {
              if (v && onSelect) onSelect(v);
            },
            mouseover: (e: import("leaflet").LeafletMouseEvent) => {
              const target = e.target as import("leaflet").Path;
              target.setStyle({ weight: 3, color: "#666", fillOpacity: 0.9 });
              target.bringToFront?.();
            },
            mouseout: (e: import("leaflet").LeafletMouseEvent) => {
              geoLayer.resetStyle(e.target as import("leaflet").Path);
            },
          });
        },
      });

      geoLayer.addTo(map);
      geoLayerRef.current = geoLayer;
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geoData, data]);

  return (
    <div
      ref={containerRef}
      style={{ height, width: "100%" }}
      className="rounded-2xl overflow-hidden border border-line"
      aria-label={geoError ? "Xarita yuklanmadi" : "Viloyatlar xaritasi"}
    />
  );
}
