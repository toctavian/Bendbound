# Bendbound

<p align="center">
  <img src="assets/bendbound-logo.png" alt="Bendbound logo" width="240" />
</p>

An open-source motorcycle ride planner and foreground GPS ride recorder, built
with React Native, Expo, and TypeScript. Find interesting roads, follow a planned
route, and keep the track you actually rode.

**Status: early beta.** The first iOS archive has been uploaded for TestFlight
testing. This is not a finished navigation product or a feature-for-feature
replacement for commercial apps. Android release setup and on-device validation
are still needed. There is no public TestFlight invitation link in this repository.

## Built So Far

### Maps and Planning

- Map-first launch with Map, Tours, and Profile tabs.
- Expandable destination search with debounced place autocomplete, nearby search
  bias, and exact coordinates from the selected result.
- Point-to-point planning and round trips with a target distance and direction.
- Fast, winding, and twisty preferences; motorway avoidance enabled by default.
- Road-following geometry from Valhalla motorcycle routing. OSRM driving routing
  is a fallback only when motorway avoidance is disabled.
- Scenic round-trip waypoint selection and an alternative-route attempt when
  substantial repeated road geometry is detected.
- Nearby fuel, mountain passes, cafes/pubs, sights, forests, and nature reserves.

### Riding

- Compact navigation overlay with GPS speed, heading, road name, available speed
  limit, upcoming maneuver, estimated arrival, and remaining distance.
- Spoken turn instructions through the device speech engine, with mute controls
  and an off-route warning.
- Flat 2D navigation, close speed-aware camera follow, and a recenter button
  after manually browsing the map.
- Pause, resume, and finish controls. GPS recording filters stale, inaccurate,
  duplicate, and implausible samples, and separates pauses and long GPS gaps.
- Selectable motorcycle markers: Sports, Adventure, Cruiser, Motocross, a delivery
  scooter, and the named Octav, Bogdan, Radu, Petre, and Foca designs.
- Persistent motorcycle name, routing, voice, and km/h or mph preferences.

### Tours and Sharing

- **My Tours** contains completed rides with recorded GPS geometry and measured
  riding time; **Saved** contains bookmarked routes for later.
- Local tour and settings persistence using Expo SQLite's key-value store.
- GPX import and export. Recorded exports preserve segments and timestamps.
- Waze destination handoff, with an explicit warning that Waze calculates its own
  route and cannot reproduce Bendbound's route exactly through this integration.
- Bendbound branding, approved logo assets, and migration of earlier local data.

## Known Limitations

- Location tracking is foreground-only. Do not rely on recording or guidance
  continuing when the screen locks or the app goes into the background. An
  unfinished ride is held in memory and is not recovered after an app restart.
- There is no automatic off-route recalculation, offline map download, account
  system, cloud synchronization, live group tracking, or crowdsourced hazard feed.
- Some UI is still demonstration content: the profile identity and activity chart,
  seeded tours, and the tour-detail group-ride action. The latter displays an alert
  but does not create a working invitation. Hazard/private-profile toggles do not
  connect to a live service.
- Direction, distance, scenic value, and motorway avoidance are routing
  preferences and heuristics, not guarantees. Motorway avoidance lowers routing
  preference rather than imposing a strict ban. Routes can still repeat roads.
- OSRM fallback routes do not currently include turn instructions. Imported GPX
  tracks do not automatically gain turn instructions either.
- Speed limits depend on map data and nearby-road matching; they can be absent,
  outdated, or associated with the wrong road. Posted signs take precedence.
- Curve/elevation figures and some planned-route statistics are estimates or
  sample data, not measured ride telemetry.
- The web command exists, but the native map experience is not a supported web app.
- The current iOS archive has missing framework dSYM warnings for React,
  ReactNativeDependencies, and Hermes. Bendbound's own matching dSYM is present;
  diagnosing crashes inside those dependencies is more limited.

Plan and adjust routes while stopped. Treat this beta as a planning aid, not an
authoritative source of road access, hazards, speed limits, or safe riding advice.

## Development Setup

The current stack is Expo SDK 57, React Native 0.86.3, React 19.2.3, Expo Router,
and react-native-maps. The entry point is `expo-router/entry` and screens live in
`src/app/`; root `App.tsx` and `index.ts` are unused scaffold files.

