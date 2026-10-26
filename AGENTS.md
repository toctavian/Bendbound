This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx` if the project uses bun (`bun.lock` present).

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start              # start the dev server
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## iOS builds: prefer Xcode

Octavian always prefers Xcode for iOS builds, signing, connected-device testing,
archiving and distribution. Use the local iOS workspace as the default workflow.
Prepare the required local configuration before asking the user to run or archive.
Do not start EAS cloud builds or direct the user to Expo-hosted installation by
default; use them only when explicitly requested or agreed for a specific need.
Expo remains the app framework and dependency/configuration tooling.

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md

## AWS MCP authentication

### Scheduled ratings identity

The 06:00 ratings publisher uses the separate `bendbound-research` certificate
profile (IAM Roles Anywhere), selected only in its dedicated MCP subprocess.
Keep the shared/manual MCP on `bendbound`. Unattended recovery refreshes machine
credentials and retries that transport; it must never open browser login or fall
back to the administrative profile. Manual prompts and administrative repair
continue to follow the browser-login-first rule below. See
[identity operations](docs/routing-research-machine-identity.md) for scope,
certificate renewal and actual verification state.


For ANY AWS/MCP access issue, check/renew AWS login FIRST and then retry the
configured MCP. This includes authentication failures, expired/invalid sessions,
AccessDenied, Unknown tool and apparently missing AWS tools. The connector is
known to be configured: do not declare it missing, search for alternatives or ask
for reconnection before attempting login recovery.

Run `aws login --profile bendbound --region eu-west-2` and let the user complete
the browser sign-in. If it returns a browser error, diagnose the generated
URL/region and retry a fresh flow instead of reusing a failing link. After login,
retry MCP and verify access. Distinguish login failure from any remaining tool
exposure/connection failure; never claim resource access from login alone.
Use AWS MCP for resource operations; CLI login only restores authentication.
Never persist sign-in URLs, authorization codes or credentials.

## Fuel Finder data

Before implementing or changing fuel-price ingestion, caching, presentation,
comparisons or supplier selection, read [the saved access terms](docs/legal/fuel-finder-access-terms.md)
and [the integration requirements](docs/place-discovery.md). Preserve provider
prices and metadata, represent suppliers impartially, provide the discrepancy
report link and OGL attribution, and satisfy the upstream freshness requirements.
App-side fetching alone does not satisfy the Aggregator API polling requirement.

## Group rides and accounts

For group rides, login, account security or live rider location sharing, read
[the shared implementation tracker](docs/group-rides-implementation.md) first.
Use its task IDs and acceptance criteria. Update its checkboxes and work log with
actual implementation, test, deployment and physical-device evidence before
finishing a session. Keep unfinished checks pending; distinguish local code from
deployed and device-validated behaviour. Never record secrets or rider coordinates
in the tracker. Preserve existing offline planning, local recordings and settings.

## Usage-limit handoff

The user requests a checkpoint when approximately 5% of either the 5-hour or
weekly allowance remains. Do not claim to monitor allowance without an actual
verified snapshot. Keep regular durable checkpoints in
`docs/group-rides-implementation.md`, including changed files, checks, deployment
state, dependencies and exact resume steps. If a usage warning becomes visible,
write that handoff before stopping. Never include credentials or rider locations.
The former hourly group-work autopilot was removed at the user's request on
2026-10-19; do not reinstall or resume it.

### Verified working Bendbound login (2026-10-20)

Run `aws login --profile bendbound --region eu-west-2` with its normal browser
flow. Let AWS CLI open a fresh London sign-in URL with its generated localhost
callback; leave the login process running until the browser completes. Do not
manually alter the endpoint, redirect URI or generated query parameters, reuse
old links, or switch regions as a routine workaround. This exact flow worked and
was confirmed by Octavian. The enrollment CLI automatically retries configured
MCP after login; actual approval and a subsequent read-only grant review both
succeeded. Retain the method only, never sign-in URLs/codes or credentials.
