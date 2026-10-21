// Preserve the PostGIS adapter for rollback and migration. Active graph mode
// performs no database queries and can run with the PostGIS container stopped.
export {createStatus,graphStatus,roadUseSQL,close} from './catalogue-postgis.mjs';
export const graphMode=()=>process.env.CATALOGUE_BACKEND==='valhalla';
const adapter=()=>graphMode()?import('./graph-catalogue.mjs'):import('./catalogue-postgis.mjs');
export const status=async(...args)=>(await adapter()).status(...args);
export const nearby=async(...args)=>(await adapter()).nearby(...args);
export const matchRoute=async(...args)=>(await adapter()).matchRoute(...args);
export const roadUse=async(...args)=>(await adapter()).roadUse(...args);
