# Rider motion and recorded-road display

Navigation projects accurate GPS fixes onto nearby road segments and animates the
rider between fixes, following bends instead of cutting their corners. Camera and
marker share the same displayed position. Heading rotates through the shortest
angle. Direction and route progress help distinguish overlapping segments.
Nearby matches are limited to 20–50 metres according to reported GPS accuracy.
Off-route, inaccurate and stale fixes do not force the rider onto the planned
route; pauses, large jumps and outages reset interpolation without extrapolating
an invented journey.

Recorded maps in My Tours, Saved and ride detail views match the original GPS
segments to motorcycle-accessible roads using `POST /match`. The endpoint is live
on the existing AWS API; the UI needs a new app build. No TestFlight build has
been submitted.

The original recording, timestamps, ride statistics and GPX remain the recorded
GPS data. The map uses separate road-display geometry. Existing recordings also
receive the display improvement when opened. Successful geometry is cached on
the device (64 batches); cached matches remain available offline. New or
uncertain matches fall back to the original trace. The London pilot map bounds
apply to the matcher; recordings outside that region retain their GPS display.

## Matching limits

- Each request accepts 2–128 points. App batches contain at most 96 with a one-point overlap.
- Recorded pauses and gaps over 30 seconds are matched separately. Batches are drawn as separate lines to avoid invented joins.
- Live matching uses the latest 64 samples every four seconds. Earlier live history keeps its GPS geometry until the saved-view matching pass.
- Requests share a client queue, with at least 2.5 seconds between requests. Display requests never block background GPS recording or ride completion.
- Valhalla uses `map_snap`, motorcycle costing and a 50-metre search radius. Every supplied point must match or interpolate confidently, within an accuracy-dependent displacement limit.
- Unmatched points, discontinuities, missing geometry, out-of-area paths or excessive detours fail closed. The app retains the raw chunk on failure.
- CloudWatch logs `/match`, request reference, status, duration and point count. Recorded coordinates and response geometry are excluded even on failure.

## Verification

The deployed matcher converted 60 offset samples from a public Dorking road
fixture to 119 road vertices in 143 ms end to end (49 ms server timing).
Health and the existing 40 km cone request passed. The source hashes and
CloudWatch completion are in
[road-matching-verification.json](ec2/road-matching-verification.json).

138 app tests and 59 catalogue/original routing tests passed, including animation
frames, heading wraparound, corner following, off-road fallbacks, pause/outage
separation, cached geometry after restart, authenticated matching and logging
privacy. Lint, typecheck and the production iOS bundle export passed. Animation
was verified with controlled frame timing; physical-device riding remains the
next check in a new native app build.

Rollback source: `/opt/bendbound/road-matching-backup-20261008.tgz`.
Use `bash catalogue/compose-aws.sh` when recreating the API to preserve CloudWatch
and graph-on-demand configuration. No map or graph import changed.
