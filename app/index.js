import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  Alert,
  Platform,
  PermissionsAndroid,
  StatusBar,
  TextInput,
  ActivityIndicator,
  FlatList,
  Keyboard,
  Modal,
  Animated,
  Easing,
  useColorScheme,
  AppState
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BleManager } from 'react-native-ble-plx';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { useKeepAwake } from 'expo-keep-awake';

let NativeDeviceMotion = null;
try {
  NativeDeviceMotion = require('expo-sensors')?.DeviceMotion;
} catch (e) {
  NativeDeviceMotion = null;
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const uint8ToBase64 = (bytes) => {
  let base64 = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b1 = bytes[i];
    const b2 = i + 1 < len ? bytes[i + 1] : 0;
    const b3 = i + 2 < len ? bytes[i + 2] : 0;
    base64 += BASE64_CHARS[b1 >> 2];
    base64 += BASE64_CHARS[((b1 & 3) << 4) | (b2 >> 4)];
    base64 += i + 1 < len ? BASE64_CHARS[((b2 & 15) << 2) | (b3 >> 6)] : '=';
    base64 += i + 2 < len ? BASE64_CHARS[b3 & 63] : '=';
  }
  return base64;
};

const wrap360 = (deg) => ((deg % 360) + 360) % 360;
const angleDiffDeg = (a, b) => {
  let d = wrap360(a) - wrap360(b);
  while (d < -180) d += 360;
  while (d > 180) d -= 360;
  return d;
};

const getWGS84Scale = (latDeg) => {
  const rad = (latDeg * Math.PI) / 180.0;
  const latConv = 111132.92 - 559.82 * Math.cos(2 * rad) + 1.175 * Math.cos(4 * rad);
  const lonConv = 111412.84 * Math.cos(rad) - 93.5 * Math.cos(3 * rad);
  return { latConv, lonConv };
};

const exactMetersBetween = (lat1, lon1, lat2, lon2) => {
  const { latConv, lonConv } = getWGS84Scale((lat1 + lat2) * 0.5);
  return Math.hypot((lon2 - lon1) * lonConv, (lat2 - lat1) * latConv);
};

// The full permitted 1.0x..2.0x control range must map to the full map scale.
// At 1x show ~1.2 km ahead; at 2x show ~180 m ahead. This avoids the
// previous 1.6-wide denominator, which made zoom-button changes barely visible.
const RANGE_NEAR_M = 180;
const RANGE_FAR_M = 1200;
const getVisibleRangeMeters = (zoomLevel) => {
  const z = Math.max(1.00, Math.min(2.00, Number(zoomLevel) || 2.00));
  return Math.round(RANGE_NEAR_M * Math.pow(RANGE_FAR_M / RANGE_NEAR_M, 2.00 - z));
};

const getLeafletZoomForScale = (zoomLevel) => {
  const z = Math.max(1.00, Math.min(2.00, Number(zoomLevel) || 2.00));
  return Math.round(14 + (z - 1.00) * 4);
};

const getStubBudgetForZoom = (zoomLevel) => {
  // the screen should be full at every zoom: only the packet size limits the number of road pieces
  return 96;
};

const SERVICE_UUID = "4fafc201-1fb5-459e-8fcc-c5c9c331914b";
const CHARACTERISTIC_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a8";
const BACKGROUND_LOCATION_TASK = "NAVPOD_BACKGROUND_LOCATION_TASK";

const STORAGE_KEY_RECENTS = "@navpod_recents";
const STORAGE_KEY_TRIPS = "@navpod_saved_trips";
const STORAGE_KEY_FACE = "@navpod_face_mode";
const STORAGE_KEY_ZOOM = "@navpod_zoom_v6";
const USER_AGENT_HEADER = { 'User-Agent': 'NavPodCompanion/1.0' };
const MAX_SAVED_TRIPS = 200;
const ROUTE_CACHE_KEY = '@navpod_last_successful_route_v1';
const ROUTE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const TELEMETRY_PACKET_ID = 0xA6;
const NAV_FLAG_ACTIVE = 1;
const NAV_FLAG_REROUTING = 2;
const NAV_FLAG_OFF_ROUTE = 4;
const NAV_FLAG_NETWORK_DEGRADED = 8;
const NAV_FLAG_JUNCTION = 16;
const NAV_FLAG_HIGH_SPEED = 32;
const NAV_FLAG_ETA_UNKNOWN = 64;
const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number.isFinite(v) ? v : lo)));
const cacheSuccessfulRoute = (routes, destination, startLat, startLon) => {
  if (!routes?.[0]?.geometry?.coordinates?.length || !destination) return;
  // Cache the exact OSRM response to retain maneuvers, intersections and geometry.
  AsyncStorage.setItem(ROUTE_CACHE_KEY, JSON.stringify({
    timestamp: Date.now(), destination, startLat, startLon, routes: routes.slice(0, 3),
  })).catch(() => {});
};
const getCachedRoute = async (destination, startLat, startLon) => {
  try {
    const value = await AsyncStorage.getItem(ROUTE_CACHE_KEY);
    if (!value) return [];
    const c = JSON.parse(value);
    if (!Number.isFinite(c.timestamp) || Date.now() - c.timestamp > ROUTE_CACHE_TTL_MS || c.timestamp > Date.now()) return [];
    if (!c.destination || exactMetersBetween(c.destination.latitude, c.destination.longitude, destination.latitude, destination.longitude) > 100) return [];
    // Only reuse the route near its original departure location.
    if (exactMetersBetween(c.startLat, c.startLon, startLat, startLon) > 100) return [];
    if (!Array.isArray(c.routes) || !c.routes[0]?.legs?.[0]?.steps || !c.routes[0]?.geometry?.coordinates?.length) return [];
    return c.routes;
  } catch (_) { return []; }
};

// Lightweight bounded OSM cache: persisted without float-array precomputations.
const ROAD_CACHE_KEY = '@navpod_osm_roads_v1';
const ROAD_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const restoreRoadCache = async (lat, lon) => {
  try {
    const raw = await AsyncStorage.getItem(ROAD_CACHE_KEY);
    if (!raw) return false;
    const item = JSON.parse(raw);
    if (!item || !Array.isArray(item.ways) || Date.now() - item.at > ROAD_CACHE_TTL_MS ||
        item.at > Date.now() || exactMetersBetween(lat, lon, item.lat, item.lon) > 850 ||
        navCore.osmLocalWays.length) return false;
    const { latConv, lonConv } = getWGS84Scale(item.lat);
    navCore.osmLocalWays = item.ways.filter(w => w && Array.isArray(w.c) && w.c.length >= 2)
      .map(w => precomputeWayMeters(w, item.lat, item.lon, latConv, lonConv));
    navCore.osmCoverageM = item.coverageM || 850;
    navCore.osmRoadCenter = { lat: item.lat, lon: item.lon, latConv, lonConv };
    rebuildCombinedOsmWays(item.lat, item.lon, latConv, lonConv);
    navCore.lastOsmGraphBuild = 0;
    navCore.diagnostics.osmCacheHits++;
    setOsmStatus(`${navCore.osmRoadWays.length} cached roads`);
    return true;
  } catch (_) { return false; }
};
const persistRoadCache = (lat, lon, ways, coverageM) => {
  // Keep a bounded cache to avoid large AsyncStorage writes and main-thread stalls.
  const compact = ways.slice(0, 450).map(w => ({
    c: w.c.length > 250 ? w.c.filter((_, i) => i % Math.ceil(w.c.length / 250) === 0 || i === w.c.length - 1) : w.c,
    lv: w.lv, id: w.id, d: w.d,
  }));
  AsyncStorage.setItem(ROAD_CACHE_KEY, JSON.stringify({
    at: Date.now(), lat, lon, coverageM: Math.min(850, coverageM), ways: compact,
  })).catch(() => {});
};

const OSM_LOCAL_BBOX_M = 1600;
const OSM_FAR_BBOX_M = 3200;
const OSM_REFETCH_METERS = 600;
// Local Overpass data covers a 1600 m half-width bounding box. Do not reuse it
// 4 km away: doing so silently drops residential streets near the rider.
const OSM_CACHE_USABLE_METERS = 1500;
const MAX_STUBS = 96;
const MAX_BLE_PAYLOAD = 500;

// Visible window in the ESP32's own "pixel" space (before its perspective squeeze).
// X +-104 covers the 172px-wide panel with margin; Y -74..262 spans the bottom edge up to the top edge.
// Anything outside this window is never sent, so no BLE bytes are wasted on invisible geometry.
const VIEW_MIN_X = -104;
const VIEW_MAX_X = 104;
const VIEW_MIN_Y = -74;
const VIEW_MAX_Y = 262;

const LEVEL_MAX_RANGE = [Infinity, Infinity, Infinity, 4500, 2200];

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const navCore = {
  activeDevice: null,
  navState: "IDLE",
  routeCoords: [],
  altRoutes: [],
  altMeta: [],
  intersections: [],
  stepManeuvers: [],
  maneuverIdxMap: new Map(),
  lastBestSegmentIdx: 0,
  routeForwardBearing: 0,
  destCoords: null,
  resolvedPlace: "",
  zoomLevel: 2.00,
  userZoomLevel: 2.00,
  autoJunctionZoom: false,
  manualZoomOverrideUntil: 0,
  roadCacheRestoreAttemptMs: 0,
  diagnostics: { gpsAccuracy: null, gpsIntervalMs: 0, lastGpsMs: 0, bleWrites: 0, bleErrors: 0, bleLastWriteMs: 0, osmCacheHits: 0, osmRequests: 0, offRouteMeters: 0, mapRoads: 0, headingSource: "waiting" },
  heading: 0,
  fusedHeading: 0,
  headingInitialized: false,
  compassGpsOffset: 0,
  gravX: 0,
  gravY: 0.7,
  gravZ: 0.7,
  isScreenDown: false,
  isPitchInverted: false,
  lastImuTimestamp: 0,
  hasActiveImuGyro: false,
  filteredSpeed: 0,
  lastSpeedTimestamp: 0,
  lastPosition: null,
  gpsCourseBearing: null,
  // Pocket mode: phone attitude is unrelated to vehicle direction.
  pocketMode: true,
  lastReliableCourseMs: 0,
  rerouteAnchor: null,
  lastFixTs: 0,
  odomAnchor: null,
  totalMeters: 0.0,
  topSpeed: 0,
  rideStartMs: 0,
  rawForwardPool: [],
  rawReversePool: [],
  rawRoadPool: [],
  lockedWorldPolylines: [],
  roadOrigin: null,
  osmRoadWays: [],
  osmRoadCenter: null,
  osmLastAttempt: 0,
  osmFetching: false,
  osmFarLoaded: false,
  osmFarFetching: false,
  osmRequestId: 0,
  osmController: null,
  osmLocalWays: [],
  osmFarWays: [],
  osmStatus: 'idle',
  lastStubCount: 0,
  cachedDistToTurn: 0,
  cachedTurnManeuver: 0,
  remainingRouteMeters: 0,
  etaMinutes: null,
  etaAtMs: 0,
  junctionMode: false,
  isNetworkDegraded: false,
  arrivalFixCount: 0,
  lastTelemetryBleTime: 0,
  lastOsmGraphBuild: 0,
  lastGraphLat: null,
  lastGraphLon: null,
  lastBleSendTime: 0,
  lastUIUpdateTime: 0,
  blePayloadMax: 244,
  bleWriteChain: Promise.resolve(),
  bleStreamInFlight: false,
  pendingStreamPayload: null,
  stopInProgress: false,
  offRouteCount: 0,
  wrongWayCount: 0,
  isRerouting: false,
  lastRerouteTime: 0,
  rerouteSeq: 0,
  rerouteAbort: null,
  routeFetchAbort: null,
  onUIUpdate: null,
  onAutoArrive: null,
};

const roadLevel = (hw) => {
  if (/^(motorway|trunk|primary)(_link)?$/.test(hw)) return 0;
  if (/^secondary(_link)?$/.test(hw)) return 1;
  if (/^tertiary(_link)?$/.test(hw)) return 2;
  if (hw === 'service' || hw === 'track') return 4;
  return 3;
};

const setOsmStatus = (text) => {
  navCore.osmStatus = text;
  if (navCore.onUIUpdate) navCore.onUIUpdate({ type: 'OSM_STATUS', text });
};

const fetchOverpassFast = async (query, parentSignal) => {
  const controllers = [];
  const cleanup = () => {
    for (let i = 0; i < controllers.length; i++) {
      try { controllers[i].abort(); } catch (e) {}
    }
  };
  if (parentSignal && parentSignal.addEventListener) {
    parentSignal.addEventListener('abort', cleanup);
  }

  try {
    const attempts = OVERPASS_ENDPOINTS.slice(0, 2).map(async (endpoint) => {
      const ctrl = new AbortController();
      controllers.push(ctrl);
      const timer = setTimeout(() => ctrl.abort(), 7500);
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
            'User-Agent': 'NavPodCompanion/1.0',
          },
          body: `data=${encodeURIComponent(query)}`,
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error('HTTP_' + res.status);
        const json = await res.json();
        if (!json || !Array.isArray(json.elements)) throw new Error('BAD_JSON');
        return json;
      } finally {
        clearTimeout(timer);
      }
    });

    const fastResult = await new Promise((resolve) => {
      let pending = attempts.length;
      let settled = false;
      attempts.forEach((p) => {
        p.then((val) => {
          if (!settled && val) {
            settled = true;
            cleanup();
            resolve(val);
          }
        }).catch(() => {
          pending -= 1;
          if (pending === 0 && !settled) resolve(null);
        });
      });
    });
    if (fastResult) return fastResult;
    if (parentSignal?.aborted) return null;
    // Third independent endpoint increases reliability when the first two are busy.
    const fallback = new AbortController();
    controllers.push(fallback);
    const timer = setTimeout(() => fallback.abort(), 7500);
    try {
      const response = await fetch(OVERPASS_ENDPOINTS[2], {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: `data=${encodeURIComponent(query)}`,
        signal: fallback.signal,
      });
      if (!response.ok) return null;
      const json = await response.json();
      return Array.isArray(json?.elements) ? json : null;
    } catch (e) { return null; }
    finally { clearTimeout(timer); }
  } finally {
    if (parentSignal && parentSignal.removeEventListener) {
      parentSignal.removeEventListener('abort', cleanup);
    }
  }
};

const OSRM_DRIVING_SERVERS = [
  'https://routing.openstreetmap.de/routed-car/route/v1/driving',
  'https://router.project-osrm.org/route/v1/driving',
];

const fetchRoutes = async (lon, lat, dest, signal, headingParam = '', allowAlternatives = false) => {
  const altStr = allowAlternatives ? 'true' : 'false';
  const coordsPath = `${lon.toFixed(6)},${lat.toFixed(6)};${dest.longitude.toFixed(6)},${dest.latitude.toFixed(6)}`;
  const queryBase = `?overview=full&geometries=geojson&steps=true&alternatives=${altStr}&continue_straight=true`;

  for (let s = 0; s < OSRM_DRIVING_SERVERS.length; s++) {
    if (signal && signal.aborted) return [];
    const server = OSRM_DRIVING_SERVERS[s];
    try {
      if (headingParam) {
        const res = await fetch(`${server}/${coordsPath}${queryBase}${headingParam}`, {
          headers: USER_AGENT_HEADER,
          signal,
        });
        if (res.ok) {
          const data = await res.json();
          if (data && Array.isArray(data.routes) && data.routes.length > 0) {
            return data.routes;
          }
        }
      }
      const res2 = await fetch(`${server}/${coordsPath}${queryBase}`, {
        headers: USER_AGENT_HEADER,
        signal,
      });
      if (res2.ok) {
        const data2 = await res2.json();
        if (data2 && Array.isArray(data2.routes) && data2.routes.length > 0) {
          return data2.routes;
        }
      }
    } catch (e) {}
  }
  return [];
};

