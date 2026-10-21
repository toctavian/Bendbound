Place discovery is available from home, new standard/round trip planners and route previews. With `EXPO_PUBLIC_POI_URL` configured, searches and route highlights use the deployed server rather than direct Overpass calls. Pins open a photo/details panel with Ride here and Add as a stop. Adding inserts before the destination and opens the existing stop editor. Round trips without stop metadata retain six sampled anchors when opened for editing; rebuilding may change the roads between those anchors.

Biker meets currently use a deliberately small UK catalogue (Ace Cafe London, Squires, Loomies), matched against OSM names and geographic bounds. Evidence: https://london.acecafe.com/monthly-meets/ and https://www.squires-cafe.co.uk/about/ and https://www.motorcyclenews.com/news/2017/may/loomies-bike-meet-of-the-week/ . Expand this catalogue with reviewed venues, not generic cafes or pubs. Regular gatherings do not guarantee riders are present at all times.

Forests require a named closed OSM forest/wood polygon containing a vertex of a normal road. Private/restricted motor access, tracks, residential streets, pocket woods under 25 hectares and mapped unpaved surfaces are excluded. The server supports closed way polygons and reconstructable relation boundaries, including inner holes; forests without adequate road geometry are omitted; OSM data cannot guarantee current access. The pin is placed on the road. Along-route cards omit unverified forest centres.

Highlights use OSM image/Wikimedia metadata, with a Wikipedia page thumbnail lookup on selection. See more opens the linked Wikipedia article, or the OSM place page when no article is mapped. Missing photos have an explicit fallback.

Fuel Finder requires OAuth client credentials: https://www.gov.uk/guidance/access-the-latest-fuel-prices-and-forecourt-data-via-api-or-email . They are stored in AWS Secrets Manager. The deployed POI service reads them through the EC2 role; see [deployment and operations](poi-service.md).

## Fuel Finder integration requirements

Read [the saved access terms](legal/fuel-finder-access-terms.md) before implementing ingestion, caching, price presentation or comparisons. These are the project implementation requirements derived from the supplied terms, not evidence that a production integration is already compliant.

