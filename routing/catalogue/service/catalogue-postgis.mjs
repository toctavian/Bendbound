import pg from 'pg';
import { RoutingError } from '../../service/engine.mjs';
import { createCache } from './cache.mjs';
import { measureRoadUse, measureIdentifiedGeometry } from './road-use.mjs';

const pool = new pg.Pool({ max: 3, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
export async function graphStatus() {
  const response = await fetch(`${process.env.NEO4J_URL}/db/neo4j/tx/commit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`neo4j:${process.env.NEO4J_PASSWORD}`).toString('base64')}` },
    body: JSON.stringify({ statements: [{ statement: 'MATCH (c:Catalogue {id:"london-100km"}) RETURN c.graphVersion AS version' }] }),
    signal: AbortSignal.timeout(3000),
  });
  const body = await response.json();
  if (!response.ok || body.errors?.length || !body.results?.[0]?.data?.length) throw new RoutingError('GRAPH_UNAVAILABLE', 'Road connectivity is not ready.', 503);
  return body.results[0].data[0].row[0];
}
export function createStatus({query=(sql,params)=>pool.query(sql,params),graph=graphStatus,mode=process.env.GRAPH_MODE||'required',countsCache=createCache({maxEntries:1})}={}) {
return async()=>{
  const { rows } = await query(`SELECT
    (SELECT value FROM catalogue_meta WHERE key='graph_version') AS version,
    (SELECT value FROM catalogue_meta WHERE key='neo4j_ready') AS graph_version`);
  const data=rows[0];
  const cached=countsCache.get(data.version);
  const counts=cached?.value || (await query(`SELECT
    (SELECT count(*)::int FROM road_sections) AS sections,
    (SELECT count(*)::int FROM road_sections WHERE recommendation_count>0) AS recommended_sections,
    (SELECT count(*)::int FROM road_edges) AS edges`)).rows[0];
  if(!cached)countsCache.set(data.version,counts);
  const graphVersion=mode==='on-demand'?data.graph_version:await graph();
  if (!counts.sections || !data.version || data.version !== graphVersion || data.graph_version !== graphVersion) throw new RoutingError('CATALOGUE_UNAVAILABLE', 'Road catalogue is not ready.', 503);
  return {...data,...counts,connectivity:{mode,status:mode==='on-demand'?'prepared-on-demand':'online'}};
};
}
export const status=createStatus();
function section(row) {
  return { id: row.id, name: row.name, ref: row.ref, lengthKm: row.length_m / 1000,
    rating: row.rating, quality: row.quality, winding: row.winding, twisty: row.twisty,
    recommendationCount: row.recommendation_count, frequencyRating: row.frequency_rating,
    ratingBasis: row.recommendation_count ? 'geometry-and-guide-frequency' : 'geometry',
    surfaceConfidence: row.surface_confidence, sources: row.sources || [], graphVersion: row.graph_version,
    geometry: row.geometry };
}
const nearbyCache=createCache({maxBytes:8*1024*1024});
export async function nearby({ center, radiusKm, limit = 30, areaPolygon = null }) {
  const key=JSON.stringify([center.latitude,center.longitude,radiusKm,limit,areaPolygon]);
  const cached=nearbyCache.get(key);if(cached)return cached.value;
  const { rows } = await pool.query(`SELECT s.*,ST_AsGeoJSON(s.geom)::json AS geometry,
    coalesce((SELECT json_agg(json_build_object('publisher',publisher,'url',url))
      FROM recommendation_sources WHERE id=ANY(s.source_ids)),'[]') AS sources
    FROM road_sections s WHERE ST_DWithin(s.geog,ST_SetSRID(ST_Point($1,$2),4326)::geography,$3)
    AND ($5::text IS NULL OR ST_CoveredBy(s.geom,ST_SetSRID(ST_GeomFromGeoJSON($5),4326)))
    ORDER BY s.recommendation_count DESC,s.rating DESC,ST_Distance(s.geog,ST_SetSRID(ST_Point($1,$2),4326)::geography),s.id LIMIT $4`,
  [center.longitude, center.latitude, radiusKm * 1000, limit, areaPolygon ? JSON.stringify({type:'Polygon',coordinates:[areaPolygon.map(p=>[p.longitude,p.latitude])]}) : null]);
  const sections=rows.map(section);nearbyCache.set(key,sections);return sections;
}
export async function matchRoute(points, wayIds) {
  const geometry = JSON.stringify({ type: 'LineString', coordinates: points.map(p => [p.longitude, p.latitude]) });
  const { rows } = await pool.query(`WITH route AS MATERIALIZED (
    SELECT ST_Buffer(geom,12) corridor,ST_Transform(ST_Expand(geom,12),4326) bounds
    FROM (SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1),4326),27700) geom) g
  ), matches AS MATERIALIZED (
    SELECT s.*,ST_Length(ST_Intersection(ST_Transform(s.geom,27700),r.corridor)) AS matched_m
    FROM road_sections s CROSS JOIN route r
    WHERE s.geom && r.bounds
    AND EXISTS(SELECT 1 FROM section_edges se JOIN road_edges e ON e.id=se.edge_id
      WHERE se.section_id=s.id AND e.osm_way_id=ANY($2::bigint[]))
  ) SELECT m.*,coalesce((SELECT json_agg(json_build_object('publisher',publisher,'url',url))
      FROM recommendation_sources WHERE id=ANY(m.source_ids)),'[]') AS sources
    FROM matches m WHERE matched_m>=length_m*0.8 ORDER BY matched_m*rating DESC LIMIT 60`, [geometry, wayIds]);
  // Exact way identity gates spatial matching. Count each section once; retain
  // partial traversal explicitly instead of claiming a whole numbered road.
  return rows.map(row => ({ ...section(row), traversedKm: Math.min(row.length_m, row.matched_m) / 1000,
    coverage: Math.min(1, row.matched_m / row.length_m), fullSection: row.matched_m / row.length_m >= 0.98 }));
}
export async function close() { await pool.end(); }

