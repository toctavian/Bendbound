"""Original, conservative geometric scoring; not a rider-popularity estimate."""
import math


def distance(a, b):
    lat1, lat2 = math.radians(a[1]), math.radians(b[1])
    h = math.sin((lat2-lat1)/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin(math.radians(b[0]-a[0])/2)**2
    return 6371000 * 2 * math.asin(min(1, math.sqrt(h)))


def features(points, highway, surface):
    length = sum(distance(a,b) for a,b in zip(points,points[1:]))
    # Resample at 30 m to avoid OSM vertex density determining bend counts.
    sampled = [points[0]]
    remaining = 30.0
    for a,b in zip(points,points[1:]):
        d = distance(a,b)
        while d >= remaining and d > 0:
            f = remaining / d
            a = (a[0]+(b[0]-a[0])*f, a[1]+(b[1]-a[1])*f)
            sampled.append(a)
            d -= remaining
            remaining = 30.0
        remaining -= d
    winding = tight = 0.0
    for a,b,c in zip(sampled,sampled[1:],sampled[2:]):
        scale = math.cos(math.radians(b[1]))
        u = ((b[0]-a[0])*scale,b[1]-a[1]); v = ((c[0]-b[0])*scale,c[1]-b[1])
        angle = abs(math.atan2(u[0]*v[1]-u[1]*v[0],u[0]*v[0]+u[1]*v[1]))
        # Ignore near-straight noise, hairpin spikes and turn-like junction corners.
        if math.radians(3) <= angle <= math.radians(65):
            winding += angle
            if angle >= math.radians(12): tight += angle
    km = max(0.1, length/1000)
    winding = min(5.0, winding/km*1.2)
    tight = min(5.0, tight/km*1.5)
    suitability = {'primary':0.65,'secondary':0.9,'tertiary':1.0,'unclassified':0.8,'residential':0.15,'service':0.05}.get(highway,0)
    unpaved = surface in {'gravel','unpaved','dirt','ground','sand','mud','grass','compacted','fine_gravel'}
    confidence = 'unpaved' if unpaved else 'mapped-paved' if surface in {'asphalt','paved','concrete','concrete:plates'} else 'unknown'
    quality = min(5.0, (0.75*max(winding,tight)+1.25)*suitability*(0 if unpaved else 1))
    return length,winding,tight,quality,confidence
