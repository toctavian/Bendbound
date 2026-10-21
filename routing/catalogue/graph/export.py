"""One-time migration of catalogue metadata onto Valhalla's own edge geometry.
Run with the pinned Valhalla Python bindings after valhalla_ways_to_edges.
PostGIS is a migration input only; neither the output nor serving needs it.
"""
import argparse
import gzip
import hashlib
import json
import math
import tarfile
import sqlite3
from pathlib import Path
from valhalla.baldr import GraphId
from valhalla.baldr.utils import GraphUtils

SCALE = 111195

def length(points):
    return sum(math.hypot((b[0]-a[0])*math.cos(math.radians((a[1]+b[1])/2)), b[1]-a[1])*SCALE/1000 for a,b in zip(points,points[1:]))

def project(point, line):
    scale = math.cos(math.radians(point[1]))
    best = (float('inf'), 0)
    offset = 0
    for a,b in zip(line,line[1:]):
        x,y=(b[0]-a[0])*scale*SCALE,(b[1]-a[1])*SCALE
        u,v=(point[0]-a[0])*scale*SCALE,(point[1]-a[1])*SCALE
        span=math.hypot(x,y)
        t=max(0,min(1,(u*x+v*y)/(span*span))) if span else 0
        candidate=(math.hypot(u-t*x,v-t*y),offset+t*span)
        if candidate[0]<best[0]: best=candidate
        offset+=span
    return best