const simplifyWayMeters = (pts, epsMeters = 4.0) => {
  const n = pts.length;
  if (n <= 2) return pts;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    const ax = pts[s].x, ay = pts[s].y;
    const dx = pts[e].x - ax, dy = pts[e].y - ay;
    const lenSq = dx * dx + dy * dy;
    let maxD = -1, idx = -1;
    for (let i = s + 1; i < e; i++) {
      let d;
      if (lenSq < 1e-6) {
        d = Math.hypot(pts[i].x - ax, pts[i].y - ay);
      } else {
        const t = Math.max(0, Math.min(1, ((pts[i].x - ax) * dx + (pts[i].y - ay) * dy) / lenSq));
        d = Math.hypot(pts[i].x - (ax + t * dx), pts[i].y - (ay + t * dy));
      }
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (idx !== -1 && maxD > epsMeters) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
};

const precomputeWayMeters = (way, refLat, refLon, latConv, lonConv) => {
  const c = way.c;
  const rawPts = [];
  for (let i = 0; i < c.length; i++) {
    rawPts.push({
      x: (c[i][0] - refLon) * lonConv,
      y: (c[i][1] - refLat) * latConv,
    });
  }
  const simp = simplifyWayMeters(rawPts, 1.0);
  const n = simp.length;
  const mx = new Float32Array(n);
  const my = new Float32Array(n);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = simp[i].x;
    const y = simp[i].y;
    mx[i] = x;
    my[i] = y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  way.mx = mx;
  way.my = my;
  way._refLat = refLat;
  way._refLon = refLon;
  way._sk = -1;
  way.minX = minX;
  way.maxX = maxX;
  way.minY = minY;
  way.maxY = maxY;
  return way;
};

const parseOverpassWays = (data, lat, lon, maxWays = 150) => {
  const { latConv, lonConv } = getWGS84Scale(lat);
  const parsed = [];
  const elements = (data && Array.isArray(data.elements)) ? data.elements : [];

  for (let eIdx = 0; eIdx < elements.length; eIdx++) {
    const w = elements[eIdx];
    if (w.type !== 'way' || !Array.isArray(w.geometry) || w.geometry.length < 2) continue;
    const srv = w.tags && w.tags.service;
    if (srv === 'parking_aisle' || srv === 'driveway' || srv === 'alley') continue;

    const geom = w.geometry;
    const coords = [];
    let minD = Infinity;

    for (let i = 0; i < geom.length; i++) {
      const pt = geom[i];
      if (!Number.isFinite(pt?.lat) || !Number.isFinite(pt?.lon)) continue;
      coords.push([pt.lon, pt.lat]);
      const d = Math.hypot((pt.lon - lon) * lonConv, (pt.lat - lat) * latConv);
      if (d < minD) minD = d;
    }
    if (coords.length < 2) continue;

    const hw = (w.tags && w.tags.highway) || '';
    parsed.push({
      c: coords,
      lv: roadLevel(hw),
      id: w.id || 0,
      d: minD,
    });
  }

  parsed.sort((a, b) => (a.d - b.d) || (a.lv - b.lv));
  const out = [];
  const limit = Math.min(parsed.length, maxWays);
  for (let i = 0; i < limit; i++) {
    out.push(precomputeWayMeters(parsed[i], lat, lon, latConv, lonConv));
  }
  // how far from the fetch centre the downloaded road data is complete
  out.coverageM = parsed.length > limit ? Math.max(100, parsed[limit - 1].d) : 1500;
  return out;
};

const rebuildCombinedOsmWays = (centerLat, centerLon, latConv, lonConv) => {
  const seenIds = new Set();
  const combined = [];
  const lists = [navCore.osmLocalWays, navCore.osmFarWays];
  for (let l = 0; l < lists.length; l++) {
    const arr = lists[l] || [];
    for (let i = 0; i < arr.length; i++) {
      const w = arr[i];
      if (w.id > 0 && seenIds.has(w.id)) continue;
      if (w.id > 0) seenIds.add(w.id);
      if (!(w.mx && w._refLat === centerLat && w._refLon === centerLon)) {
        precomputeWayMeters(w, centerLat, centerLon, latConv, lonConv);
      }
      combined.push(w);
    }
  }
  navCore.osmRoadWays = combined;
  // Next GPS update must rebuild the visible geometry from the refreshed OSM ways.
  navCore.lastOsmGraphBuild = 0;
};

const loadFarRoadsIfNeeded = async () => {
  if (navCore.navState !== "NAVIGATING") return;
  if (navCore.zoomLevel >= 1.05 || navCore.filteredSpeed > 70 || navCore.junctionMode) return;
  if (navCore.osmFarLoaded || navCore.osmFarFetching) return;
  const center = navCore.osmRoadCenter || (navCore.lastPosition ? {
    lat: navCore.lastPosition.latitude,
    lon: navCore.lastPosition.longitude,
  } : null);
  if (!center) return;

  navCore.osmFarFetching = true;
  const requestId = navCore.osmRequestId;
  const { latConv, lonConv } = getWGS84Scale(center.lat);
  if (!navCore.osmRoadCenter) {
    navCore.osmRoadCenter = { lat: center.lat, lon: center.lon, latConv, lonConv };
  }
  const dLat = (OSM_FAR_BBOX_M / latConv);
  const dLon = (OSM_FAR_BBOX_M / lonConv);
  const bbox = `${(center.lat - dLat).toFixed(5)},${(center.lon - dLon).toFixed(5)},${(center.lat + dLat).toFixed(5)},${(center.lon + dLon).toFixed(5)}`;
  const q = `[out:json][timeout:8];way(${bbox})["highway"~"^(motorway|trunk|primary|secondary|tertiary)(_link)?$"];out geom qt;`;

  try {
    const data = await fetchOverpassFast(q, navCore.osmController ? navCore.osmController.signal : null);
    if (!data || requestId !== navCore.osmRequestId || navCore.navState !== "NAVIGATING") return;
    navCore.osmFarWays = parseOverpassWays(data, center.lat, center.lon, 400);
    rebuildCombinedOsmWays(center.lat, center.lon, latConv, lonConv);
    navCore.osmFarLoaded = true;
    setOsmStatus(`${navCore.osmRoadWays.length} roads (full map)`);
    if (navCore.lastPosition) {
      processGPSPosition({ coords: navCore.lastPosition }, true, true);
    }
  } catch (e) {
  } finally {
    navCore.osmFarFetching = false;
  }
};

const loadNearbyRoads = async (lat, lon) => {
  if (navCore.osmFetching || navCore.navState !== "NAVIGATING") return;
  const now = Date.now();
  const center = navCore.osmRoadCenter;
  if (center && navCore.osmLocalWays.length > 0 &&
      exactMetersBetween(lat, lon, center.lat, center.lon) < Math.min(OSM_REFETCH_METERS, Math.max(120, (navCore.osmCoverageM || 400) * 0.40))) {
    if (navCore.zoomLevel < 1.05 && !navCore.osmFarLoaded) {
      loadFarRoadsIfNeeded();
    }
    return;
  }
  if (now - navCore.osmLastAttempt < 12000) return;
  // Try a persisted offline road tile before requesting the network.
  if (!center && now - navCore.roadCacheRestoreAttemptMs > 10000) {
    navCore.roadCacheRestoreAttemptMs = now;
    const restored = await restoreRoadCache(lat, lon);
    if (restored && navCore.lastPosition) {
      processGPSPosition({ coords: navCore.lastPosition }, true, true);
      return;
    }
  }
  navCore.osmLastAttempt = now;
  navCore.osmFetching = true;
  navCore.osmFarLoaded = false;
  navCore.diagnostics.osmRequests++;
  const requestId = ++navCore.osmRequestId;
  const controller = new AbortController();
  navCore.osmController = controller;

  const { latConv, lonConv } = getWGS84Scale(lat);
  const dLat = (OSM_LOCAL_BBOX_M / latConv);
  const dLon = (OSM_LOCAL_BBOX_M / lonConv);
  const bbox = `${(lat - dLat).toFixed(5)},${(lon - dLon).toFixed(5)},${(lat + dLat).toFixed(5)},${(lon + dLon).toFixed(5)}`;
  const q = `[out:json][timeout:8];way(${bbox})["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|track)(_link)?$"];out geom qt;`;

  try {
    const data = await fetchOverpassFast(q, controller.signal);
    if (requestId !== navCore.osmRequestId || navCore.navState !== "NAVIGATING") return;
    if (data && Array.isArray(data.elements) && data.elements.length > 0) {
      navCore.osmLocalWays = parseOverpassWays(data, lat, lon, 1500);
      persistRoadCache(lat, lon, navCore.osmLocalWays, navCore.osmLocalWays.coverageM || 850);
      navCore.osmCoverageM = navCore.osmLocalWays.coverageM || 400;
      navCore.osmRoadCenter = { lat, lon, latConv, lonConv };
      rebuildCombinedOsmWays(lat, lon, latConv, lonConv);
      navCore.lastOsmGraphBuild = 0;
      setOsmStatus(`${navCore.osmRoadWays.length} local roads`);
      if (navCore.lastPosition) {
        processGPSPosition({ coords: navCore.lastPosition }, true, true);
      }
      if (navCore.zoomLevel < 1.05) {
        loadFarRoadsIfNeeded();
      }
    }
  } catch (err) {
  } finally {
    if (navCore.osmController === controller) navCore.osmController = null;
    navCore.osmFetching = false;
  }
};

// Straight "ray" roads built from OSRM intersection bearings.
// These are ONLY a short fallback for the moments before real OSM roads are available.
// (Previously they were 220-2800 m long and were always mixed in with the real roads, which is
// what made side roads look fake and tangled. Alternative routes are no longer mixed in either.)
const buildGuaranteedRouteJunctionWays = (lat, lon, lonConv, latConv, viewRangeMeters) => {
  const out = [];
  const rayLenM = Math.max(40, Math.min(120, viewRangeMeters * 0.16));
  const maxRangeM = viewRangeMeters * 1.20;
  const maxSq = maxRangeM * maxRangeM;

  for (const s of (navCore.intersections || [])) {
    const p = s && s.location;
    if (!p || !Number.isFinite(s.bearing)) continue;
    const dx = (p[0] - lon) * lonConv;
    const dy = (p[1] - lat) * latConv;
    const dSq = dx * dx + dy * dy;
    if (dSq > maxSq) continue;
    const b = (s.bearing * Math.PI) / 180.0;
    const way = {
      c: [
        [p[0], p[1]],
        [p[0] + (Math.sin(b) * rayLenM) / lonConv, p[1] + (Math.cos(b) * rayLenM) / latConv],
      ],
      lv: 2,
      id: -1,
      d: Math.sqrt(dSq),
      isRay: true,
    };
    out.push(precomputeWayMeters(way, lat, lon, latConv, lonConv));
    if (out.length >= 40) break;
  }
  return out;
};

const encodeXByte = (rx) => {
  const v = Math.max(-127, Math.min(127, Math.round(rx / 1.30)));
  return v < 0 ? 256 + v : v;
};
const encodeYByte = (ry) => {
  const v = Math.max(-127, Math.min(127, Math.round((ry - 88.0) / 1.40)));
  return v < 0 ? 256 + v : v;
};

const clipLineSegmentToRect = (x1, y1, x2, y2, minX = VIEW_MIN_X, maxX = VIEW_MAX_X, minY = VIEW_MIN_Y, maxY = VIEW_MAX_Y) => {
  let t0 = 0.0;
  let t1 = 1.0;
  const dx = x2 - x1;
  const dy = y2 - y1;

  let p, q, r;

  p = -dx; q = x1 - minX;
  if (Math.abs(p) < 1e-6) { if (q < 0) return null; }
  else { r = q / p; if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; } }

  p = dx; q = maxX - x1;
  if (Math.abs(p) < 1e-6) { if (q < 0) return null; }
  else { r = q / p; if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; } }

  p = -dy; q = y1 - minY;
  if (Math.abs(p) < 1e-6) { if (q < 0) return null; }
  else { r = q / p; if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; } }

  p = dy; q = maxY - y1;
  if (Math.abs(p) < 1e-6) { if (q < 0) return null; }
  else { r = q / p; if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; } }

  return {
    x1: x1 + t0 * dx,
    y1: y1 + t0 * dy,
    x2: x1 + t1 * dx,
    y2: y1 + t1 * dy,
  };
};

const withTimeout = (promise, ms = 1500) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('BLE_TIMEOUT')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });

const ingest3DInertialSample = (gx, gy, gz, rotXDegPerSec, rotYDegPerSec, rotZDegPerSec, nowMs) => {
  if (navCore.pocketMode) return; // Ignore pocket gyroscope rotation.
  const gNorm = Math.hypot(gx, gy, gz);
  if (gNorm > 2.0) {
    const ux = gx / gNorm;
    const uy = gy / gNorm;
    const uz = gz / gNorm;
    navCore.gravX = navCore.gravX * 0.8 + ux * 0.2;
    navCore.gravY = navCore.gravY * 0.8 + uy * 0.2;
    navCore.gravZ = navCore.gravZ * 0.8 + uz * 0.2;

    if (navCore.gravZ < -0.65 && Math.abs(navCore.gravY) < 0.55) {
      navCore.isScreenDown = true;
    } else if (navCore.gravZ > -0.45) {
      navCore.isScreenDown = false;
    }

    const pitchInv = (navCore.gravY < -0.32) || (navCore.gravY > 0.45 && navCore.gravZ < -0.22);
    const pitchNorm = (navCore.gravY > -0.15) && (navCore.gravZ > -0.05);
    if (pitchInv) navCore.isPitchInverted = true;
    else if (pitchNorm) navCore.isPitchInverted = false;
  }

  if (navCore.lastImuTimestamp > 0) {
    const dt = (nowMs - navCore.lastImuTimestamp) / 1000.0;
    if (dt > 0.001 && dt < 0.25) {
      const nNorm = Math.hypot(navCore.gravX, navCore.gravY, navCore.gravZ) || 1.0;
      const ux = navCore.gravX / nNorm;
      const uy = navCore.gravY / nNorm;
      const uz = navCore.gravZ / nNorm;

      const yawRateDegPerSec = -(rotXDegPerSec * ux + rotYDegPerSec * uy + rotZDegPerSec * uz);

      if (Math.abs(yawRateDegPerSec) > 0.9) {
        navCore.hasActiveImuGyro = true;
        const deltaYaw = yawRateDegPerSec * dt;
        navCore.fusedHeading = wrap360(navCore.fusedHeading + deltaYaw);
        const nextHeading = wrap360(navCore.fusedHeading + navCore.compassGpsOffset);

        if (Math.abs(angleDiffDeg(nextHeading, navCore.heading)) >= 1.0) {
          navCore.heading = nextHeading;
          if (navCore.navState === "NAVIGATING") {
            streamCachedVectorsToBLE(false);
          }
        }
      }
    }
  }
  navCore.lastImuTimestamp = nowMs;
};

const ingestCompassHeadingSample = (rawMagOrTrueHeading) => {
  if (navCore.pocketMode) return; // Phone compass != motorcycle direction.
  if (!Number.isFinite(rawMagOrTrueHeading) || rawMagOrTrueHeading < 0) return;

  if (navCore.filteredSpeed >= 9.0 && Number.isFinite(navCore.gpsCourseBearing) &&
      Date.now() - (navCore.lastReliableCourseMs || 0) < 4000) {
    return;
  }

  let compensatedH = wrap360(rawMagOrTrueHeading);

  if (navCore.isScreenDown) {
    compensatedH = wrap360(360 - compensatedH);
  }
  if (navCore.isPitchInverted) {
    compensatedH = wrap360(compensatedH + 180);
  }

  if (!navCore.headingInitialized) {
    navCore.fusedHeading = compensatedH;
    navCore.heading = wrap360(compensatedH + navCore.compassGpsOffset);
    navCore.headingInitialized = true;
    return;
  }

  const diff = angleDiffDeg(compensatedH, navCore.fusedHeading);
  const absDiff = Math.abs(diff);

  if (absDiff < 3.0) return;

  const gyroRecentlyActive = navCore.hasActiveImuGyro && (Date.now() - navCore.lastImuTimestamp < 350);
  const gain = gyroRecentlyActive ? 0.06 : (absDiff > 25 ? 0.25 : 0.12);

  navCore.fusedHeading = wrap360(navCore.fusedHeading + diff * gain);
  const nextHeading = wrap360(navCore.fusedHeading + navCore.compassGpsOffset);

  if (Math.abs(angleDiffDeg(nextHeading, navCore.heading)) >= 2.8) {
    navCore.heading = nextHeading;
    if (navCore.navState === "NAVIGATING") {
      streamCachedVectorsToBLE(false);
    }
  }
};

const parseSingleRoute = (route) => {
  const stubs = [];
  const maneuvers = [];
  if (!route || !route.legs || !route.legs[0]?.steps) return { stubs, maneuvers };

  route.legs[0].steps.forEach((step) => {
    const m = step.maneuver;
    if (m && Array.isArray(m.location)) {
      const type = m.type || '';
      const mod = m.modifier || '';
      let code = 0;

      if (type === 'roundabout' || type === 'rotary' || type === 'roundabout turn') {
        const exitNum = Number(m.exit);
        code = (Number.isFinite(exitNum) && exitNum >= 1 && exitNum <= 6) ? (10 + exitNum) : 4;
      } else if (mod === 'uturn') {
        code = -3;
      } else if (type !== 'depart' && type !== 'arrive') {
        if (mod === 'sharp left') code = -2;
        else if (mod === 'left' || mod === 'slight left') code = -1;
        else if (mod === 'right' || mod === 'slight right') code = 1;
        else if (mod === 'sharp right') code = 2;
      }

      if (code !== 0) {
        maneuvers.push({ lon: m.location[0], lat: m.location[1], code });
      }
    }

    if (!step.intersections) return;
    step.intersections.forEach((inter) => {
      if (inter.location && Array.isArray(inter.bearings)) {
        const outBearing = (inter.out !== undefined && inter.bearings[inter.out] !== undefined)
          ? inter.bearings[inter.out]
          : null;
        const inBearing = (inter.in !== undefined && inter.bearings[inter.in] !== undefined)
          ? (inter.bearings[inter.in] + 180) % 360
          : null;

        inter.bearings.forEach((bearing, idx) => {
          if (idx === inter.out || idx === inter.in) return;
          if (outBearing !== null && Math.abs(angleDiffDeg(bearing, outBearing)) < 20) return;
          if (inBearing !== null && Math.abs(angleDiffDeg(bearing, inBearing)) < 20) return;
          if (outBearing !== null && Math.abs(angleDiffDeg(bearing, (outBearing + 180) % 360)) < 20) return;
          if (inBearing !== null && Math.abs(angleDiffDeg(bearing, (inBearing + 180) % 360)) < 20) return;

          stubs.push({ location: inter.location, bearing });
        });
      }
    });
  });

  return { stubs, maneuvers };
};

const buildManeuverIndexMap = (coords, maneuvers) => {
  const map = new Map();
  if (!coords || !coords.length || !maneuvers || !maneuvers.length) return map;
  const { latConv, lonConv } = getWGS84Scale(coords[0][1]);
  for (let k = 0; k < maneuvers.length; k++) {
    const m = maneuvers[k];
    // Preserve *all* OSRM maneuvers, including ordinary left/right turns.
    if (!Number.isFinite(m.code) || m.code === 0) continue;
    let best = -1;
    let bestD = 18;
    for (let i = 0; i < coords.length; i++) {
      const d = Math.hypot((coords[i][0] - m.lon) * lonConv, (coords[i][1] - m.lat) * latConv);
      if (d < bestD) {
        bestD = d;
        best = i;
        if (d < 0.5) break;
      }
    }
    if (best >= 0) map.set(best, m.code);
  }
  return map;
};

const toLeafletCoords = (coords) => coords.map((pt) => [pt[1], pt[0]]);

const applyRouteResponse = (routes) => {
  const metas = routes.map(parseSingleRoute);
  navCore.routeCoords = (Array.isArray(routes[0]?.geometry?.coordinates) ? routes[0].geometry.coordinates : []).filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  navCore.altRoutes = routes.slice(1).map((r) => (Array.isArray(r.geometry?.coordinates) ? r.geometry.coordinates : []).filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])));
  navCore.altMeta = metas.slice(1);
  navCore.intersections = metas[0].stubs;
  navCore.stepManeuvers = metas[0].maneuvers;
  navCore.maneuverIdxMap = buildManeuverIndexMap(navCore.routeCoords, metas[0].maneuvers);
  navCore.lastBestSegmentIdx = 0;
  navCore.offRouteCount = 0;
  navCore.wrongWayCount = 0;
};

const emitRouteToUI = () => {
  const dest = navCore.destCoords;
  if (!navCore.onUIUpdate || !dest) return;
  navCore.onUIUpdate({
    type: "REROUTE_SUCCESS",
    coords: toLeafletCoords(navCore.routeCoords),
    altCoords: navCore.altRoutes.map(toLeafletCoords),
    destLat: dest.latitude,
    destLon: dest.longitude,
  });
};

const simplifyPolylineRDP = (points, maxPoints) => {
  if (!points || points.length <= maxPoints) return points || [];
  if (maxPoints <= 2) return [points[0], points[points.length - 1]];

  const n = points.length;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  let keptCount = 2;

  const findFurthest = (start, end) => {
    const pA = points[start];
    const pB = points[end];
    const dx = pB.x - pA.x;
    const dy = pB.y - pA.y;
    const lenSq = dx * dx + dy * dy;
    let maxDist = -1;
    let bestIdx = -1;

    for (let i = start + 1; i < end; i++) {
      let d;
      if (lenSq < 1e-4) {
        d = Math.hypot(points[i].x - pA.x, points[i].y - pA.y);
      } else {
        const t = Math.max(0, Math.min(1, ((points[i].x - pA.x) * dx + (points[i].y - pA.y) * dy) / lenSq));
        d = Math.hypot(points[i].x - (pA.x + t * dx), points[i].y - (pA.y + t * dy));
      }
      if (d > maxDist) {
        maxDist = d;
        bestIdx = i;
      }
    }
    return { start, end, maxDist, bestIdx };
  };

  const segments = [findFurthest(0, n - 1)];

  while (keptCount < maxPoints && segments.length > 0) {
    let bestSegIdx = 0;
    for (let i = 1; i < segments.length; i++) {
      if (segments[i].maxDist > segments[bestSegIdx].maxDist) {
        bestSegIdx = i;
      }
    }

    const seg = segments.splice(bestSegIdx, 1)[0];
    if (seg.bestIdx === -1) continue;

    keep[seg.bestIdx] = 1;
    keptCount++;

    if (seg.bestIdx - seg.start > 1) {
      segments.push(findFurthest(seg.start, seg.bestIdx));
    }
    if (seg.end - seg.bestIdx > 1) {
      segments.push(findFurthest(seg.bestIdx, seg.end));
    }
  }

  const out = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push(points[i]);
  }
  return out;
};

const slicePoolToRange = (rawPool, targetRangeMeters, maxOutPoints, maxExtendMeters = Infinity) => {
  if (!rawPool || rawPool.length <= 1) return [{ x: 0, y: 0 }];

  const clipped = [{ x: rawPool[0].x, y: rawPool[0].y }];
  let accum = 0;

  for (let i = 1; i < rawPool.length; i++) {
    const p0 = rawPool[i - 1];
    const p1 = rawPool[i];
    const segLen = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    if (segLen < 0.4) continue;

    if (accum + segLen >= targetRangeMeters) {
      const r = (targetRangeMeters - accum) / segLen;
      clipped.push({
        x: p0.x + (p1.x - p0.x) * r,
        y: p0.y + (p1.y - p0.y) * r,
      });
      accum = targetRangeMeters;
      break;
    }
    clipped.push({ x: p1.x, y: p1.y });
    accum += segLen;
  }

  if (accum < targetRangeMeters && clipped.length >= 2) {
    const pLast = clipped[clipped.length - 1];
    const pPrev = clipped[clipped.length - 2];
    const dx = pLast.x - pPrev.x;
    const dy = pLast.y - pPrev.y;
    const dLen = Math.hypot(dx, dy);
    const rem = Math.min(targetRangeMeters - accum, maxExtendMeters);
    if (dLen > 0.1 && rem > 0.5) {
      clipped.push({
        x: pLast.x + (dx / dLen) * rem,
        y: pLast.y + (dy / dLen) * rem,
      });
    }
  }

  if (clipped.length > maxOutPoints) {
    return simplifyPolylineRDP(clipped, maxOutPoints);
  }

  const stepMeters = Math.max(10, Math.round(targetRangeMeters / 16));
  const subdiv = [clipped[0]];
  for (let i = 0; i < clipped.length - 1 && subdiv.length < maxOutPoints; i++) {
    const p0 = clipped[i];
    const p1 = clipped[i + 1];
    const segLen = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const remSlots = maxOutPoints - subdiv.length;
    const remSegs = clipped.length - 1 - i;
    const maxSub = Math.max(1, Math.floor(remSlots / Math.max(1, remSegs)));
    const steps = Math.min(maxSub, Math.max(1, Math.ceil(segLen / stepMeters)));

    for (let s = 1; s <= steps && subdiv.length < maxOutPoints; s++) {
      const r = s / steps;
      subdiv.push({
        x: p0.x + (p1.x - p0.x) * r,
        y: p0.y + (p1.y - p0.y) * r,
      });
    }
  }
  return subdiv;
};

