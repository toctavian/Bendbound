import { createRequire } from 'node:module';
import { RoutingError } from '../../service/engine.mjs';
const require=createRequire(import.meta.url);
/** Read-only, indexed national overlay: only the requested area's ratings enter RAM. */
export function createSqliteGraphCatalogue(file,createCatalogue,lookup) {
  const {DatabaseSync}=require('node:sqlite');
  const db=new DatabaseSync(file,{readOnly:true,allowExtension:false});
  db.exec('PRAGMA cache_size=-16384; PRAGMA mmap_size=0;');
  const meta=JSON.parse(db.prepare('SELECT value FROM metadata WHERE key=?').get('summary').value);
  if(meta.schemaVersion!==3 || !/^[a-f0-9]{64}$/.test(meta.graphVersion))throw new RoutingError('CATALOGUE_UNAVAILABLE','Invalid national rating overlay.',503);
  const data={...meta,sections:{length:meta.sections},nativeEdges:{length:meta.nativeEdges},unmappedSections:{length:meta.unmappedSections}};
  const native=createCatalogue({schemaVersion:2,graphVersion:meta.graphVersion,sections:[],nativeEdges:[]},{lookup,allowEmpty:true});
  const area=db.prepare('SELECT s.value FROM bounds b JOIN sections s ON s.rowid=b.id WHERE b.minx<=? AND b.maxx>=? AND b.miny<=? AND b.maxy>=?');
  const nativeRow=db.prepare('SELECT value FROM native_edges WHERE id=?');
  const mapped=db.prepare('SELECT s.value FROM membership m JOIN sections s ON s.rowid=m.section WHERE m.physical=?');
  function create(rows) {
    const sections=[...new Map(rows.map(r=>{const s=JSON.parse(r.value);return [s.id,s];})).values()];
    const ids=new Set(sections.flatMap(s=>s.physicalIds));
    const edges=[...ids].map(id=>{const r=nativeRow.get(id);if(!r)throw new RoutingError('CATALOGUE_UNAVAILABLE','Missing native rating identity.',503);return JSON.parse(r.value);});
    return createCatalogue({schemaVersion:2,graphVersion:meta.graphVersion,sections,nativeEdges:edges},{lookup,allowEmpty:true});
  }
  return {
    data,
    async nearby(args) {
      const dy=args.radiusKm/111.195,dx=dy/Math.cos(args.center.latitude*Math.PI/180);
      const rows=area.all(args.center.longitude+dx,args.center.longitude-dx,args.center.latitude+dy,args.center.latitude-dy);
      // The existing exact radius/cone check runs before ranking/limit. No SQL
      // shortlist can drop a valid road just outside a bounding-box corner.
      return create(rows).nearby(args);
    },
    nativeUsage:native.nativeUsage,
    async matchRoute(points,ways,payload) {
      if(!payload?.nativeRanges)throw new RoutingError('ROAD_IDENTITY','Native edge coverage has not been verified.',502);
      const rows=[];for(const id of payload.nativeRanges.keys())rows.push(...mapped.all(id));
      return create(rows).matchRoute(points,ways,payload);
    },
    close:()=>db.close(),
  };
}
