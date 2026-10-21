#!/usr/bin/env python3
"""Import complete OSM geometries and a junction topology graph, versioned together."""
import collections
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import time

import osmium
import psycopg
from neo4j import GraphDatabase
from features import features, distance

ROOT = Path(__file__).resolve().parent
LONDON = (-0.1278,51.5074)
pbf = Path(sys.argv[1])
version = json.loads(pbf.with_name('manifest.json').read_text())['sha256']
highways = {'motorway','motorway_link','trunk','trunk_link','primary','primary_link','secondary','secondary_link','tertiary','tertiary_link','unclassified','residential','living_street','service'}


def permitted(tags):
    if tags.get('highway') not in highways: return False
    access = next((tags[k] for k in ['motorcycle','motor_vehicle','vehicle','access'] if k in tags), 'yes')
    return access not in {'no','private','agricultural','forestry','delivery','customers','destination'}


class Junctions(osmium.SimpleHandler):
    def __init__(self):
        super().__init__(); self.count = collections.Counter()
    def way(self, way):
        if way.tags.get('highway') not in highways: return
        tags = dict(way.tags)
        if permitted(tags): self.count.update(set(n.ref for n in way.nodes))


conn = psycopg.connect(os.environ['DATABASE_URL'])
conn.execute(ROOT.joinpath('schema.sql').read_text()); conn.commit()
current = conn.execute("SELECT value FROM catalogue_meta WHERE key='graph_version'").fetchone()
if current and current[0] != version: raise RuntimeError('Use a fresh catalogue for a new map; preserve existing graph/ratings.')
if not current:
    edges_ready=conn.execute("SELECT value FROM catalogue_meta WHERE key='raw_edges_version'").fetchone()
    if edges_ready and edges_ready[0]!=version: raise RuntimeError('Raw road graph version differs from the engine map.')
    if not edges_ready:
        print('Counting shared OSM nodes', flush=True)
        junctions = Junctions(); junctions.apply_file(str(pbf))
        print('Importing road geometry and topology', flush=True)
        with conn.cursor().copy('COPY road_edges (id,osm_way_id,start_node,end_node,ref,name,highway,surface,oneway,geom,length_m,winding,twisty,quality,surface_confidence,graph_version) FROM STDIN') as copy:
            class Roads(osmium.SimpleHandler):
                def way(self, way):
                    if way.tags.get('highway') not in highways: return
                    tags = dict(way.tags)
                    if not permitted(tags): return
                    try: nodes = [(n.ref,(n.lon,n.lat)) for n in way.nodes]
                    except osmium.InvalidLocationError: return
                    if len(nodes)<2: return
                    cuts=[0]+[i for i in range(1,len(nodes)-1) if junctions.count[nodes[i][0]]>1]+[len(nodes)-1]
                    for begin,end in zip(cuts,cuts[1:]):
                        pts=[p for _,p in nodes[begin:end+1]]
                        length,wind,twisty,quality,confidence=features(pts,tags['highway'],tags.get('surface',''))
                        if length < 2: continue
                        oneway=-1 if tags.get('oneway')=='-1' else 1 if tags.get('oneway') in {'yes','1','true'} or tags.get('junction')=='roundabout' else 0
                        if tags.get('oneway:motorcycle')=='no': oneway=0
                        wkt='SRID=4326;LINESTRING('+','.join(f'{x} {y}' for x,y in pts)+')'
                        copy.write_row((f'{way.id}:{begin}:{end}',way.id,nodes[begin][0],nodes[end][0],tags.get('ref',''),tags.get('name',''),tags['highway'],tags.get('surface',''),oneway,wkt,length,wind,twisty,quality,confidence,version))
            Roads().apply_file(str(pbf),locations=True,idx='flex_mem')
        del junctions
        conn.execute("INSERT INTO catalogue_meta VALUES('raw_edges_version',%s::jsonb)",(json.dumps(version),))
        conn.commit()
    # Curated facts with citations, never copied third-party tracks/reviews.
    evidence=json.loads(ROOT.joinpath('evidence.json').read_text())
    for src in evidence['sources']:
        conn.execute('INSERT INTO recommendation_sources VALUES(%s,%s,%s,%s) ON CONFLICT DO NOTHING',(src['id'],src['publisher'],src['url'],evidence['checkedAt']))
        for ref in src['refs']:
            conn.execute('INSERT INTO recommendations VALUES(%s,%s,ST_MakeEnvelope(%s,%s,%s,%s,4326)) ON CONFLICT DO NOTHING',(src['id'],ref,*src.get('scopes',{}).get(ref,src['bbox'])))
    conn.commit()
    print('Preparing indexed eligible road geometry', flush=True)
    conn.execute('ANALYZE road_edges');conn.commit()
    conn.execute("SET statement_timeout='15min'")
    conn.execute("""
      CREATE TEMP TABLE eligible ON COMMIT DROP AS
      SELECT *,CASE WHEN ref='' THEN coalesce(nullif(name,''),id) ELSE ref||':'||name END AS group_key
      FROM road_edges WHERE quality>=1.0 AND highway IN ('primary','secondary','tertiary','unclassified')
      AND surface_confidence!='unpaved' AND length_m>10
      AND geom && ST_Transform(ST_Buffer(ST_Transform(ST_SetSRID(ST_Point(-0.1278,51.5074),4326),27700),99500),4326)
      AND ST_CoveredBy(ST_Transform(geom,27700),ST_Buffer(ST_Transform(ST_SetSRID(ST_Point(-0.1278,51.5074),4326),27700),99500));
      CREATE INDEX eligible_geom ON eligible USING gist(geom);
      CREATE INDEX eligible_group ON eligible(group_key);
      ANALYZE eligible;
    """)
    eligible_count=conn.execute('SELECT count(*) FROM eligible').fetchone()[0]
    print(f'Building complete sections from {eligible_count} eligible edges',flush=True)
    conn.execute("""
      CREATE TEMP TABLE chunks ON COMMIT DROP AS
      WITH merged AS (
        SELECT group_key,min(ref) ref,min(name) name,ST_LineMerge(ST_UnaryUnion(ST_Collect(geom))) geom
        FROM eligible GROUP BY group_key
      ), lines AS (
        SELECT group_key,ref,name,(ST_Dump(geom)).geom AS geom FROM merged
      ), pieces AS (
        SELECT group_key,ref,name,ST_LineSubstring(geom,i::float/n,(i+1)::float/n) geom
        FROM lines CROSS JOIN LATERAL (SELECT greatest(1,ceil(ST_Length(geom::geography)/5000)::int) n) parts
        CROSS JOIN LATERAL generate_series(0,n-1) i
      ) SELECT *, 'section-'||md5(ST_AsEWKB(geom)::text) AS id FROM pieces
      WHERE ST_Length(geom::geography)>=500;
      CREATE INDEX chunks_geom ON chunks USING gist(geom);
      ANALYZE chunks;
    """)
    print(f"Scoring {conn.execute('SELECT count(*) FROM chunks').fetchone()[0]} complete sections",flush=True)
    conn.execute("""
      INSERT INTO road_sections
      SELECT c.id,c.ref,coalesce(nullif(c.name,''),nullif(c.ref,''),'Unnamed road'),c.geom,c.geom::geography,
        ST_Length(c.geom::geography),least(5.0,m.winding),least(5.0,m.twisty),least(5.0,m.quality),0,NULL,least(5.0,m.quality),'{}',%s,m.confidence
      FROM chunks c CROSS JOIN LATERAL (
        SELECT sum(e.quality*e.matched_m)/sum(e.matched_m) AS quality,
          sum(e.winding*e.matched_m)/sum(e.matched_m) AS winding,
          sum(e.twisty*e.matched_m)/sum(e.matched_m) AS twisty,
          CASE WHEN bool_and(e.surface_confidence='mapped-paved') THEN 'mapped-paved' ELSE 'unknown' END confidence
        FROM (SELECT e.*,ST_Length(ST_Intersection(e.geom,c.geom)::geography) matched_m
          FROM eligible e WHERE e.group_key=c.group_key AND e.geom && c.geom) e WHERE matched_m>1
      ) m WHERE m.quality IS NOT NULL ON CONFLICT DO NOTHING
    """,(version,))
    print('Linking sections to original OSM edges',flush=True)
    conn.execute("""INSERT INTO section_edges
      SELECT c.id,e.id FROM chunks c JOIN eligible e ON c.group_key=e.group_key AND c.geom && e.geom
      JOIN road_sections s ON s.id=c.id
      WHERE ST_Length(ST_Intersection(c.geom,e.geom)::geography)>1 ON CONFLICT DO NOTHING""")
    conn.execute("""UPDATE road_sections s SET source_ids=x.ids,recommendation_count=cardinality(x.ids),
      frequency_rating=1+4.0*cardinality(x.ids)/(cardinality(x.ids)+2),
      rating=quality*0.7+(1+4.0*cardinality(x.ids)/(cardinality(x.ids)+2))*0.3
      FROM (SELECT s.id,array_agg(DISTINCT r.source_id) ids FROM road_sections s JOIN recommendations r
        ON s.ref=r.ref AND ST_CoveredBy(s.geom,r.scope) GROUP BY s.id) x WHERE s.id=x.id""")
    conn.execute("INSERT INTO catalogue_meta VALUES('graph_version',%s::jsonb) ON CONFLICT DO NOTHING",(json.dumps(version),))
    conn.execute("INSERT INTO catalogue_meta VALUES('area',%s::jsonb) ON CONFLICT DO NOTHING",(json.dumps({'center':{'latitude':51.5074,'longitude':-0.1278},'radiusKm':100}),))
    conn.commit()
    conn.execute('ANALYZE');conn.commit()