const flushStreamBLE = () => {
  const device = navCore.activeDevice;
  if (!device || navCore.bleStreamInFlight || !navCore.pendingStreamPayload) return;
  if (navCore.navState !== "NAVIGATING") {
    navCore.pendingStreamPayload = null;
    return;
  }

  const payload = navCore.pendingStreamPayload;
  navCore.pendingStreamPayload = null;
  navCore.bleStreamInFlight = true;

  const encoded = uint8ToBase64(payload);
  const op = navCore.bleWriteChain.catch(() => {}).then(async () => {
    if (device !== navCore.activeDevice || navCore.navState !== "NAVIGATING") return;
    try {
      const writeStart = Date.now();
      await withTimeout(
        device.writeCharacteristicWithoutResponseForService(
          SERVICE_UUID,
          CHARACTERISTIC_UUID,
          encoded
        ),
        900
      );
      navCore.diagnostics.bleWrites++;
      navCore.diagnostics.bleLastWriteMs = Date.now() - writeStart;
    } catch (e) {
      navCore.diagnostics.bleErrors++;
      const isTimeout = e && e.message === 'BLE_TIMEOUT';
      if (!isTimeout && device === navCore.activeDevice && payload.length > 20 && navCore.blePayloadMax > 20) {
        const steps = [360, 244, 180, 120, 80, 20];
        const next = steps.find((s) => s < payload.length) || 20;
        navCore.blePayloadMax = Math.min(navCore.blePayloadMax, next);
        setTimeout(() => streamCachedVectorsToBLE(true), 20);
      }
    }
  });

  navCore.bleWriteChain = op.then(() => undefined, () => undefined);
  op.then(() => undefined, () => undefined).then(() => {
    navCore.bleStreamInFlight = false;
    if (navCore.pendingStreamPayload && navCore.navState === "NAVIGATING") {
      flushStreamBLE();
    }
  });
};

const queueBLEPacket = (payload, isStream = false) => {
  const device = navCore.activeDevice;
  if (!device) return Promise.resolve(false);

  if (isStream) {
    navCore.pendingStreamPayload = payload;
    flushStreamBLE();
    return Promise.resolve(true);
  }

  const encoded = uint8ToBase64(payload);
  const op = navCore.bleWriteChain.catch(() => {}).then(async () => {
    if (device !== navCore.activeDevice) return false;
    try {
      await withTimeout(
        device.writeCharacteristicWithoutResponseForService(
          SERVICE_UUID,
          CHARACTERISTIC_UUID,
          encoded
        ),
        1000
      );
      return true;
    } catch (err) {
      try {
        await withTimeout(
          device.writeCharacteristicWithResponseForService(
            SERVICE_UUID,
            CHARACTERISTIC_UUID,
            encoded
          ),
          1000
        );
        return true;
      } catch (e2) {
        return false;
      }
    }
  });

  navCore.bleWriteChain = op.then(() => undefined, () => undefined);
  return op;
};

const ptSegDistSq = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-6) return (px - ax) * (px - ax) + (py - ay) * (py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return (px - cx) * (px - cx) + (py - cy) * (py - cy);
};

// Squared distance between two line segments (0 when they cross).
const segSegDistSq = (ax, ay, bx, by, cx, cy, dx, dy) => {
  const d1x = bx - ax, d1y = by - ay;
  const d2x = dx - cx, d2y = dy - cy;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) > 1e-9) {
    const t = ((cx - ax) * d2y - (cy - ay) * d2x) / den;
    const u = ((cx - ax) * d1y - (cy - ay) * d1x) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
  }
  return Math.min(
    ptSegDistSq(ax, ay, cx, cy, dx, dy),
    ptSegDistSq(bx, by, cx, cy, dx, dy),
    ptSegDistSq(cx, cy, ax, ay, bx, by),
    ptSegDistSq(dx, dy, ax, ay, bx, by)
  );
};

// Simplifies a way once per zoom bucket (shift-invariant, so it is cached between GPS fixes).
const ensureSimplified = (way, eps) => {
  const key = Math.round(eps * 4);
  if (way._sk === key && way._sx) return;
  const n = way.mx.length;
  const pts = new Array(n);
  for (let i = 0; i < n; i++) pts[i] = { x: way.mx[i], y: way.my[i] };
  const sp = simplifyWayMeters(pts, eps);
  way._sx = new Float32Array(sp.length);
  way._sy = new Float32Array(sp.length);
  for (let i = 0; i < sp.length; i++) { way._sx[i] = sp[i].x; way._sy[i] = sp[i].y; }
  way._sk = key;
};

// Builds the clean set of side roads, in the SAME frame as the route:
// origin = the point where the vehicle is snapped onto the route, x = east, y = north (metres).
// Output: navCore.lockedWorldPolylines = array of polylines, each an array of contiguous {x,y} points.
const buildLockedWorldRoadGraph = () => {
  const zoomScale = navCore.zoomLevel || 2.00;
  const fwdRangeMeters = getVisibleRangeMeters(zoomScale);
  const O = navCore.roadOrigin;
  const roadPool = navCore.rawRoadPool || [];

  if (!O || roadPool.length === 0) {
    navCore.lockedWorldPolylines = [];
    return;
  }

  // shiftX/Y converts a road's stored metres (relative to the OSM fetch centre) into the route frame.
  const shiftX = Number.isFinite(O.shiftX) ? O.shiftX : 0;
  const shiftY = Number.isFinite(O.shiftY) ? O.shiftY : 0;

  const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const pxPerM = 255.0 / fwdRangeMeters;
  // radius that always contains the visible window, whatever the heading is
  const worldRadius = (Math.hypot(VIEW_MAX_X, VIEW_MAX_Y) / pxPerM) * 1.05;

  const corridorM = clampN(5.0 / pxPerM, 3.0, 35.0);   // roads closer than this hide under the blue route
  const corridorSq = corridorM * corridorM;
  const twinM = clampN(3.0 / pxPerM, 2.5, 25.0);        // parallel roads closer than ~5px are merged
  const epsM = clampN(0.9 / pxPerM, 0.8, 25.0);         // ~1px shape tolerance whatever the zoom
  const minRoadLenMeters = Math.max(4.0, 8.0 / pxPerM);
  const stepM = Math.max(6.0, corridorM * 1.2);

  // ---- main route polyline in this frame (limited to what can be on screen)
  const backPool = navCore.rawReversePool || [];
  const fwdPool = navCore.rawForwardPool || [];
  const routeChain = [];
  {
    const back = [];
    let acc = 0;
    for (let i = 1; i < backPool.length; i++) {
      acc += Math.hypot(backPool[i].x - backPool[i - 1].x, backPool[i].y - backPool[i - 1].y);
      back.push({ x: backPool[i].x, y: backPool[i].y });
      if (acc > worldRadius) break;
    }
    for (let i = back.length - 1; i >= 0; i--) routeChain.push(back[i]);
    acc = 0;
    for (let i = 0; i < fwdPool.length; i++) {
      if (i > 0) acc += Math.hypot(fwdPool[i].x - fwdPool[i - 1].x, fwdPool[i].y - fwdPool[i - 1].y);
      routeChain.push({ x: fwdPool[i].x, y: fwdPool[i].y });
      if (acc > worldRadius) break;
    }
  }
  const routeSimple = simplifyWayMeters(routeChain, Math.max(0.5, epsM * 0.5));
  const rSegs = [];
  for (let i = 0; i < routeSimple.length - 1; i++) {
    const ax = routeSimple[i].x, ay = routeSimple[i].y;
    const bx = routeSimple[i + 1].x, by = routeSimple[i + 1].y;
    const l = Math.hypot(bx - ax, by - ay);
    if (l < 0.3) continue;
    rSegs.push({
      ax, ay, bx, by, ux: (bx - ax) / l, uy: (by - ay) / l,
      x0: Math.min(ax, bx), x1: Math.max(ax, bx), y0: Math.min(ay, by), y1: Math.max(ay, by),
    });
  }

  // ---- pre-select the most useful roads (keeps the work bounded when zoomed far out)
  const pre = [];
  for (let wIdx = 0; wIdx < roadPool.length; wIdx++) {
    const w = roadPool[wIdx];
    if (fwdRangeMeters > LEVEL_MAX_RANGE[w.lv]) continue;
    if (!w.mx || w.mx.length < 2) continue;
    if (w.maxX + shiftX < -worldRadius || w.minX + shiftX > worldRadius ||
        w.maxY + shiftY < -worldRadius || w.minY + shiftY > worldRadius) continue;
    const ccx = (w.minX + w.maxX) * 0.5 + shiftX, ccy = (w.minY + w.maxY) * 0.5 + shiftY;
    const ddx = Math.max(0, Math.abs(ccx) - (w.maxX - w.minX) * 0.5);
    const ddy = Math.max(0, Math.abs(ccy) - (w.maxY - w.minY) * 0.5);
    pre.push({ w, s: w.lv * 48 + (Math.hypot(ddx, ddy) / fwdRangeMeters) * 540 });
  }
  pre.sort((a, b) => a.s - b.s);
  const wayList = pre.slice(0, 650).map((o) => o.w);

  // ---- collect candidate road runs
  const cands = [];
  for (let wIdx = 0; wIdx < wayList.length; wIdx++) {
    const way = wayList[wIdx];
    if (fwdRangeMeters > LEVEL_MAX_RANGE[way.lv]) continue;

    if (!way.mx || way.mx.length < 2) continue;

    if (
      way.maxX + shiftX < -worldRadius ||
      way.minX + shiftX > worldRadius ||
      way.maxY + shiftY < -worldRadius ||
      way.minY + shiftY > worldRadius
    ) {
      continue;
    }

    ensureSimplified(way, epsM);
    const mxArr = way._sx;
    const myArr = way._sy;

    // split the way into runs that lie inside the window
    const runs = [];
    let run = [];
    for (let i = 1; i < mxArr.length; i++) {
      const seg = clipLineSegmentToRect(
        mxArr[i - 1] + shiftX, myArr[i - 1] + shiftY,
        mxArr[i] + shiftX, myArr[i] + shiftY,
        -worldRadius, worldRadius, -worldRadius, worldRadius
      );
      if (!seg) {
        if (run.length > 1) runs.push(run);
        run = [];
        continue;
      }
      const last = run[run.length - 1];
      if (last && Math.hypot(seg.x1 - last.x, seg.y1 - last.y) > 0.5) {
        if (run.length > 1) runs.push(run);
        run = [];
      }
      if (run.length === 0) run.push({ x: seg.x1, y: seg.y1 });
      run.push({ x: seg.x2, y: seg.y2 });
    }
    if (run.length > 1) runs.push(run);

    for (let rIdx = 0; rIdx < runs.length; rIdx++) {
      const pts = runs[rIdx];
      if (pts.length < 2) continue;

      let len = 0;
      let minDistOrigin = Infinity;
      for (let k = 0; k < pts.length; k++) {
        if (k > 0) len += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y);
        const d0 = Math.hypot(pts[k].x, pts[k].y);
        if (d0 < minDistOrigin) minDistOrigin = d0;
      }
      if (len < minRoadLenMeters && !way.isRay) continue;

      // distance from this road to the route (segment-to-segment, so crossings count as 0)
      let minRouteSq = Infinity;
      for (let k = 1; k < pts.length && minRouteSq > 0; k++) {
        const capM = corridorM * 4;
        const sMinX = Math.min(pts[k - 1].x, pts[k].x) - capM, sMaxX = Math.max(pts[k - 1].x, pts[k].x) + capM;
        const sMinY = Math.min(pts[k - 1].y, pts[k].y) - capM, sMaxY = Math.max(pts[k - 1].y, pts[k].y) + capM;
        for (let r = 0; r < rSegs.length; r++) {
          const rs = rSegs[r];
          if (rs.x1 < sMinX || rs.x0 > sMaxX || rs.y1 < sMinY || rs.y0 > sMaxY) continue;
          const d = segSegDistSq(pts[k - 1].x, pts[k - 1].y, pts[k].x, pts[k].y, rs.ax, rs.ay, rs.bx, rs.by);
          if (d < minRouteSq) {
            minRouteSq = d;
            if (d === 0) break;
          }
        }
      }
      const minRouteDist = Math.sqrt(minRouteSq);
      const touchesRoute = minRouteDist < corridorM * 2.2;

      // everything is relative to the zoom range so the choice is sensible at every zoom
      const priority =
        (touchesRoute ? -150 : 0) +
        way.lv * 110 +
        (Math.min(minRouteDist, fwdRangeMeters * 2) / fwdRangeMeters) * 150 +
        (minDistOrigin / fwdRangeMeters) * 300 -
        (Math.min(len, fwdRangeMeters * 1.2) / fwdRangeMeters) * 120;

      cands.push({ pts, priority });
    }
  }

  cands.sort((a, b) => a.priority - b.priority);

  // ---- clean up: hide what lies under the route, merge parallel duplicates, keep roads contiguous
  const gridCell = Math.max(twinM * 2, stepM * 1.5, 20);
  const grid = new Map(); // cell -> pieces of already accepted roads (for the duplicate test)
  const gKey = (ix, iy) => (ix + 8192) * 16384 + (iy + 8192);
  const locked = [];
  const MAX_POLYLINES = 190;

  for (let cIdx = 0; cIdx < cands.length; cIdx++) {
    if (locked.length >= MAX_POLYLINES) break;
    const pts = cands[cIdx].pts;

    const chains = [];
    let chain = [];
    let chainPieces = [];
    const flush = () => {
      if (chain.length >= 2) chains.push({ pts: chain, pieces: chainPieces });
      chain = [];
      chainPieces = [];
    };

    for (let k = 1; k < pts.length; k++) {
      const ax = pts[k - 1].x, ay = pts[k - 1].y;
      const bx = pts[k].x, by = pts[k].y;
      const dx = bx - ax, dy = by - ay;
      const segLen = Math.hypot(dx, dy);
      if (segLen < 1e-3) continue;
      const nPieces = Math.max(1, Math.ceil(segLen / stepM));

      for (let q = 0; q < nPieces; q++) {
        const t0 = q / nPieces;
        const t1 = (q + 1) / nPieces;
        const px0 = ax + dx * t0, py0 = ay + dy * t0;
        const px1 = ax + dx * t1, py1 = ay + dy * t1;
        const pux = dx / segLen, puy = dy / segLen;
        const pmx = (px0 + px1) * 0.5, pmy = (py0 + py1) * 0.5;
        const half = (segLen / nPieces) * 0.5;

        let drop = false;

        // 1) lies under / along the main route -> it would only show up as a grey fringe beside the blue line
        for (let r = 0; r < rSegs.length; r++) {
          const rs = rSegs[r];
          if (pmx < rs.x0 - corridorM || pmx > rs.x1 + corridorM || pmy < rs.y0 - corridorM || pmy > rs.y1 + corridorM) continue;
          if (ptSegDistSq(pmx, pmy, rs.ax, rs.ay, rs.bx, rs.by) < corridorSq &&
              Math.abs(pux * rs.ux + puy * rs.uy) > 0.80) {
            drop = true;
            break;
          }
        }

        // 2) parallel duplicate of a road that is already accepted (dual carriageways, double-mapped ways)
        if (!drop) {
          const gx = Math.floor(pmx / gridCell), gy = Math.floor(pmy / gridCell);
          for (let ox = -1; ox <= 1 && !drop; ox++) {
            for (let oy = -1; oy <= 1 && !drop; oy++) {
              const bucket = grid.get(gKey(gx + ox, gy + oy));
              if (!bucket) continue;
              for (let i = 0; i < bucket.length; i++) {
                const a = bucket[i];
                const reach = a.half + twinM;
                if (Math.abs(pmx - a.cx) > reach || Math.abs(pmy - a.cy) > reach) continue;
                if (Math.abs(pux * a.ux + puy * a.uy) < 0.90) continue;
                const t = ((pmx - a.cx) * a.ux + (pmy - a.cy) * a.uy);
                if (Math.abs(t) >= a.half) continue;                 // beside it, not overlapping it
                const lateral = Math.abs(-(pmx - a.cx) * a.uy + (pmy - a.cy) * a.ux);
                if (lateral < twinM) { drop = true; break; }
              }
            }
          }
        }

        if (drop) {
          flush();
          continue;
        }
        if (chain.length === 0) chain.push({ x: px0, y: py0 });
        chain.push({ x: px1, y: py1 });
        chainPieces.push({ cx: pmx, cy: pmy, ux: pux, uy: puy, half });
      }
    }
    flush();

    for (let c = 0; c < chains.length; c++) {
      const cp = chains[c].pts;
      let chainLen = 0;
      for (let i = 1; i < cp.length; i++) chainLen += Math.hypot(cp[i].x - cp[i - 1].x, cp[i].y - cp[i - 1].y);
      if (chainLen < Math.max(4.0, 8.0 / pxPerM)) continue;       // tiny left-overs look like specks
      locked.push(simplifyWayMeters(cp, 0.35));                    // merge collinear pieces again
      for (let i = 0; i < chains[c].pieces.length; i++) {
        const pc = chains[c].pieces[i];
        const key = gKey(Math.floor(pc.cx / gridCell), Math.floor(pc.cy / gridCell));
        const bucket = grid.get(key);
        if (bucket) bucket.push(pc); else grid.set(key, [pc]);
      }
    }
  }

  // too many pieces for one packet? simplify the roads a little more (keeps the whole screen covered)
  let segTotal = 0;
  for (let i = 0; i < locked.length; i++) segTotal += locked[i].length - 1;
  let out = locked;
  const BUDGET_EST = 285;
  for (let scale = 1.8; segTotal > BUDGET_EST && scale <= 6; scale *= 1.7) {
    out = locked.map((p) => simplifyWayMeters(p, epsM * scale));
    segTotal = 0;
    for (let i = 0; i < out.length; i++) segTotal += out[i].length - 1;
  }
  navCore.lockedWorldPolylines = out;
  navCore.diagnostics.mapRoads = out.length;
};