export const roadUseSQL=`WITH original AS MATERIALIZED (
  SELECT geom
  FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON($2),4326) geom) g
), physical AS MATERIALIZED (
  SELECT id,osm_way_id,geom,length_m FROM road_edges
  WHERE osm_way_id=ANY($3::bigint[]) AND geom && ST_Expand((SELECT geom FROM original),0.00001)
), segments AS MATERIALIZED (
  SELECT (value->>'wayId')::bigint way_id,
    ST_SetSRID(ST_MakeLine(ST_Point((value->'a'->>0)::float8,(value->'a'->>1)::float8),
      ST_Point((value->'b'->>0)::float8,(value->'b'->>1)::float8)),4326) geom
  FROM jsonb_array_elements($1::jsonb)
), projected AS MATERIALIZED (
  SELECT way_id,geom,ST_Transform(geom,27700) line,
    ST_Buffer(ST_Transform(geom,27700),12) corridor FROM segments
), intervals AS (
  SELECT e.id edge_id,e.length_m,
    least(ST_LineLocatePoint(e.geom,ST_StartPoint(p.geom)),ST_LineLocatePoint(e.geom,ST_EndPoint(p.geom))) from_fraction,
    greatest(ST_LineLocatePoint(e.geom,ST_StartPoint(p.geom)),ST_LineLocatePoint(e.geom,ST_EndPoint(p.geom))) to_fraction
  FROM projected p JOIN physical e ON e.osm_way_id=p.way_id
    AND e.geom && ST_Expand(p.geom,0.00001)
  WHERE ST_CoveredBy(ST_LineSubstring(ST_Transform(e.geom,27700),
    least(ST_LineLocatePoint(e.geom,ST_StartPoint(p.geom)),ST_LineLocatePoint(e.geom,ST_EndPoint(p.geom))),
    greatest(ST_LineLocatePoint(e.geom,ST_StartPoint(p.geom)),ST_LineLocatePoint(e.geom,ST_EndPoint(p.geom)))),p.corridor)
) SELECT * FROM intervals WHERE to_fraction>from_fraction AND (to_fraction-from_fraction)*length_m>0.01`;
export async function roadUse(segments,totalKm,points) {
  const original=JSON.stringify({type:'LineString',coordinates:points.map(p=>[p.longitude,p.latitude])});
  const wayIds=[...new Set(segments.map(s=>s.wayId))];
  const {rows}=await pool.query(roadUseSQL,[JSON.stringify(segments),original,wayIds]);
  const measured=measureRoadUse(rows,totalKm),geometry=measureIdentifiedGeometry(segments,totalKm);
  const repeatedKm=Math.max(measured.repeatedKm,geometry.repeatedKm),maxTraversals=Math.max(measured.maxTraversals,geometry.maxTraversals);
  return {...measured,repeatedKm,repeatedRatio:repeatedKm/totalKm,maxTraversals,identityVerification:'postgis-and-osm-geometry',
    valid:measured.valid && maxTraversals<=2 && repeatedKm/totalKm<=0.1+1e-9};
}
