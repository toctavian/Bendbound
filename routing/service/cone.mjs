// Generated from src/utils/roundTripArea.ts by routing/build-geometry.cjs.
// The angle is selected independently; reach scales with half the ride length.
// Keep the geographic search bounded to the current London pilot coverage.
export function coneRadiusKm(targetKm) {
    return Math.max(5, Math.min(100, targetKm / 2));
}
export function coneBufferKm(radiusKm) {
    return Math.max(1, Math.min(5, radiusKm * 0.15));
}
export function conePolygon(area, buffered = false) {
    const radians = Math.PI / 180;
    const local = [[0, 0]];
    const opening = area.coneAngleDegrees ?? 120;
    const steps = Math.ceil(opening / 2);
    for (let i = 0; i <= steps; i++) {
        const angle = (area.direction - opening / 2 + i * opening / steps) * radians;
        local.push([area.radiusKm * Math.sin(angle), area.radiusKm * Math.cos(angle)]);
    }
    let boundary = local;
    if (buffered) {
        const margin = coneBufferKm(area.radiusKm);
        const cloud = local.flatMap(([x, y]) => Array.from({ length: 64 }, (_, i) => [x + margin * Math.cos(i * Math.PI / 32), y + margin * Math.sin(i * Math.PI / 32)]));
        cloud.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        const half = (points) => {
            const hull = [];
            for (const p of points) {
                while (hull.length > 1 && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0)
                    hull.pop();
                hull.push(p);
            }
            return hull.slice(0, -1);
        };
        boundary = [...half(cloud), ...half([...cloud].reverse())];
    }
    const ring = boundary.map(([x, y]) => ({
        latitude: area.center.latitude + y / 6371 / radians,
        longitude: area.center.longitude + x / (6371 * Math.cos(area.center.latitude * radians)) / radians,
    }));
    return [...ring, ring[0]];
}
// Both polygons are convex in the same local projection. Checking every route
// vertex also constrains every line segment, including sparse engine geometry.
export function insideCone(point, ring) {
    let sign = 0;
    for (let i = 1; i < ring.length; i++) {
        const a = ring[i - 1], b = ring[i];
        const cross = (b.longitude - a.longitude) * (point.latitude - a.latitude)
            - (b.latitude - a.latitude) * (point.longitude - a.longitude);
        if (Math.abs(cross) < 1e-12)
            continue;
        const side = Math.sign(cross);
        if (sign && side !== sign)
            return false;
        sign = side;
    }
    return true;
}