const streamCachedVectorsToBLE = (forceSend = false) => {
  if (!navCore.activeDevice || navCore.navState !== "NAVIGATING") return;
  const now = Date.now();
  // A slow BLE connection cannot display 13 freshly encoded full frames per second.
  // Coalesce heading/GPS changes while keeping junction instructions responsive.
  const minFrameMs = navCore.junctionMode ? 95 : (navCore.filteredSpeed > 70 ? 135 : 155);
  if (!forceSend && now - navCore.lastBleSendTime < minFrameMs) return;
  if (!forceSend && navCore.bleStreamInFlight && navCore.pendingStreamPayload) return;
  navCore.lastBleSendTime = now;

  const zoomScale = navCore.zoomLevel || 2.00;
  const fwdRangeMeters = getVisibleRangeMeters(zoomScale);
  const pixelScale = 255.0 / fwdRangeMeters;

  const currentHeading = navCore.heading;
  const radH = (currentHeading * Math.PI) / 180.0;
  const cosH = Math.cos(radH);
  const sinH = Math.sin(radH);

  const headingDelta = Math.abs(angleDiffDeg(currentHeading, navCore.routeForwardBearing));
  const isTurnedAround = headingDelta > 115;

  const fwdPool = navCore.rawForwardPool || [];
  const backPool = navCore.rawReversePool || [];
  if (fwdPool.length <= 1 && backPool.length <= 1) return;

  const highSpeed = navCore.filteredSpeed > 70;
  const junction = navCore.junctionMode;
  const maxBytes = Math.max(20, Math.min(MAX_BLE_PAYLOAD, navCore.blePayloadMax || 20, highSpeed ? 180 : MAX_BLE_PAYLOAD));
  const availVecBytes = Math.max(10, maxBytes - 9);
  const maxRoutePts = maxBytes <= 23
    ? Math.max(4, Math.floor(availVecBytes / 2))
    : (maxBytes >= 400 ? 48 : (maxBytes >= 240 ? 30 : 20));

  // ---- main route: ONLY the road ahead of the vehicle (no trail behind the arrow).
  // If the rider is facing away from the route, the route lies behind the arrow, so it is drawn there.
  const routeRangeMeters = isTurnedAround ? fwdRangeMeters * 0.40 : fwdRangeMeters * 1.40;
  const routeChain = slicePoolToRange(fwdPool, routeRangeMeters, highSpeed ? Math.min(18, maxRoutePts) : (junction ? Math.min(24, maxRoutePts) : maxRoutePts), 0);

  const encodedPoints = [];
  let lastEndX = null;
  let lastEndY = null;

  for (let i = 0; i < routeChain.length - 1 && encodedPoints.length < maxRoutePts; i++) {
    const w0 = routeChain[i];
    const w1 = routeChain[i + 1];
    const x0 = (w0.x * cosH - w0.y * sinH) * pixelScale;
    const y0 = (w0.x * sinH + w0.y * cosH) * pixelScale;
    const x1 = (w1.x * cosH - w1.y * sinH) * pixelScale;
    const y1 = (w1.x * sinH + w1.y * cosH) * pixelScale;

    const seg = clipLineSegmentToRect(x0, y0, x1, y1);
    if (!seg) {
      lastEndX = null;
      lastEndY = null;
      continue;
    }

    const isDiscontinuous =
      lastEndX === null ||
      lastEndY === null ||
      Math.hypot(seg.x1 - lastEndX, seg.y1 - lastEndY) > 2.2;

    if (isDiscontinuous) {
      if (encodedPoints.length > 0 && encodedPoints.length + 2 <= maxRoutePts) {
        encodedPoints.push({ bx: 0x80, by: 0x80 });
      }
      if (encodedPoints.length < maxRoutePts) {
        encodedPoints.push({ bx: encodeXByte(seg.x1), by: encodeYByte(seg.y1) });
      }
    }

    if (encodedPoints.length < maxRoutePts) {
      const bx2 = encodeXByte(seg.x2);
      const by2 = encodeYByte(seg.y2);
      const prev = encodedPoints[encodedPoints.length - 1];
      if (!prev || prev.bx !== bx2 || prev.by !== by2) {
        encodedPoints.push({ bx: bx2, by: by2 });
      }
    }

    lastEndX = seg.x2;
    lastEndY = seg.y2;
  }

  // ---- side roads: whole roads are added in priority order until the byte/zoom budget is used up
  const remBytesForStubs = Math.max(0, availVecBytes - encodedPoints.length * 2);
  const zoomStubCap = getStubBudgetForZoom(zoomScale);
  const maxStubsPossible = highSpeed ? 0 : Math.min(MAX_STUBS, zoomStubCap,
    junction ? 12 : (navCore.filteredSpeed < 30 ? 96 : 45), Math.floor(remBytesForStubs / 4));
  const encodedStubs = [];
  const polylines = navCore.lockedWorldPolylines || [];
  // Locked roads were generated around a previous GPS/route-snap origin.
  // Translate them into the CURRENT snapped frame before projection.
  const frame = navCore.lockedRoadFrame;
  const currentO = navCore.roadOrigin;
  let graphDx = 0, graphDy = 0;
  if (frame && currentO) {
    const meters = getWGS84Scale((frame.lat + currentO.lat) * 0.5);
    graphDx = (frame.lon - currentO.lon) * meters.lonConv + frame.ox - currentO.ox;
    graphDy = (frame.lat - currentO.lat) * meters.latConv + frame.oy - currentO.oy;
  }

  for (let pIdx = 0; pIdx < polylines.length; pIdx++) {
    if (encodedStubs.length >= maxStubsPossible) break;
    const poly = polylines[pIdx];
    const n = poly.length;
    if (n < 2) continue;

    // rotate + scale every vertex ONCE, so neighbouring segments (and roads sharing a node) share identical bytes
    const sx = new Array(n);
    const sy = new Array(n);
    const qx = new Array(n);
    const qy = new Array(n);
    for (let i = 0; i < n; i++) {
      sx[i] = ((poly[i].x + graphDx) * cosH - (poly[i].y + graphDy) * sinH) * pixelScale;
      sy[i] = ((poly[i].x + graphDx) * sinH + (poly[i].y + graphDy) * cosH) * pixelScale;
      qx[i] = encodeXByte(sx[i]);
      qy[i] = encodeYByte(sy[i]);
    }

    const local = [];
    for (let i = 1; i < n; i++) {
      const clipped = clipLineSegmentToRect(sx[i - 1], sy[i - 1], sx[i], sy[i]);
      if (!clipped) continue;
      const startIsVertex = clipped.x1 === sx[i - 1] && clipped.y1 === sy[i - 1];
      const endIsVertex = clipped.x2 === sx[i] && clipped.y2 === sy[i];
      const bx1 = startIsVertex ? qx[i - 1] : encodeXByte(clipped.x1);
      const by1 = startIsVertex ? qy[i - 1] : encodeYByte(clipped.y1);
      const bx2 = endIsVertex ? qx[i] : encodeXByte(clipped.x2);
      const by2 = endIsVertex ? qy[i] : encodeYByte(clipped.y2);
      if (bx1 === bx2 && by1 === by2) continue;
      local.push({ bx1, by1, bx2, by2 });
    }

    if (local.length === 0) continue;
    // The previous all-or-nothing check discarded entire long roads. Keep
    // a contiguous visible portion when the BLE budget is almost full.
    const remaining = maxStubsPossible - encodedStubs.length;
    if (remaining <= 0) break;
    if (local.length <= remaining) {
      for (let i = 0; i < local.length; i++) encodedStubs.push(local[i]);
    } else {
      // Pick the part closest to the rider, while preserving connected order.
      let bestStart = 0;
      let bestDist = Infinity;
      for (let i = 0; i < local.length; i++) {
        const s = local[i];
        const signed = (v) => v > 127 ? v - 256 : v;
        const mx = ((signed(s.bx1) + signed(s.bx2)) * 0.5) * 1.30;
        const my = ((signed(s.by1) + signed(s.by2)) * 0.5) * 1.40 + 88;
        const dist = mx * mx + (my - 0) * (my - 0);
        if (dist < bestDist) { bestDist = dist; bestStart = i; }
      }
      bestStart = Math.max(0, Math.min(local.length - remaining, bestStart - Math.floor(remaining / 2)));
      for (let i = bestStart; i < bestStart + remaining; i++) encodedStubs.push(local[i]);
    }
  }

  navCore.lastStubCount = encodedStubs.length;

  const numPoints = encodedPoints.length;
  const numStubs = encodedStubs.length;
  const totalLen = 8 + numPoints * 2 + numStubs * 4 + 1;

  const payload = new Uint8Array(totalLen);
  payload[0] = 0xA5;
  payload[1] = 0x5A;
  payload[2] = numPoints;
  payload[3] = numStubs;

  const safeDist = Math.max(0, Math.min(65535, Math.round(navCore.cachedDistToTurn)));
  payload[4] = (safeDist >> 8) & 0xFF;
  payload[5] = safeDist & 0xFF;

  let turnManeuver = navCore.cachedTurnManeuver;
  if (navCore.isRerouting) turnManeuver = 3;
  else if (isTurnedAround) turnManeuver = -4;
  payload[6] = turnManeuver < 0 ? 256 + turnManeuver : turnManeuver;
  payload[7] = Math.max(100, Math.min(200, Math.round(zoomScale * 100)));

  let idx = 8;
  for (let i = 0; i < numPoints; i++) {
    payload[idx++] = encodedPoints[i].bx;
    payload[idx++] = encodedPoints[i].by;
  }

  for (let i = 0; i < numStubs; i++) {
    payload[idx++] = encodedStubs[i].bx1;
    payload[idx++] = encodedStubs[i].by1;
    payload[idx++] = encodedStubs[i].bx2;
    payload[idx++] = encodedStubs[i].by2;
  }

  let xorSum = 0;
  for (let i = 0; i < totalLen - 1; i++) {
    xorSum ^= payload[i];
  }
  payload[totalLen - 1] = xorSum;

  queueBLEPacket(payload, true);
  // Optional destination pin packet. Older firmware ignores unknown 0xA7 commands.
  // Coordinates use the SAME projected screen frame as the normal vector packet.
  if (now - (navCore.lastDestPinBleTime || 0) >= 600 && navCore.destCoords && navCore.roadOrigin) {
    navCore.lastDestPinBleTime = now;
    const O = navCore.roadOrigin;
    const dlon = (navCore.destCoords.longitude - O.lon) * O.lonConv - O.ox;
    const dlat = (navCore.destCoords.latitude - O.lat) * O.latConv - O.oy;
    const dx = (dlon * cosH - dlat * sinH) * pixelScale;
    const dy = (dlon * sinH + dlat * cosH) * pixelScale;
    const visible = Number.isFinite(dx) && Number.isFinite(dy) &&
      dx >= VIEW_MIN_X && dx <= VIEW_MAX_X && dy >= VIEW_MIN_Y && dy <= VIEW_MAX_Y;
    const pin = new Uint8Array([0xA7, 0x01, visible ? encodeXByte(dx) : 0,
      visible ? encodeYByte(dy) : 0, visible ? 1 : 0, 0]);
    for (let i = 0; i < 5; i++) pin[5] ^= pin[i];
    queueBLEPacket(pin, false);
  }
  // Separate extension: legacy vector packet stays byte-for-byte compatible.
  // Tiny telemetry is sent at ~1Hz, not on every fast gyro update.
  if (now - navCore.lastTelemetryBleTime >= 1000) {
    navCore.lastTelemetryBleTime = now;
    const flags = NAV_FLAG_ACTIVE | (navCore.isRerouting ? NAV_FLAG_REROUTING : 0) |
      (navCore.offRouteCount >= 2 ? NAV_FLAG_OFF_ROUTE : 0) |
      (navCore.isNetworkDegraded ? NAV_FLAG_NETWORK_DEGRADED : 0) |
      (junction ? NAV_FLAG_JUNCTION : 0) | (highSpeed ? NAV_FLAG_HIGH_SPEED : 0) |
      (navCore.etaMinutes === null ? NAV_FLAG_ETA_UNKNOWN : 0);
    const remaining = clampInt(navCore.remainingRouteMeters, 0, 0xFFFFFF);
    const eta = navCore.etaMinutes === null ? 0xFFFF : clampInt(navCore.etaMinutes, 0, 0xFFFE);
    const ext = new Uint8Array([TELEMETRY_PACKET_ID, 0x01,
      (remaining >>> 16) & 255, (remaining >>> 8) & 255, remaining & 255,
      (eta >>> 8) & 255, eta & 255, flags, 0]);
    for (let i = 0; i < ext.length - 1; i++) ext[ext.length - 1] ^= ext[i];
    queueBLEPacket(ext, false);
  }
};

const triggerBackgroundReroute = async (curLat, curLon, forceImmediate = false, trueGpsCourse = null) => {
  const curDest = navCore.destCoords;
  if (!curDest || navCore.navState !== "NAVIGATING") return;
  if (!Number.isFinite(curLat) || !Number.isFinite(curLon)) return;
  if (navCore.isRerouting && !forceImmediate) return;

  const now = Date.now();
  if (!forceImmediate && now - navCore.lastRerouteTime < (navCore.isNetworkDegraded ? 30000 : 8000)) return;

  if (navCore.rerouteAbort) navCore.rerouteAbort.abort();
  const reqId = ++navCore.rerouteSeq;
  navCore.isRerouting = true;
  navCore.lastRerouteTime = now;
  streamCachedVectorsToBLE(true);

  const controller = new AbortController();
  navCore.rerouteAbort = controller;
  const timeoutId = setTimeout(() => controller.abort(), 5500);

  const headingParam = Number.isFinite(trueGpsCourse) && trueGpsCourse >= 0
    ? `&bearings=${Math.round(wrap360(trueGpsCourse))},60;`
    : '';

  try {
    const startLat = navCore.lastPosition ? navCore.lastPosition.latitude : curLat;
    const startLon = navCore.lastPosition ? navCore.lastPosition.longitude : curLon;

    const routes = await fetchRoutes(startLon, startLat, curDest, controller.signal, headingParam, false);
    if (reqId !== navCore.rerouteSeq || navCore.navState !== "NAVIGATING") return;

    if (routes.length > 0) {
      navCore.isNetworkDegraded = false;
      cacheSuccessfulRoute(routes, curDest, startLat, startLon);
      applyRouteResponse(routes);
      navCore.altRoutes = [];
      navCore.altMeta = [];
      navCore.rerouteAnchor = { latitude: startLat, longitude: startLon };
      emitRouteToUI();
    } else {
      // Preserve the active route rather than blocking the rider during outages.
      navCore.isNetworkDegraded = true;
    }
  } catch (e) {
    navCore.isNetworkDegraded = true;
  } finally {
    clearTimeout(timeoutId);
    if (reqId === navCore.rerouteSeq) {
      navCore.isRerouting = false;
      navCore.rerouteAbort = null;
      if (navCore.navState === "NAVIGATING" && navCore.lastPosition) {
        processGPSPosition({ coords: navCore.lastPosition }, true, true);
      }
    }
  }
};

const findBestRouteSegment = (coords, lat, lon, latConv, lonConv, hintIdx = -1) => {
  const totalSegs = coords.length - 1;
  if (totalSegs <= 0) return { bestIdx: 0, minDist: 0, segBearing: 0, remSegMeters: 0, projX: 0, projY: 0 };

  const evaluateRange = (startIdx, endIdx) => {
    let bestIdx = startIdx;
    let minDist = Infinity;
    let bestBearing = 0;
    let bestRemMeters = 0;
    let bestProjX = 0;
    let bestProjY = 0;

    for (let i = startIdx; i < endIdx; i++) {
      const ax = (coords[i][0] - lon) * lonConv;
      const ay = (coords[i][1] - lat) * latConv;
      const bx = (coords[i + 1][0] - lon) * lonConv;
      const by = (coords[i + 1][1] - lat) * latConv;

      const segDx = bx - ax;
      const segDy = by - ay;
      const segLenSq = segDx * segDx + segDy * segDy;

      let t = 0;
      if (segLenSq > 0.001) {
        t = Math.max(0, Math.min(1, -(ax * segDx + ay * segDy) / segLenSq));
      }

      const px = ax + t * segDx;
      const py = ay + t * segDy;
      const d = Math.hypot(px, py);
      if (d < minDist) {
        minDist = d;
        bestIdx = i;
        bestBearing = wrap360((Math.atan2(segDx, segDy) * 180) / Math.PI);
        bestRemMeters = (1.0 - t) * Math.sqrt(segLenSq);
        bestProjX = px;
        bestProjY = py;
      }
    }
    return {
      bestIdx,
      minDist,
      segBearing: bestBearing,
      remSegMeters: bestRemMeters,
      projX: bestProjX,
      projY: bestProjY,
    };
  };

  if (hintIdx >= 0) {
    const winStart = Math.max(0, hintIdx - 6);
    const winEnd = Math.min(totalSegs, hintIdx + 40);
    const localRes = evaluateRange(winStart, winEnd);
    if (localRes.minDist <= 22) return localRes;
  }

  return evaluateRange(0, totalSegs);
};