Use Node.js 22.13 or newer on the Node 22 line, or a compatible newer LTS release,
and npm. iOS development needs macOS, Xcode, and CocoaPods. Android development
needs Android Studio and its SDK/emulator tooling. See the
[Expo SDK 57 requirements](https://docs.expo.dev/versions/v57.0.0/).

```sh
git clone https://github.com/toctavian/Bendbound.git
cd Bendbound
npm ci --legacy-peer-deps
npm start
```

The current lockfile has peer conflicts: React DOM 19.3.0 expects a newer React
than this native app uses, and the installed Worklets version is outside Expo
Modules Core's declared optional peer range. A plain `npm ci` fails with
`ERESOLVE`. The explicit `--legacy-peer-deps` workaround preserves the current
snapshot; it does not prove compatibility. Its install plan has been checked
with a dry run, not a fresh native build. Aligning these transitive dependencies
is a follow-up task. Do not upgrade React independently of the Expo SDK.

`npm start` launches Metro. Use a compatible Expo Go installation for a quick
preview, or build the native app locally:

```sh
npm run ios
# Or, with Android tooling configured:
npm run android
```

Native builds do not require EAS cloud builds. Android standalone maps require
your own restricted Google Maps SDK key and package/signing configuration; these
are not configured in this snapshot. Follow the
[Expo react-native-maps setup](https://docs.expo.dev/versions/v57.0.0/sdk/map-view/).
iOS uses Apple Maps by default.

No separate application backend is included or required for the current beta.
Do not commit service secrets or signing credentials. Values bundled into a
mobile app, including `EXPO_PUBLIC_*` variables, are not secret.

## Checks

```sh
npm test
npm run typecheck
npm run lint
npx expo install --check
npx expo-doctor
```

The current suite has 48 tests covering recording, GPS filtering, map-camera
behavior, voice cues, search, units, settings persistence, migration, and branding.
These use mocked native APIs and are not a replacement for device testing.
Before distributing a build, test cold launch without Metro, location permission,
route planning, voice guidance, recentering, pausing/resuming, and reopening saved
rides on a physical phone.

## iOS and TestFlight

Native directories are generated and intentionally ignored by Git. Configuration
belongs in `app.json` and Expo config plugins, not hand-edited generated files.
The current iOS identifier is `com.octavian.bendbound`; forks should use their own
identifier and signing team.

```sh
npx expo prebuild --platform ios
open ios/Bendbound.xcworkspace
```

In Xcode, select your developer team and automatic signing, archive for a generic
iOS device, then distribute using **TestFlight & App Store**. This requires an
Apple Developer Program membership and an App Store Connect app record. External
testing requires TestFlight review before friends can install through invitations.
Do not choose **TestFlight Internal Only** for an external friends group. See
[Apple's distribution guide](https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases/).

Increment the iOS build number for subsequent uploads and regenerate/synchronize
the native configuration before archiving. TestFlight release builds bundle their
JavaScript and do not require Expo Go, Metro, or the developer's computer.

## Data, Services, and Privacy

Completed rides and preferences are stored locally; there is no Bendbound account
or cloud backup. Export important rides before uninstalling or changing app
identity. Legacy storage migration works within the same app sandbox, not across
separate app installations or Expo Go project identities.

The app makes direct requests to third-party services:

| Service | Purpose | Data sent |
| --- | --- | --- |
| Apple Maps / Google Maps | Native basemap and traffic display | Map requests handled by the native SDK |
| `valhalla1.openstreetmap.de` | Motorcycle routing and road/speed-limit lookup | Waypoints, nearby position, routing preferences |
| `router.project-osrm.org` | Optional driving-route fallback | Route waypoints |
| `photon.komoot.io` | Place autocomplete | Search text and nearby coordinates |
| Overpass public instances | Nearby/scenic points of interest | Search center, radius, and categories |
| Waze | Explicit destination handoff | Destination coordinates |

Providers also receive normal network metadata such as the client's IP address.
The public routing/search/POI endpoints have no availability guarantee for this
project. Review their usage policies and provision suitable services before
expanding beyond a small beta. The app is not fully offline or network-private.
Exported GPX files can reveal sensitive locations and timestamps.

Routing and POI data use OpenStreetMap. Credit
[OpenStreetMap contributors](https://www.openstreetmap.org/copyright); that data
has its own licensing and attribution requirements separate from this repository.

## Project Layout

```text
src/app/          Map, tour, profile, and motorcycle-settings screens
src/components/   Map, navigation overlay, search sheet, markers, shared controls
src/hooks/        Place suggestions and voice-guidance lifecycle
src/state/        App state, local persistence, and legacy migration
src/utils/        Routing, POIs, road context, recording, GPX, and speed conversion
src/data/         Sample tours and motorcycle metadata
assets/           App branding and motorcycle illustrations
tests/            Node test-runner regression suite
```

## Contributing

Issues and pull requests are welcome. Include reproduction steps, device/OS,
expected behavior, and actual behavior. Remove precise home/work coordinates and
other personal data from screenshots, GPX files, and logs before sharing them.

Keep changes focused, follow the existing TypeScript and Expo Router patterns,
and add tests for behavioral changes. Use `npx expo install` for Expo/native
dependencies and check the matching SDK documentation. See [AGENTS.md](AGENTS.md)
for repository development guidance.

Useful next steps include dependency alignment for clean installs, physical-device
regression coverage, background recording and recovery, Android release setup,
better route-quality evaluation, automatic rerouting, and removing demo-only UI.

## License and Assets

The repository is distributed under the [MIT License](LICENSE), preserving the
Expo starter's copyright notice. Dependencies and external map data retain their
respective licenses. `private: true` in `package.json` prevents accidental npm
publishing; it does not make the GitHub repository private.

The logo and motorcycle illustrations include AI-generated artwork. See
[branding notes](assets/BRANDING.md) and
[named motorcycle references](assets/motorcycles/NAMED-MARKERS.md) for provenance.
The named markers are model-inspired illustrations, not exact factory replicas.
Third-party names and marks do not imply endorsement. Bendbound is independent
of Calimoto, Waze, and the motorcycle manufacturers.
