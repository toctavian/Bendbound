# Bendbound daily ratings

Automatically updated after the independent review and successful AWS publication.
`latest.json` identifies the deployed graph/database and checksums `ratings.jsonl.gz`.
The snapshot contains every section's rating and evidence fields, ordered by ID.
It is a compact overlay, not a standalone routing database. Apply only to the exact
graph version in the manifest. The full baseline and build are archived separately.

Unchanged publications do not create commits. The job uses a separate checkout and
never stages app source, credentials, rider data, raw agent logs or map extracts.
Road identities derive from OpenStreetMap (https://www.openstreetmap.org/copyright).
Publisher citations appear in the sources fields; no articles or tracks are copied.
