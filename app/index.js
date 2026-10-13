import React, { useState, useEffect, useRef } from 'react';
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
  useColorScheme
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BleManager } from 'react-native-ble-plx';
import * as Location from 'expo-location';
import { useKeepAwake } from 'expo-keep-awake';
import { encode } from 'base-64';

const SERVICE_UUID = "4fafc201-1fb5-459e-8fcc-c5c9c331914b";
const CHARACTERISTIC_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a8";
const STORAGE_KEY_RECENTS = "@navpod_recents";
const STORAGE_KEY_TRIPS = "@navpod_saved_trips";
const STORAGE_KEY_FACE = "@navpod_face_mode";
const USER_AGENT_HEADER = { 'User-Agent': 'NavPodCompanion/1.0' };

export default function Page() {
  // Prevent phone from sleeping while mounted on scooter or in apron/pocket
  useKeepAwake();

  const systemScheme = useColorScheme();
  const [themeMode, setThemeMode] = useState(systemScheme || 'dark');
  const isDark = themeMode === 'dark';

  // Minimalist Intro State
  const [showSplash, setShowSplash] = useState(true);
  const introFade = useRef(new Animated.Value(1)).current;
  const logoScale = useRef(new Animated.Value(0.85)).current;
  const logoOpacity = useRef(new Animated.Value(0)).current;

  const [status, setStatus] = useState("Disconnected");
  const [turnDistance, setTurnDistance] = useState(0);
  const [navState, setNavState] = useState("IDLE");

  // Nav Face: 0 = Map + vectors, 1 = Turn Arrow Only
  const [navFace, setNavFace] = useState(0);

  const [searchQuery, setSearchQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [destCoords, setDestCoords] = useState(null);
  const [resolvedPlace, setResolvedPlace] = useState("");
  const [recentLocations, setRecentLocations] = useState([]);
  const [showRecents, setShowRecents] = useState(false);

  // Saved Rides
  const [savedTrips, setSavedTrips] = useState([]);
  const [showTripsModal, setShowTripsModal] = useState(false);

  // Live Telemetry
  const [currentSpeedKmh, setCurrentSpeedKmh] = useState(0);
  const [rideSeconds, setRideSeconds] = useState(0);
  const [totalMetersTraveled, setTotalMetersTraveled] = useState(0);

  const timerIntervalRef = useRef(null);
  const rideSecondsRef = useRef(0);
  const totalMetersRef = useRef(0);
  const lastPositionRef = useRef(null);
  const destCoordsRef = useRef(null);
  const navStateRef = useRef("IDLE");

  // Auto-Reroute Tracker Refs
  const offRouteCountRef = useRef(0);
  const isReroutingRef = useRef(false);
  const lastRerouteTimeRef = useRef(0);

  const webViewRef = useRef(null);
  const managerRef = useRef(null);
  const activeDeviceRef = useRef(null);
  const disconnectSubscriptionRef = useRef(null);
  const locationSubRef = useRef(null);
  const headingSubRef = useRef(null);
  const currentLocationRef = useRef(null);
  const headingRef = useRef(0);
  const activeRouteCoords = useRef([]);
  const intersectionsRef = useRef([]);

  useEffect(() => {
    destCoordsRef.current = destCoords;
  }, [destCoords]);

  useEffect(() => {
    navStateRef.current = navState;
  }, [navState]);

  useEffect(() => {
    runIntroSequence();
    loadRecentLocations();
    loadSavedTrips();
    loadNavFaceSetting();
    initApp();

    return () => {
      if (disconnectSubscriptionRef.current) disconnectSubscriptionRef.current.remove();
      if (locationSubRef.current) locationSubRef.current.remove();
      if (headingSubRef.current) headingSubRef.current.remove();
      if (managerRef.current) managerRef.current.destroy();
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    };
  }, []);

  const runIntroSequence = () => {
    Animated.parallel([
      Animated.timing(logoOpacity, {
        toValue: 1,
        duration: 500,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(logoScale, {
        toValue: 1,
        duration: 700,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();

    setTimeout(() => {
      Animated.timing(introFade, {
        toValue: 0,
        duration: 400,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      }).start(() => {
        setShowSplash(false);
      });
    }, 1100);
  };

  const loadNavFaceSetting = async () => {
    try {
      const val = await AsyncStorage.getItem(STORAGE_KEY_FACE);
      if (val !== null) setNavFace(parseInt(val, 10));
    } catch (e) {}
  };

  const toggleNavFace = async () => {
    const nextFace = navFace === 0 ? 1 : 0;
    setNavFace(nextFace);
    await AsyncStorage.setItem(STORAGE_KEY_FACE, nextFace.toString());
    sendNavFaceCommand(nextFace);
  };

  const sendNavFaceCommand = async (faceId) => {
    if (!activeDeviceRef.current) return;
    const payload = new Uint8Array([0x03, faceId]);
    let binary = String.fromCharCode(payload[0]) + String.fromCharCode(payload[1]);
    try {
      await activeDeviceRef.current.writeCharacteristicWithoutResponseForService(
        SERVICE_UUID,
        CHARACTERISTIC_UUID,
        encode(binary)
      );
    } catch (e) {}
  };

  const toggleTheme = () => {
    setThemeMode((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  const loadRecentLocations = async () => {
    try {
      const data = await AsyncStorage.getItem(STORAGE_KEY_RECENTS);
      if (data) setRecentLocations(JSON.parse(data));
    } catch (e) {
      console.warn("Failed to load recents", e);
    }
  };

  const saveRecentLocation = async (item) => {
    try {
      const updated = [item, ...recentLocations.filter((r) => r.name !== item.name)].slice(0, 5);
      setRecentLocations(updated);
      await AsyncStorage.setItem(STORAGE_KEY_RECENTS, JSON.stringify(updated));
    } catch (e) {
      console.warn("Failed to save recent", e);
    }
  };

  const loadSavedTrips = async () => {
    try {
      const data = await AsyncStorage.getItem(STORAGE_KEY_TRIPS);
      if (data) setSavedTrips(JSON.parse(data));
    } catch (e) {
      console.warn("Failed to load saved trips", e);
    }
  };

  const persistTripRecord = async (durationSec, meters, placeName, coords) => {
    try {
      const newTrip = {
        id: Date.now().toString(),
        destination: placeName || "Destination",
        coords: coords || null,
        date: new Date().toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        }),
        durationSec,
        meters,
      };
      const updated = [newTrip, ...savedTrips];
      setSavedTrips(updated);
      await AsyncStorage.setItem(STORAGE_KEY_TRIPS, JSON.stringify(updated));
    } catch (e) {
      console.warn("Failed to record trip", e);
    }
  };

  const deleteTrip = (tripId) => {
    Alert.alert("Delete Trip", "Remove this trip from your logs?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          const updated = savedTrips.filter((t) => t.id !== tripId);
          setSavedTrips(updated);
          await AsyncStorage.setItem(STORAGE_KEY_TRIPS, JSON.stringify(updated));
        },
      },
    ]);
  };

  const clearAllTrips = () => {
    Alert.alert("Clear History", "Permanently remove all recorded trips?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear All",
        style: "destructive",
        onPress: async () => {
          setSavedTrips([]);
          await AsyncStorage.removeItem(STORAGE_KEY_TRIPS);
        },
      },
    ]);
  };

  const initApp = async () => {
    try {
      if (Platform.OS === 'android') {
        const granted = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        ]);

        const fineLoc = granted[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
        if (fineLoc !== PermissionsAndroid.RESULTS.GRANTED) {
          Alert.alert("Permission Required", "Location access is needed for routing.");
          return;
        }
      }

      if (!managerRef.current) {
        managerRef.current = new BleManager();
      }

      const { status: locStatus } = await Location.requestForegroundPermissionsAsync();
      if (locStatus === 'granted') {
        headingSubRef.current = await Location.watchHeadingAsync((data) => {
          const h = data.trueHeading || data.magHeading || 0;
          headingRef.current = h;
          if (activeDeviceRef.current && activeRouteCoords.current.length > 0) {
            processAndStreamVectors();
          }
        });

        locationSubRef.current = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.High,
            distanceInterval: 1,
            timeInterval: 1000,
          },
          (loc) => {
            currentLocationRef.current = loc.coords;
            updateMapUser(loc.coords.latitude, loc.coords.longitude);

            const rawSpeedMps = loc.coords.speed;
            if (rawSpeedMps && rawSpeedMps > 0.3) {
              setCurrentSpeedKmh(Math.round(rawSpeedMps * 3.6));
            } else {
              setCurrentSpeedKmh(0);
            }

            const currentNav = navStateRef.current;
            const curDest = destCoordsRef.current;

            if (lastPositionRef.current && currentNav === "NAVIGATING") {
              const dLat = (loc.coords.latitude - lastPositionRef.current.latitude) * 110540;
              const dLon = (loc.coords.longitude - lastPositionRef.current.longitude) * 
                           (111320 * Math.cos((loc.coords.latitude * Math.PI) / 180.0));
              const deltaDist = Math.hypot(dLat, dLon);
              if (deltaDist > 1 && deltaDist < 100) {
                totalMetersRef.current += Math.round(deltaDist);
                setTotalMetersTraveled(totalMetersRef.current);
              }
            }
            lastPositionRef.current = loc.coords;

            if (currentNav === "NAVIGATING") {
              // Scooter Arrival Check (25 meters)
              if (curDest) {
                const endLatDist = (curDest.latitude - loc.coords.latitude) * 110540;
                const endLonDist = (curDest.longitude - loc.coords.longitude) * 
                                   (111320 * Math.cos((loc.coords.latitude * Math.PI) / 180.0));
                if (Math.hypot(endLatDist, endLonDist) < 25) {
                  stopNavigation(true);
                  return;
                }
              }

              // Off-Route Reroute Check (45-meter corridor)
              const coords = activeRouteCoords.current;
              if (coords.length > 0) {
                let minDeviationMeters = Infinity;
                const latConv = 110540;
                const lonConv = 111320 * Math.cos((loc.coords.latitude * Math.PI) / 180.0);

                for (let i = 0; i < coords.length; i++) {
                  const dX = (coords[i][0] - loc.coords.longitude) * lonConv;
                  const dY = (coords[i][1] - loc.coords.latitude) * latConv;
                  const d = Math.hypot(dX, dY);
                  if (d < minDeviationMeters) {
                    minDeviationMeters = d;
                  }
                }

                if (minDeviationMeters > 45) {
                  offRouteCountRef.current += 1;
                  if (offRouteCountRef.current >= 3 && !isReroutingRef.current) {
                    triggerAutoReroute(loc.coords.latitude, loc.coords.longitude);
                  }
                } else {
                  offRouteCountRef.current = 0;
                }
              }

              processAndStreamVectors();
            }
          }
        );
      }
    } catch (err) {
      console.warn("Init error:", err);
    }
  };

  const triggerAutoReroute = async (curLat, curLon) => {
    const curDest = destCoordsRef.current;
    if (!curDest || isReroutingRef.current) return;

    const now = Date.now();
    if (now - lastRerouteTimeRef.current < 8000) return;

    isReroutingRef.current = true;
    lastRerouteTimeRef.current = now;

    const url = `https://router.project-osrm.org/route/v1/driving/${curLon},${curLat};${curDest.longitude},${curDest.latitude}?overview=full&geometries=geojson&steps=true`;

    try {
      const res = await fetch(url, { headers: USER_AGENT_HEADER });
      const data = await res.json();

      if (data.routes && data.routes.length > 0) {
        const route = data.routes[0];
        activeRouteCoords.current = route.geometry.coordinates;

        const leafCoords = route.geometry.coordinates.map((pt) => [pt[1], pt[0]]);
        updateMapRoute(leafCoords, curDest.latitude, curDest.longitude);

        const stubs = [];
        route.legs[0].steps.forEach((step) => {
          if (step.intersections) {
            step.intersections.forEach((inter) => {
              stubs.push({
                location: inter.location,
                bearings: inter.bearings ? inter.bearings.filter((b) => b !== inter.out) : [],
              });
            });
          }
        });
        intersectionsRef.current = stubs;

        offRouteCountRef.current = 0;
        processAndStreamVectors();
      }
    } catch (err) {
      console.warn("Auto-reroute failed:", err);
    } finally {
      isReroutingRef.current = false;
    }
  };

  const updateMapUser = (lat, lon) => {
    if (webViewRef.current) {
      webViewRef.current.injectJavaScript(`if (window.setUserLocation) { setUserLocation(${lat}, ${lon}); } true;`);
    }
  };

  const updateMapRoute = (coords, destLat, destLon) => {
    if (webViewRef.current) {
      const jsonStr = JSON.stringify(coords);
      webViewRef.current.injectJavaScript(`if (window.drawRoute) { drawRoute(${jsonStr}, ${destLat}, ${destLon}); } true;`);
    }
  };

  const selectQuickLocation = (loc) => {
    setDestCoords({ latitude: loc.latitude, longitude: loc.longitude });
    setResolvedPlace(loc.name);
    setShowRecents(false);
    setShowTripsModal(false);
    Keyboard.dismiss();

    if (webViewRef.current) {
      webViewRef.current.injectJavaScript(`if (window.setDestinationPin) { setDestinationPin(${loc.latitude}, ${loc.longitude}); } true;`);
    }
  };

  const searchPlaceByName = async () => {
    if (!searchQuery.trim()) return;

    setIsSearching(true);
    setShowRecents(false);
    Keyboard.dismiss();

    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
        searchQuery
      )}&limit=1`;

      const res = await fetch(url, { headers: USER_AGENT_HEADER });
      const data = await res.json();

      if (data && data.length > 0) {
        const firstMatch = data[0];
        const lat = parseFloat(firstMatch.lat);
        const lon = parseFloat(firstMatch.lon);
        const placeName = firstMatch.display_name.split(',')[0];

        setDestCoords({ latitude: lat, longitude: lon });
        setResolvedPlace(placeName);

        saveRecentLocation({ name: placeName, latitude: lat, longitude: lon });

        if (webViewRef.current) {
          webViewRef.current.injectJavaScript(`if (window.setDestinationPin) { setDestinationPin(${lat}, ${lon}); } true;`);
        }
      } else {
        Alert.alert("Location Not Found", "Try typing a nearby major landmark or street.");
      }
    } catch (e) {
      Alert.alert("Network Error", "Unable to reach search service.");
    } finally {
      setIsSearching(false);
    }
  };

  const startNavigation = async () => {
    if (!currentLocationRef.current) {
      Alert.alert("GPS Pending", "Waiting for GPS satellite lock...");
      return;
    }

    if (!destCoords) {
      Alert.alert("No Destination", "Search for a destination first.");
      return;
    }

    setNavState("FETCHING");
    const myLon = currentLocationRef.current.longitude;
    const myLat = currentLocationRef.current.latitude;

    const url = `https://router.project-osrm.org/route/v1/driving/${myLon},${myLat};${destCoords.longitude},${destCoords.latitude}?overview=full&geometries=geojson&steps=true`;

    try {
      const res = await fetch(url, { headers: USER_AGENT_HEADER });
      const data = await res.json();

      if (data.routes && data.routes.length > 0) {
        const route = data.routes[0];
        activeRouteCoords.current = route.geometry.coordinates;

        const leafCoords = route.geometry.coordinates.map((pt) => [pt[1], pt[0]]);
        updateMapRoute(leafCoords, destCoords.latitude, destCoords.longitude);

        const stubs = [];
        route.legs[0].steps.forEach((step) => {
          if (step.intersections) {
            step.intersections.forEach((inter) => {
              stubs.push({
                location: inter.location,
                bearings: inter.bearings ? inter.bearings.filter((b) => b !== inter.out) : [],
              });
            });
          }
        });
        intersectionsRef.current = stubs;

        setRideSeconds(0);
        rideSecondsRef.current = 0;
        totalMetersRef.current = 0;
        setTotalMetersTraveled(0);

        if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = setInterval(() => {
          rideSecondsRef.current += 1;
          setRideSeconds(rideSecondsRef.current);
        }, 1000);

        setNavState("NAVIGATING");
        sendNavFaceCommand(navFace);
        processAndStreamVectors();
      } else {
        Alert.alert("Route Error", "No drivable route found.");
        setNavState("IDLE");
      }
    } catch (e) {
      Alert.alert("Routing Failed", "Check internet connection.");
      setNavState("IDLE");
    }
  };

  const stopNavigation = (isAutoReached = false) => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    setNavState("IDLE");
    activeRouteCoords.current = [];

    if (webViewRef.current) {
      webViewRef.current.injectJavaScript(`if (window.clearRoute) { clearRoute(); } true;`);
    }

    const finalSecs = rideSecondsRef.current;
    const finalMeters = totalMetersRef.current;

    if (finalSecs > 10 || finalMeters > 50) {
      persistTripRecord(finalSecs, finalMeters, resolvedPlace, destCoordsRef.current);
    }

    sendCompletionSummaryPacket(finalSecs, finalMeters);

    Alert.alert(
      isAutoReached ? "Destination Reached" : "Trip Ended",
      `Duration: ${formatDuration(finalSecs)}\nDistance: ${(finalMeters / 1000).toFixed(2)} km`
    );
  };

  const sendCompletionSummaryPacket = async (seconds, meters) => {
    if (!activeDeviceRef.current) return;

    const payload = new Uint8Array(5);
    payload[0] = 0xFF;
    payload[1] = (seconds >> 8) & 0xFF;
    payload[2] = seconds & 0xFF;
    payload[3] = (meters >> 8) & 0xFF;
    payload[4] = meters & 0xFF;

    let binary = '';
    for (let i = 0; i < payload.byteLength; i++) {
      binary += String.fromCharCode(payload[i]);
    }

    try {
      await activeDeviceRef.current.writeCharacteristicWithoutResponseForService(
        SERVICE_UUID,
        CHARACTERISTIC_UUID,
        encode(binary)
      );
    } catch (e) {}
  };

  const formatDuration = (totalSec) => {
    const minutes = Math.floor(totalSec / 60);
    const seconds = totalSec % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };

  const processAndStreamVectors = () => {
    if (!activeDeviceRef.current || !currentLocationRef.current) return;

    const myLat = currentLocationRef.current.latitude;
    const myLon = currentLocationRef.current.longitude;
    const currentHeading = headingRef.current;
    const coords = activeRouteCoords.current;

    if (coords.length === 0) return;

    let nearestIdx = 0;
    let minDist = Infinity;
    for (let i = 0; i < coords.length; i++) {
      const d = Math.hypot(coords[i][1] - myLat, coords[i][0] - myLon);
      if (d < minDist) {
        minDist = d;
        nearestIdx = i;
      }
    }

    const latConversion = 110540;
    const lonConversion = 111320 * Math.cos((myLat * Math.PI) / 180.0);

    const upcomingPointsMeters = [{ x: 0, y: 0 }];

    for (let i = nearestIdx; i < Math.min(nearestIdx + 25, coords.length); i++) {
      const dX = (coords[i][0] - myLon) * lonConversion;
      const dY = (coords[i][1] - myLat) * latConversion;
      upcomingPointsMeters.push({ x: dX, y: dY });
    }

    let distToTurn = 150;
    if (upcomingPointsMeters.length > 2) {
      distToTurn = Math.round(
        Math.hypot(upcomingPointsMeters[1].x, upcomingPointsMeters[1].y)
      );
    }
    setTurnDistance(distToTurn);

    let turnManeuver = 0;
    if (upcomingPointsMeters.length >= 3) {
      let idxTarget = 1;
      while (idxTarget < upcomingPointsMeters.length - 1 && 
             Math.hypot(upcomingPointsMeters[idxTarget].x, upcomingPointsMeters[idxTarget].y) < 8) {
        idxTarget++;
      }

      const p1 = upcomingPointsMeters[idxTarget];
      const p2 = upcomingPointsMeters[Math.min(idxTarget + 2, upcomingPointsMeters.length - 1)];

      const ang1 = Math.atan2(p1.x, p1.y);
      const ang2 = Math.atan2(p2.x - p1.x, p2.y - p1.y);
      let diff = ((ang2 - ang1) * 180) / Math.PI;
      while (diff < -180) diff += 360;
      while (diff > 180) diff -= 360;

      if (diff < -65) turnManeuver = -2;
      else if (diff < -22) turnManeuver = -1;
      else if (diff > 65) turnManeuver = 2;
      else if (diff > 22) turnManeuver = 1;
      else turnManeuver = 0;
    }

    const upcomingStubs = [];
    intersectionsRef.current.forEach((inter) => {
      const dX = (inter.location[0] - myLon) * lonConversion;
      const dY = (inter.location[1] - myLat) * latConversion;

      if (Math.hypot(dX, dY) < 140 && upcomingStubs.length < 8) {
        inter.bearings.forEach((bearing) => {
          if (upcomingStubs.length < 8) {
            const rad = (bearing * Math.PI) / 180.0;
            upcomingStubs.push({
              x1: dX,
              y1: dY,
              x2: dX + Math.sin(rad) * 22,
              y2: dY + Math.cos(rad) * 22,
            });
          }
        });
      }
    });

    streamCourseUpPacket(upcomingPointsMeters, upcomingStubs, currentHeading, distToTurn, turnManeuver);
  };

  const streamCourseUpPacket = async (points, stubs, currentHeading, distToTurn, turnManeuver) => {
    if (!activeDeviceRef.current) return;

    const rad = (currentHeading * Math.PI) / 180.0;
    const cosH = Math.cos(rad);
    const sinH = Math.sin(rad);
    const scale = 0.8;

    const numPoints = Math.min(points.length, 30);
    const numStubs = Math.min(stubs.length, 10);

    const payload = new Uint8Array(6 + numPoints * 2 + numStubs * 4);
    payload[0] = 0x01;
    payload[1] = numPoints;
    payload[2] = numStubs;
    payload[3] = (distToTurn >> 8) & 0xFF;
    payload[4] = distToTurn & 0xFF;
    payload[5] = turnManeuver < 0 ? 256 + turnManeuver : turnManeuver;

    let idx = 6;

    for (let i = 0; i < numPoints; i++) {
      const rx = points[i].x * cosH - points[i].y * sinH;
      const ry = points[i].x * sinH + points[i].y * cosH;
      const px = Math.max(-80, Math.min(80, Math.round(rx * scale)));
      const py = Math.max(-100, Math.min(120, Math.round(ry * scale)));

      payload[idx++] = px < 0 ? 256 + px : px;
      payload[idx++] = py < 0 ? 256 + py : py;
    }

    for (let i = 0; i < numStubs; i++) {
      const rx1 = stubs[i].x1 * cosH - stubs[i].y1 * sinH;
      const ry1 = stubs[i].x1 * sinH + stubs[i].y1 * cosH;
      const rx2 = stubs[i].x2 * cosH - stubs[i].y2 * sinH;
      const ry2 = stubs[i].x2 * sinH + stubs[i].y2 * cosH;

      const px1 = Math.max(-80, Math.min(80, Math.round(rx1 * scale)));
      const py1 = Math.max(-100, Math.min(120, Math.round(ry1 * scale)));
      const px2 = Math.max(-80, Math.min(80, Math.round(rx2 * scale)));
      const py2 = Math.max(-100, Math.min(120, Math.round(ry2 * scale)));

      payload[idx++] = px1 < 0 ? 256 + px1 : px1;
      payload[idx++] = py1 < 0 ? 256 + py1 : py1;
      payload[idx++] = px2 < 0 ? 256 + px2 : px2;
      payload[idx++] = py2 < 0 ? 256 + py2 : py2;
    }

    let binary = '';
    for (let i = 0; i < payload.byteLength; i++) {
      binary += String.fromCharCode(payload[i]);
    }

    try {
      await activeDeviceRef.current.writeCharacteristicWithoutResponseForService(
        SERVICE_UUID,
        CHARACTERISTIC_UUID,
        encode(binary)
      );
    } catch (e) {}
  };

  const connectToNavPod = () => {
    if (!managerRef.current) return;

    setStatus("Searching");
    managerRef.current.startDeviceScan(null, null, (error, scannedDevice) => {
      if (error) {
        setStatus("Offline");
        return;
      }
      if (scannedDevice && scannedDevice.name === "ESP32-NAV-POD") {
        managerRef.current.stopDeviceScan();
        setStatus("Pairing");
        scannedDevice
          .connect()
          .then((dev) => dev.discoverAllServicesAndCharacteristics())
          .then((dev) => {
            activeDeviceRef.current = dev;
            setStatus("Connected");

            if (disconnectSubscriptionRef.current) {
              disconnectSubscriptionRef.current.remove();
            }
            disconnectSubscriptionRef.current = dev.onDisconnected(() => {
              activeDeviceRef.current = null;
              setStatus("Disconnected");
            });

            sendNavFaceCommand(navFace);
          })
          .catch(() => {
            setStatus("Disconnected");
          });
      }
    });
  };

  const isConnected = status === "Connected";

  const leafletHTML = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
      <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
      <style>
        body, html, #map { margin: 0; padding: 0; width: 100%; height: 100%; }
        .leaflet-control-attribution { display: none !important; }

        body.dark-mode { background: #0a0a0a; }
        body.dark-mode .leaflet-tile {
          filter: brightness(0.6) invert(1) contrast(3) hue-rotate(200deg) saturate(0.3) brightness(0.7);
        }

        body.light-mode { background: #f6f7f9; }
        body.light-mode .leaflet-tile {
          filter: saturate(0.85) contrast(1.05);
        }
      </style>
    </head>
    <body class="${isDark ? 'dark-mode' : 'light-mode'}">
      <div id="map"></div>
      <script>
        var map = L.map('map', { zoomControl: false, preferCanvas: true }).setView([17.3850, 78.4867], 14);

        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19
        }).addTo(map);

        var userMarker = null;
        var destMarker = null;
        var routeLine = null;

        function setUserLocation(lat, lon) {
          if (!userMarker) {
            userMarker = L.circleMarker([lat, lon], { radius: 7, color: '#00E5FF', fillColor: '#00E5FF', fillOpacity: 1, weight: 3 }).addTo(map);
            map.setView([lat, lon], 15);
          } else {
            userMarker.setLatLng([lat, lon]);
          }
        }

        function setDestinationPin(lat, lon) {
          if (destMarker) map.removeLayer(destMarker);
          destMarker = L.circleMarker([lat, lon], { radius: 8, color: '#FF1744', fillColor: '#FF1744', fillOpacity: 1, weight: 3 }).addTo(map);
          if (userMarker) {
            map.fitBounds(L.latLngBounds([userMarker.getLatLng(), [lat, lon]]), { padding: [40, 40] });
          } else {
            map.setView([lat, lon], 15);
          }
        }

        function drawRoute(coords, destLat, destLon) {
          if (routeLine) map.removeLayer(routeLine);
          setDestinationPin(destLat, destLon);
          routeLine = L.polyline(coords, { color: '#00E5FF', weight: 5, opacity: 0.95, lineJoin: 'round' }).addTo(map);
          map.fitBounds(routeLine.getBounds(), { padding: [40, 40] });
        }

        function clearRoute() {
          if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
          if (destMarker) { map.removeLayer(destMarker); destMarker = null; }
        }
      </script>
    </body>
    </html>
  `;

  const palette = {
    bg: isDark ? '#050505' : '#F6F7F9',
    card: isDark ? '#0F0F0F' : '#FFFFFF',
    border: isDark ? '#1C1C1C' : '#E2E4E8',
    textMain: isDark ? '#FFFFFF' : '#111827',
    textMuted: isDark ? '#666666' : '#8B949E',
    label: isDark ? '#555555' : '#6B7280',
    inputBg: isDark ? '#121212' : '#FFFFFF',
    searchBtn: isDark ? '#222222' : '#ECEFF2',
    searchBtnText: isDark ? '#FFFFFF' : '#111827',
    recentsBg: isDark ? '#111111' : '#FFFFFF',
    recentItemBorder: isDark ? '#1A1A1A' : '#F0F2F5',
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: palette.bg }]}>
      <StatusBar 
        barStyle={isDark ? "light-content" : "dark-content"} 
        backgroundColor={palette.bg} 
      />

      <View style={styles.content}>
        
        {/* Header Bar */}
        <View style={styles.header}>
          <Text style={[styles.appTitle, { color: palette.textMain }]}>NAV POD</Text>
          <View style={styles.headerRight}>
            
            <TouchableOpacity 
              style={[styles.faceBadge, { backgroundColor: palette.card, borderColor: palette.border }]} 
              onPress={toggleNavFace}
            >
              <Text style={styles.faceBadgeText}>{navFace === 0 ? '🗺️ MAP' : '↗️ TURN'}</Text>
            </TouchableOpacity>

            <TouchableOpacity 
              style={[styles.headerIconBtn, { backgroundColor: palette.card, borderColor: palette.border }]} 
              onPress={() => setShowTripsModal(true)}
            >
              <Text style={styles.headerIconText}>📋</Text>
            </TouchableOpacity>

            <TouchableOpacity 
              style={[styles.headerIconBtn, { backgroundColor: palette.card, borderColor: palette.border }]} 
              onPress={toggleTheme}
            >
              <Text style={styles.headerIconText}>{isDark ? '☀️' : '🌙'}</Text>
            </TouchableOpacity>

            <TouchableOpacity 
              style={[
                styles.statusBadge, 
                { backgroundColor: palette.card, borderColor: palette.border },
                isConnected && styles.statusBadgeConnected
              ]} 
              onPress={connectToNavPod}
              disabled={isConnected}
            >
              <View style={[styles.statusDot, isConnected && styles.statusDotConnected]} />
              <Text style={[styles.statusText, isConnected && styles.statusTextConnected]}>
                {status}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Scooter Live Telemetry Row */}
        <View style={[styles.metricsCard, { backgroundColor: palette.card, borderColor: palette.border }]}>
          <View style={styles.metricItem}>
            <Text style={[styles.metricLabel, { color: palette.label }]}>SPEED</Text>
            <Text style={styles.metricSpeedValue}>
              {currentSpeedKmh} <Text style={styles.unit}>km/h</Text>
            </Text>
          </View>
          <View style={[styles.verticalDivider, { backgroundColor: palette.border }]} />
          <View style={styles.metricItem}>
            <Text style={[styles.metricLabel, { color: palette.label }]}>RIDE TIME</Text>
            <Text style={styles.metricValueLarge}>{formatDuration(rideSeconds)}</Text>
          </View>
          <View style={[styles.verticalDivider, { backgroundColor: palette.border }]} />
          <View style={styles.metricItem}>
            <Text style={[styles.metricLabel, { color: palette.label }]}>DISTANCE</Text>
            <Text style={[styles.metricValue, { color: palette.textMain }]}>
              {(totalMetersTraveled / 1000).toFixed(1)} <Text style={styles.unit}>km</Text>
            </Text>
          </View>
          <View style={[styles.verticalDivider, { backgroundColor: palette.border }]} />
          <View style={styles.metricItem}>
            <Text style={[styles.metricLabel, { color: palette.label }]}>NEXT TURN</Text>
            <Text style={[styles.metricValue, { color: palette.textMain }]}>
              {turnDistance} <Text style={styles.unit}>m</Text>
            </Text>
          </View>
        </View>

        {/* Map Preview */}
        <View style={[styles.mapContainer, { borderColor: palette.border }]}>
          <WebView
            key={themeMode}
            ref={webViewRef}
            originWhitelist={['*']}
            source={{ html: leafletHTML }}
            style={styles.map}
            scrollEnabled={false}
          />
        </View>

        {/* Search Bar & Recents */}
        <View style={styles.searchSection}>
          <View style={[styles.searchBar, { backgroundColor: palette.inputBg, borderColor: palette.border }]}>
            <TextInput
              style={[styles.searchInput, { color: palette.textMain }]}
              value={searchQuery}
              onChangeText={setSearchQuery}
              onFocus={() => setShowRecents(true)}
              placeholder="Search destination..."
              placeholderTextColor={palette.textMuted}
              returnKeyType="search"
              onSubmitEditing={searchPlaceByName}
            />
            <TouchableOpacity 
              style={[styles.searchAction, { backgroundColor: palette.searchBtn }]} 
              onPress={searchPlaceByName}
              disabled={isSearching}
            >
              {isSearching ? (
                <ActivityIndicator size="small" color={palette.searchBtnText} />
              ) : (
                <Text style={[styles.searchActionText, { color: palette.searchBtnText }]}>GO</Text>
              )}
            </TouchableOpacity>
          </View>

          {showRecents && recentLocations.length > 0 && (
            <View style={[styles.recentsDropdown, { backgroundColor: palette.recentsBg, borderColor: palette.border }]}>
              <View style={[styles.recentsHeader, { borderBottomColor: palette.border }]}>
                <Text style={[styles.recentsTitle, { color: palette.label }]}>RECENT PLACES</Text>
                <TouchableOpacity onPress={() => setShowRecents(false)}>
                  <Text style={styles.closeRecentsText}>HIDE</Text>
                </TouchableOpacity>
              </View>
              <FlatList
                data={recentLocations}
                keyExtractor={(item, idx) => idx.toString()}
                renderItem={({ item }) => (
                  <TouchableOpacity 
                    style={[styles.recentItem, { borderBottomColor: palette.recentItemBorder }]} 
                    onPress={() => selectQuickLocation(item)}
                  >
                    <Text style={styles.recentPin}>📍</Text>
                    <Text style={[styles.recentText, { color: palette.textMain }]} numberOfLines={1}>{item.name}</Text>
                  </TouchableOpacity>
                )}
              />
            </View>
          )}

          {resolvedPlace && !showRecents ? (
            <Text style={styles.targetIndicator} numberOfLines={1}>
              ● {resolvedPlace}
            </Text>
          ) : null}
        </View>

        <View style={styles.spacer} />

        {/* Glove-Friendly Large Action Button */}
        {navState === "NAVIGATING" ? (
          <TouchableOpacity 
            style={[styles.actionBtn, styles.stopBtn]} 
            onPress={() => stopNavigation(false)}
            activeOpacity={0.8}
          >
            <Text style={styles.actionBtnText}>END TRIP</Text>
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

        {/* Saved Trips Modal */}
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
                  <Text style={[styles.modalTitle, { color: palette.textMain }]}>SCOOTER RIDE LOGS</Text>
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
                      </TouchableOpacity>

                      <TouchableOpacity 
                        style={styles.deleteTripBtn}
                        onPress={() => deleteTrip(item.id)}
                      >
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

      {/* Minimalist Intro Overlay */}
      {showSplash && (
        <Animated.View style={[styles.splashOverlay, { opacity: introFade }]}>
          <Animated.View
            style={[
              styles.splashCenter,
              {
                opacity: logoOpacity,
                transform: [{ scale: logoScale }],
              },
            ]}
          >
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
  content: { flex: 1, paddingHorizontal: 18, paddingTop: 6, paddingBottom: 16 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  faceBadge: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  faceBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#00E5FF',
    letterSpacing: 0.5,
  },
  headerIconBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 18, borderWidth: 1, justifyContent: 'center', alignItems: 'center' },
  headerIconText: { fontSize: 14 },
  appTitle: { fontSize: 21, fontWeight: '900', letterSpacing: 2 },
  statusBadge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 20, borderWidth: 1 },
  statusBadgeConnected: { borderColor: '#00E5FF44', backgroundColor: '#00E5FF15' },
  statusDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#888', marginRight: 6 },
  statusDotConnected: { backgroundColor: '#00E5FF' },
  statusText: { color: '#888', fontSize: 11, fontWeight: '700' },
  statusTextConnected: { color: '#00E5FF' },
  metricsCard: { flexDirection: 'row', borderRadius: 14, paddingVertical: 12, paddingHorizontal: 6, borderWidth: 1, marginBottom: 14 },
  metricItem: { flex: 1, alignItems: 'center' },
  verticalDivider: { width: 1, height: '70%', alignSelf: 'center' },
  metricLabel: { fontSize: 8.5, fontWeight: '700', letterSpacing: 0.8, marginBottom: 4 },
  metricSpeedValue: { fontSize: 16, fontWeight: '900', color: '#00E5FF' },
  metricValueLarge: { fontSize: 15, fontWeight: '800', color: '#F59E0B' },
  metricValue: { fontSize: 15, fontWeight: '700' },
  unit: { fontSize: 9.5, color: '#888', fontWeight: '500' },
  mapContainer: { height: 210, borderRadius: 14, overflow: 'hidden', borderWidth: 1, marginBottom: 14 },
  map: { flex: 1 },
  searchSection: { marginBottom: 10 },
  searchBar: { flexDirection: 'row', borderRadius: 12, borderWidth: 1, alignItems: 'center', paddingHorizontal: 14, height: 50 },
  searchInput: { flex: 1, fontSize: 15 },
  searchAction: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  searchActionText: { fontSize: 12, fontWeight: '800' },
  recentsDropdown: { borderRadius: 12, borderWidth: 1, marginTop: 8, padding: 10, maxHeight: 180 },
  recentsHeader: { flexDirection: 'row', justifyContent: 'space-between', paddingBottom: 6, borderBottomWidth: 1 },
  recentsTitle: { fontSize: 10, fontWeight: '700', letterSpacing: 1 },
  closeRecentsText: { fontSize: 10, color: '#00E5FF', fontWeight: '700' },
  recentItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1 },
  recentPin: { fontSize: 14, marginRight: 10 },
  recentText: { fontSize: 13, fontWeight: '500' },
  targetIndicator: { color: '#10B981', fontSize: 12, fontWeight: '600', marginTop: 8, marginLeft: 4 },
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
  deleteTripBtn: { padding: 8 },
  deleteTripText: { fontSize: 16 },

  // Minimalist Splash Styles
  splashOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#050505',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 9999,
  },
  splashCenter: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  splashChevron: {
    color: '#00E5FF',
    fontSize: 34,
    marginBottom: 14,
  },
  splashTitle: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: 6,
  },
});