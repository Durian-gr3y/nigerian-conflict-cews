'use client';

/**
 * ZoneRiskMap.tsx
 * Nigeria CEWS — MapLibre GL choropleth risk map with LGA boundaries,
 * alert circles, zone filters, and live SWR polling.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import useSWR from 'swr';

// ─── Types ────────────────────────────────────────────────────────────────────

export type RiskLevel = 'watch' | 'advisory' | 'warning' | 'emergency';
export type Zone = 'NWZ' | 'NEZ' | 'NCZ' | 'SWZ' | 'SEZ' | 'SSZ';

export interface ZoneScore {
  zone: Zone;
  risk_level: RiskLevel;
  score: number;
  lgas: LGARisk[];
}

export interface LGARisk {
  lga_id: string;
  lga_name: string;
  state: string;
  zone: Zone;
  risk_level: RiskLevel;
  risk_score: number;
  alert_count: number;
  casualties_confirmed: number;
  casualties_estimated: number;
  lat: number;
  lng: number;
}

export interface AlertMarker {
  id: string;
  lga_id: string;
  lga_name: string;
  state: string;
  zone: Zone;
  alert_type: string;
  description: string;
  casualties_confirmed: number;
  casualties_estimated: number;
  incident_occurred_at: string;
  risk_level: RiskLevel;
  lat: number;
  lng: number;
}

export interface ZoneScoresResponse {
  updated_at: string;
  zones: ZoneScore[];
  alerts: AlertMarker[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const NIGERIA_CENTER: [number, number] = [8.6753, 9.082];
const DEFAULT_ZOOM = 5;
const POLL_INTERVAL_MS = 60_000; // 60 seconds

const RISK_COLOURS: Record<RiskLevel, string> = {
  watch: '#eab308',     // yellow-500
  advisory: '#f97316', // orange-500
  warning: '#ef4444',  // red-500
  emergency: '#7f1d1d', // red-950 (darkred)
};

const RISK_FILL_OPACITY: Record<RiskLevel, number> = {
  watch: 0.25,
  advisory: 0.35,
  warning: 0.45,
  emergency: 0.6,
};

const ZONE_CENTRES: Record<Zone, { center: [number, number]; zoom: number }> = {
  NWZ: { center: [7.3986, 12.0022], zoom: 6 },
  NEZ: { center: [13.1603, 11.8333], zoom: 6 },
  NCZ: { center: [8.5, 9.5], zoom: 6 },
  SWZ: { center: [3.9470, 7.3986], zoom: 6.5 },
  SEZ: { center: [7.5, 5.5], zoom: 6.5 },
  SSZ: { center: [6.3, 4.8], zoom: 6.5 },
};

const ZONE_LABELS: Record<Zone, string> = {
  NWZ: 'North West',
  NEZ: 'North East',
  NCZ: 'North Central',
  SWZ: 'South West',
  SEZ: 'South East',
  SSZ: 'South South',
};

const ZONES: Zone[] = ['NWZ', 'NEZ', 'NCZ', 'SWZ', 'SEZ', 'SSZ'];

// ─── pg_tileserv / API config ─────────────────────────────────────────────────

const TILESERV_BASE =
  process.env.NEXT_PUBLIC_TILESERV_URL ?? 'http://localhost:7800';

const MVT_SOURCE_URL = `${TILESERV_BASE}/public.lga_boundaries/{z}/{x}/{y}.pbf`;

// ─── Fetcher ──────────────────────────────────────────────────────────────────

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<ZoneScoresResponse>;
  });

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-NG', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function riskBadgeClass(level: RiskLevel): string {
  const base = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium';
  const map: Record<RiskLevel, string> = {
    watch: `${base} bg-yellow-900 text-yellow-300`,
    advisory: `${base} bg-orange-900 text-orange-300`,
    warning: `${base} bg-red-900 text-red-300`,
    emergency: `${base} bg-red-950 text-red-200 border border-red-700`,
  };
  return map[level];
}

// ─── Component ────────────────────────────────────────────────────────────────

interface ZoneRiskMapProps {
  className?: string;
}

export default function ZoneRiskMap({ className = '' }: ZoneRiskMapProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);

  const [activeZone, setActiveZone] = useState<Zone | null>(null);
  const [mapReady, setMapReady] = useState(false);

  // SWR polling for zone scores + alert markers
  const { data, error, isLoading } = useSWR<ZoneScoresResponse>(
    '/api/v1/analytics/zone-scores',
    fetcher,
    {
      refreshInterval: POLL_INTERVAL_MS,
      revalidateOnFocus: true,
      dedupingInterval: 30_000,
    }
  );

  // Top 5 highest-risk LGAs across all zones
  const top5LGAs: LGARisk[] = React.useMemo(() => {
    if (!data) return [];
    const allLGAs = data.zones.flatMap((z) => z.lgas);
    return [...allLGAs]
      .sort((a, b) => b.risk_score - a.risk_score)
      .slice(0, 5);
  }, [data]);

  // ── Initialise map ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: {
        version: 8,
        sources: {
          'carto-dark': {
            type: 'raster',
            tiles: [
              'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
              'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
            ],
            tileSize: 256,
            attribution: '© OpenStreetMap contributors © CARTO',
          },
        },
        layers: [
          {
            id: 'carto-dark-layer',
            type: 'raster',
            source: 'carto-dark',
          },
        ],
      },
      center: NIGERIA_CENTER,
      zoom: DEFAULT_ZOOM,
      maxBounds: [
        [2.5, 3.9],   // SW corner
        [15.1, 14.1], // NE corner
      ],
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    map.addControl(
      new maplibregl.AttributionControl({ compact: true }),
      'bottom-right'
    );

    map.on('load', () => {
      // ── MVT source for LGA boundaries ──
      map.addSource('lga-boundaries', {
        type: 'vector',
        tiles: [MVT_SOURCE_URL],
        minzoom: 4,
        maxzoom: 14,
      });

      // Choropleth fill layer
      map.addLayer({
        id: 'lga-fill',
        type: 'fill',
        source: 'lga-boundaries',
        'source-layer': 'lga_boundaries',
        paint: {
          'fill-color': [
            'match',
            ['get', 'risk_level'],
            'watch', RISK_COLOURS.watch,
            'advisory', RISK_COLOURS.advisory,
            'warning', RISK_COLOURS.warning,
            'emergency', RISK_COLOURS.emergency,
            '#374151', // default gray
          ],
          'fill-opacity': [
            'match',
            ['get', 'risk_level'],
            'watch', RISK_FILL_OPACITY.watch,
            'advisory', RISK_FILL_OPACITY.advisory,
            'warning', RISK_FILL_OPACITY.warning,
            'emergency', RISK_FILL_OPACITY.emergency,
            0.1,
          ],
        },
      });

      // LGA boundary outline
      map.addLayer({
        id: 'lga-outline',
        type: 'line',
        source: 'lga-boundaries',
        'source-layer': 'lga_boundaries',
        paint: {
          'line-color': '#6b7280',
          'line-width': 0.5,
          'line-opacity': 0.6,
        },
      });

      // Highlighted outline on hover
      map.addLayer({
        id: 'lga-outline-hover',
        type: 'line',
        source: 'lga-boundaries',
        'source-layer': 'lga_boundaries',
        paint: {
          'line-color': '#f9fafb',
          'line-width': 2,
          'line-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 1, 0],
        },
      });

      // Alert circles source (GeoJSON — updated when data arrives)
      map.addSource('alert-circles', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      map.addLayer({
        id: 'alert-circles-layer',
        type: 'circle',
        source: 'alert-circles',
        paint: {
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['get', 'casualties_total'],
            0, 6,
            10, 10,
            50, 18,
            200, 30,
          ],
          'circle-color': [
            'match',
            ['get', 'risk_level'],
            'watch', RISK_COLOURS.watch,
            'advisory', RISK_COLOURS.advisory,
            'warning', RISK_COLOURS.warning,
            'emergency', RISK_COLOURS.emergency,
            '#9ca3af',
          ],
          'circle-opacity': 0.85,
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#1f2937',
        },
      });

      // ── Hover state tracking ──
      let hoveredLgaId: string | number | null = null;

      map.on('mousemove', 'lga-fill', (e) => {
        map.getCanvas().style.cursor = 'pointer';
        if (e.features && e.features.length > 0) {
          const fid = e.features[0].id;
          if (fid !== hoveredLgaId) {
            if (hoveredLgaId !== null) {
              map.setFeatureState(
                { source: 'lga-boundaries', sourceLayer: 'lga_boundaries', id: hoveredLgaId },
                { hover: false }
              );
            }
            hoveredLgaId = fid ?? null;
            if (hoveredLgaId !== null) {
              map.setFeatureState(
                { source: 'lga-boundaries', sourceLayer: 'lga_boundaries', id: hoveredLgaId },
                { hover: true }
              );
            }
          }
        }
      });

      map.on('mouseleave', 'lga-fill', () => {
        map.getCanvas().style.cursor = '';
        if (hoveredLgaId !== null) {
          map.setFeatureState(
            { source: 'lga-boundaries', sourceLayer: 'lga_boundaries', id: hoveredLgaId },
            { hover: false }
          );
          hoveredLgaId = null;
        }
      });

      // ── Popup on LGA click ──
      map.on('click', 'lga-fill', (e) => {
        if (!e.features || e.features.length === 0) return;
        const props = e.features[0].properties;
        const lngLat = e.lngLat;

        popupRef.current?.remove();

        const html = `
          <div class="cews-popup" style="min-width:200px;font-family:system-ui,sans-serif;color:#f9fafb">
            <h3 style="margin:0 0 4px;font-size:14px;font-weight:700">${props?.lga_name ?? 'LGA'}</h3>
            <p style="margin:0 0 6px;font-size:11px;color:#9ca3af">${props?.state ?? ''} · ${props?.zone ?? ''}</p>
            <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
              <span style="background:${RISK_COLOURS[(props?.risk_level as RiskLevel) ?? 'watch']};color:#111;border-radius:999px;padding:2px 8px;font-size:11px;font-weight:600;text-transform:uppercase">
                ${props?.risk_level ?? 'unknown'}
              </span>
              <span style="font-size:11px;color:#d1d5db">Score: ${props?.risk_score?.toFixed(1) ?? '–'}</span>
            </div>
            <p style="margin:0;font-size:11px;color:#d1d5db">
              Alerts: <b>${props?.alert_count ?? 0}</b> &nbsp;|&nbsp;
              Casualties: <b>${(props?.casualties_confirmed ?? 0) + (props?.casualties_estimated ?? 0)}</b>
            </p>
          </div>
        `;

        popupRef.current = new maplibregl.Popup({
          closeButton: true,
          closeOnClick: false,
          className: 'cews-map-popup',
          maxWidth: '280px',
        })
          .setLngLat(lngLat)
          .setHTML(html)
          .addTo(map);
      });

      // ── Popup on alert circle click ──
      map.on('click', 'alert-circles-layer', (e) => {
        if (!e.features || e.features.length === 0) return;
        const props = e.features[0].properties;
        const coords = (e.features[0].geometry as GeoJSON.Point).coordinates as [number, number];

        popupRef.current?.remove();

        const html = `
          <div class="cews-popup" style="min-width:220px;font-family:system-ui,sans-serif;color:#f9fafb">
            <h3 style="margin:0 0 4px;font-size:14px;font-weight:700">${props?.alert_type?.replace(/_/g, ' ')?.toUpperCase() ?? 'ALERT'}</h3>
            <p style="margin:0 0 4px;font-size:11px;color:#9ca3af">${props?.lga_name ?? ''}, ${props?.state ?? ''}</p>
            <p style="margin:0 0 6px;font-size:11px;color:#d1d5db;line-height:1.4">${props?.description ?? ''}</p>
            <div style="display:flex;gap:8px;font-size:11px;color:#d1d5db">
              <span>✓ ${props?.casualties_confirmed ?? 0}</span>
              <span>~ ${props?.casualties_estimated ?? 0}</span>
              <span style="margin-left:auto;color:#9ca3af">${formatDate(props?.incident_occurred_at ?? '')}</span>
            </div>
          </div>
        `;

        popupRef.current = new maplibregl.Popup({
          closeButton: true,
          closeOnClick: false,
          className: 'cews-map-popup',
          maxWidth: '300px',
        })
          .setLngLat({ lng: coords[0], lat: coords[1] })
          .setHTML(html)
          .addTo(map);

        e.preventDefault(); // prevent LGA popup from also firing
      });

      map.on('mouseenter', 'alert-circles-layer', () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'alert-circles-layer', () => {
        map.getCanvas().style.cursor = '';
      });

      setMapReady(true);
    });

    mapRef.current = map;

    return () => {
      popupRef.current?.remove();
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // ── Update GeoJSON source when data changes ────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !data) return;

    const source = map.getSource('alert-circles') as maplibregl.GeoJSONSource | undefined;
    if (!source) return;

    const features: GeoJSON.Feature<GeoJSON.Point>[] = data.alerts.map((alert) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [alert.lng, alert.lat] },
      properties: {
        id: alert.id,
        lga_name: alert.lga_name,
        state: alert.state,
        zone: alert.zone,
        alert_type: alert.alert_type,
        description: alert.description,
        casualties_confirmed: alert.casualties_confirmed,
        casualties_estimated: alert.casualties_estimated,
        casualties_total: alert.casualties_confirmed + alert.casualties_estimated,
        incident_occurred_at: alert.incident_occurred_at,
        risk_level: alert.risk_level,
      },
    }));

    source.setData({ type: 'FeatureCollection', features });
  }, [data, mapReady]);

  // ── Zone filter / fly-to ──────────────────────────────────────────────────
  const handleZoneFilter = useCallback(
    (zone: Zone | null) => {
      setActiveZone(zone);
      const map = mapRef.current;
      if (!map) return;

      if (zone === null) {
        map.flyTo({ center: NIGERIA_CENTER, zoom: DEFAULT_ZOOM, duration: 1200 });
        // Remove zone filter from MVT layer
        map.setFilter('lga-fill', null);
        map.setFilter('lga-outline', null);
        return;
      }

      const { center, zoom } = ZONE_CENTRES[zone];
      map.flyTo({ center, zoom, duration: 1200 });

      // Filter MVT layers to show only the selected zone
      const zoneFilter: maplibregl.FilterSpecification = ['==', ['get', 'zone'], zone];
      map.setFilter('lga-fill', zoneFilter);
      map.setFilter('lga-outline', zoneFilter);
    },
    []
  );

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={`relative flex h-full min-h-[600px] bg-gray-950 rounded-xl overflow-hidden ${className}`}>
      {/* Map container */}
      <div ref={mapContainerRef} className="flex-1" aria-label="Nigeria CEWS Risk Map" role="application" />

      {/* Zone filter buttons — overlaid top-left */}
      <div
        className="absolute top-3 left-3 z-10 flex flex-wrap gap-1.5"
        role="group"
        aria-label="Filter by zone"
      >
        <button
          onClick={() => handleZoneFilter(null)}
          aria-pressed={activeZone === null}
          className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-white ${
            activeZone === null
              ? 'bg-white text-gray-900'
              : 'bg-gray-800/80 text-gray-200 hover:bg-gray-700'
          }`}
        >
          All Zones
        </button>
        {ZONES.map((z) => {
          const zoneData = data?.zones.find((zd) => zd.zone === z);
          const colour = zoneData ? RISK_COLOURS[zoneData.risk_level] : '#6b7280';
          return (
            <button
              key={z}
              onClick={() => handleZoneFilter(z)}
              aria-pressed={activeZone === z}
              style={activeZone === z ? { backgroundColor: colour, color: '#111' } : {}}
              className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-white ${
                activeZone === z
                  ? ''
                  : 'bg-gray-800/80 text-gray-200 hover:bg-gray-700'
              }`}
            >
              {z}
            </button>
          );
        })}
      </div>

      {/* Loading / error overlay */}
      {isLoading && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-gray-950/60 pointer-events-none">
          <div className="flex items-center gap-2 rounded-lg bg-gray-800 px-4 py-2 text-sm text-gray-200 shadow-lg">
            <svg className="h-4 w-4 animate-spin text-blue-400" viewBox="0 0 24 24" fill="none" aria-hidden>
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
            Loading risk data…
          </div>
        </div>
      )}
      {error && (
        <div className="absolute top-12 left-1/2 z-20 -translate-x-1/2 rounded-lg bg-red-900/90 px-4 py-2 text-xs text-red-200 shadow">
          ⚠ Failed to load zone scores — retrying…
        </div>
      )}

      {/* Legend */}
      <div className="absolute bottom-8 left-3 z-10 rounded-lg bg-gray-900/90 p-3 shadow-lg backdrop-blur-sm">
        <p className="mb-2 text-xs font-semibold text-gray-300 uppercase tracking-wide">Risk Level</p>
        <div className="space-y-1">
          {(Object.entries(RISK_COLOURS) as [RiskLevel, string][]).map(([level, colour]) => (
            <div key={level} className="flex items-center gap-2">
              <span
                className="h-3 w-3 rounded-sm shrink-0"
                style={{ backgroundColor: colour }}
                aria-hidden
              />
              <span className="text-xs capitalize text-gray-300">{level}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Sidebar — top 5 highest risk LGAs */}
      <aside
        className="w-64 shrink-0 overflow-y-auto bg-gray-900/95 border-l border-gray-700 p-4 z-10"
        aria-label="Top 5 highest-risk LGAs"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold text-white">🔴 Top Risk LGAs</h2>
          {data && (
            <span className="text-xs text-gray-500">
              Updated {formatDate(data.updated_at)}
            </span>
          )}
        </div>

        {top5LGAs.length === 0 && !isLoading && (
          <p className="text-xs text-gray-500">No data available.</p>
        )}

        <ol className="space-y-3">
          {top5LGAs.map((lga, i) => (
            <li
              key={lga.lga_id}
              className="rounded-lg bg-gray-800 p-3 cursor-pointer hover:bg-gray-700 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
              onClick={() => {
                mapRef.current?.flyTo({
                  center: [lga.lng, lga.lat],
                  zoom: 9,
                  duration: 1000,
                });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  mapRef.current?.flyTo({
                    center: [lga.lng, lga.lat],
                    zoom: 9,
                    duration: 1000,
                  });
                }
              }}
              tabIndex={0}
              role="button"
              aria-label={`Fly to ${lga.lga_name}, ${lga.state}`}
            >
              <div className="flex items-start gap-2">
                <span className="text-xs font-bold text-gray-400 shrink-0 w-4 text-right">
                  {i + 1}.
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white truncate">{lga.lga_name}</p>
                  <p className="text-xs text-gray-400 truncate">
                    {lga.state} · {lga.zone}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5 items-center">
                    <span className={riskBadgeClass(lga.risk_level)}>
                      {lga.risk_level}
                    </span>
                    <span className="text-xs text-gray-400">
                      Score: {lga.risk_score.toFixed(1)}
                    </span>
                  </div>
                  <div className="mt-1 flex gap-2 text-xs text-gray-500">
                    <span>🚨 {lga.alert_count}</span>
                    <span>💀 {lga.casualties_confirmed + lga.casualties_estimated}</span>
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ol>

        {/* Zone summary cards */}
        {data && (
          <div className="mt-6">
            <h2 className="mb-2 text-sm font-bold text-white">Zone Summary</h2>
            <div className="space-y-1.5">
              {data.zones.map((z) => (
                <button
                  key={z.zone}
                  onClick={() => handleZoneFilter(z.zone)}
                  className="w-full rounded-md flex items-center justify-between px-2 py-1.5 text-xs hover:bg-gray-700 transition-colors text-left"
                  aria-label={`Filter ${ZONE_LABELS[z.zone]}, risk: ${z.risk_level}`}
                >
                  <span className="text-gray-300 font-medium">{z.zone}</span>
                  <span
                    className="rounded-full px-2 py-0.5 text-xs font-semibold uppercase"
                    style={{
                      backgroundColor: RISK_COLOURS[z.risk_level],
                      color: z.risk_level === 'emergency' ? '#fca5a5' : '#111',
                    }}
                  >
                    {z.risk_level}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </aside>

      {/* Inject popup styles */}
      <style>{`
        .cews-map-popup .maplibregl-popup-content {
          background: #1f2937;
          border: 1px solid #374151;
          border-radius: 8px;
          padding: 12px;
          box-shadow: 0 10px 25px rgba(0,0,0,0.5);
        }
        .cews-map-popup .maplibregl-popup-tip {
          border-top-color: #1f2937;
        }
        .cews-map-popup .maplibregl-popup-close-button {
          color: #9ca3af;
          font-size: 16px;
          right: 6px;
          top: 4px;
        }
        .cews-map-popup .maplibregl-popup-close-button:hover {
          color: #f9fafb;
          background: transparent;
        }
      `}</style>
    </div>
  );
}
