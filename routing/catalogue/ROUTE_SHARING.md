# Route links

The preview shares an immutable planning snapshot via the native share sheet.
`POST /shared-routes` requires the existing pilot credential at Caddy and returns
a cryptographically random 128-bit identifier. The public link is
`https://api.bendboundapp.com/shared/<id>`. It includes the exact road geometry,
turn instructions, profile, motorway preference and every ordered stop, including
its name and address. It excludes GPS recordings and credentials.

`GET /shared-routes/<id>` returns the snapshot without pilot authentication, so
recipients need only the link. Links expire after 90 days; storage is capped at
256 MiB. Expired files are cleaned on creation. Files persist in
`routing/.data/route-shares`, outside the API image. Preserve this directory on
redeployments and backups. Anyone with the link can access the snapshot.

iOS Universal Links use `/.well-known/apple-app-site-association` and the native
associated-domain entitlement. A newly signed iOS build is required. The browser
landing page also offers `bendbound://shared/<id>` for installations that do not
yet have the domain association, and for Android custom-scheme handling. Android
verified App Links require release certificate fingerprints before adding an
assetlinks.json and intent filter; they are not configured in this change.

Both cold and warm links use the hidden `shared/[id]` screen, wait for app state
recovery, and replace the map with a preview. Imports never start navigation or
tracking, and cannot replace an active or paused durable ride. Standard-trip
editing retains the shared origin with an explicit option to switch to current
location. Opening the same link again resets the preview via a new import token.

## Deployment

Upload the changed service modules, Caddyfile and compose.yml to the current EC2
checkout, retaining a rollback copy. Run `deploy-route-sharing.sh` from this
directory on the host through AWS MCP/SSM. The script checks Caddy before reloading
and rebuilds only the API; routing tiles and database volumes stay intact.
Verify unauthenticated POST fails, authenticated POST succeeds, public GET returns
the exact snapshot, the landing page opens, and the association is served without
redirects or credentials. Confirm authenticated `/health` still reports ready.

On a new phone build: send a multi-stop route through Messages, open it with
Bendbound closed and already open, check stop order and origin, edit a stop and
replan, verify no recording starts, and check an incoming link during a ride
leaves that ride intact.
