import { mkdtemp, cp, mkdir, rm, readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
const root = dirname(fileURLToPath(import.meta.url));
const output = join(root, '.artifacts', 'sessions.zip');
const scratch = await mkdtemp(join(tmpdir(), 'bendbound-session-package-'));
try {
  await mkdir(dirname(output), { recursive: true });
  await cp(join(root, 'src'), join(scratch, 'src'), { recursive: true,
    filter: (source) => !source.split('/').includes('__pycache__') && !source.endsWith('.pyc'),
  });
  await cp(join(root, 'node_modules'), join(scratch, 'node_modules'), { recursive: true });
  await cp(join(root, 'package.json'), join(scratch, 'package.json'));
  // Explicit allowlist: no env files, tests, examples, deployment state or app data.
  const topLevel = await readdir(scratch);
  if (topLevel.some((entry) => !['src', 'node_modules', 'package.json'].includes(entry))) throw new Error('Unexpected deployment file.');
  const secretPattern = /\.(env|pem|p8|key|sqlite|db)(\.|$)/i;
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (secretPattern.test(entry.name) || entry.isSymbolicLink()) throw new Error('Unsafe deployment entry.');
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await inspect(path);
    }
  }
  await inspect(scratch);
  const manifest = JSON.parse(await readFile(join(scratch, 'package.json'), 'utf8'));
  if (manifest.type !== 'module') throw new Error('Lambda package must be ESM.');
  await rm(output, { force: true });
  execFileSync('zip', ['-qr', output, '.'], { cwd: scratch, stdio: 'inherit' });
  console.log(`Prepared ${resolve(output)} (local only; not uploaded or deployed).`);
} finally { await rm(scratch, { recursive: true, force: true }); }
