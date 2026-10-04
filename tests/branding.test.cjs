const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');

const root = path.join(__dirname, '..');
const json = (file) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));

test('Bendbound branding uses the approved artwork and only the new project identity', () => {
  const { expo } = json('app.json');
  assert.equal(expo.name, 'Bendbound');
  assert.equal(expo.slug, 'bendbound');
  assert.equal(expo.scheme, 'bendbound');
  assert.equal(expo.icon, './assets/bendbound-logo.png');
  assert.equal(expo.android.icon, expo.icon);
  assert.equal(expo.android.adaptiveIcon, undefined);
  assert.equal(expo.web.favicon, expo.icon);
  const permission = expo.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-location')[1];
  assert.match(permission.locationWhenInUsePermission, /Allow Bendbound/);
  const logo = readFileSync(path.join(root, expo.icon));
  assert.equal(logo.subarray(1, 4).toString(), 'PNG');
  assert.equal(logo.readUInt32BE(16), logo.readUInt32BE(20));
  assert.equal(createHash('sha256').update(logo).digest('hex'), '9626d9f582f38134903a3f1ba215d259e7c91eb2b1bebbca179af452a4df16d1');
  assert.equal(json('package.json').name, 'bendbound');
  const lock = json('package-lock.json');
  assert.equal(lock.name, 'bendbound');
  assert.equal(lock.packages[''].name, 'bendbound');
});