- API mode: operate a server-side upstream poller with a target interval of four minutes and measure the actual successful polling gaps daily. The supplied wording is interpreted here as requiring an average interval no greater than five minutes, not a maximum of five calls per minute. Complete pagination/delta ingestion for the represented dataset; a token refresh, health check, partial page or request to our own proxy does not constitute checking current prices. Catch up promptly after interruptions.
- CSV mode: use the latest published CSV and record its actual publication/version metadata. Do not apply API `checkedAt` semantics to a CSV snapshot or relabel CSV as near real-time. The current app contract supports API mode only; CSV needs separate freshness/presentation handling.
- Preserve original prices, all available fuel types and the provider's timestamps/metadata in storage. Keep stable upstream forecourt IDs for matching; use neutral geographic/user criteria to select places. Do not omit suppliers, reorder or adjust prices for commercial advantage. Future comparisons must state objective criteria and compare like fuel types/units. There is no price ranking or price comparison in the current UI.
- Show the original price amount and provider timestamps. Label our upstream verification time separately from price/site update times; never replace provider timestamps with the time we served a cached response.
- Keep the [Report a Discrepancy](https://www.fuel-finder.service.gov.uk/motorist/price-report) link accessible beside fuel-price information, including when prices are temporarily unavailable.
- Include Fuel Finder attribution and a link to the [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/). The app includes the default public-sector attribution statement; incorporate any additional attribution statement specified by the Information Provider at registration.
- Log upstream poll attempts/successes, source versions, ingestion coverage, throttling and outage windows so compliance evidence can be produced. Never log credentials. During outages stop presenting unverified cached prices as live, mitigate with retries respecting upstream throttling, and resume normal polling as soon as possible. The reasonable-control exception is limited to the actual event; it is not permission for routine stale caching.

### Proxy response contract

Set `EXPO_PUBLIC_FUEL_PRICES_URL` to an HTTPS proxy endpoint. Keep OAuth credentials on the server. The app sends latitude, longitude and name; the server must positively identify the station using its upstream forecourt identity and return this normalized response. Retain any additional original metadata server-side; normalization must be lossless for relevant prices and timestamps.

```json
{
  "latitude": 51.5,
  "longitude": -0.1,
  "checkedAt": "2026-10-12T10:04:00Z",
  "updatedAt": "2026-10-10T10:00:00Z",
  "source": "Fuel Finder",
  "currency": "GBP",
  "unit": "pence/litre",
  "prices": [
    { "fuel": "E10", "amount": "139.90", "updatedAt": "2026-10-10T10:00:00Z" },
    { "fuel": "B7", "amount": "145.90", "updatedAt": "2026-10-10T10:00:00Z" }
  ]
}
```

`checkedAt` must be the last successful, complete upstream verification that covers this station, not the proxy request/response time. `updatedAt` values retain the provider's original site and per-fuel timestamps. An old price-update timestamp is valid when a recent upstream check confirms the price remains unchanged. Decimal amount strings preserve provider precision; numeric amounts are also accepted without additional rounding.

Return unavailable/no match rather than matching an adjacent forecourt by proximity alone. The app additionally checks the station coordinates, currency, units, amount values and timestamps. It rejects the whole snapshot if any price entry is invalid, rather than silently selecting fuel types. Published null price values remain visible as unavailable grades. The server supplies stable forecourt IDs; the app returns that ID on price requests, so prices are not matched to a forecourt by proximity or name alone. It displays only snapshots verified less than five minutes ago, refreshes an open fuel panel every four minutes and on app resume, and expires displayed prices when upstream verification reaches five minutes. Network failures show an unavailable state. These client checks do not establish that the server is polling correctly.

The POI service, server polling and app endpoint configuration are implemented. See [deployment and verification](poi-service.md) for the live state. Saving the terms alone did not accept them or enable access.


### Local API secrets

Store local server credentials in the Git-ignored root `.secrets.env` file, using `.secrets.env.example` as the tracked template. It contains placeholders for `FUEL_FINDER_CLIENT_ID` and `FUEL_FINDER_CLIENT_SECRET`; fill in the local file only. The local file has owner-only read/write permissions.

This file is deliberately separate from Expo's automatically loaded environment files. The future fuel-price server must explicitly load it; creating the file does not configure the server or enable API access. Never put secrets in `EXPO_PUBLIC_` variables, app configuration or mobile code. For deployment, configure credentials in the server environment or its secret store rather than committing this local file.


### Read-only credential and price test

Before production polling is active, run `npm run fuel:test` (Node 20.12+ with `util.parseEnv` support). With the deployed worker active, use `node scripts/poi-live-smoke.mjs` instead; the provider allows only one concurrent request per client and a separate live credential test could collide with the worker. It reads `.secrets.env` directly, requests one OAuth token, reuses it to read batch 1 of fuel prices and forecourt details, and prints a small diagnostic sample in provider order. Prices and their source timestamps are preserved. Credentials, access tokens and refresh tokens are neither printed nor persisted. Failed requests are not automatically retried; rate-limit failures must be allowed to recover.

Official specifications: [OAuth](https://www.developer.fuel-finder.service.gov.uk/fuel-finder/api/openapi/access-token.en.json) and [Information Recipient APIs](https://www.developer.fuel-finder.service.gov.uk/fuel-finder/api/openapi/info-recipent.en.json). The script uses the production host specified there and read-only data endpoints. Use production Information Recipient credentials. This diagnostic does not fetch the complete dataset, schedule polling, enable app prices or demonstrate production freshness compliance.


Production credential storage and EC2 access are documented in [Fuel Finder credentials in AWS](fuel-secrets-aws.md). Local edits do not automatically update that secret.
