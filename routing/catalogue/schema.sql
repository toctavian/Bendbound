CREATE EXTENSION IF NOT EXISTS postgis;
CREATE TABLE IF NOT EXISTS catalogue_meta (key text PRIMARY KEY, value jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS road_edges (
 id text PRIMARY KEY, osm_way_id bigint NOT NULL, start_node bigint NOT NULL, end_node bigint NOT NULL,
 ref text NOT NULL, name text NOT NULL, highway text NOT NULL, surface text NOT NULL, oneway smallint NOT NULL,
 geom geometry(LineString,4326) NOT NULL, length_m double precision NOT NULL,
 winding double precision NOT NULL, twisty double precision NOT NULL, quality double precision NOT NULL,
 surface_confidence text NOT NULL, graph_version text NOT NULL
);
CREATE INDEX IF NOT EXISTS road_edges_geom ON road_edges USING gist(geom);
CREATE INDEX IF NOT EXISTS road_edges_ref ON road_edges(ref);
CREATE INDEX IF NOT EXISTS road_edges_osm_way ON road_edges(osm_way_id);
CREATE TABLE IF NOT EXISTS recommendation_sources (
 id text PRIMARY KEY, publisher text NOT NULL, url text NOT NULL, checked_at date NOT NULL
);
CREATE TABLE IF NOT EXISTS recommendations (
 source_id text NOT NULL REFERENCES recommendation_sources(id), ref text NOT NULL,
 scope geometry(Polygon,4326) NOT NULL, PRIMARY KEY(source_id,ref)
);
CREATE TABLE IF NOT EXISTS road_sections (
 id text PRIMARY KEY, ref text NOT NULL, name text NOT NULL,
 geom geometry(LineString,4326) NOT NULL, geog geography(LineString,4326) NOT NULL,
 length_m double precision NOT NULL, winding double precision NOT NULL, twisty double precision NOT NULL,
 quality double precision NOT NULL, recommendation_count integer NOT NULL DEFAULT 0,
 frequency_rating double precision, rating double precision NOT NULL,
 source_ids text[] NOT NULL DEFAULT '{}', graph_version text NOT NULL,
 surface_confidence text NOT NULL
);
CREATE INDEX IF NOT EXISTS road_sections_geog ON road_sections USING gist(geog);
CREATE INDEX IF NOT EXISTS road_sections_geom ON road_sections USING gist(geom);
CREATE TABLE IF NOT EXISTS section_edges (
 section_id text NOT NULL REFERENCES road_sections(id), edge_id text NOT NULL REFERENCES road_edges(id),
 PRIMARY KEY(section_id,edge_id)
);
-- Future rider likes are first-party evidence, separate from guide frequency.
CREATE TABLE IF NOT EXISTS section_feedback (
 section_id text NOT NULL REFERENCES road_sections(id), rider_id text NOT NULL,
 rating smallint CHECK(rating BETWEEN 1 AND 5), liked boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(section_id,rider_id)
);
