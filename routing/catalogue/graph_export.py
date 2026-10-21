"""Export a clean initial graph for Neo4j's offline bulk loader."""
import json
from pathlib import Path


def export_graph(conn,directory,version):
    directory=Path(directory);directory.mkdir(parents=True,exist_ok=True)
    def write(name,header,query):
        print('Exporting '+name,flush=True)
        with (directory/name).open('wb') as output:
            output.write((header+'\n').encode())
            with conn.cursor().copy('COPY ('+query+') TO STDOUT WITH (FORMAT CSV)') as copy:
                for block in copy:output.write(block)
        conn.commit()
    write('junctions.csv','id:ID(Junction),longitude:double,latitude:double,:LABEL',"""
      SELECT DISTINCT ON(id) id,x,y,'Junction' FROM (
        SELECT start_node id,ST_X(ST_StartPoint(geom)) x,ST_Y(ST_StartPoint(geom)) y FROM road_edges
        UNION ALL SELECT end_node,ST_X(ST_EndPoint(geom)),ST_Y(ST_EndPoint(geom)) FROM road_edges
      ) p ORDER BY id
    """)
    write('roads.csv',':START_ID(Junction),:END_ID(Junction),id,osmWayId:long,ref,lengthM:double,rating:double,graphVersion,:TYPE',"""
      SELECT start_node,end_node,id,osm_way_id,ref,length_m,quality,graph_version,'ROAD' FROM road_edges WHERE oneway>=0
      UNION ALL SELECT end_node,start_node,id||'-reverse',osm_way_id,ref,length_m,quality,graph_version,'ROAD' FROM road_edges WHERE oneway<=0
    """)
    write('sections.csv','id:ID(Section),ref,rating:double,quality:double,recommendationCount:int,graphVersion,:LABEL',"SELECT id,ref,rating,quality,recommendation_count,graph_version,'RoadSection' FROM road_sections")
    write('touches.csv',':START_ID(Section),:END_ID(Junction),:TYPE',"""
      SELECT DISTINCT section_id,start_node,'TOUCHES' FROM section_edges se JOIN road_edges e ON e.id=se.edge_id
      UNION SELECT DISTINCT section_id,end_node,'TOUCHES' FROM section_edges se JOIN road_edges e ON e.id=se.edge_id
    """)
    counts=conn.execute('SELECT (SELECT count(*) FROM road_edges),(SELECT count(*) FROM road_sections)').fetchone()
    conn.commit()
    (directory/'manifest.json').write_text(json.dumps({'graphVersion':version,'roadEdges':counts[0],'sections':counts[1]},indent=2)+'\n')
