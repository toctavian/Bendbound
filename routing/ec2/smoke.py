#!/usr/bin/env python3
"""Exercise health, a motorcycle route and the guide's validated London loop."""
import json
import time
import urllib.request


def request(path, data=None):
    started = time.monotonic()
    req = urllib.request.Request(
        f"http://127.0.0.1:8088/{path}",
        data=json.dumps(data).encode() if data is not None else None,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=90) as response:
        body = json.load(response)
    return body, round(time.monotonic() - started, 3)


health, seconds = request("health")
assert health["status"] == "ready", health
print(json.dumps({"check": "health", "seconds": seconds, "response": health}), flush=True)

cases = {
    "route": {
        "locations": [{"lat": 51.481, "lon": -0.009}, {"lat": 51.505, "lon": -0.075}],
        "costing": "motorcycle",
        "units": "kilometers",
    },
    "round-trip": {
        "center": {"latitude": 51.481, "longitude": -0.009},
        "targetKm": 20,
        "direction": 90,
        "profile": "winding",
        "avoidMotorways": True,
    },
}
for path, data in cases.items():
    route, seconds = request(path, data)
    legs = route["trip"]["legs"]
    assert legs and all(leg.get("shape") and leg.get("maneuvers") for leg in legs)
    if path == "round-trip":
        assert route["planner"]["valid"] is True, route.get("planner")
    print(json.dumps({
        "check": path,
        "seconds": seconds,
        "summary": route["trip"].get("summary"),
        "legs": len(legs),
        "maneuvers": sum(len(leg["maneuvers"]) for leg in legs),
        "planner": route.get("planner"),
    }), flush=True)
