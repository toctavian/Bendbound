#!/usr/bin/env python3
"""Local, streaming UK geometric ratings. Existing cited sections remain intact.
New sections use the app's original geometry scorer and claim no online popularity.
"""
import argparse,gzip,json,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import osmium
from features import features,distance

def build(pbf,existing,output):
    retained=[];known=set()
    with gzip.open(existing,'rt') as source:
        for line in source:
            section=json.loads(line);retained.append(section)
            known.update(str(w) for w in section['wayIds'])
    count=0
    destination=Path(output);temporary=destination.with_suffix('.tmp')
    with temporary.open('w') as out:
        for s in retained:out.write(json.dumps(s,separators=(',',':'))+'\n')
        class Roads(osmium.SimpleHandler):
            def way(self,way):
                nonlocal count
                tags=dict(way.tags)
                if str(way.id) in known or tags.get('highway') not in {'primary','secondary','tertiary','unclassified'}:return
                access=next((tags[k] for k in ['motorcycle','motor_vehicle','vehicle','access'] if k in tags),'yes')
                if access in {'no','private','agricultural','forestry','delivery','customers','destination'}:return
                try:points=[(n.lon,n.lat) for n in way.nodes]
                except osmium.InvalidLocationError:return
                if len(points)<2:return
                # Keep entire OSM way pieces, split at real vertices at <=5 km.
                pieces=[];piece=[points[0]];span=0
                for a,b in zip(points,points[1:]):
                    piece.append(b);span+=distance(a,b)
                    if span>=5000:pieces.append(piece);piece=[b];span=0
                if len(piece)>1:pieces.append(piece)
                for i,pts in enumerate(pieces):
                    metres,winding,twisty,quality,confidence=features(pts,tags['highway'],tags.get('surface',''))
                    if metres<500 or quality<1.25 or confidence=='unpaved':continue
                    s={'id':f'uk-way-{way.id}-{i}','name':tags.get('name') or tags.get('ref') or 'Unnamed road','ref':tags.get('ref',''),'wayIds':[str(way.id)],'geometry':{'type':'LineString','coordinates':pts},'lengthKm':metres/1000,'rating':quality,'quality':quality,'winding':winding,'twisty':twisty,'recommendationCount':0,'frequencyRating':None,'surfaceConfidence':confidence,'ratingBasis':'geometry','sources':[]}
                    out.write(json.dumps(s,separators=(',',':'))+'\n');count+=1
        Roads().apply_file(str(pbf),locations=True,idx='flex_mem')
    temporary.replace(destination)
    print(json.dumps({'retainedCitedCatalogueSections':len(retained),'newGeometrySections':count,'output':str(destination)}))
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--pbf',required=True);p.add_argument('--existing',required=True);p.add_argument('--output',required=True);a=p.parse_args();build(a.pbf,a.existing,a.output)