if os.environ.get('NEO4J_IMPORT_MODE')=='bulk':
    from graph_export import export_graph
    export_graph(conn,ROOT/'.imports',version)
    conn.close()
    sys.exit(0)

print('Synchronising junction topology to Neo4j',flush=True)
driver=GraphDatabase.driver(os.environ['NEO4J_URI'],auth=('neo4j',os.environ['NEO4J_PASSWORD']))
with driver.session() as session:
    session.run('CREATE CONSTRAINT junction_id IF NOT EXISTS FOR (j:Junction) REQUIRE j.id IS UNIQUE').consume()
    session.run('CREATE CONSTRAINT section_id IF NOT EXISTS FOR (s:RoadSection) REQUIRE s.id IS UNIQUE').consume()
    session.run('CREATE CONSTRAINT catalogue_id IF NOT EXISTS FOR (c:Catalogue) REQUIRE c.id IS UNIQUE').consume()
    # Idempotent full graph copy, keyed by source OSM nodes. Parallel ways
    # are distinct; crossing line geometries are not falsely made junctions.
    with conn.cursor(name='edges') as cur:
        cur.execute('SELECT id,start_node,end_node,ref,length_m,oneway,quality,ST_X(ST_StartPoint(geom)),ST_Y(ST_StartPoint(geom)),ST_X(ST_EndPoint(geom)),ST_Y(ST_EndPoint(geom)) FROM road_edges ORDER BY id')
        while rows:=cur.fetchmany(1500):
            items=[dict(zip(['id','start','end','ref','lengthM','oneway','rating','sx','sy','ex','ey'],r)) for r in rows]
            session.run('''UNWIND $rows AS r
              MERGE (a:Junction {id:r.start}) SET a.location=point({longitude:r.sx,latitude:r.sy})
              MERGE (b:Junction {id:r.end}) SET b.location=point({longitude:r.ex,latitude:r.ey})
              FOREACH (_ IN CASE WHEN r.oneway>=0 THEN [1] ELSE [] END |
                MERGE (a)-[e:ROAD {id:r.id}]->(b) SET e.lengthM=r.lengthM,e.ref=r.ref,e.rating=r.rating,e.graphVersion=$version)
              FOREACH (_ IN CASE WHEN r.oneway<=0 THEN [1] ELSE [] END |
                MERGE (b)-[e:ROAD {id:r.id+'-reverse'}]->(a) SET e.lengthM=r.lengthM,e.ref=r.ref,e.rating=r.rating,e.graphVersion=$version)
            ''',rows=items,version=version).consume()
    conn.commit()
    with conn.cursor(name='sections') as cur:
        cur.execute('SELECT s.id,s.ref,s.rating,se.edge_id,e.start_node,e.end_node FROM road_sections s JOIN section_edges se ON se.section_id=s.id JOIN road_edges e ON e.id=se.edge_id')
        while rows:=cur.fetchmany(1500):
            items=[dict(zip(['id','ref','rating','edge','start','end'],r)) for r in rows]
            session.run('''UNWIND $rows AS r MERGE (s:RoadSection {id:r.id}) SET s.ref=r.ref,s.rating=r.rating,s.graphVersion=$version
              WITH s,r MATCH (a:Junction {id:r.start}),(b:Junction {id:r.end})
              MERGE (s)-[:TOUCHES]->(a) MERGE (s)-[:TOUCHES]->(b)''',rows=items,version=version).consume()
    session.run('MERGE (c:Catalogue {id:"london-100km"}) SET c.graphVersion=$version,c.turnRestrictionsAuthoritative=false,c.importedAt=datetime()',version=version).consume()
conn.commit()
conn.execute("INSERT INTO catalogue_meta VALUES('neo4j_ready',%s::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",(json.dumps(version),));conn.commit()
counts=conn.execute('SELECT (SELECT count(*) FROM road_edges),(SELECT count(*) FROM road_sections),(SELECT count(*) FROM road_sections WHERE recommendation_count>0)').fetchone()
print(json.dumps({'graphVersion':version,'edges':counts[0],'sections':counts[1],'recommendedSections':counts[2]}),flush=True)
driver.close();conn.close()
