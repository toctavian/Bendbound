// Run against a checkout of the same tag as the pinned Docker image.
import fs from 'node:fs';
import path from 'node:path';
import protobuf from 'protobufjs';
const source=process.argv[2];
if(!source)throw new Error('Usage: node graph/build-schema.mjs /path/to/valhalla-3.9.0');
const root=new protobuf.Root();
root.loadSync(path.join(source,'proto/descriptors/api.proto'),{keepCase:true});root.resolveAll();
fs.writeFileSync(new URL('../service/valhalla-schema.json',import.meta.url),JSON.stringify(root.toJSON()));
