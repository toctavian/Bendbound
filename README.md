# Bendbound

<p align="center">
  <img src="assets/bendbound-logo.png" alt="Bendbound logo" width="240" />
</p>

An open-source motorcycle ride planner and GPS ride recorder, built
with React Native, Expo, and TypeScript. Find interesting roads, follow a planned
route, and keep the track you actually rode.

**Status: early beta — updated 26 October 2026.** iOS version 1.1.0, build 10
is available to the configured internal and friends TestFlight groups. It installed
and launched on a real BrowserStack iPhone 15 running iOS 17.3. This is not a
finished navigation product or a feature-for-feature replacement for commercial
apps. Android release setup and on-device validation
are still needed. There is no public TestFlight invitation link in this repository.

Project website: [bendboundapp.com](https://bendboundapp.com). UK routing is
deployed on AWS; accounts and private group lobbies are in a controlled pilot.
**Live rider location sharing remains disabled.**

## Built So Far

### Maps and Planning

- Map-first launch with Map, Tours, and Profile tabs.
- Expandable destination search with debounced place autocomplete, nearby search
  bias, and exact coordinates from the selected result.
- Standard trips with no app-imposed stop count limit, and
  round trips with a target distance and direction. **New route** opens the stop
  editor: search for places, insert stops before the destination, change places,
  move them up/down, or remove them before creating the route. Previewed standard
  trips offer **Add / edit stops**, and saved trips retain the editable itinerary.
  Stops use matching letters in the editor and on the map (A–Z, then AA, AB, etc.)
  and are visited in the chosen order. Long itineraries are calculated in sections
  with a shared stop at each boundary, then joined with combined distances, times
  and turn instructions. A failed section fails the whole calculation rather than
  returning an incomplete trip. Routing service availability still applies.
  Quick destination searches and dropped pins can also be extended from preview.
- Fast, winding, and twisty preferences; motorway avoidance enabled by default.
- Road-following geometry from Valhalla motorcycle routing. OSRM driving routing
  is a fallback only when motorway avoidance is disabled and no self-hosted URL
  is configured. The [self-hosted Valhalla service](routing/README.md) is deployed
  at `https://api.bendboundapp.com`, covering England, Wales, Scotland and Northern
  Ireland. Native road sections and shortcuts use a graph-matched SQLite ratings
  overlay. GraphHopper remains a benchmark only. See the
  [UK deployment handoff](docs/uk-routing-expansion.md).
- Round-trip planning applies distance, direction and road-reuse checks. The
  deployed UK service uses native road identity, a directional cone and bounded
  search; it does not promise zero repeated road. The verified UK release smoke
  stayed inside a 120° cone with 3.73% repeated road, below its 10% limit.
  Per-search distance is capped at 100 km. A failed search asks for a different
  direction, distance or start rather than claiming no valid loop exists.
  Public-provider fallback uses a separate legacy search and validation path.
- Nearby fuel, mountain passes, cafes/pubs, sights, forests, and nature reserves.
- Round-trip previews show numbered highlights in riding order along the final
  route, with horizontally scrolling cards for names, place types, addresses
  where available, distance into the ride, and distance from the road. Tap a pin
  to reveal its card, or select a card to focus the map. Pins sit on the route
  beside places within 250 m; these are nearby highlights, not added detours.
  The preview keeps up to 24 highlights spread through the returned results.
  Lookup runs separately from planning, offers retry on failure, and stops when
  navigation begins. Saved round trips keep this preview behaviour when reopened.

### Riding

- Compact navigation overlay with GPS speed, heading, road name, available speed
  limit, upcoming maneuver, estimated arrival, and remaining distance.
- Spoken turn instructions through the device speech engine, with mute controls
  and an off-route warning.
- A 45° riding camera aligned with the nearby route segment during navigation,
  GPS heading when off route or recording, speed-aware zoom, and recentering.
  A single MapLibre vector map serves every screen, using OpenFreeMap data and a
  restrained custom style: sparse road/town labels, muted land and flat buildings.
  Routes render above the basemap; there is no Apple/Google map underneath.
- Large white turn arrows with route-coloured outlines trace the planned route's exact
  geometry; arrowheads follow the outgoing segment even when the map is tilted
  or rotated. Name-only changes and straight instructions do not get arrows.
  Nearby turns shorten their arrows to avoid overlap; passed turns disappear
  during navigation. Arrows are hidden in thumbnails and zoomed-out overviews.
- Background GPS recording during active rides, including screen lock, with
  Always / Allow all the time location permission. A global Expo task persists
  GPS batches independently of the map screen; Android shows an ongoing ride
  notification and iOS shows its background location indicator.
- Pause and resume stop/restart GPS collection. **Finish & save** moves the
  recording into My Tours; **Finish & discard** stops tracking and removes only
  the current recording. Previously saved rides and routes are preserved.
- Unfinished recordings and their planned routes survive app restarts. A stopped
  task or stale recording on a cold launch is recovered as paused. Saved rides
  remain in a recovery journal until the tour collection is written successfully.
- GPS recording filters inaccurate, duplicate, and implausible samples, accepts
  delayed native batches in timestamp order, and separates pauses and long GPS gaps.
- Selectable motorcycle markers: Sports, Adventure, Cruiser, Motocross, a delivery
  scooter, and the named Octav, Bogdan, Radu, Petre, and Foca designs.
- Persistent motorcycle name, routing, voice, and km/h or mph preferences.
- One route and arrow colour setting, available under Profile → Navigation and
  Routes & bike, with red, blue, purple, green, orange, and teal choices. The
  selected colour applies to planned routes and arrow outlines across maps and
  previews; white arrow centres keep their contrast.

### Tours and Sharing

- **My Tours** contains completed rides with recorded GPS geometry and measured
  riding time; **Saved** contains bookmarked routes for later.
- Local tour and settings persistence using Expo SQLite's key-value store.
- GPX import and export. Recorded exports preserve segments and timestamps.
- Share generated routes through the native share sheet using planning links
  retained for 90 days. Recipients can open the route in Bendbound; planning links
  do not authenticate a rider or enable location sharing.
- Waze destination handoff, with an explicit warning that Waze calculates its own
  route and cannot reproduce Bendbound's route exactly through this integration.
- Bendbound branding, approved logo assets, and migration of earlier local data.

### Accounts and Private Group Rides

- Native Sign in with Apple exchanges verified Apple authorization for Cognito
  sessions. Pilot access requires explicit, expiring server-side tester approval.
  Ordinary planning, local recordings and settings remain usable without login.
- After generating a route, **Group ride** opens the private lobby. Implemented
  controls include rider-name editing, invitations, member roster/refresh and
  host end/member leave. Rooms allow up to 10 approved riders; invitations expire
  within an hour and rooms within 12 hours. Sending a new invite replaces the old one.
- The lobby API is deployed in **lobby-only mode**. Shared route links are planning
  links, not immutable group route snapshots. Each rider navigates independently.
- Session refresh, logout recovery and account-deletion UI/backend foundations
  exist. Full device acceptance of refresh, logout, deletion and group lifecycle
  is still pending; these are not public-launch claims.
- Native Apple sign-in has been reported working on the owner's physical iPhone.
  The 26 October BrowserStack trial proved build 10 installation and launch, but
  native sign-in stopped at the requirement for device-level Apple ID sign-in.
  BrowserStack's exposed Settings controls did not provide that login, and its
  [iCloud Settings FAQ](https://www.browserstack.com/support/faq/app-live/features-app-live/my-app-requires-access-to-icloud-settings-can-i-test-this-on-app-live)
  lists support as planned. No authenticated group test passed in that session.

See the [group/account implementation tracker](docs/group-rides-implementation.md)
for deployed versus local versus device-validated work and the remaining gates.

### Routing Ratings and Operations

- The UK baseline contains 141,445 rated road sections. A Mac LaunchAgent runs
  daily at **06:00 Europe/London**: research new road recommendations, independently
  review the cumulative evidence, then deterministically apply supported changes.
  Disputed mappings remain unscored; individual rating deltas retain an audit trail.
- Reviewed ratings publish through AWS MCP using a dedicated machine identity.
  Checksum, immutable graph, native-consumer and public-route checks guard
  activation, with rollback on verification failure.
- After successful AWS publication, the same Mac job automatically pushes a
  compact rating/evidence snapshot and checksum metadata to the separate
  [`ratings-data` branch](https://github.com/toctavian/Bendbound/tree/ratings-data).
  The first upload was verified on 25 October. This is a Mac-scheduled workflow;
  the Mac must be awake, online and authenticated. It is not a hosted GitHub Action.
- On 25 October, 10.8 GB of build artifacts were checksum-verified and moved to
  the NAS. The immutable baseline, research ledger, reviews and recent published
  databases remain local (about 3.5 GiB); the daily task does not need the NAS mounted.

See [daily research operations](docs/routing-daily-research.md) and the
[UK routing handoff](docs/uk-routing-expansion.md). The promotional website is
served through AWS Lambda and CloudFront; its source and deployment notes are in
[`website/`](website/README.md).

## Known Limitations

- Background recording requires a new native build (iOS build 5 or later with
  these changes), not just a JavaScript reload or Expo Go. Force-quitting the app,
  disabling location access, or OS restrictions can interrupt tracking; recovery
  retains the recorded points, but cannot reconstruct missing travel. Background
  spoken navigation is not implemented by the GPS recording task.
- Background recording has automated lifecycle tests; physical-device screen-lock
  and permission testing is still required on iOS and Android.
- iOS builds compile Expo modules from source (`usePrecompiledModules: false`)
  to avoid the precompiled native-view startup crash observed with this dependency
  combination. The first native build takes longer; subsequent builds use Xcode's cache.
- There is no automatic off-route recalculation, offline map download, cloud
  backup of local rides/settings, enabled live group tracking or crowdsourced
  hazard feed. Accounts and lobbies do not upload local recordings implicitly.
- Two-user lobby create/invite/join, account lifecycle and live peer-location
  delivery still need physical-device acceptance. Screen-lock and battery testing
  on the owner's phone remain pending. Live sharing needs further GPS, transport,
  peer-map and operational work before it can be enabled.
- Some content remains seeded or illustrative. Hazard/private-profile toggles
  do not connect to a live service; Profile now uses actual account identity and
  local recorded-ride totals rather than the previous synthetic activity chart.
- Direction and scenic value remain routing heuristics. The public provider's
  motorway avoidance is a preference. The self-hosted Valhalla service enables
  hard motorway exclusions, which still allow excluded features at endpoints.
- Bounded round-trip search may fail to find a route within the requested limits
  even where one exists. Dead ends and sole access roads can require repeated
  sections. Provider-specific limits differ; see the active UK deployment notes.
  Imported GPX tracks do not gain the planner's route-quality guarantees.
- OSRM fallback routes do not currently include turn instructions. Imported GPX
  tracks do not automatically gain turn instructions either.
- Route highlights depend on named OpenStreetMap places and the availability of
  the Overpass service. Queries return up to 1,000 candidates before filtering;
  the preview is a selection, not an exhaustive list. Area centres may be farther
  from the road than their entrances, and distance from route is straight-line.
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
and MapLibre React Native 11. The entry point is `entry.js`, which initializes
background tracking before loading Expo Router. Screens live in `src/app/`;
root `App.tsx` and `index.ts` are unused scaffold files.

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

The lockfile is maintained with `--legacy-peer-deps`: resolving optional web and
animation peers without it can select React DOM or Worklets versions incompatible
with this Expo SDK. This workaround does not prove native compatibility. Do not
upgrade React independently of the Expo SDK.

`npm start` launches Metro. The native map and Apple sign-in modules require
a compatible native development build; Expo Go cannot validate these flows.
Build locally:

```sh
npm run ios
# Or, with Android tooling configured:
npm run android
```

Native builds do not require EAS cloud builds. Maps use MapLibre with
[OpenFreeMap](https://openfreemap.org/quick_start/) vector tiles on both platforms;
no Google Maps key is required. The MapLibre Expo config plugin configures the
native dependency. Run prebuild and install pods after updating dependencies,
then create a new native build. Expo Go and JavaScript-only updates cannot add
this map engine to an existing binary. iOS build 4 introduces this replacement.
OpenFreeMap requires internet access and has no availability guarantee. There is
no bulk/offline map download feature. Map attribution is available from the map's
information button above the bottom panel.

For Xcode 27 / iOS 27, `expo-build-properties` enables the scene lifecycle
required at launch. After changing this configuration, regenerate the iOS project
and create a new native build; a JavaScript update cannot fix an older binary.
See [Expo's SDK 57 scene migration guide](https://github.com/expo/fyi/blob/main/ios-scene-lifecycle.md#staying-on-sdk-57-with-xcode-27).

The repository includes self-hosted routing and private group/account backends.
Public-provider planning and local recordings can operate without pilot login;
private groups require the configured deployed APIs and approved identities.
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

The automated suite covers recording, GPS filtering, map-camera
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
the native configuration before archiving. When the iOS project already exists,
save `expo.version` and `expo.ios.buildNumber` in `app.json`, then run:

```sh
npx expo prebuild --platform ios --no-clean --no-install
```

This updates the generated `CFBundleShortVersionString` and `CFBundleVersion` in
`ios/Bendbound/Info.plist`. Changing only `app.json` does not update an existing
native project during an Xcode archive. Likewise, Xcode's `MARKETING_VERSION` and
`CURRENT_PROJECT_VERSION` do not override literal values in that plist. Reopen
the workspace if Xcode still shows stale values and create a **new** archive;
existing archives retain their original version and build number.
The `--no-install` option is appropriate for this version-only sync, not for
changes that add native dependencies and require installing pods.

TestFlight release builds bundle their
JavaScript and do not require Expo Go, Metro, or the developer's computer.

## Data, Services, and Privacy

Completed rides and preferences are stored locally, without automatic cloud
backup. Optional pilot accounts support private group lobbies; signing in does
not automatically upload local rides or settings. Export important rides before
uninstalling or changing app identity. Legacy storage migration works within the same app sandbox, not across
separate app installations or Expo Go project identities.

The app makes direct requests to third-party services. Configuring
`EXPO_PUBLIC_ROUTING_URL` moves standard and round-trip calculations to your
service; the other lookups below, including road/speed-limit lookup, remain:

| Service | Purpose | Data sent |
| --- | --- | --- |
| `tiles.openfreemap.org` | Vector basemap and label fonts on every map screen | Visible tile coordinates and font ranges |
| `valhalla1.openstreetmap.de` | Motorcycle routing and road/speed-limit lookup | Waypoints, nearby position, routing preferences |
| Configured self-hosted routing URL | Standard/round-trip routing when enabled | Start, stops, direction, distance and riding preferences |
| `router.project-osrm.org` | Optional driving-route fallback | Route waypoints |
| `photon.komoot.io` | Place autocomplete | Search text and nearby coordinates |
| Overpass public instances | Nearby/scenic points of interest | Search center, radius, and categories |
| Waze | Explicit destination handoff | Destination coordinates |
| Configured route-sharing service | Create/open an explicitly shared planning link | Planned route geometry, stops and instructions |
| Apple and configured Cognito/auth APIs | Optional pilot sign-in and account/session lifecycle | Authorization proofs and session credentials |
| Configured group API | Private lobby and membership controls | Authorized room actions, rider name and motorcycle choice; live location publication is disabled |

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
src/services/     Background GPS, recovery, authentication and group clients
src/state/        App state, local persistence, and legacy migration
src/utils/        Routing, POIs, road context, recording, GPX, and speed conversion
src/data/         Sample tours and motorcycle metadata
assets/           App branding and motorcycle illustrations
tests/            App Node test-runner regression suite
services/group-rides/  Private account/lobby/location backend and infrastructure
routing/          Routing engine, ratings catalogue and daily research workflow
website/          Promotional site, verification and AWS deployment tooling
docs/             Implementation trackers, deployment evidence and policies
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
background-recording regression coverage, Android release setup,
account/lobby acceptance, live-sharing implementation and privacy/operational
release gates, better route-quality evaluation and automatic rerouting.
See the [Calimoto public-repository review](docs/calimoto-routing-review.md) for
routing ideas and the limits of the available public code.

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
