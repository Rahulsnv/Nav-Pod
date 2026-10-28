# NavPod

**NavPod** is a DIY motorcycle navigation system that pairs an Android companion app with a compact Waveshare ESP32-C6 display over Bluetooth Low Energy (BLE).

The phone handles route planning and map data. The ESP32 renders a simplified navigation view so riders can keep their phone safely stowed.

> **Project status:** Active development / experimental. GPS accuracy, BLE reliability, background navigation, and on-road performance require validation before use as a primary navigation aid.

## Features

- **Turn-by-turn guidance:** Route and maneuver information generated using OSRM.
- **Vector navigation display:** Blue route lines with nearby roads shown in gray on a 172 × 320 display.
- **Destination marker:** Red destination pin on compatible firmware.
- **Pocket Mode:** Prefers direction of GPS travel over phone orientation when moving.
- **Zoom controls:** Configured 1×–2× range, depending on the installed app/firmware version.
- **Road data:** OpenStreetMap geometry, requested via Overpass API.
- **Place search:** Nominatim geocoding, with nearby-result prioritization in recent builds.
- **BLE communication:** The Android app sends compact navigation data to the ESP32-C6.
- **Diagnostics and caching:** Experimental tools for GPS/BLE monitoring, cached routing, and local roads in recent versions.

Feature availability depends on the particular Android and firmware versions installed. Some features have not been verified on real hardware.

## Hardware

- Waveshare ESP32-C6 1.47-inch LCD development board
- 172 × 320 pixel color LCD (ST7789 family)
- Bluetooth Low Energy connection to an Android phone
- Stable USB power supply or suitable vehicle USB output
- Secure, weather-protected motorcycle mount

## Software stack

| Component | Technology |
| --- | --- |
| Android application | React Native, with Expo libraries in the current project |
| Android builds | Gradle |
| Routing | OSRM |
| Base map / roads | OpenStreetMap and Overpass API |
| Search / geocoding | Nominatim |
| Wireless link | Bluetooth Low Energy (BLE) |
| Microcontroller firmware | Arduino/C++ on ESP32-C6 |

## How it works

```text
Android phone
  GPS + location filtering
  Destination search (Nominatim)
  Route calculation (OSRM)
  Nearby road geometry (OSM / Overpass)
  Map simplification + BLE packets
                 |
                 v
       Waveshare ESP32-C6
       Route / road / turn rendering
       172 × 320 LCD
```

The ESP32 is primarily a display, not a standalone GPS navigator. The phone supplies position, route, and map updates.

## Getting started

### Requirements

- Node.js and npm
- Android SDK, compatible JDK, and Android build tools
- A physical Android phone with location and Bluetooth support
- Arduino IDE or a compatible ESP32 build toolchain for the firmware

### Install app dependencies

From the project root:

```bash
npm install
```

### Build an Android APK (Windows Command Prompt)

```cmd
cd android
gradlew.bat assembleRelease -PreactNativeArchitectures=arm64-v8a
```

Expected output for a conventional React Native project:

```text
android\app\build\outputs\apk\release\app-release.apk
```

A release APK requires a valid signing configuration. For debugging, use `gradlew.bat assembleDebug` instead.

### Flash the ESP32

1. Open the compatible NavPod `.ino` sketch in Arduino IDE.
2. Install the required ESP32 board package and display/BLE dependencies for that sketch.
3. Select the ESP32-C6 board configuration and USB port.
4. Build and upload the firmware.
5. Power the display and pair/connect it from NavPod.

Keep the Android app and ESP32 firmware on **compatible protocol versions**. Updating one side alone may not enable newly added features.

## Background navigation

NavPod has experimental work on an Android foreground navigation service. **Continuous GPS-to-BLE updates with the phone locked are not yet confirmed reliable across devices.** Expo background location alone does not guarantee uninterrupted React Native BLE vector streaming. A native Android service must be integrated, permissioned, built, and tested against the actual Android project and hardware.

## Known limitations

- GPS heading may lag or become unreliable at very low speeds or while stationary.
- Map matching may be inaccurate around parallel roads, flyovers, or weak GPS reception.
- Side-road completeness depends on OSM coverage, filtering, and BLE throughput.
- Background BLE handoff and reconnection require real-device testing.
- The 172 × 320 screen limits the amount of geometry that can be drawn legibly.
- Do not interact with the phone or display while operating a motorcycle.

## Troubleshooting

**Wrong starting location:** Enable precise location, allow the phone to obtain a fresh outdoor GPS fix, and check diagnostics before starting a route.

**Screen-off updates stop:** Check the foreground service setup, Android permissions, battery restrictions, and BLE ownership. A notification alone does not guarantee background packet transmission.

**Missing side roads:** Check network availability, Overpass responses, loaded-road counts, and BLE geometry budgets.

**Incorrect orientation:** Verify GPS heading accuracy and Pocket Mode behavior; phone compass orientation is not reliable while carried in a pocket.

**Android crash:** With USB debugging enabled, capture logs using:

```cmd
adb logcat -b crash -v time
```

## Project structure

The exact layout may differ by branch:

```text
NavPod/
├── app/                 # Expo Router screens, if used
├── src/                 # Application modules, if used
├── assets/              # Images and application assets
├── android/             # Native Android project and Gradle config
├── package.json
└── README.md
```

Verify the actual application entry point before replacing `index.js`, since Expo Router projects can use files in `app/` instead.

## Contributing

Issues, reproducible bug reports, and pull requests are welcome where enabled by the repository owner. For navigation bugs, include Android version, app/firmware versions, GPS accuracy, and relevant logs; remove personal location details before sharing.

## Acknowledgements

NavPod uses technologies and data services from the React Native, Expo, OpenStreetMap, OSRM, and ESP32 ecosystems. Follow the respective providers' attribution, usage policies, and licensing requirements.