def encode(points):
    lat=lon=0;out=[]
    for x,y in points:
        a,b=round(y*1e6),round(x*1e6)
        for delta in (a-lat,b-lon):
            v=~(delta<<1) if delta<0 else delta<<1
            while v>=32:out.append(chr((32|(v&31))+63));v>>=5
            out.append(chr(v+63))
        lat,lon=a,b
    return ''.join(out)

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--config', default='/data/valhalla.json')
    args=parser.parse_args()
    config=json.load(open(args.config))
    config['mjolnir']['max_cache_size']=512*1024*1024
    config['mjolnir']['use_lru_mem_cache']=True
    config['mjolnir']['lru_mem_cache_hard_control']=True
    reader=GraphUtils(config)
    if Path(args.output).suffix == '.sqlite':
        from export_sqlite import build
        build(args.source, args.output, config, reader, GraphId, project, length, encode)
        return
    sources=[json.loads(line) for line in open(args.source)]
    wanted={str(w) for s in sources for w in s['wayIds']}
    ways={};known_upper=set()
    for line in open(Path(config['mjolnir']['tile_dir'])/'way_edges.txt'):
        fields=line.strip().split(',')
        known_upper.update(fields[i] for i in range(2,len(fields),2) if (int(fields[i])&7)<2)
        if fields[0] in wanted:
            edges=[];seen={}
            for i in range(1,len(fields),2):
                edge_id=fields[i+1]
                shape=[[round(lon,6),round(lat,6)] for lon,lat in reader.get_edge_shape(GraphId(int(edge_id)))]
                if len(shape)<2: continue
                canonical=min(shape,list(reversed(shape)))
                physical=hashlib.sha256(json.dumps(canonical,separators=(',',':')).encode()).hexdigest()
                key=fields[0]+':'+physical
                if key in seen:
                    seen[key]['edgeIds'].append(edge_id)
                    continue
                item={'physicalId':key,'coordinates':shape,'edgeIds':[edge_id]}
                seen[key]=item
                edges.append(item)
            ways[fields[0]]=edges
    sections=[];unmapped=[]
    for source in sources:
        original=source['geometry']['coordinates']
        chosen=[]
        for way in source['wayIds']:
            for edge in ways.get(str(way),[]):
                shape=edge['coordinates']
                projected=[project(p,original) for p in shape]
                # Include entire native edges only. Never claim an external line
                # as Valhalla geometry or extend a rating onto distant sections.
                if max(p[0] for p in projected)>25: continue
                if projected[0][1]>projected[-1][1]:shape=list(reversed(shape))
                chosen.append((min(p[1] for p in projected),edge['physicalId'],shape,edge['edgeIds'],edge['coordinates']))
        chosen.sort(key=lambda e:e[0])
        groups=[]
        for _,physical,shape,edge_ids,cost_line in chosen:
            if groups and length([groups[-1]['geometry']['coordinates'][-1],shape[0]])<0.001:
                groups[-1]['geometry']['coordinates'].extend(shape[1:])
                groups[-1]['physicalIds'].append(physical)
                groups[-1]['edgeIds'].extend(edge_ids)
                groups[-1]['costLines'].append(cost_line)
                groups[-1]['lengthKm']+=length(shape)
            else:
                groups.append({'geometry':{'type':'LineString','coordinates':shape},'physicalIds':[physical],'edgeIds':edge_ids.copy(),'costLines':[cost_line],'lengthKm':length(shape)})
        if not groups:unmapped.append(source['id'])
        metadata={k:v for k,v in source.items() if k not in ['geometry','wayIds','lengthKm']}
        for i,group in enumerate(groups):
            sections.append({**metadata,**group,'id':source['id'] if len(groups)==1 else source['id']+'-'+str(i),'sourceSectionId':source['id']})
    # Shortcuts concatenate the same native vertex sequences. Attach ratings
    # to their exact covered fractions offline; serving needs no edge walking.
    def segment_key(a,b):return tuple(sorted((tuple(a),tuple(b))))
    segment_sections={}
    for index,s in enumerate(sections):
        s['shortcutRanges']=[]
        for a,b in zip(s['geometry']['coordinates'],s['geometry']['coordinates'][1:]):
            segment_sections.setdefault(segment_key(a,b),set()).add(index)
    shortcut_count=0
    with tarfile.open(config['mjolnir']['tile_extract'],'r:') as archive:
        for entry in archive:
            if not entry.name.endswith('.gph'):continue
            tile=GraphId.from_tile_path(entry.name)
            if tile.level()>1:continue
            count=reader.get_graph_tile_header(tile).directededgecount
            for n in range(count):
                graph_id=tile+n;edge_id=str(graph_id.value)
                if edge_id in known_upper:continue
                try:shape=[[round(x,6),round(y,6)] for x,y in reader.get_edge_shape(graph_id)]
                except RuntimeError:continue
                spans=[length([a,b]) for a,b in zip(shape,shape[1:])];total=sum(spans)
                if total<=0:continue
                offset=0;ranges={}
                for (a,b),span in zip(zip(shape,shape[1:]),spans):
                    start,end=offset/total,(offset+span)/total
                    for index in segment_sections.get(segment_key(a,b),()):
                        chunks=ranges.setdefault(index,[])
                        if chunks and abs(chunks[-1][1]-start)<1e-8:chunks[-1][1]=end
                        else:chunks.append([start,end])
                    offset+=span
                if ranges:shortcut_count+=1
                for index,chunks in ranges.items():
                    sections[index]['shortcutRanges'].extend([edge_id,a,min(1,b)] for a,b in chunks if b-a>1e-8)
    print(json.dumps({'event':'ratings.shortcuts','nativeShortcutEdges':shortcut_count}),flush=True)
    digest=hashlib.sha256()
    with open(config['mjolnir']['tile_extract'],'rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''):digest.update(chunk)
    version=digest.hexdigest()
    for s in sections:s['graphVersion']=version
    native_edges={}
    for edges in ways.values():
        for e in edges:native_edges[e['physicalId']]=[e['physicalId'],encode(e['coordinates']),e['edgeIds']]
    needed={key for s in sections for key in s['physicalIds']}
    for s in sections:
        coords=s.pop('geometry')['coordinates']
        s['shape']=encode(coords)
        s['bbox']=[min(p[0] for p in coords),min(p[1] for p in coords),max(p[0] for p in coords),max(p[1] for p in coords)]
        s.pop('edgeIds');s.pop('costLines')
    output={'schemaVersion':2,'nativeEdges':[native_edges[key] for key in sorted(needed)],'graphVersion':version,'valhallaVersion':'3.9.0','sourceSections':len(sources),'unmappedSections':unmapped,'sections':sections}
    destination=Path(args.output);temporary=destination.with_suffix('.tmp')
    if destination.suffix=='.sqlite':
        if temporary.exists():temporary.unlink()
        db=sqlite3.connect(temporary)
        db.executescript('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE sections(id TEXT UNIQUE,value TEXT); CREATE VIRTUAL TABLE bounds USING rtree(id,minx,maxx,miny,maxy); CREATE TABLE native_edges(id TEXT PRIMARY KEY,value TEXT); CREATE TABLE membership(physical TEXT,section INTEGER); CREATE INDEX membership_physical ON membership(physical);')
        summary={'schemaVersion':3,'graphVersion':version,'sections':len(sections),'recommendedSections':sum(s.get('recommendationCount',0)>0 for s in sections),'nativeEdges':len(needed),'sourceSections':len(sources),'unmappedSections':len(unmapped)}
        db.execute('INSERT INTO metadata VALUES(?,?)',('summary',json.dumps(summary)))
        for row in output['nativeEdges']:db.execute('INSERT INTO native_edges VALUES(?,?)',(row[0],json.dumps(row,separators=(',',':'))))
        for s in sections:
            row=db.execute('INSERT INTO sections VALUES(?,?)',(s['id'],json.dumps(s,separators=(',',':')))).lastrowid
            west,south,east,north=s['bbox'];db.execute('INSERT INTO bounds VALUES(?,?,?,?,?)',(row,west,east,south,north))
            db.executemany('INSERT INTO membership VALUES(?,?)',[(physical,row) for physical in s['physicalIds']])
        db.commit();assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok';db.close()
    else:
        with gzip.open(temporary,'wt') as f:json.dump(output,f,separators=(',',':'))
    temporary.replace(destination)
    print(json.dumps({'event':'ratings.exported','graphVersion':version,'sourceSections':len(sources),'sections':len(sections),'unmappedSections':len(unmapped),'unmappedRecommendedSections':sum(s['recommendationCount']>0 for s in sources if s['id'] in unmapped),'ratedPhysicalEdges':len(needed),'sectionEdgeMemberships':sum(len(s['physicalIds']) for s in sections)}))

if __name__=='__main__':main()
