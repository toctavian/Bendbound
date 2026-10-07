import { mkdir, stat, rename, readFile, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const mapURL = process.env.OSM_URL || 'https://download.geofabrik.de/europe/united-kingdom/england/greater-london-latest.osm.pbf';
async function download(url, path) {
  try { if ((await stat(path)).size > 0) return; } catch {}
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`);
  await pipeline(response.body, createWriteStream(`${path}.part`));
  await rename(`${path}.part`, path);
}
async function hash(path, algorithm = 'sha256') {
  const digest = createHash(algorithm);
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
await mkdir(`${root}.data/map`, { recursive: true });
await mkdir(`${root}.tools`, { recursive: true });
const manifestPath = `${root}.data/map/manifest.json`;
let previous;
try { previous = JSON.parse(await readFile(manifestPath, 'utf8')); } catch {}
if (previous && previous.source !== mapURL) throw new Error('Different OSM_URL: use a fresh .data directory; do not mix graphs.');
await download(mapURL, `${root}.data/map/region.osm.pbf`);
await writeFile(manifestPath, JSON.stringify({ source: mapURL, sha256: await hash(`${root}.data/map/region.osm.pbf`), preparedAt: previous?.preparedAt || new Date().toISOString() }, null, 2));
console.log('OSM extract ready; both engines will use the same file.');
if (process.argv.includes('--graphhopper')) {
  const url = 'https://repo.maven.apache.org/maven2/com/graphhopper/graphhopper-web/11.1/graphhopper-web-11.1.jar';
  const path = `${root}.tools/graphhopper-web-11.1.jar`;
  await download(url, path);
  const checksum = await fetch(`${url}.sha1`);
  if (!checksum.ok || (await checksum.text()).trim() !== await hash(path, 'sha1')) throw new Error('GraphHopper artifact checksum mismatch.');
  console.log('GraphHopper 11.1 downloaded and Maven checksum verified.');
}
