-- Run with psql -v ON_ERROR_STOP=1 against the staging catalogue.
BEGIN;
DO $$
DECLARE
  radius_count integer;
  midpoint_count integer;
  recommended_count integer;
  raw_version text;
BEGIN
  -- This road crosses the search area although its midpoint is far outside.
  SELECT count(*) INTO radius_count FROM (SELECT
    ST_GeogFromText('LINESTRING(-0.1278 51.5074,0.3722 51.5074)') AS line) r
    WHERE ST_DWithin(r.line,ST_GeogFromText('POINT(-0.1278 51.5074)'),1000);
  SELECT count(*) INTO midpoint_count FROM (SELECT
    ST_LineInterpolatePoint(ST_GeomFromText('LINESTRING(-0.1278 51.5074,0.3722 51.5074)',4326),0.5)::geography AS midpoint) r
    WHERE ST_DWithin(r.midpoint,ST_GeogFromText('POINT(-0.1278 51.5074)'),1000);
  IF radius_count!=1 OR midpoint_count!=0 THEN RAISE EXCEPTION 'Full-line radius query failed'; END IF;
  IF EXISTS(SELECT 1 FROM road_sections WHERE ST_NPoints(geom)<2 OR length_m<500 OR length_m>5100 OR rating<0 OR rating>5) THEN
    RAISE EXCEPTION 'Invalid complete road geometry or rating'; END IF;
  SELECT count(*) INTO recommended_count FROM road_sections WHERE recommendation_count>0;
  IF recommended_count=0 THEN RAISE EXCEPTION 'No corroborated recommendation data'; END IF;
  IF EXISTS(SELECT 1 FROM road_sections WHERE recommendation_count!=cardinality(source_ids)
    OR (recommendation_count=0 AND frequency_rating IS NOT NULL)
    OR (recommendation_count>0 AND abs(frequency_rating-(1+4.0*recommendation_count/(recommendation_count+2)))>0.000001)) THEN
    RAISE EXCEPTION 'Recommendation counts or frequency scores disagree'; END IF;
  IF EXISTS(SELECT 1 FROM road_sections s WHERE NOT EXISTS(SELECT 1 FROM section_edges e WHERE e.section_id=s.id)) THEN
    RAISE EXCEPTION 'Section has no original OSM road identity'; END IF;
  SELECT value#>>'{}' INTO raw_version FROM catalogue_meta WHERE key='graph_version';
  IF EXISTS(SELECT 1 FROM road_sections WHERE graph_version!=raw_version) THEN
    RAISE EXCEPTION 'Mixed map versions'; END IF;
END $$;
ROLLBACK;
EXPLAIN (ANALYZE, BUFFERS) SELECT id FROM road_sections
WHERE ST_DWithin(geog,ST_SetSRID(ST_Point(-0.3297,51.2328),4326)::geography,1000);