const processGPSPosition = (loc, forceSend = false, synthetic = false) => {
  if (!loc || !loc.coords || !Number.isFinite(loc.coords.latitude) || !Number.isFinite(loc.coords.longitude)) return;

  // Reject out-of-order and implausible fixes before updating position, reroute or BLE.
  if (!synthetic) {
    const fixTime = Number.isFinite(loc.timestamp) ? loc.timestamp : Date.now();
    if (fixTime <= navCore.lastFixTs) return;
    const accuracy = loc.coords.accuracy;
    if (!Number.isFinite(accuracy) || accuracy <= 0 || accuracy > 65) {
      navCore.diagnostics.gpsQuality = 'poor';
      return;
    }
    if (navCore.lastAcceptedGps && navCore.lastPosition) {
      const dt = (fixTime - navCore.lastAcceptedGps) / 1000;
      if (dt > 0 && dt < 12) {
        const movement = exactMetersBetween(navCore.lastPosition.latitude, navCore.lastPosition.longitude,
          loc.coords.latitude, loc.coords.longitude);
        // 52 m/s allows brisk highway travel; inaccurate isolated teleport fixes are discarded.
        if (movement > Math.max(accuracy * 2.5 + 12, 52 * dt + accuracy)) {
          navCore.diagnostics.gpsQuality = 'jump rejected';
          return;
        }
      }
    }
    navCore.lastFixTs = fixTime;
    navCore.lastAcceptedGps = fixTime;
    navCore.diagnostics.gpsQuality = accuracy <= 20 ? 'good' : 'limited';
  }

  const coords = navCore.routeCoords || [];
  const curDest = navCore.destCoords;
  const now = Date.now();
  const gpsAcc = Number.isFinite(loc.coords.accuracy) && loc.coords.accuracy > 0 ? loc.coords.accuracy : 100;

  if (!synthetic) {
    const dtSpeed = navCore.lastSpeedTimestamp > 0 ? (now - navCore.lastSpeedTimestamp) / 1000.0 : 0;
    let stepMetersFromLast = 0;
    let geoSpeedMps = -1;

    if (navCore.lastPosition && dtSpeed >= 0.2 && dtSpeed < 6.0) {
      stepMetersFromLast = exactMetersBetween(
        navCore.lastPosition.latitude,
        navCore.lastPosition.longitude,
        loc.coords.latitude,
        loc.coords.longitude
      );
      geoSpeedMps = stepMetersFromLast / dtSpeed;
    }

    const hasDoppler = Number.isFinite(loc.coords.speed) && loc.coords.speed >= 0 && gpsAcc <= 30;
    let fusedSpeedMps = 0;

    if (hasDoppler) {
      const dopplerMps = loc.coords.speed;
      if (geoSpeedMps >= 0 && gpsAcc <= 15) {
        const clampedGeo = Math.min(geoSpeedMps, dopplerMps * 1.6 + 2.0);
        fusedSpeedMps = 0.78 * dopplerMps + 0.22 * clampedGeo;
      } else {
        fusedSpeedMps = dopplerMps;
      }
    } else if (geoSpeedMps >= 0 && gpsAcc <= 28) {
      const minValidMove = Math.max(0.8, gpsAcc * 0.22);
      fusedSpeedMps = stepMetersFromLast >= minValidMove ? geoSpeedMps : 0;
    }

    if (dtSpeed > 0 && dtSpeed < 3.0) {
      const prevMps = navCore.filteredSpeed / 3.6;
      const maxAllowedMps = prevMps + 9.5 * dtSpeed;
      if (fusedSpeedMps > maxAllowedMps && gpsAcc > 8) {
        fusedSpeedMps = maxAllowedMps;
      }
    }

    navCore.lastSpeedTimestamp = now;
    let currentRawKmh = Math.min(135, fusedSpeedMps * 3.6);

    if (currentRawKmh < 1.8 || (navCore.filteredSpeed === 0 && currentRawKmh < 2.6)) {
      currentRawKmh = 0;
    }

    if (currentRawKmh === 0) {
      navCore.filteredSpeed = navCore.filteredSpeed < 3.2 ? 0 : navCore.filteredSpeed * 0.42;
    } else {
      const speedDelta = Math.abs(currentRawKmh - navCore.filteredSpeed);
      const alpha = speedDelta > 5.0 ? 0.84 : (speedDelta > 2.0 ? 0.65 : 0.45);
      navCore.filteredSpeed = alpha * currentRawKmh + (1.0 - alpha) * navCore.filteredSpeed;
    }

    const speedNow = Math.round(navCore.filteredSpeed);
    if (navCore.navState === "NAVIGATING" && speedNow > navCore.topSpeed && gpsAcc <= 20) {
      navCore.topSpeed = speedNow;
    }

    if (navCore.navState === "NAVIGATING") {
      if (!navCore.odomAnchor) {
        navCore.odomAnchor = {
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
          timestamp: now,
        };
      } else if (gpsAcc <= 35) {
        const dMeters = exactMetersBetween(
          navCore.odomAnchor.latitude,
          navCore.odomAnchor.longitude,
          loc.coords.latitude,
          loc.coords.longitude
        );
        const dtOdom = Math.max(0.2, (now - navCore.odomAnchor.timestamp) / 1000.0);
        const maxPlausibleMeters = Math.max(18.0, dtOdom * 38.0);

        const minMoveGate = navCore.filteredSpeed >= 3.5
          ? 0.5
          : Math.max(2.5, gpsAcc * 0.42);

        if (dMeters >= minMoveGate && dMeters <= maxPlausibleMeters) {
          navCore.totalMeters += dMeters;
          navCore.odomAnchor = {
            latitude: loc.coords.latitude,
            longitude: loc.coords.longitude,
            timestamp: now,
          };
        } else if (dMeters > maxPlausibleMeters) {
          navCore.odomAnchor = {
            latitude: loc.coords.latitude,
            longitude: loc.coords.longitude,
            timestamp: now,
          };
        }
      }
    }

    navCore.diagnostics.gpsAccuracy = gpsAcc;
    navCore.diagnostics.gpsIntervalMs = navCore.diagnostics.lastGpsMs ? now - navCore.diagnostics.lastGpsMs : 0;
    navCore.diagnostics.lastGpsMs = now;
    // POCKET MODE: use GPS travel course, never pocket orientation.
    // Apply only ONE adaptive smoothing stage for fast turn response.
    let freshGpsCourse = null;
    const reliableCourse = gpsAcc <= 22 && navCore.filteredSpeed >= 8;
    if (reliableCourse && Number.isFinite(loc.coords.heading) && loc.coords.heading >= 0) {
      freshGpsCourse = wrap360(loc.coords.heading);
    } else if (reliableCourse && navCore.lastPosition && gpsAcc <= 18) {
      const moveM = exactMetersBetween(
        navCore.lastPosition.latitude, navCore.lastPosition.longitude,
        loc.coords.latitude, loc.coords.longitude
      );
      // Only derive bearing when the separation exceeds expected GPS jitter.
      if (moveM >= Math.max(5, gpsAcc * 1.5)) {
        const { latConv, lonConv } = getWGS84Scale(loc.coords.latitude);
        const dx = (loc.coords.longitude - navCore.lastPosition.longitude) * lonConv;
        const dy = (loc.coords.latitude - navCore.lastPosition.latitude) * latConv;
        freshGpsCourse = wrap360(Math.atan2(dx, dy) * 180 / Math.PI);
      }
    }
    if (freshGpsCourse !== null) {
      const delta = angleDiffDeg(freshGpsCourse, navCore.heading);
      // Respond quickly to real turns, but suppress small course jitter.
      const gain = Math.abs(delta) >= 25 ? 1.0 :
        Math.abs(delta) >= 9 ? 0.92 : 0.70;
      navCore.heading = navCore.headingInitialized
        ? wrap360(navCore.heading + delta * gain)
        : freshGpsCourse;
      navCore.gpsCourseBearing = freshGpsCourse;
      navCore.diagnostics.headingSource = "GPS course";
      navCore.headingInitialized = true;
      navCore.lastReliableCourseMs = now;
    } else if (navCore.filteredSpeed < 3) {
      // Hold last map rotation at a standstill. Never use the pocket compass.
      navCore.gpsCourseBearing = null;
      navCore.diagnostics.headingSource = "held (stopped)";
    }

    navCore.lastPosition = loc.coords;
  }

  const finalSpeedKmh = Math.round(navCore.filteredSpeed);

  if (navCore.navState === "NAVIGATING" && curDest && !synthetic && gpsAcc <= 40) {
    const distToDest = exactMetersBetween(
      loc.coords.latitude,
      loc.coords.longitude,
      curDest.latitude,
      curDest.longitude
    );
    // Require consecutive accurate GPS fixes, never a single noisy position.
    if (distToDest < 22 && gpsAcc <= 22 && finalSpeedKmh <= 15) navCore.arrivalFixCount++;
    else navCore.arrivalFixCount = 0;
    if (navCore.arrivalFixCount >= 3) {
      if (!navCore.stopInProgress && navCore.onAutoArrive) navCore.onAutoArrive();
      return;
    }
  }

  let distToTurn = 0;
  let turnManeuver = 0;

  if (coords.length > 0 && navCore.navState === "NAVIGATING") {
    const { latConv: latConversion, lonConv: lonConversion } = getWGS84Scale(loc.coords.latitude);

    const primaryEval = findBestRouteSegment(
      coords,
      loc.coords.latitude,
      loc.coords.longitude,
      latConversion,
      lonConversion,
      navCore.lastBestSegmentIdx
    );
    navCore.lastBestSegmentIdx = primaryEval.bestIdx;
    navCore.diagnostics.offRouteMeters = Math.round(primaryEval.minDist);
    // Avoid snapping across distant parallel roads; use GPS course as a confidence check.
    const matchingBearingError = Number.isFinite(navCore.gpsCourseBearing)
      ? Math.abs(angleDiffDeg(navCore.gpsCourseBearing, primaryEval.segBearing)) : 0;
    const confidentMapMatch = primaryEval.minDist <= Math.max(12, gpsAcc * 1.25) &&
      (finalSpeedKmh < 9 || matchingBearingError < 75);
    navCore.diagnostics.mapMatch = confidentMapMatch ? 'locked' : 'uncertain';

    let bestSegmentIdx = primaryEval.bestIdx;
    let minCrossTrackDist = primaryEval.minDist;
    let segBearing = primaryEval.segBearing;
    let remSegMeters = primaryEval.remSegMeters;
    let projX = primaryEval.projX;
    let projY = primaryEval.projY;

    navCore.routeForwardBearing = segBearing;
    // Predict road heading only at low speeds and when matched close to the planned route.
    // Blend toward the road tangent, never pre-rotate through an uncompleted junction.
    if (!synthetic && navCore.filteredSpeed >= 3 && navCore.filteredSpeed < 11 &&
        primaryEval.minDist < Math.min(10, gpsAcc + 3) &&
        Math.abs(angleDiffDeg(segBearing, navCore.heading)) < 32) {
      navCore.heading = wrap360(navCore.heading + angleDiffDeg(segBearing, navCore.heading) * 0.18);
      navCore.diagnostics.headingSource = 'GPS + road tangent';
    }
    const activeCoords = navCore.routeCoords;

    const travelBearing = Number.isFinite(navCore.gpsCourseBearing)
      ? navCore.gpsCourseBearing
      : navCore.heading;
    const courseError = Math.abs(angleDiffDeg(travelBearing, segBearing));

    const offRouteThreshold = Math.max(18, Math.min(32, gpsAcc * 1.3));
    const turnedOntoOtherRoad = minCrossTrackDist > Math.max(14, gpsAcc * 1.2) && courseError > 65 && finalSpeedKmh >= 12;

    if (!synthetic) {
      if (minCrossTrackDist > offRouteThreshold || turnedOntoOtherRoad) {
        navCore.offRouteCount += 1;
        if (navCore.offRouteCount >= 3) {
          triggerBackgroundReroute(
            loc.coords.latitude,
            loc.coords.longitude,
            false,
            navCore.gpsCourseBearing
          );
        }
      } else {
        navCore.offRouteCount = 0;
      }

      if (courseError > 120 && finalSpeedKmh >= 5) {
        navCore.wrongWayCount += 1;
        if (navCore.wrongWayCount >= 4 && minCrossTrackDist > 12) {
          triggerBackgroundReroute(
            loc.coords.latitude,
            loc.coords.longitude,
            false,
            navCore.gpsCourseBearing
          );
        }
      } else {
        navCore.wrongWayCount = 0;
      }
    }

    const originX = projX;
    const originY = projY;
    const maneuverMap = navCore.maneuverIdxMap;

    const rawForward = [{ x: 0, y: 0 }];
    const startIndex = bestSegmentIdx + 1;
    let cumulativeFwdMeters = 0;
    for (let i = startIndex; i < activeCoords.length; i++) {
      const dX = (activeCoords[i][0] - loc.coords.longitude) * lonConversion - originX;
      const dY = (activeCoords[i][1] - loc.coords.latitude) * latConversion - originY;
      let target = rawForward[rawForward.length - 1];
      const segM = Math.hypot(dX - target.x, dY - target.y);
      if (segM > 0.5) {
        cumulativeFwdMeters += segM;
        target = { x: dX, y: dY, lon: activeCoords[i][0], lat: activeCoords[i][1] };
        rawForward.push(target);
      }
      const mc = maneuverMap.get(i);
      if (mc !== undefined) target.man = mc;
      if (cumulativeFwdMeters > 25000) break;
    }

    const rawReverse = [{ x: 0, y: 0 }];
    let cumulativeRevMeters = 0;
    for (let i = bestSegmentIdx; i >= 0; i--) {
      const dX = (activeCoords[i][0] - loc.coords.longitude) * lonConversion - originX;
      const dY = (activeCoords[i][1] - loc.coords.latitude) * latConversion - originY;
      const prev = rawReverse[rawReverse.length - 1];
      const segM = Math.hypot(dX - prev.x, dY - prev.y);
      if (segM > 0.8) {
        cumulativeRevMeters += segM;
        rawReverse.push({ x: dX, y: dY });
      }
      if (cumulativeRevMeters > 10000) break;
    }

    if (rawReverse.length === 1 && rawForward.length >= 2) {
      const fdx = rawForward[1].x;
      const fdy = rawForward[1].y;
      const fLen = Math.hypot(fdx, fdy);
      if (fLen > 0.1) {
        rawReverse.push({
          x: -(fdx / fLen) * 400.0,
          y: -(fdy / fLen) * 400.0,
        });
      }
    }

    let pathDistance = 0;
    let foundTurn = false;

    // Use OSRM's semantic maneuver instructions FIRST. A curved road is not
    // necessarily a turn; inferring turns solely from geometry produces false prompts.
    // rawForward[0] is the snapped vehicle position, so measure along that chain.
    for (let i = 1; i < rawForward.length; i++) {
      pathDistance += Math.hypot(rawForward[i].x - rawForward[i - 1].x,
                                 rawForward[i].y - rawForward[i - 1].y);
      if (rawForward[i].man !== undefined) {
        turnManeuver = rawForward[i].man;
        distToTurn = Math.round(pathDistance);
        foundTurn = true;
        break;
      }
    }

    // Geometry fallback only when routing service supplied no forward maneuver.
    pathDistance = 0;
    for (let i = 1; !foundTurn && i < rawForward.length - 1; i++) {
      const segDist = (i === 1)
        ? remSegMeters
        : Math.hypot(
            rawForward[i].x - rawForward[i - 1].x,
            rawForward[i].y - rawForward[i - 1].y
          );
      pathDistance += segDist;

      if (rawForward[i].man !== undefined) {
        turnManeuver = rawForward[i].man;
        distToTurn = Math.round(pathDistance);
        foundTurn = true;
        break;
      }

      const pPrev = rawForward[i - 1];
      const pCurr = rawForward[i];
      const pNext = rawForward[Math.min(i + 1, rawForward.length - 1)];

      const ang1 = (Math.atan2(pCurr.x - pPrev.x, pCurr.y - pPrev.y) * 180) / Math.PI;
      const ang2 = (Math.atan2(pNext.x - pCurr.x, pNext.y - pCurr.y) * 180) / Math.PI;
      let windowAngleSum = angleDiffDeg(ang2, ang1);

      let lookDist = 0;
      let prevAng = ang2;
      for (let k = i + 1; k < rawForward.length - 1 && lookDist < 28; k++) {
        const pk0 = rawForward[k];
        const pk1 = rawForward[k + 1];
        lookDist += Math.hypot(pk1.x - pk0.x, pk1.y - pk0.y);
        const nextAng = (Math.atan2(pk1.x - pk0.x, pk1.y - pk0.y) * 180) / Math.PI;
        const stepDiff = angleDiffDeg(nextAng, prevAng);
        if (stepDiff * windowAngleSum >= -5) {
          windowAngleSum += stepDiff;
        }
        prevAng = nextAng;
      }

      if (Math.abs(windowAngleSum) >= 145) {
        turnManeuver = -3;
        distToTurn = Math.round(pathDistance);
        foundTurn = true;
        break;
      } else if (Math.abs(windowAngleSum) > 26) {
        if (windowAngleSum < -68) turnManeuver = -2;
        else if (windowAngleSum < -26) turnManeuver = -1;
        else if (windowAngleSum > 68) turnManeuver = 2;
        else if (windowAngleSum > 26) turnManeuver = 1;
        distToTurn = Math.round(pathDistance);
        foundTurn = true;
        break;
      }
    }

    if (!foundTurn) {
      turnManeuver = 0;
      distToTurn = Math.round(pathDistance);
    }

    // Distance follows the snapped route, not the straight line to destination.
    let remainingMeters = Math.max(0, remSegMeters);
    for (let i = bestSegmentIdx + 1; i < activeCoords.length - 1; i++) {
      remainingMeters += exactMetersBetween(activeCoords[i][1], activeCoords[i][0], activeCoords[i + 1][1], activeCoords[i + 1][0]);
    }
    navCore.remainingRouteMeters = Math.round(remainingMeters);
    // At a stop ETA is unknown rather than artificially dividing by near-zero speed.
    const movingKmh = navCore.filteredSpeed;
    navCore.etaMinutes = movingKmh >= 5 ? Math.ceil(remainingMeters / (movingKmh / 3.6) / 60) : null;
    navCore.etaAtMs = navCore.etaMinutes === null ? 0 : Date.now() + navCore.etaMinutes * 60000;
    navCore.junctionMode = turnManeuver !== 0 && distToTurn < 100;
    // Temporary automatic zoom. The saved user zoom is never modified.
    const wantAutoZoom = navCore.junctionMode && finalSpeedKmh < 75 &&
      Date.now() >= navCore.manualZoomOverrideUntil;
    if (wantAutoZoom !== navCore.autoJunctionZoom) {
      navCore.autoJunctionZoom = wantAutoZoom;
      navCore.zoomLevel = wantAutoZoom ? 2.0 : navCore.userZoomLevel;
      navCore.lastOsmGraphBuild = 0;
    }
    if (!synthetic && gpsAcc <= 40 && finalSpeedKmh < 70) loadNearbyRoads(loc.coords.latitude, loc.coords.longitude);

    const osmCenter = navCore.osmRoadCenter;
    const roadCacheUsable = osmCenter &&
      exactMetersBetween(loc.coords.latitude, loc.coords.longitude, osmCenter.lat, osmCenter.lon) < OSM_CACHE_USABLE_METERS;

    const curRangeM = getVisibleRangeMeters(navCore.zoomLevel || 2.00);
    let roadPool;
    // ONE frame for everything: origin = the snapped point on the route (originX/originY).
    // Roads are stored relative to the OSM fetch centre (or to this GPS fix when no cache is usable),
    // so shiftX/shiftY = (that reference point) - (snapped point), expressed in metres.
    let shiftX = -originX;
    let shiftY = -originY;

    if (roadCacheUsable && navCore.osmRoadWays.length > 0) {
      // real OSM roads only; the fake straight "rays" are no longer mixed in when real data exists
      roadPool = navCore.osmRoadWays;
      shiftX = (osmCenter.lon - loc.coords.longitude) * lonConversion - originX;
      shiftY = (osmCenter.lat - loc.coords.latitude) * latConversion - originY;
    } else {
      roadPool = buildGuaranteedRouteJunctionWays(loc.coords.latitude, loc.coords.longitude, lonConversion, latConversion, curRangeM);
      if (navCore.osmStatus === 'idle') {
        setOsmStatus(`${roadPool.length} route roads active`);
      }
    }

    navCore.roadOrigin = {
      lon: loc.coords.longitude,
      lat: loc.coords.latitude,
      lonConv: lonConversion,
      latConv: latConversion,
      ox: originX,
      oy: originY,
      shiftX,
      shiftY,
    };
    navCore.rawForwardPool = rawForward;
    navCore.rawReversePool = rawReverse;
    navCore.rawRoadPool = roadPool;
    navCore.cachedDistToTurn = distToTurn;
    navCore.cachedTurnManeuver = turnManeuver;

    // Avoid rebuilding a potentially large geometry graph for every GPS tick.
    const movedForGraph = navCore.lastGraphLat === null ? Infinity : exactMetersBetween(
      loc.coords.latitude, loc.coords.longitude, navCore.lastGraphLat, navCore.lastGraphLon);
    // Graph generation is CPU-heavy on dense city roads. Keep it separate
    // from cheap route/heading refreshes and forced BLE retransmissions.
    const graphInterval = navCore.junctionMode ? 1800 : (finalSpeedKmh > 70 ? 4200 : 3000);
    const graphMoveThreshold = navCore.junctionMode ? 20 : (finalSpeedKmh > 70 ? 55 : 36);
    const graphAge = Date.now() - navCore.lastOsmGraphBuild;
    if (navCore.lastOsmGraphBuild === 0 ||
        (graphAge >= graphInterval && (movedForGraph > graphMoveThreshold || graphAge >= graphInterval * 2))) {
      buildLockedWorldRoadGraph();
      navCore.lockedRoadFrame = {
        lat: navCore.roadOrigin.lat, lon: navCore.roadOrigin.lon,
        ox: navCore.roadOrigin.ox, oy: navCore.roadOrigin.oy,
      };
      navCore.lastOsmGraphBuild = Date.now();
      navCore.lastGraphLat = loc.coords.latitude;
      navCore.lastGraphLon = loc.coords.longitude;
    }
    streamCachedVectorsToBLE(forceSend);
  }

  const uiNow = Date.now();
  if (navCore.onUIUpdate && (forceSend || uiNow - navCore.lastUIUpdateTime >= 600)) {
    navCore.lastUIUpdateTime = uiNow;
    navCore.onUIUpdate({
      type: "TELEMETRY",
      loc,
      finalSpeedKmh,
      distToTurn,
      remainingRouteMeters: navCore.remainingRouteMeters,
      etaMinutes: navCore.etaMinutes,
      junctionMode: navCore.junctionMode,
      totalMeters: Math.round(navCore.totalMeters),
      stubs: navCore.lastStubCount,
      payloadMax: navCore.blePayloadMax,
    });
  }
};

TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
  try {
    if (error || !data || !data.locations || data.locations.length === 0) return;
    if (navCore.navState !== 'NAVIGATING') return;
    data.locations.forEach((l) => {
      if (l?.coords?.latitude && l?.coords?.longitude) processGPSPosition(l);
    });
  } catch (e) {}
});

const buildLeafletHTML = (isDark, useWebImu) => `
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
      <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
      <style>
        body, html, #map { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; -webkit-tap-highlight-color: transparent; }
        .leaflet-control-attribution { font-size: 8px !important; opacity: 0.7; }
        body.dark-mode { background: #0a0a0a; }
        body.dark-mode .leaflet-tile {
          filter: brightness(0.6) invert(1) contrast(3) hue-rotate(200deg) saturate(0.3) brightness(0.7);
        }
        body.light-mode { background: #f6f7f9; }
        body.light-mode .leaflet-tile {
          filter: saturate(0.85) contrast(1.05);
        }
        .navpod-pin { width: 25px; height: 25px; background: #EA4335; border: 3px solid white;
          border-radius: 50% 50% 50% 0; transform: translate(2px, 2px) rotate(-45deg);
          box-shadow: 0 2px 7px rgba(0,0,0,.4); display: flex; align-items: center; justify-content: center; }
        .navpod-pin-hole { width: 8px; height: 8px; background: white; border-radius: 50%; }
        .tap-hint {
          position: absolute;
          top: 8px;
          left: 10px;
          background: rgba(12, 12, 12, 0.78);
          color: #00E5FF;
          padding: 4px 8px;
          border-radius: 6px;
          font-family: sans-serif;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.5px;
          pointer-events: none;
          z-index: 900;
          border: 1px solid rgba(0, 229, 255, 0.25);
        }
      </style>
    </head>
    <body class="${isDark ? 'dark-mode' : 'light-mode'}">
      <div class="tap-hint">TAP MAP TO PIN DESTINATION</div>
      <div id="map"></div>
      <script>
        window.USE_WEB_IMU = ${useWebImu ? 'true' : 'false'};

        var map = L.map('map', {
          zoomControl: false,
          preferCanvas: true,
          tap: true
        }).setView([17.3850, 78.4867], 17);

        map.attributionControl.setPrefix(false);
        map.attributionControl.setPosition('bottomleft');
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; OpenStreetMap'
        }).addTo(map);

        var userMarker = null;
        var destMarker = null;
        var routeLine = null;
        var altLines = [];
        var currentTargetZoom = 18;

        if (window.USE_WEB_IMU) {
          var lastImuPost = 0;
          window.addEventListener('devicemotion', function(e) {
            var now = Date.now();
            if (now - lastImuPost < 40) return;
            var g = e.accelerationIncludingGravity;
            var r = e.rotationRate;
            if (!g) return;
            lastImuPost = now;
            if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
              window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'IMU_3D',
                gx: g.x || 0,
                gy: g.y || 0,
                gz: g.z || 0,
                rx: r ? (r.beta || 0) : 0,
                ry: r ? (r.gamma || 0) : 0,
                rz: r ? (r.alpha || 0) : 0,
                t: now
              }));
            }
          }, true);
        }

        map.on('click', function(e) {
          var lat = e.latlng.lat;
          var lon = e.latlng.lng;
          setDestinationPin(lat, lon, false);
          if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'MAP_TAP',
              lat: lat,
              lon: lon
            }));
          }
        });

        function setUserLocation(lat, lon) {
          if (!userMarker) {
            userMarker = L.circleMarker([lat, lon], {
              radius: 7,
              color: '#FFFFFF',
              fillColor: '#00E5FF',
              fillOpacity: 1,
              weight: 2.5
            }).addTo(map);
            map.setView([lat, lon], currentTargetZoom);
          } else {
            userMarker.setLatLng([lat, lon]);
          }
        }

        function setMapZoom(z) {
          currentTargetZoom = z;
          if (userMarker) {
            map.setView(userMarker.getLatLng(), z, { animate: true });
          } else {
            map.setZoom(z, { animate: true });
          }
        }

        function recenterOnUser() {
          if (userMarker) {
            map.setView(userMarker.getLatLng(), currentTargetZoom, { animate: true });
          }
        }

        function setDestinationPin(lat, lon, shouldFit) {
          if (!destMarker) {
            destMarker = L.marker([lat, lon], {
              icon: L.divIcon({
                className: 'navpod-destination-icon',
                html: '<div class="navpod-pin"><div class="navpod-pin-hole"></div></div>',
                iconSize: [30, 42], iconAnchor: [15, 42]
              }),
              zIndexOffset: 1000
            }).addTo(map);
          } else {
            destMarker.setLatLng([lat, lon]);
          }

          if (shouldFit) {
            if (userMarker) {
              map.fitBounds(L.latLngBounds([userMarker.getLatLng(), [lat, lon]]), { padding: [40, 40] });
            } else {
              map.setView([lat, lon], currentTargetZoom);
            }
          }
        }

        function drawRoute(coords, altCoordsList, destLat, destLon) {
          if (routeLine) map.removeLayer(routeLine);
          altLines.forEach(function(l) { map.removeLayer(l); });
          altLines = [];

          setDestinationPin(destLat, destLon, false);

          if (Array.isArray(altCoordsList)) {
            altCoordsList.forEach(function(altCoords) {
              var al = L.polyline(altCoords, {
                color: '#9CA3AF',
                weight: 4,
                opacity: 0.9,
                lineCap: 'round',
                lineJoin: 'round'
              }).addTo(map);
              altLines.push(al);
            });
          }

          routeLine = L.polyline(coords, {
            color: '#00E5FF',
            weight: 5,
            opacity: 0.95,
            lineCap: 'round',
            lineJoin: 'round'
          }).addTo(map);
          if (userMarker) {
            map.setView(userMarker.getLatLng(), currentTargetZoom, { animate: true });
          } else {
            map.fitBounds(routeLine.getBounds(), { padding: [40, 40] });
          }
        }

        function clearRoute() {
          if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
          altLines.forEach(function(l) { map.removeLayer(l); });
          altLines = [];
        }
      </script>
    </body>
    </html>
  `;

