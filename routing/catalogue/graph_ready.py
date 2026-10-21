"""Check a completed bulk graph and mark matching SQL/graph versions ready."""
import json
import os
from pathlib import Path
import time
import psycopg
from neo4j import GraphDatabase

root=Path(__file__).resolve().parent
manifest=json.loads(root.joinpath('.imports/manifest.json').read_text())
driver=GraphDatabase.driver(os.environ['NEO4J_URI'],auth=('neo4j',os.environ['NEO4J_PASSWORD']))
for attempt in range(90):
    try:driver.verify_connectivity();break
    except Exception:
        if attempt==89:raise
        time.sleep(2)
with driver.session() as session:
    for name,label in [('junction_id','Junction'),('section_id','RoadSection'),('catalogue_id','Catalogue')]:
        session.run(f'CREATE CONSTRAINT {name} IF NOT EXISTS FOR (n:{label}) REQUIRE n.id IS UNIQUE').consume()
    counts=session.run('MATCH (s:RoadSection) RETURN count(s) AS n').single()['n']
    if counts!=manifest['sections']:raise RuntimeError('Graph and PostGIS section counts disagree')
    roads=session.run('MATCH ()-[r:ROAD]->() RETURN count(r) AS n').single()['n']
    if roads<manifest['roadEdges']:raise RuntimeError('Graph import dropped drivable edges')
    session.run('MERGE (c:Catalogue {id:"london-100km"}) SET c.graphVersion=$version,c.turnRestrictionsAuthoritative=false,c.importedAt=datetime()',version=manifest['graphVersion']).consume()
driver.close()
with psycopg.connect(os.environ['DATABASE_URL']) as conn:
    conn.execute("INSERT INTO catalogue_meta VALUES('neo4j_ready',%s::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",(json.dumps(manifest['graphVersion']),))
    conn.execute("INSERT INTO catalogue_meta VALUES('graph_counts',%s::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",(json.dumps({'sections':counts,'directedRoads':roads}),))
print(json.dumps({'graphVersion':manifest['graphVersion'],'sections':counts,'directedRoads':roads}),flush=True)