export default function Page() {
  useKeepAwake();
  const systemScheme = useColorScheme();
  const [themeMode, setThemeMode] = useState(systemScheme || 'dark');
  const isDark = themeMode === 'dark';

  const [showSplash, setShowSplash] = useState(true);
  const introFade = useRef(new Animated.Value(1)).current;
  const logoScale = useRef(new Animated.Value(0.85)).current;
  const logoOpacity = useRef(new Animated.Value(0)).current;

  const [status, setStatus] = useState("Disconnected");
  const [turnDistance, setTurnDistance] = useState(0);
  const [navState, setNavState] = useState("IDLE");
  const [navFace, setNavFace] = useState(0);
  const [zoomLevel, setZoomLevel] = useState(2.00);
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [destCoords, setDestCoords] = useState(null);
  const [resolvedPlace, setResolvedPlace] = useState("");
  const [recentLocations, setRecentLocations] = useState([]);
  const [showRecents, setShowRecents] = useState(false);
  const [savedTrips, setSavedTrips] = useState([]);
  const [showTripsModal, setShowTripsModal] = useState(false);
  const [currentSpeedKmh, setCurrentSpeedKmh] = useState(0);
  const [remainingRouteMeters, setRemainingRouteMeters] = useState(0);
  const [etaMinutes, setEtaMinutes] = useState(null);
  const [junctionMode, setJunctionMode] = useState(false);
  const [rideSeconds, setRideSeconds] = useState(0);
  const [totalMetersTraveled, setTotalMetersTraveled] = useState(0);
  const [osmStatusText, setOsmStatusText] = useState('idle');
  const [bleInfo, setBleInfo] = useState('-');

  const timerIntervalRef = useRef(null);
  const rideSecondsRef = useRef(0);
  const webViewRef = useRef(null);
  const managerRef = useRef(null);
  const disconnectSubscriptionRef = useRef(null);
  const headingSubRef = useRef(null);
  const motionSubRef = useRef(null);
  const nativeMotionActiveRef = useRef(false);
  const foregroundWatcherRef = useRef(null);
  const watcherModeRef = useRef(null);
  const watcherStartPromiseRef = useRef(null);
  const scanTimeoutRef = useRef(null);
  const scanInProgressRef = useRef(false);
  const connectActionRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectEnabledRef = useRef(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [diagnosticSnapshot, setDiagnosticSnapshot] = useState({});
  const scheduleReconnect = () => {
    if (!mountedRef.current || !reconnectEnabledRef.current || reconnectTimerRef.current) return;
    const delay = Math.min(30000, 1500 * Math.pow(2, Math.min(5, reconnectAttemptRef.current++)));
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      if (!navCore.activeDevice && mountedRef.current) connectActionRef.current?.(true);
    }, delay);
  };
  const reverseGeoAbortRef = useRef(null);
  const introTimeoutRef = useRef(null);
  const mountedRef = useRef(true);
  const currentLocationRef = useRef(null);
  const navFaceRef = useRef(0);
  const recentsRef = useRef([]);
  const tripsRef = useRef([]);
  const syncMapRef = useRef(() => {});
  const initialDarkRef = useRef(isDark);

  const leafletSource = useMemo(
    () => ({ html: buildLeafletHTML(initialDarkRef.current, !NativeDeviceMotion) }),
    []
  );

  useEffect(() => { navCore.navState = navState; }, [navState]);
  useEffect(() => { navCore.destCoords = destCoords; }, [destCoords]);
  useEffect(() => { navCore.resolvedPlace = resolvedPlace; }, [resolvedPlace]);
  useEffect(() => { navCore.userZoomLevel = zoomLevel; if (!navCore.autoJunctionZoom) navCore.zoomLevel = zoomLevel; }, [zoomLevel]);
  useEffect(() => { navFaceRef.current = navFace; }, [navFace]);

  useEffect(() => {
    if (webViewRef.current) {
      try {
        webViewRef.current.injectJavaScript(`document.body.className='${isDark ? 'dark-mode' : 'light-mode'}'; true;`);
      } catch (e) {}
    }
  }, [isDark]);

  syncMapRef.current = () => {
    const wv = webViewRef.current;
    if (!wv) return;
    const targetZ = getLeafletZoomForScale(navCore.zoomLevel);
    let js = `document.body.className='${isDark ? 'dark-mode' : 'light-mode'}';if(window.setMapZoom){setMapZoom(${targetZ});}`;
    const loc = currentLocationRef.current;
    if (loc) js += `if(window.setUserLocation){setUserLocation(${loc.latitude},${loc.longitude});}`;
    const dest = navCore.destCoords;
    if (dest) js += `if(window.setDestinationPin){setDestinationPin(${dest.latitude},${dest.longitude},false);}`;
    if (navCore.navState === 'NAVIGATING' && dest && navCore.routeCoords.length > 0) {
      js += `if(window.drawRoute){drawRoute(${JSON.stringify(toLeafletCoords(navCore.routeCoords))},${JSON.stringify(navCore.altRoutes.map(toLeafletCoords))},${dest.latitude},${dest.longitude});}`;
    }
    js += 'true;';
    try { wv.injectJavaScript(js); } catch (e) {}
  };

  useEffect(() => {
    mountedRef.current = true;
    navCore.onUIUpdate = (event) => {
      if (event.type === "TELEMETRY") {
        if (event.loc && event.loc.coords) {
          currentLocationRef.current = event.loc.coords;
          setCurrentSpeedKmh(event.finalSpeedKmh);
          setTurnDistance(event.distToTurn);
          setRemainingRouteMeters(event.remainingRouteMeters || 0);
          setEtaMinutes(event.etaMinutes);
          setJunctionMode(!!event.junctionMode);
          setTotalMetersTraveled(event.totalMeters);
          const rangeM = getVisibleRangeMeters(navCore.zoomLevel);
          setBleInfo(`${rangeM}m range / ${event.stubs} segs`);
          if (AppState.currentState === 'active' && webViewRef.current) {
            try {
              webViewRef.current.injectJavaScript(`if (window.setUserLocation) { setUserLocation(${event.loc.coords.latitude}, ${event.loc.coords.longitude}); } true;`);
            } catch (e) {}
          }
        }
      } else if (event.type === "OSM_STATUS") {
        setOsmStatusText(event.text);
      } else if (event.type === "REROUTE_SUCCESS") {
        if (AppState.currentState === 'active' && webViewRef.current) {
          try {
            const jsonStr = JSON.stringify(event.coords);
            const altStr = JSON.stringify(event.altCoords || []);
            webViewRef.current.injectJavaScript(`if (window.drawRoute) { drawRoute(${jsonStr}, ${altStr}, ${event.destLat}, ${event.destLon}); } true;`);
          } catch (e) {}
        }
      }
    };

    navCore.onAutoArrive = () => {
      if (!navCore.stopInProgress) stopNavigation(true);
    };

    const appStateSub = AppState.addEventListener('change', (next) => {
      if (next === 'active') syncMapRef.current();
    });

    runIntroSequence();
    loadRecentLocations();
    loadSavedTrips();
    loadNavFaceSetting();
    loadZoomSetting();
    initApp();

    return () => {
      mountedRef.current = false;
      navCore.onUIUpdate = null;
      navCore.onAutoArrive = null;
      appStateSub.remove();
      if (introTimeoutRef.current) clearTimeout(introTimeoutRef.current);
      if (navCore.routeFetchAbort) navCore.routeFetchAbort.abort();
      if (navCore.rerouteAbort) navCore.rerouteAbort.abort();
      if (navCore.osmController) navCore.osmController.abort();
      if (reverseGeoAbortRef.current) reverseGeoAbortRef.current.abort();
      reconnectEnabledRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (disconnectSubscriptionRef.current) disconnectSubscriptionRef.current.remove();
      if (headingSubRef.current) headingSubRef.current.remove();
      if (motionSubRef.current) motionSubRef.current.remove();
      if (foregroundWatcherRef.current) foregroundWatcherRef.current.remove();
      if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
      if (managerRef.current) {
        try { managerRef.current.stopDeviceScan(); } catch (e) {}
        try { managerRef.current.destroy(); } catch (e) {}
        managerRef.current = null;
      }
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    };
  }, []);

  const runIntroSequence = () => {
    Animated.parallel([
      Animated.timing(logoOpacity, { toValue: 1, duration: 500, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(logoScale, { toValue: 1, duration: 700, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();

    introTimeoutRef.current = setTimeout(() => {
      Animated.timing(introFade, { toValue: 0, duration: 400, easing: Easing.inOut(Easing.ease), useNativeDriver: true }).start(() => {
        if (mountedRef.current) setShowSplash(false);
      });
    }, 1100);
  };

  const loadNavFaceSetting = async () => {
    try {
      const val = await AsyncStorage.getItem(STORAGE_KEY_FACE);
      if (val !== null) {
        const face = parseInt(val, 10) === 1 ? 1 : 0;
        navFaceRef.current = face;
        setNavFace(face);
      }
    } catch (e) {}
  };

  const loadZoomSetting = async () => {
    try {
      const val = await AsyncStorage.getItem(STORAGE_KEY_ZOOM);
      if (val !== null) {
        const parsed = parseFloat(val);
        if (Number.isFinite(parsed)) {
          const safeZoom = Math.max(1.00, Math.min(2.0, parsed));
          setZoomLevel(safeZoom);
          navCore.zoomLevel = safeZoom;
          navCore.userZoomLevel = safeZoom;
        }
      }
    } catch (e) {}
  };

  const syncZoomToPhoneAndESP32 = (nextZoom) => {
    nextZoom = Math.max(1.00, Math.min(2.00, nextZoom));
    navCore.userZoomLevel = nextZoom;
    // Rider's manual input wins over auto junction zoom for 30 seconds.
    navCore.manualZoomOverrideUntil = Date.now() + 30000;
    navCore.autoJunctionZoom = false;
    navCore.zoomLevel = nextZoom;
    // Force regeneration at the new physical scale instead of reusing
    // the gray-road graph built for the old zoom level.
    navCore.lastOsmGraphBuild = 0;

    if (nextZoom < 1.05 && navCore.navState === "NAVIGATING") {
      loadFarRoadsIfNeeded();
    }

    if (navCore.navState === "NAVIGATING" && navCore.lastPosition) {
      processGPSPosition({ coords: navCore.lastPosition }, true, true);
    } else if (navCore.activeDevice) {
      queueBLEPacket(new Uint8Array([0x04, Math.round(nextZoom * 100)]), false);
    }

    if (webViewRef.current) {
      const leafletZoom = getLeafletZoomForScale(nextZoom);
      try {
        webViewRef.current.injectJavaScript(`if (window.setMapZoom) { setMapZoom(${leafletZoom}); } true;`);
      } catch (e) {}
    }

    setZoomLevel(nextZoom);
    AsyncStorage.setItem(STORAGE_KEY_ZOOM, nextZoom.toString()).catch(() => {});
  };

  const handleZoomIn = () => {
    const next = Math.min(2.0, Number((navCore.userZoomLevel + 0.20).toFixed(2)));
    syncZoomToPhoneAndESP32(next);
  };

  const handleZoomOut = () => {
    const next = Math.max(1.00, Number((navCore.userZoomLevel - 0.20).toFixed(2)));
    syncZoomToPhoneAndESP32(next);
  };

  const handleRecenterMap = () => {
    if (webViewRef.current) {
      webViewRef.current.injectJavaScript(`if (window.recenterOnUser) { recenterOnUser(); } true;`);
    }
  };

  const commitDestination = (lat, lon, name, fitMap) => {
    const dest = { latitude: lat, longitude: lon };
    navCore.destCoords = dest;
    navCore.resolvedPlace = name;
    setDestCoords(dest);
    setResolvedPlace(name);
    setShowRecents(false);
    Keyboard.dismiss();

    if (fitMap && AppState.currentState === 'active' && webViewRef.current) {
      try {
        webViewRef.current.injectJavaScript(`if (window.setDestinationPin) { setDestinationPin(${lat}, ${lon}, true); } true;`);
      } catch (e) {}
    }

    if (navCore.navState === 'NAVIGATING' && currentLocationRef.current) {
      triggerBackgroundReroute(
        currentLocationRef.current.latitude,
        currentLocationRef.current.longitude,
        true,
        navCore.heading
      );
    }
  };

  const handleWebViewMessage = async (event) => {
    try {
      const payload = JSON.parse(event.nativeEvent.data);

      if (payload.type === 'IMU_3D') {
        if (nativeMotionActiveRef.current) return;
        ingest3DInertialSample(
          payload.gx || 0,
          payload.gy || 0,
          payload.gz || 0,
          payload.rx || 0,
          payload.ry || 0,
          payload.rz || 0,
          payload.t || Date.now()
        );
        return;
      }

      if (payload.type === 'MAP_TAP' && Number.isFinite(payload.lat) && Number.isFinite(payload.lon)) {
        const lat = payload.lat;
        const lon = payload.lon;
        const fallbackLabel = `Pin (${lat.toFixed(4)}, ${lon.toFixed(4)})`;

        commitDestination(lat, lon, fallbackLabel, false);

        if (reverseGeoAbortRef.current) {
          reverseGeoAbortRef.current.abort();
        }
        const controller = new AbortController();
        reverseGeoAbortRef.current = controller;

        try {
          const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18`;
          const res = await fetch(url, { headers: USER_AGENT_HEADER, signal: controller.signal });
          const data = await res.json();
          if (data && data.display_name && mountedRef.current) {
            const cleanName = data.name || data.display_name.split(',')[0] || fallbackLabel;
            setResolvedPlace(cleanName);
            navCore.resolvedPlace = cleanName;
            saveRecentLocation({ name: cleanName, latitude: lat, longitude: lon });
          }
        } catch (err) {}
      }
    } catch (e) {}
  };

  const toggleNavFace = async () => {
    const nextFace = navFace === 0 ? 1 : 0;
    navFaceRef.current = nextFace;
    setNavFace(nextFace);
    AsyncStorage.setItem(STORAGE_KEY_FACE, nextFace.toString()).catch(() => {});
    sendNavFaceCommand(nextFace);
  };

  const sendNavFaceCommand = async (faceId) => {
    if (!navCore.activeDevice) return;
    await queueBLEPacket(new Uint8Array([0x03, faceId]));
  };

  const toggleTheme = () => setThemeMode((prev) => (prev === 'dark' ? 'light' : 'dark'));

  const persistRecents = (next) => {
    recentsRef.current = next;
    setRecentLocations(next);
    if (next.length === 0) AsyncStorage.removeItem(STORAGE_KEY_RECENTS).catch(() => {});
    else AsyncStorage.setItem(STORAGE_KEY_RECENTS, JSON.stringify(next)).catch(() => {});
  };

  const persistTrips = (next) => {
    tripsRef.current = next;
    setSavedTrips(next);
    if (next.length === 0) AsyncStorage.removeItem(STORAGE_KEY_TRIPS).catch(() => {});
    else AsyncStorage.setItem(STORAGE_KEY_TRIPS, JSON.stringify(next)).catch(() => {});
  };

  const loadRecentLocations = async () => {
    try {
      const data = await AsyncStorage.getItem(STORAGE_KEY_RECENTS);
      const parsed = data ? JSON.parse(data) : [];
      recentsRef.current = Array.isArray(parsed) ? parsed : [];
      setRecentLocations(recentsRef.current);
    } catch (e) {}
  };

  const saveRecentLocation = (item) => {
    persistRecents([item, ...recentsRef.current.filter((r) => r.name !== item.name)].slice(0, 7));
  };

  const deleteRecentLocation = (placeName) => {
    persistRecents(recentsRef.current.filter((r) => r.name !== placeName));
  };

  const clearAllRecentLocations = () => persistRecents([]);

  const loadSavedTrips = async () => {
    try {
      const data = await AsyncStorage.getItem(STORAGE_KEY_TRIPS);
      const parsed = data ? JSON.parse(data) : [];
      tripsRef.current = Array.isArray(parsed) ? parsed : [];
      setSavedTrips(tripsRef.current);
    } catch (e) {}
  };

  const persistTripRecord = (durationSec, meters, placeName, coords, avgSpeedKmh, topSpeedKmh) => {
    const newTrip = {
      id: Date.now().toString(),
      destination: placeName || "Destination",
      coords: coords || null,
      date: new Date().toLocaleDateString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      }),
      durationSec,
      meters,
      avgSpeedKmh: avgSpeedKmh || 0,
      topSpeedKmh: topSpeedKmh || 0,
    };
    persistTrips([newTrip, ...tripsRef.current].slice(0, MAX_SAVED_TRIPS));
  };

  const deleteTrip = (tripId) => {
    Alert.alert("Delete Trip", "Remove this trip from your logs?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete", style: "destructive",
        onPress: () => persistTrips(tripsRef.current.filter((t) => t.id !== tripId)),
      },
    ]);
  };

  const clearAllTrips = () => {
    Alert.alert("Clear History", "Permanently remove all recorded trips?", [
      { text: "Cancel", style: "cancel" },
      { text: "Clear All", style: "destructive", onPress: () => persistTrips([]) },
    ]);
  };

  const startForegroundWatcher = async (navigating) => {
    if (watcherStartPromiseRef.current) {
      try { await watcherStartPromiseRef.current; } catch (e) {}
    }
    const mode = navigating ? 'nav' : 'idle';
    if (foregroundWatcherRef.current && watcherModeRef.current === mode) return;
    stopForegroundWatcher();

    const options = navigating
      ? { accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 0, timeInterval: 500 }
      : { accuracy: Location.Accuracy.High, distanceInterval: 3, timeInterval: 2000 };

    const request = Location.watchPositionAsync(options, (loc) => {
      if (!mountedRef.current) return;
      processGPSPosition(loc);
      if (navCore.lastFixTs === loc.timestamp && navCore.lastPosition) {
        currentLocationRef.current = navCore.lastPosition;
      }
    }).then((sub) => {
      if (mountedRef.current && !foregroundWatcherRef.current) {
        foregroundWatcherRef.current = sub;
        watcherModeRef.current = mode;
      } else {
        sub.remove();
      }
    }).catch(() => {}).finally(() => { watcherStartPromiseRef.current = null; });

    watcherStartPromiseRef.current = request;
    return request;
  };

  const stopForegroundWatcher = () => {
    if (foregroundWatcherRef.current) {
      foregroundWatcherRef.current.remove();
      foregroundWatcherRef.current = null;
      watcherModeRef.current = null;
    }
  };

  const startBackgroundUpdates = async () => {
    try {
      if (!(await TaskManager.isAvailableAsync())) return;
      let { status: bgStatus } = await Location.getBackgroundPermissionsAsync();
      if (bgStatus !== 'granted') {
        ({ status: bgStatus } = await Location.requestBackgroundPermissionsAsync());
      }
      if (bgStatus !== 'granted') return;
      if (await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK)) return;
      await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: 1000,
        distanceInterval: 0,
        pausesUpdatesAutomatically: false,
        showsBackgroundLocationIndicator: true,
        foregroundService: {
          notificationTitle: 'NavPod navigation active',
          notificationBody: 'Streaming your route to the NavPod display',
          notificationColor: '#00E5FF',
        },
      });
    } catch (e) {}
  };

  const initApp = async () => {
    try {
      const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
      if (fgStatus !== 'granted') {
        Alert.alert('Location Needed', 'NavPod needs location access for speed, routing and the map. Enable it in Settings.');
        return;
      }

      // Pocket mode uses GPS course; no compass/gyroscope subscriptions.
      // This also reduces power consumption and prevents pocket-rotation jitter.
      await startForegroundWatcher(false);
    } catch (err) {}
  };

  const selectQuickLocation = (loc) => {
    if (reverseGeoAbortRef.current) reverseGeoAbortRef.current.abort();
    setShowTripsModal(false);
    commitDestination(loc.latitude, loc.longitude, loc.name, true);
  };

  const searchPlaceByName = async () => {
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    setShowRecents(false);
    Keyboard.dismiss();
    try {
      const query = searchQuery.trim();
      const center = currentLocationRef.current;
      const validCenter = center && Number.isFinite(center.latitude) && Number.isFinite(center.longitude);
      // First look near the rider; a distant identically-named village should not win.
      // The 1.35-degree window covers Hyderabad and surrounding Telangana towns.
      const lat = validCenter ? center.latitude : 17.3850;
      const lon = validCenter ? center.longitude : 78.4867;
      const lonSpan = 1.35 / Math.max(0.65, Math.cos(lat * Math.PI / 180));
      const viewbox = [lon - lonSpan, lat + 1.35, lon + lonSpan, lat - 1.35]
        .map((v) => v.toFixed(5)).join(',');
      const searchBase = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&q=${encodeURIComponent(query)}&limit=10`;
      const fetchMatches = async (bounded) => {
        const response = await fetch(`${searchBase}&viewbox=${viewbox}&bounded=${bounded ? 1 : 0}`, {
          headers: USER_AGENT_HEADER,
        });
        if (!response.ok) throw new Error(`Nominatim HTTP ${response.status}`);
        const results = await response.json();
        return Array.isArray(results) ? results : [];
      };
      let data = await fetchMatches(true);
      if (data.length === 0) data = await fetchMatches(false);
      if (data.length > 0) {
        // Nominatim's first result can still be wrong when several places share a name.
        const ranked = data.map((place) => {
          const pLat = Number(place.lat), pLon = Number(place.lon);
          const distance = Number.isFinite(pLat) && Number.isFinite(pLon)
            ? exactMetersBetween(lat, lon, pLat, pLon) : Infinity;
          const placeName = String(place.name || place.display_name || '').split(',')[0].trim().toLowerCase();
          const exactName = placeName === query.toLowerCase();
          return { place, score: (exactName ? -15000 : 0) + distance };
        }).sort((a, b) => a.score - b.score);
        const firstMatch = ranked[0].place;
        const lat = parseFloat(firstMatch.lat);
        const lon = parseFloat(firstMatch.lon);
        const placeName = firstMatch.display_name.split(',')[0];
        if (reverseGeoAbortRef.current) reverseGeoAbortRef.current.abort();
        commitDestination(lat, lon, placeName, true);
        saveRecentLocation({ name: placeName, latitude: lat, longitude: lon });
      } else {
        Alert.alert("Location Not Found", "Try typing a nearby landmark or tap directly on the map.");
      }
    } catch (e) {
      Alert.alert("Network Error", "Unable to reach search service.");
    } finally {
      if (mountedRef.current) setIsSearching(false);
    }
  };

  const startNavigation = async () => {
    if (navCore.navState !== 'IDLE') return;
    if (!currentLocationRef.current) {
      Alert.alert("GPS Pending", "Waiting for GPS satellite lock...");
      return;
    }
    if (!destCoords) {
      Alert.alert("No Destination", "Tap a spot on the map or search for a destination first.");
      return;
    }

    // A route must start at a fresh, accurate location, not the last cached fix.
    // On failure we stop rather than silently routing from another street.
    let startFix;
    try {
      startFix = await Promise.race([
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.BestForNavigation }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('GPS fix timeout')), 8500))
      ]);
    } catch (_) {
      Alert.alert('GPS not ready', 'Move outdoors, enable precise location and try again once GPS accuracy improves.');
      return;
    }
    if (!startFix?.coords || !Number.isFinite(startFix.coords.accuracy) ||
        startFix.coords.accuracy > 35 || Date.now() - startFix.timestamp > 12000) {
      Alert.alert('GPS inaccurate', 'Your GPS fix is not reliable enough to start a route (need 35 m or better). Try again outdoors.');
      return;
    }
    currentLocationRef.current = startFix.coords;
    processGPSPosition(startFix);
    navCore.stopInProgress = false;
    navCore.navState = "FETCHING";
    setNavState("FETCHING");

    if (navCore.routeFetchAbort) navCore.routeFetchAbort.abort();
    const controller = new AbortController();
    navCore.routeFetchAbort = controller;
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const myLon = currentLocationRef.current.longitude;
    const myLat = currentLocationRef.current.latitude;

    try {
      let routes = await fetchRoutes(myLon, myLat, destCoords, controller.signal);
      const usingCachedRoute = routes.length === 0;
      if (routes.length) cacheSuccessfulRoute(routes, destCoords, myLat, myLon);
      else routes = await getCachedRoute(destCoords, myLat, myLon);
      clearTimeout(timeoutId);
      if (navCore.navState !== "FETCHING") return;

      if (routes.length > 0) {
        navCore.destCoords = destCoords;
        navCore.isNetworkDegraded = usingCachedRoute;
        navCore.arrivalFixCount = 0;
        applyRouteResponse(routes);
        emitRouteToUI();

        setRideSeconds(0);
        rideSecondsRef.current = 0;
        navCore.rideStartMs = Date.now();
        navCore.totalMeters = 0.0;
        navCore.odomAnchor = {
          latitude: myLat,
          longitude: myLon,
          timestamp: Date.now(),
        };
        navCore.topSpeed = 0;
        setTotalMetersTraveled(0);
        setRemainingRouteMeters(0);
        setEtaMinutes(null);

        navCore.navState = "NAVIGATING";
        setNavState("NAVIGATING");

        processGPSPosition({ coords: currentLocationRef.current }, true, true);
        loadNearbyRoads(myLat, myLon).catch(() => {});
        setTimeout(() => {
          if (navCore.navState === "NAVIGATING") {
            sendNavFaceCommand(navFaceRef.current);
            streamCachedVectorsToBLE(true);
          }
        }, 80);

        if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = setInterval(() => {
          if (navCore.navState !== "NAVIGATING") return;
          const secs = Math.floor((Date.now() - navCore.rideStartMs) / 1000);
          rideSecondsRef.current = secs;
          setRideSeconds(secs);

          if (Date.now() - navCore.lastSpeedTimestamp > 1800 && navCore.filteredSpeed > 0) {
            navCore.filteredSpeed = navCore.filteredSpeed < 2.8 ? 0 : navCore.filteredSpeed * 0.45;
            setCurrentSpeedKmh(Math.round(navCore.filteredSpeed));
          }

          streamCachedVectorsToBLE(true);
        }, 1000);

        startForegroundWatcher(true).catch(() => {});
        // Diagnostic stability mode: don't request Android "Allow all the time" or
        // start the native foreground location service during navigation.
        // Foreground GPS tracking remains active above. Turn this back on only
        // after checking AndroidManifest/Expo configuration and crash logs.
        // startBackgroundUpdates();
      } else {
        Alert.alert("Route Error", "No route found for this area.");
        navCore.navState = "IDLE";
        setNavState("IDLE");
      }
    } catch (e) {
      clearTimeout(timeoutId);
      if (navCore.navState === "FETCHING") {
        Alert.alert("Routing Failed", "Check your internet connection.");
        navCore.navState = "IDLE";
        setNavState("IDLE");
      }
    }
  };

  const stopNavigation = (isAutoReached = false) => {
    if (navCore.stopInProgress) return;
    navCore.stopInProgress = true;

    try {
      const wasNavigating = navCore.navState === 'NAVIGATING';

      if (navCore.routeFetchAbort) {
        navCore.routeFetchAbort.abort();
        navCore.routeFetchAbort = null;
      }
      navCore.rerouteSeq++;
      if (navCore.rerouteAbort) {
        navCore.rerouteAbort.abort();
        navCore.rerouteAbort = null;
      }
      navCore.isRerouting = false;

      navCore.navState = 'IDLE';
      setNavState('IDLE');

      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }

      if (!wasNavigating) return;

      const finalSecs = Math.max(0, Math.floor((Date.now() - navCore.rideStartMs) / 1000));
      const finalMeters = Math.round(navCore.totalMeters);
      const topSpd = navCore.topSpeed;
      const avgSpd = finalSecs > 0 ? Math.round((navCore.totalMeters / finalSecs) * 3.6) : 0;
      const tripPlace = navCore.resolvedPlace;
      const tripCoords = navCore.destCoords;

      navCore.pendingStreamPayload = null;
      navCore.bleStreamInFlight = false;
      navCore.bleWriteChain = Promise.resolve();
      navCore.routeCoords = [];
      navCore.altRoutes = [];
      navCore.altMeta = [];
      navCore.intersections = [];
      navCore.stepManeuvers = [];
      navCore.maneuverIdxMap = new Map();
      navCore.rawForwardPool = [];
      navCore.rawReversePool = [];
      navCore.rawRoadPool = [];
      navCore.lockedWorldPolylines = [];
      navCore.roadOrigin = null;
      navCore.osmLastAttempt = 0;
      navCore.osmRequestId++;
      if (navCore.osmController) navCore.osmController.abort();
      navCore.osmController = null;
      navCore.osmRoadWays = [];
      navCore.osmLocalWays = [];
      navCore.osmFarWays = [];
      navCore.osmRoadCenter = null;
      navCore.osmFarLoaded = false;
      navCore.osmFarFetching = false;
      navCore.osmStatus = 'idle';
      navCore.lastStubCount = 0;
      setOsmStatusText('idle');
      setBleInfo('-');
      navCore.odomAnchor = null;

      setCurrentSpeedKmh(0);
      setTurnDistance(0);

      if (webViewRef.current) {
        try {
          webViewRef.current.injectJavaScript(`if (window.clearRoute) { clearRoute(); } true;`);
        } catch (e) {}
      }

      sendCompletionSummaryPacket(finalSecs, finalMeters);
      setTimeout(() => sendCompletionSummaryPacket(finalSecs, finalMeters), 80);

      if (finalSecs > 10 || finalMeters > 50) {
        persistTripRecord(finalSecs, finalMeters, tripPlace, tripCoords, avgSpd, topSpd);
      }

      TaskManager.isAvailableAsync()
        .then((avail) => (avail ? Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK) : false))
        .then((running) => (running ? Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK) : null))
        .catch(() => {});

      startForegroundWatcher(false).catch(() => {});

      Alert.alert(
        isAutoReached ? "Destination Reached" : "Trip Ended",
        `Duration: ${formatDuration(finalSecs)}\nDistance: ${(finalMeters / 1000).toFixed(2)} km\nAvg Speed: ${avgSpd} km/h\nTop Speed: ${topSpd} km/h`
      );
    } finally {
      navCore.stopInProgress = false;
    }
  };

  const sendCompletionSummaryPacket = (seconds, meters) => {
    if (!navCore.activeDevice) return;
    const safeSeconds = Math.max(0, Math.min(65535, Math.round(seconds)));
    const safeMeters = Math.max(0, Math.min(65535, Math.round(meters)));
    const payload = new Uint8Array([
      0xFF,
      (safeSeconds >> 8) & 0xFF, safeSeconds & 0xFF,
      (safeMeters >> 8) & 0xFF, safeMeters & 0xFF,
    ]);
    queueBLEPacket(payload, false);
  };

  const formatDuration = (totalSec) => {
    const minutes = Math.floor(totalSec / 60);
    const seconds = totalSec % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };

  const connectToNavPod = async (silent = false) => {
    if (!silent) reconnectEnabledRef.current = true;
    if (navCore.activeDevice || scanInProgressRef.current || status === 'Searching' || status === 'Pairing') return;
    scanInProgressRef.current = true;

    try {
      if (Platform.OS === 'android') {
        const version = Number(Platform.Version);
        const permissions = version >= 31
          ? [
              PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
              PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
              PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
            ]
          : [
              PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
              PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION
            ];
        const results = await PermissionsAndroid.requestMultiple(permissions);
        if (permissions.some((p) => results[p] !== PermissionsAndroid.RESULTS.GRANTED)) {
          scanInProgressRef.current = false;
          setStatus('No permission');
          reconnectEnabledRef.current = false;
          if (!silent) Alert.alert('Permission Needed', 'Allow Nearby Devices and Location permissions to connect.');
          return;
        }
      }

      if (!managerRef.current) managerRef.current = new BleManager();
      const manager = managerRef.current;
      setStatus('Searching');

      if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
      scanTimeoutRef.current = setTimeout(() => {
        scanInProgressRef.current = false;
        try { manager.stopDeviceScan(); } catch (e) {}
        if (!navCore.activeDevice && mountedRef.current) setStatus('Disconnected');
        scheduleReconnect();
      }, 15000);

      manager.startDeviceScan(null, null, (error, scannedDevice) => {
        if (!mountedRef.current) return;
        if (error) {
          scanInProgressRef.current = false;
          if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
          scanTimeoutRef.current = null;
          try { manager.stopDeviceScan(); } catch (e) {}
          setStatus('Offline');
          if (!silent) Alert.alert('Bluetooth unavailable', 'Turn on Bluetooth to connect.');
          scheduleReconnect();
          return;
        }

        const devName = scannedDevice ? (scannedDevice.name || scannedDevice.localName) : null;
        if (devName !== 'ESP32-NAV-POD') return;
        scanInProgressRef.current = false;
        if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
        scanTimeoutRef.current = null;
        try { manager.stopDeviceScan(); } catch (e) {}

        setStatus('Pairing');
        scannedDevice.connect({ timeout: 10000 })
          .then(async (dev) => {
            if (Platform.OS === 'android') {
              try {
                const mtuDevice = await dev.requestMTU(517);
                const negotiated = Number(mtuDevice?.mtu || dev.mtu || 23);
                navCore.blePayloadMax = Math.max(20, Math.min(MAX_BLE_PAYLOAD, negotiated - 3));
              } catch (e) {
                navCore.blePayloadMax = 20; // Unknown MTU: assume BLE minimum (23 - 3), not 244.
              }
              try { await manager.requestConnectionPriorityForDevice(dev.id, 1); } catch (e) {}
            } else {
              navCore.blePayloadMax = Math.max(20, Math.min(MAX_BLE_PAYLOAD, (dev.mtu || 185) - 3));
            }
            return dev.discoverAllServicesAndCharacteristics();
          })
          .then((dev) => {
            if (!mountedRef.current) {
              dev.cancelConnection().catch(() => {});
              return;
            }
            navCore.activeDevice = dev;
            navCore.bleWriteChain = Promise.resolve();
            setStatus('Connected');
            reconnectEnabledRef.current = true;
            reconnectAttemptRef.current = 0;
            if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
            disconnectSubscriptionRef.current?.remove();
            disconnectSubscriptionRef.current = dev.onDisconnected(() => {
              navCore.activeDevice = null;
              navCore.blePayloadMax = 244;
              navCore.pendingStreamPayload = null;
              navCore.bleStreamInFlight = false;
              if (mountedRef.current) setStatus('Disconnected');
              scheduleReconnect();
            });
            sendNavFaceCommand(navFaceRef.current);
            if (navCore.navState === "NAVIGATING") {
              setTimeout(() => streamCachedVectorsToBLE(true), 80);
            }
          })
          .catch(() => {
            if (mountedRef.current) setStatus('Disconnected');
            scheduleReconnect();
          });
      });
    } catch (err) {
      scanInProgressRef.current = false;
      if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
      setStatus('Offline');
      if (!silent) Alert.alert('Bluetooth unavailable', 'Turn on Bluetooth to connect.');
      scheduleReconnect();
    }
  };
  connectActionRef.current = connectToNavPod;

  useEffect(() => {
    if (!showDiagnostics) return;
    const update = () => setDiagnosticSnapshot({ ...navCore.diagnostics, blePayloadMax: navCore.blePayloadMax,
      gpsSpeedKmh: Math.round(navCore.filteredSpeed), loadedWays: navCore.osmRoadWays.length,
      lastBLEAgeMs: Date.now() - navCore.lastBleSendTime });
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [showDiagnostics]);

  const isConnected = status === "Connected";

  const palette = {
    bg: isDark ? '#0B1018' : '#F5F7FA',
    card: isDark ? '#151D29' : '#FFFFFF',
    border: isDark ? '#263244' : '#E7EBF0',
    textMain: isDark ? '#EFF5FA' : '#152334',
    textMuted: isDark ? '#9CABBB' : '#66788D',
    label: isDark ? '#555555' : '#6B7280',
    inputBg: isDark ? '#121212' : '#FFFFFF',
    searchBtn: isDark ? '#222222' : '#ECEFF2',
    searchBtnText: isDark ? '#FFFFFF' : '#111827',
    recentsBg: isDark ? '#111111' : '#FFFFFF',
    recentItemBorder: isDark ? '#1A1A1A' : '#F0F2F5',
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: palette.bg }]}>
      <StatusBar barStyle={isDark ? "light-content" : "dark-content"} backgroundColor={palette.bg} />
      <Modal transparent visible={showDiagnostics} animationType="slide" onRequestClose={() => setShowDiagnostics(false)}>
        <View style={{ flex: 1, backgroundColor: '#101827', padding: 24, justifyContent: 'center' }}>
          <Text style={{ color: '#FFFFFF', fontWeight: 'bold', fontSize: 23, marginBottom: 18 }}>NavPod Diagnostics</Text>
          {[
            ['GPS accuracy', diagnosticSnapshot.gpsAccuracy == null ? '—' : `${diagnosticSnapshot.gpsAccuracy.toFixed(1)} m`],
            ['GPS interval', `${diagnosticSnapshot.gpsIntervalMs || 0} ms`],
            ['Heading source', diagnosticSnapshot.headingSource || '—'],
            ['Map matching', diagnosticSnapshot.mapMatch || '—'],
            ['Distance off route', `${diagnosticSnapshot.offRouteMeters || 0} m`],
            ['GPS quality', `${diagnosticSnapshot.gpsQuality || 'waiting'}`],
            ['OSM roads loaded', `${diagnosticSnapshot.loadedWays || 0}`],
            ['Displayed road runs', `${diagnosticSnapshot.mapRoads || 0}`],
            ['Offline road cache hits', `${diagnosticSnapshot.osmCacheHits || 0}`],
            ['Overpass requests', `${diagnosticSnapshot.osmRequests || 0}`],
            ['BLE writes / failures', `${diagnosticSnapshot.bleWrites || 0} / ${diagnosticSnapshot.bleErrors || 0}`],
            ['Last BLE write duration', `${diagnosticSnapshot.bleLastWriteMs || 0} ms`],
            ['BLE payload limit', `${diagnosticSnapshot.blePayloadMax || 20} bytes`],
          ].map(([label, value]) => (
            <View key={label} style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 9 }}>
              <Text style={{ color: '#9AAEC8', flex: 1 }}>{label}</Text>
              <Text style={{ color: '#FFFFFF', flex: 1, textAlign: 'right' }}>{value}</Text>
            </View>
          ))}
          <Text style={{ color: '#9AAEC8', marginTop: 8, marginBottom: 15, fontSize: 12 }}>
            BLE write duration is not end-to-end latency. Packet loss and ESP32 FPS require firmware telemetry.
          </Text>
          <TouchableOpacity onPress={() => setShowDiagnostics(false)} style={{ padding: 14, borderRadius: 8, backgroundColor: '#164A63' }}>
            <Text style={{ color: 'white', textAlign: 'center' }}>Close</Text>
          </TouchableOpacity>
        </View>
      </Modal>
      <View style={styles.content}>
        <View style={styles.header}>
          <View style={styles.brandGroup}>
            <Text style={[styles.brandEyebrow, { color: palette.textMuted }]}>MOTORCYCLE NAVIGATION</Text>
            <Text style={[styles.appTitle, { color: palette.textMain }]}>NavPod<Text style={styles.brandDot}>.</Text></Text>
          </View>
          <View style={styles.headerRight}>
            <TouchableOpacity onPress={() => connectToNavPod(false)} disabled={isConnected}
              accessibilityRole="button" accessibilityLabel="Connect to NavPod" style={[styles.statusBadge,{ backgroundColor: palette.card, borderColor: palette.border }]}>
              <View style={[styles.statusDot, isConnected && styles.statusDotConnected]} />
              <Text style={[styles.statusText,{color:palette.textMuted},isConnected && styles.statusTextConnected]} numberOfLines={1}>{isConnected ? 'Connected' : 'Connect'}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setShowDiagnostics(true)} accessibilityRole="button" accessibilityLabel="Diagnostics"
              style={[styles.headerIconBtn, { backgroundColor: palette.card, borderColor: palette.border }]}>
              <Text style={[styles.headerIconText,{color:palette.textMain}]}>D</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={toggleTheme} accessibilityRole="button" accessibilityLabel="Switch theme"
              style={[styles.headerIconBtn, { backgroundColor: palette.card, borderColor: palette.border }]}>
              <Text style={[styles.headerIconText,{color:palette.textMain}]}>{isDark ? 'L' : 'D'}</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={[styles.searchSection, styles.heroSearchSection]}>
          <View style={[styles.searchBar, { backgroundColor: palette.card, borderColor: palette.border }]}>
            <Text style={styles.searchGlyph}>⌕</Text>
            <TextInput
              style={[styles.searchInput, { color: palette.textMain }]}
              value={searchQuery} onChangeText={setSearchQuery}
              onFocus={() => setShowRecents(true)}
              placeholder="Where to?" placeholderTextColor={palette.textMuted}
              returnKeyType="search" onSubmitEditing={searchPlaceByName}
              accessibilityLabel="Search destination"
            />
            <TouchableOpacity style={styles.searchAction} onPress={searchPlaceByName} disabled={isSearching} accessibilityRole="button" accessibilityLabel="Search location">
              {isSearching ? <ActivityIndicator size="small" color="#FFFFFF" /> : <Text style={styles.searchActionText}>Search</Text>}
            </TouchableOpacity>
          </View>
          {showRecents && recentLocations.length > 0 && (
            <View style={[styles.recentsDropdown, { backgroundColor: palette.card, borderColor: palette.border }]}>
              <View style={[styles.recentsHeader, { borderBottomColor: palette.border }]}>
                <Text style={[styles.recentsTitle, { color: palette.textMuted }]}>RECENT DESTINATIONS</Text>
                <View style={styles.recentsHeaderActions}>
                  <TouchableOpacity onPress={clearAllRecentLocations}><Text style={styles.clearRecentsText}>CLEAR</Text></TouchableOpacity>
                  <TouchableOpacity onPress={() => setShowRecents(false)}><Text style={styles.closeRecentsText}>CLOSE</Text></TouchableOpacity>
                </View>
              </View>
              <FlatList data={recentLocations} keyboardShouldPersistTaps="handled"
                keyExtractor={(item, idx) => `${item.name}-${idx}`}
                renderItem={({ item }) => (
                  <View style={[styles.recentItemRow, { borderBottomColor: palette.recentItemBorder }]}>
                    <TouchableOpacity style={styles.recentItemContent} onPress={() => selectQuickLocation(item)}>
                      <Text style={styles.recentPin}>⌖</Text>
                      <Text style={[styles.recentText, { color: palette.textMain }]} numberOfLines={1}>{item.name}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => deleteRecentLocation(item.name)} style={styles.removeRecentItemBtn} accessibilityLabel="Remove recent location"><Text style={styles.removeRecentItemText}>×</Text></TouchableOpacity>
                  </View>
                )}/>
            </View>
          )}
          {resolvedPlace && !showRecents ? <Text style={[styles.targetIndicator,{color:palette.textMuted}]} numberOfLines={1}>Destination · {resolvedPlace}</Text> : null}
        </View>

        <View style={[styles.metricsCard, { backgroundColor: palette.card, borderColor: palette.border }]}>
          <View style={styles.primaryMetric}>
            <Text style={[styles.metricLabel,{color:palette.textMuted}]}>SPEED</Text>
            <Text style={[styles.metricSpeedValue,{color:palette.textMain}]}>{currentSpeedKmh}<Text style={styles.unit}> km/h</Text></Text>
          </View>
          <View style={[styles.verticalDivider,{backgroundColor:palette.border}]}/>
          <View style={styles.primaryMetric}>
            <Text style={[styles.metricLabel,{color:palette.textMuted}]}>NEXT TURN</Text>
            <Text style={[styles.metricValueLarge,{color:palette.textMain}]}>{turnDistance >= 1000 ? `${(turnDistance / 1000).toFixed(1)} km` : `${turnDistance} m`}</Text>
          </View>
          <View style={[styles.verticalDivider,{backgroundColor:palette.border}]}/>
          <View style={styles.secondaryMetric}>
            <Text style={[styles.metricLabel,{color:palette.textMuted}]}>RIDE</Text>
            <Text style={[styles.metricValue,{color:palette.textMain}]}>{formatDuration(rideSeconds)}</Text>
            <Text style={[styles.secondaryDetail,{color:palette.textMuted}]}>{(totalMetersTraveled / 1000).toFixed(1)} km</Text>
          </View>
        </View>

        <View style={[styles.mapContainer, { borderColor: palette.border }]}>
          <WebView
            ref={webViewRef}
            originWhitelist={['*']}
            source={leafletSource}
            style={styles.map}
            scrollEnabled={false}
            javaScriptEnabled
            domStorageEnabled
            setSupportMultipleWindows={false}
            onMessage={handleWebViewMessage}
            onLoadEnd={() => syncMapRef.current()}
          />
          <TouchableOpacity style={styles.recenterBtn} onPress={handleRecenterMap} activeOpacity={0.8}>
            <Text style={styles.recenterBtnText}>🎯</Text>
          </TouchableOpacity>
          <View style={styles.floatingZoomContainer}>
            <TouchableOpacity style={styles.floatingZoomBtn} onPress={handleZoomIn} activeOpacity={0.6}>
              <Text style={styles.floatingZoomText}>+</Text>
            </TouchableOpacity>
            <View style={styles.floatingZoomDivider} />
            <Text style={styles.floatingZoomLabel}>{zoomLevel.toFixed(1)}x</Text>
            <View style={styles.floatingZoomDivider} />
            <TouchableOpacity style={styles.floatingZoomBtn} onPress={handleZoomOut} activeOpacity={0.6}>
              <Text style={styles.floatingZoomText}>-</Text>
            </TouchableOpacity>
          </View>
        </View>


        <View style={styles.utilityRow}>
          <TouchableOpacity style={[styles.utilityButton,{borderColor:palette.border,backgroundColor:palette.card}]} onPress={toggleNavFace} accessibilityLabel="Toggle map or turn view">
            <View style={styles.utilityInner}><View style={[styles.utilityIconBox,{backgroundColor:palette.border}]}><Text style={[styles.utilityIconText,{color:palette.textMain}]}>M</Text></View><Text numberOfLines={1} style={[styles.utilityText,{color:palette.textMain}]}>{navFace === 0 ? 'Map view' : 'Turn view'}</Text></View>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.utilityButton,{borderColor:palette.border,backgroundColor:palette.card}]} onPress={() => setShowTripsModal(true)} accessibilityLabel="Saved rides">
            <View style={styles.utilityInner}><View style={[styles.utilityIconBox,{backgroundColor:palette.border}]}><Text style={[styles.utilityIconText,{color:palette.textMain}]}>H</Text></View><Text numberOfLines={1} style={[styles.utilityText,{color:palette.textMain}]}>Ride history</Text></View>
          </TouchableOpacity>
        </View>
        <View style={styles.spacer} />

        {navState !== "IDLE" ? (
          <TouchableOpacity
            style={[styles.actionBtn, styles.stopBtn]}
            onPress={() => stopNavigation(false)}
            activeOpacity={0.8}
          >
            <Text style={styles.actionBtnText}>{navState === "FETCHING" ? "CANCEL" : "END TRIP"}</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.actionBtn, styles.startBtn]}
            onPress={startNavigation}
            activeOpacity={0.8}
          >
            <Text style={styles.actionBtnText}>START NAVIGATION</Text>
          </TouchableOpacity>
        )}

        <Modal
          visible={showTripsModal}
          animationType="slide"
          transparent={true}
          onRequestClose={() => setShowTripsModal(false)}
        >
          <View style={styles.modalOverlay}>
            <View style={[styles.modalCard, { backgroundColor: palette.card, borderColor: palette.border }]}>
              <View style={[styles.modalHeader, { borderBottomColor: palette.border }]}>
                <View>
                  <Text style={[styles.modalTitle, { color: palette.textMain }]}>RIDE LOG</Text>
                  <Text style={[styles.modalSubtitle, { color: palette.textMuted }]}>
                    {savedTrips.length} {savedTrips.length === 1 ? 'trip' : 'trips'} saved
                  </Text>
                </View>
                <View style={styles.modalHeaderActions}>
                  {savedTrips.length > 0 && (
                    <TouchableOpacity onPress={clearAllTrips} style={styles.clearAllBtn}>
                      <Text style={styles.clearAllText}>Clear All</Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity
                    onPress={() => setShowTripsModal(false)}
                    style={[styles.closeModalBtn, { backgroundColor: palette.searchBtn }]}
                  >
                    <Text style={[styles.closeModalBtnText, { color: palette.textMain }]}>✕</Text>
                  </TouchableOpacity>
                </View>
              </View>
              {savedTrips.length === 0 ? (
                <View style={styles.emptyTripsContainer}>
                  <Text style={[styles.emptyTripsText, { color: palette.textMuted }]}>
                    No saved trips yet. Completed rides will log here automatically.
                  </Text>
                </View>
              ) : (
                <FlatList
                  data={savedTrips}
                  keyExtractor={(item) => item.id}
                  contentContainerStyle={{ paddingVertical: 8 }}
                  renderItem={({ item }) => (
                    <View style={[styles.tripCard, { borderBottomColor: palette.border }]}>
                      <TouchableOpacity
                        style={styles.tripInfo}
                        onPress={() => {
                          if (item.coords) {
                            selectQuickLocation({
                              name: item.destination,
                              latitude: item.coords.latitude,
                              longitude: item.coords.longitude
                            });
                          }
                        }}
                      >
                        <Text style={[styles.tripDestination, { color: palette.textMain }]} numberOfLines={1}>
                          📍 {item.destination}
                        </Text>
                        <Text style={[styles.tripMeta, { color: palette.textMuted }]}>
                          {item.date} • {formatDuration(item.durationSec)} • {(item.meters / 1000).toFixed(2)} km
                        </Text>
                        <Text style={styles.tripSpeedMeta}>
                          Avg: {item.avgSpeedKmh || 0} km/h   •   Max: {item.topSpeedKmh || 0} km/h
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.deleteTripBtn} onPress={() => deleteTrip(item.id)}>
                        <Text style={styles.deleteTripText}>🗑️</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                />
              )}
            </View>
          </View>
        </Modal>
      </View>

      {showSplash && (
        <Animated.View style={[styles.splashOverlay, { opacity: introFade }]}>
          <Animated.View style={[styles.splashCenter, { opacity: logoOpacity, transform: [{ scale: logoScale }] }]}>
            <Text style={styles.splashChevron}>▲</Text>
            <Text style={styles.splashTitle}>NAV POD</Text>
          </Animated.View>
        </Animated.View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flex: 1, paddingHorizontal: 14, paddingTop: 8, paddingBottom: 12 },
  header: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', rowGap: 9, marginBottom: 12 },
  headerRight: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: 6, flexShrink: 1 },
  faceBadge: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, borderWidth: 1, justifyContent: 'center', alignItems: 'center' },
  faceBadgeText: { fontSize: 10, fontWeight: '800', color: '#00E5FF', letterSpacing: 0.5 },
  headerIconBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 18, borderWidth: 1, justifyContent: 'center', alignItems: 'center' },
  headerIconText: { fontSize: 14 },
  appTitle: { fontSize: 21, fontWeight: '900', letterSpacing: 2 },
  statusBadge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 20, borderWidth: 1 },
  statusBadgeConnected: { borderColor: '#00E5FF44', backgroundColor: '#00E5FF15' },
  statusDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#888', marginRight: 6 },
  statusDotConnected: { backgroundColor: '#00E5FF' },
  statusText: { color: '#888', fontSize: 11, fontWeight: '700' },
  statusTextConnected: { color: '#00E5FF' },
  metricsCard: { flexDirection: 'row', borderRadius: 14, paddingVertical: 10, paddingHorizontal: 5, borderWidth: 1, marginBottom: 12 },
  metricItem: { flex: 1, alignItems: 'center' },
  verticalDivider: { width: 1, height: '70%', alignSelf: 'center' },
  metricLabel: { fontSize: 8.5, fontWeight: '700', letterSpacing: 0.8, marginBottom: 4 },
  metricSpeedValue: { fontSize: 16, fontWeight: '900', color: '#00E5FF' },
  metricValueLarge: { fontSize: 15, fontWeight: '800', color: '#F59E0B' },
  metricValue: { fontSize: 15, fontWeight: '700' },
  unit: { fontSize: 9.5, color: '#888', fontWeight: '500' },
  mapContainer: { height: 255, borderRadius: 16, overflow: 'hidden', borderWidth: 1, marginBottom: 12, position: 'relative' },
  map: { flex: 1 },
  recenterBtn: {
    position: 'absolute',
    right: 12,
    top: 10,
    width: 34,
    height: 34,
    backgroundColor: 'rgba(12, 12, 12, 0.92)',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 999,
    elevation: 6,
  },
  recenterBtnText: { fontSize: 15 },
  floatingZoomContainer: {
    position: 'absolute', right: 12, bottom: 12,
    backgroundColor: 'rgba(12, 12, 12, 0.92)',
    borderRadius: 8, borderWidth: 1, borderColor: '#2A2A2A',
    alignItems: 'center', overflow: 'hidden', zIndex: 999, elevation: 6,
  },
  floatingZoomBtn: { width: 34, height: 32, justifyContent: 'center', alignItems: 'center' },
  floatingZoomText: { color: '#00E5FF', fontSize: 20, fontWeight: '900' },
  floatingZoomLabel: { color: '#888', fontSize: 9.5, fontWeight: '800', paddingVertical: 2 },
  floatingZoomDivider: { width: '75%', height: 1, backgroundColor: '#262626' },
  searchSection: { marginBottom: 10 },
  searchBar: { flexDirection: 'row', borderRadius: 12, borderWidth: 1, alignItems: 'center', paddingHorizontal: 14, height: 50 },
  searchInput: { flex: 1, fontSize: 15 },
  searchAction: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  searchActionText: { fontSize: 12, fontWeight: '800' },
  recentsDropdown: { borderRadius: 12, borderWidth: 1, marginTop: 8, padding: 10, maxHeight: 180 },
  recentsHeader: { flexDirection: 'row', justifyContent: 'space-between', paddingBottom: 6, borderBottomWidth: 1 },
  recentsHeaderActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  recentsTitle: { fontSize: 10, fontWeight: '700', letterSpacing: 1 },
  clearRecentsBtn: { paddingHorizontal: 4, paddingVertical: 2 },
  clearRecentsText: { fontSize: 9.5, color: '#EF4444', fontWeight: '800', letterSpacing: 0.5 },
  closeRecentsText: { fontSize: 10, color: '#00E5FF', fontWeight: '700' },
  recentItemRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1 },
  recentItemContent: { flex: 1, flexDirection: 'row', alignItems: 'center', marginRight: 8 },
  recentPin: { fontSize: 14, marginRight: 10 },
  recentText: { fontSize: 13, fontWeight: '500' },
  removeRecentItemBtn: { padding: 4 },
  removeRecentItemText: { fontSize: 11, color: '#888', fontWeight: '800' },
  targetIndicator: { color: '#10B981', fontSize: 12, fontWeight: '600', marginTop: 8, marginLeft: 4 },
  debugLine: { color: '#888', fontSize: 10, marginTop: 6, marginLeft: 4, fontWeight: '600' },
  spacer: { flex: 1 },
  actionBtn: { height: 56, borderRadius: 14, justifyContent: 'center', alignItems: 'center' },
  startBtn: { backgroundColor: '#00E5FF' },
  stopBtn: { backgroundColor: '#EF4444' },
  actionBtnText: { color: '#000000', fontSize: 16, fontWeight: '900', letterSpacing: 1 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.65)', justifyContent: 'flex-end' },
  modalCard: { maxHeight: '75%', borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 32 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 14, borderBottomWidth: 1 },
  modalTitle: { fontSize: 16, fontWeight: '900', letterSpacing: 1.5 },
  modalSubtitle: { fontSize: 11, marginTop: 2 },
  modalHeaderActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  clearAllBtn: { paddingHorizontal: 8, paddingVertical: 4 },
  clearAllText: { color: '#EF4444', fontSize: 12, fontWeight: '700' },
  closeModalBtn: { width: 28, height: 28, borderRadius: 14, justifyContent: 'center', alignItems: 'center' },
  closeModalBtnText: { fontSize: 12, fontWeight: '700' },
  emptyTripsContainer: { paddingVertical: 40, alignItems: 'center' },
  emptyTripsText: { fontSize: 13, textAlign: 'center', lineHeight: 20, paddingHorizontal: 20 },
  tripCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, borderBottomWidth: 1 },
  tripInfo: { flex: 1, marginRight: 10 },
  tripDestination: { fontSize: 14, fontWeight: '700', marginBottom: 4 },
  tripMeta: { fontSize: 12 },
  tripSpeedMeta: { fontSize: 11, color: '#00E5FF', fontWeight: '800', marginTop: 3 },
  deleteTripBtn: { padding: 8 },
  deleteTripText: { fontSize: 16 },
  splashOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#050505',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 9999,
  },
  splashCenter: { alignItems: 'center', justifyContent: 'center' },
  splashChevron: { color: '#00E5FF', fontSize: 34, marginBottom: 14 },
  splashTitle: { color: '#FFFFFF', fontSize: 20, fontWeight: '800', letterSpacing: 6 },
  // Map-first visual system: display-only overrides, no navigation handlers changed.
  content: { flex: 1, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 12 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 },
  brandGroup: { flexShrink: 1 },
  brandEyebrow: { fontSize: 9, fontWeight: '700', letterSpacing: 1.7, marginBottom: 2 },
  appTitle: { fontSize: 26, fontWeight: '800', letterSpacing: -0.8 },
  brandDot: { color: '#57BBD5' },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  headerIconBtn: { width: 38, height: 38, borderWidth: 1, borderRadius: 13, justifyContent: 'center', alignItems: 'center' },
  headerIconText: { fontSize: 14, fontWeight: '800', textAlign: 'center', includeFontPadding: false },
  statusBadge: { flexDirection: 'row', alignItems: 'center', borderRadius: 13, borderWidth: 1, paddingHorizontal: 10, height: 38, maxWidth: 105 },
  statusText: { fontSize: 11, fontWeight: '700' },
  statusDot: { height: 7, width: 7, borderRadius: 4, marginRight: 6, backgroundColor: '#8C9CAC' },
  statusDotConnected: { backgroundColor: '#42C6A0' },
  statusTextConnected: { color: '#42C6A0' },
  heroSearchSection: { marginBottom: 12 },
  searchBar: { height: 56, borderRadius: 17, borderWidth: 1, flexDirection: 'row', alignItems: 'center', paddingLeft: 15, paddingRight: 5 },
  searchGlyph: { fontSize: 25, color: '#7991A3', marginRight: 10 },
  searchInput: { flex: 1, fontSize: 15, paddingVertical: 0, minWidth: 0 },
  searchAction: { height: 44, minWidth: 75, backgroundColor: '#287E9E', borderRadius: 12, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 12 },
  searchActionText: { fontSize: 13, fontWeight: '700', color: '#FFFFFF' },
  metricsCard: { flexDirection: 'row', borderRadius: 17, paddingVertical: 12, paddingHorizontal: 8, borderWidth: 1, marginBottom: 12, minHeight: 79 },
  primaryMetric: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  secondaryMetric: { flex: 0.95, alignItems: 'center', justifyContent: 'center' },
  verticalDivider: { width: 1, alignSelf: 'center', height: '65%' },
  metricLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 1.1, marginBottom: 5 },
  metricSpeedValue: { fontSize: 23, fontWeight: '800' },
  metricValueLarge: { fontSize: 22, fontWeight: '800' },
  metricValue: { fontSize: 14, fontWeight: '700' },
  secondaryDetail: { fontSize: 10, marginTop: 3 },
  unit: { fontSize: 10, color: '#8B99A8', fontWeight: '600' },
  mapContainer: { flex: 1, minHeight: 190, borderRadius: 20, overflow: 'hidden', borderWidth: 1, marginBottom: 12, position: 'relative' },
  recenterBtn: { position: 'absolute', right: 12, top: 12, width: 42, height: 42, backgroundColor: 'rgba(18,29,42,0.95)', borderRadius: 13, borderWidth: 1, borderColor: '#3E5162', justifyContent: 'center', alignItems: 'center', zIndex: 999, elevation: 6 },
  floatingZoomContainer: { position: 'absolute', right: 12, bottom: 12, backgroundColor: 'rgba(18,29,42,0.95)', borderRadius: 13, borderWidth: 1, borderColor: '#3E5162', alignItems: 'center', overflow: 'hidden', zIndex: 999, elevation: 6 },
  floatingZoomBtn: { width: 44, height: 40, alignItems: 'center', justifyContent: 'center' },
  floatingZoomText: { color: '#D7EDF8', fontSize: 24, fontWeight: '500' },
  floatingZoomLabel: { color: '#D7EDF8', fontSize: 11, fontWeight: '800', paddingVertical: 5 },
  utilityRow: { flexDirection: 'row', gap: 10, marginBottom: 12 },
  utilityButton: { flex: 1, height: 44, borderRadius: 13, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  utilityText: { fontSize: 12, fontWeight: '700', flexShrink: 1, includeFontPadding: false },
  utilityInner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingHorizontal: 7 },
  utilityIconBox: { width: 24, height: 24, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  utilityIconText: { fontSize: 12, fontWeight: '800', includeFontPadding: false, textAlign: 'center' },
  spacer: { flex: 0 },
  actionBtn: { height: 56, borderRadius: 16, justifyContent: 'center', alignItems: 'center' },
  startBtn: { backgroundColor: '#287E9E' },
  stopBtn: { backgroundColor: '#AD4550' },
  actionBtnText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800', letterSpacing: 0.7 },

});