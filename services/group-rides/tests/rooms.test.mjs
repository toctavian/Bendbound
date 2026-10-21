import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createRoomService, RoomError } from '../src/rooms.mjs';
import { UnauthorizedError } from '../src/authorizer.mjs';
import { createRoomApi } from '../src/roomApi.mjs';
function setup() {
  let time = 1_000_000; const records = new Map(), blocked = new Set();
  const store = { async read(id) { return structuredClone(records.get(id) ?? null); },
    async create(room) { if (records.has(room.id)) return false; records.set(room.id, structuredClone(room)); return true; },
    async replace(room, revision) { if (records.get(room.id)?.revision !== revision) return false; records.set(room.id, structuredClone(room)); return true; } };
  const sessionActive = async ({ familyId }) => !blocked.has(familyId);
  const rooms = createRoomService({ store, sessionActive, now: () => time });
  const actor = (id) => ({ userId: id, sessionId: `${id}-family`, expiresAt: 100_000_000 });
  const command = () => ({ id: randomUUID(), createdAt: time });
  const profile = (name = 'Rider') => ({ displayName: name, motorcycleType: 'adventure' });
  const create = (user = actor('owner'), c = command()) => rooms.create(user, c, { title: 'Test ride', ...profile() });
  return { rooms, records, actor, command, profile, create, store, blocked, advance: (delta) => { time += delta; } };
}
const fails = (code) => (error) => error instanceof RoomError && error.code === code;
test('room creation is idempotent, scope-bound and rejects conflicting payloads or untrusted profiles', async () => {
  const h = setup(), c = h.command(), owner = h.actor('owner'); const room = await h.create(owner, c);
  assert.equal((await h.create(owner, c)).id, room.id); assert.equal(h.records.size, 1); assert.equal(room.members[0].sharing, false);
  await assert.rejects(h.rooms.create(owner, c, { title: 'Changed', ...h.profile() }), fails('COMMAND_CONFLICT'));
  assert.notEqual((await h.create(h.actor('someone-else'), c)).id, room.id);
  await assert.rejects(h.rooms.create(owner, h.command(), { title: 'Ride', displayName: 'Rider', motorcycleType: '__proto__' }), fails('INVALID_MOTORCYCLE'));
});
test('invites alone grant no room read; rotation/expiry and removal revoke old invitation access', async () => {
  const h = setup(), owner = h.actor('owner'), rider = h.actor('rider'), room = await h.create();
  const invite = await h.rooms.invite(owner, room.id);
  assert.equal(JSON.stringify([...h.records.values()]).includes(invite.token), false);
  await assert.rejects(h.rooms.read(rider, room.id), fails('ROOM_UNAVAILABLE'));
  await h.rooms.join(rider, room.id, invite.token, h.profile());
  assert.equal((await h.rooms.read(rider, room.id)).members.length, 2);
  await h.rooms.remove(owner, room.id, h.command(), rider.userId);
  await assert.rejects(h.rooms.read(rider, room.id), fails('ROOM_UNAVAILABLE'));
  await assert.rejects(h.rooms.join(rider, room.id, invite.token, h.profile()), fails('INVITE_UNAVAILABLE'));
  const newer = await h.rooms.invite(owner, room.id); const newest = await h.rooms.invite(owner, room.id);
  await assert.rejects(h.rooms.join(rider, room.id, newer.token, h.profile()), fails('INVITE_UNAVAILABLE'));
  h.advance(3_600_001); await assert.rejects(h.rooms.join(rider, room.id, newest.token, h.profile()), fails('INVITE_UNAVAILABLE'));
});
test('only owner starts/ends/removes; start cannot opt in another member', async () => {
  const h = setup(), owner = h.actor('owner'), rider = h.actor('rider'), room = await h.create();
  await h.rooms.join(rider, room.id, (await h.rooms.invite(owner, room.id)).token, h.profile());
  await assert.rejects(h.rooms.start(rider, room.id, h.command()), fails('OWNER_REQUIRED'));
  const started = await h.rooms.start(owner, room.id, h.command()); assert.equal(started.room.members.every((m) => !m.sharing), true);
  await assert.rejects(h.rooms.end(rider, room.id, h.command()), fails('OWNER_REQUIRED'));
});
test('sharing leases bind current member/session/epoch; stop/removal/rejoin invalidate old leases', async () => {
  const h = setup(), owner = h.actor('owner'), rider = h.actor('rider'), room = await h.create();
  const token = (await h.rooms.invite(owner, room.id)).token; await h.rooms.join(rider, room.id, token, h.profile());
  const consent = h.command(), first = await h.rooms.sharing(rider, room.id, consent, true);
  assert.equal((await h.rooms.sharing(rider, room.id, consent, true)).result.deviceEpoch, first.result.deviceEpoch);
  await assert.rejects(h.rooms.publicationLease(rider, room.id, first.result.deviceEpoch), fails('SHARING_NOT_ACTIVE'));
  await h.rooms.start(owner, room.id, h.command());
  assert.equal((await h.rooms.publicationLease(rider, room.id, first.result.deviceEpoch)).userId, rider.userId);
  await assert.rejects(h.rooms.publicationLease({ ...rider, sessionId: 'other-family' }, room.id, first.result.deviceEpoch), fails('SHARING_NOT_ACTIVE'));
  await h.rooms.sharing(rider, room.id, h.command(), false);
  assert.equal((await h.rooms.sharing(rider, room.id, consent, true)).result, null);
  await assert.rejects(h.rooms.publicationLease(rider, room.id, first.result.deviceEpoch), fails('SHARING_NOT_ACTIVE'));
  await h.rooms.remove(owner, room.id, h.command(), rider.userId);
  await assert.rejects(h.rooms.publicationLease(rider, room.id, first.result.deviceEpoch), fails('ROOM_UNAVAILABLE'));
  await h.rooms.join(rider, room.id, (await h.rooms.invite(owner, room.id)).token, h.profile());
  await assert.rejects(h.rooms.publicationLease(rider, room.id, first.result.deviceEpoch), fails('SHARING_NOT_ACTIVE'));
});
test('owner leave transfers to earliest remaining member; repeated leave leaks no room snapshot', async () => {
  const h = setup(), owner = h.actor('owner'), rider = h.actor('rider'), room = await h.create();
  await h.rooms.join(rider, room.id, (await h.rooms.invite(owner, room.id)).token, h.profile());
  const leave = h.command(); const after = await h.rooms.leave(owner, room.id, leave);
  assert.equal(after.room, null); assert.equal((await h.rooms.read(rider, room.id)).members[0].role, 'owner');
  assert.deepEqual(await h.rooms.leave(owner, room.id, leave), { room: null, result: null });
  await assert.rejects(h.rooms.read(owner, room.id), fails('ROOM_UNAVAILABLE'));
  const end = h.command(); await h.rooms.end(rider, room.id, end); assert.equal((await h.rooms.end(rider, room.id, end)).room.state, 'ended');
});
test('concurrent joins respect cap and preserve successful membership updates', async () => {
  const h = setup(), room = await h.create(), token = (await h.rooms.invite(h.actor('owner'), room.id)).token;
  // Deliberate CAS collisions: callers must re-read, not overwrite each other.
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => h.rooms.join(h.actor('rider-' + i), room.id, token, h.profile())));
  let count = (await h.rooms.read(h.actor('owner'), room.id)).members.length;
  for (let i = 0; i < results.length && count < 10; i++) {
    if (results[i].status === 'rejected') { await h.rooms.join(h.actor('retry-' + i), room.id, token, h.profile()); count++; }
  }
  assert.equal((await h.rooms.read(h.actor('owner'), room.id)).members.length, 10);
  await assert.rejects(h.rooms.join(h.actor('extra'), room.id, token, h.profile()), fails('GROUP_FULL'));
});
test('session revocation/room expiry is checked even before storage cleanup', async () => {
  const h = setup(), actor = h.actor('owner'), room = await h.create();
  h.blocked.add(actor.sessionId); await assert.rejects(h.rooms.read(actor, room.id), UnauthorizedError);
  h.blocked.clear(); h.advance(12 * 3_600_000); await assert.rejects(h.rooms.read(actor, room.id), fails('ROOM_UNAVAILABLE')); assert.equal(h.records.size, 1);
});
test('private HTTP API rejects body identities, query capabilities and unauthorised reads', async () => {
  const h = setup(); const api = createRoomApi({ consumeRoomBudget: async () => {}, authorize: async (header) => { if (header !== 'Bearer owner') throw new UnauthorizedError(); return h.actor('owner'); }, rooms: h.rooms });
  const event = (method, path, data) => ({ rawPath: path, requestContext: { http: { method } }, headers: { authorization: 'Bearer owner' }, ...(data ? { body: JSON.stringify(data) } : {}) });
  assert.equal((await api(event('POST', '/v1/rooms', { command: h.command(), title: 'Ride', ...h.profile(), userId: 'victim' }))).statusCode, 400);
  const created = await api(event('POST', '/v1/rooms', { command: h.command(), title: 'Ride', ...h.profile() })); assert.equal(created.statusCode, 201);
  const id = JSON.parse(created.body).room.id;
  assert.equal((await api({ ...event('GET', '/v1/rooms/' + id), headers: {} })).statusCode, 401);
  assert.equal((await api({ ...event('GET', '/v1/rooms/' + id), rawQueryString: 'token=synthetic' })).statusCode, 400);
  assert.equal((await api(event('GET', '/v1/rooms/' + id))).headers['Cache-Control'], 'no-store');
});

test('creation retries retain service idempotency but spend permits before any service effects', async () => {
  const { RoomRateLimitedError } = await import('../src/roomBudget.mjs');
  const h = setup(); let permits = 0, effects = 0;
  const api = createRoomApi({ authorize: async () => h.actor('owner'),
    consumeRoomBudget: async (operation, subject) => {
      assert.equal(operation, 'create'); assert.equal(subject, 'owner');
      if (++permits > 2) throw new RoomRateLimitedError(30);
    }, rooms: { create: async (...args) => { effects++; return h.rooms.create(...args); } } });
  const request = { rawPath: '/v1/rooms', requestContext: { http: { method: 'POST' } },
    body: JSON.stringify({ command: h.command(), title: 'Ride', ...h.profile() }) };
  const first = await api(request), retry = await api(request);
  assert.equal(first.statusCode, 201); assert.equal(retry.statusCode, 201);
  assert.equal(JSON.parse(first.body).room.id, JSON.parse(retry.body).room.id);
  assert.equal(h.records.size, 1); assert.equal(effects, 2);
  assert.equal((await api(request)).statusCode, 429); assert.equal(effects, 2); assert.equal(h.records.size, 1);
});

test('budget denial preserves room state and real teardown still revokes leases, membership and room access', async () => {
  const { RoomRateLimitedError } = await import('../src/roomBudget.mjs');
  const h = setup(), owner = h.actor('owner'), rider = h.actor('rider'), room = await h.create();
  await h.rooms.join(rider, room.id, (await h.rooms.invite(owner, room.id)).token, h.profile());
  await h.rooms.start(owner, room.id, h.command());
  const lease = await h.rooms.sharing(rider, room.id, h.command(), true);
  let current = owner;
  const api = createRoomApi({ authorize: async () => current, rooms: h.rooms,
    consumeRoomBudget: async () => { throw new RoomRateLimitedError(30); } });
  const request = (method, suffix, input = {}) => ({ rawPath: `/v1/rooms/${room.id}${suffix}`,
    requestContext: { http: { method } }, body: JSON.stringify(input) });
  const before = structuredClone(h.records.get(room.id));
  for (const [method, suffix, input] of [['GET', '', {}], ['POST', '/invites', {}],
    ['POST', '/start', { command: h.command() }], ['PUT', '/profile', { command: h.command(), ...h.profile('Changed') }],
    ['PUT', '/sharing', { command: h.command(), enabled: true }]]) {
    assert.equal((await api(request(method, suffix, input))).statusCode, 429);
    assert.deepEqual(h.records.get(room.id), before);
  }
  current = rider;
  assert.equal((await api(request('PUT', '/sharing', { command: h.command(), enabled: false }))).statusCode, 200);
  await assert.rejects(h.rooms.publicationLease(rider, room.id, lease.result.deviceEpoch), fails('SHARING_NOT_ACTIVE'));
  // Owner-only safety actions still enforce role checks even though they bypass budgets.
  assert.equal((await api(request('POST', '/end', { command: h.command() }))).statusCode, 403);
  assert.equal((await api(request('DELETE', '/members/owner', { command: h.command() }))).statusCode, 403);
  assert.equal((await api(request('DELETE', '/members/me', { command: h.command() }))).statusCode, 200);
  await assert.rejects(h.rooms.read(rider, room.id), fails('ROOM_UNAVAILABLE'));
  current = owner;
  assert.equal((await api(request('POST', '/end', { command: h.command() }))).statusCode, 200);
  assert.equal(h.records.get(room.id).state, 'ended');
  await assert.rejects(h.rooms.read(owner, room.id), fails('ROOM_UNAVAILABLE'));
});

test('control command retries remain idempotent and spend permits without further room mutations', async () => {
  const { RoomRateLimitedError } = await import('../src/roomBudget.mjs');
  const h = setup(), room = await h.create(); let permits = 0;
  const api = createRoomApi({ authorize: async () => h.actor('owner'), rooms: h.rooms,
    consumeRoomBudget: async (operation, subject) => {
      assert.equal(operation, 'control'); assert.equal(subject, 'owner');
      if (++permits > 2) throw new RoomRateLimitedError(30);
    } });
  const request = { rawPath: `/v1/rooms/${room.id}/profile`, requestContext: { http: { method: 'PUT' } },
    body: JSON.stringify({ command: h.command(), ...h.profile('Updated') }) };
  assert.equal((await api(request)).statusCode, 200);
  const after = structuredClone(h.records.get(room.id));
  assert.equal((await api(request)).statusCode, 200);
  assert.deepEqual(h.records.get(room.id), after);
  assert.equal((await api(request)).statusCode, 429);
  assert.equal(permits, 3); assert.deepEqual(h.records.get(room.id), after);
});

test('unresolved fixed routes never persist, including public-share-shaped IDs and retries', async () => {
  const h = setup(), owner = h.actor('owner'), command = h.command();
  const input = { title: 'Ride', ...h.profile() };
  for (const routeSnapshotId of ['a'.repeat(32), 'unknown_snapshot', 'b'.repeat(128)]) {
    await assert.rejects(h.rooms.create(owner, command, { ...input, routeSnapshotId }), fails('ROUTE_UNAVAILABLE'));
    assert.equal(h.records.size, 0);
  }
  await assert.rejects(h.rooms.create(owner, command, { ...input, routeSnapshotId: '../route' }), fails('INVALID_ROOM'));
  // A route denial does not reserve the creation command or prevent a free ride.
  const free = await h.rooms.create(owner, command, { ...input, routeSnapshotId: null });
  assert.equal((await h.rooms.create(owner, command, input)).id, free.id);
  const before = structuredClone(h.records.get(free.id));
  await assert.rejects(h.rooms.create(owner, command, { ...input, routeSnapshotId: 'unknown_snapshot' }), fails('ROUTE_UNAVAILABLE'));
  assert.deepEqual(h.records.get(free.id), before);
  h.blocked.add(owner.sessionId);
  await assert.rejects(h.rooms.create(owner, command, { ...input, routeSnapshotId: 'unknown_snapshot' }), UnauthorizedError);
});

test('legacy unresolved rooms cannot start or retry a start, while authorised teardown remains usable', async () => {
  const h = setup(), owner = h.actor('owner'), rider = h.actor('rider'), stranger = h.actor('stranger');
  const room = await h.create();
  await h.rooms.join(rider, room.id, (await h.rooms.invite(owner, room.id)).token, h.profile());
  const start = h.command();
  await h.rooms.start(owner, room.id, start);
  const lease = await h.rooms.sharing(rider, room.id, h.command(), true);
  // Synthetic pre-gate record; production code must never rewrite it to free ride.
  h.records.get(room.id).routeSnapshotId = 'legacy_snapshot';
  const before = structuredClone(h.records.get(room.id));
  for (const command of [start, h.command()]) {
    await assert.rejects(h.rooms.start(owner, room.id, command), fails('ROUTE_UNAVAILABLE'));
    assert.deepEqual(h.records.get(room.id), before);
  }
  await assert.rejects(h.rooms.start(rider, room.id, h.command()), fails('OWNER_REQUIRED'));
  await assert.rejects(h.rooms.start(stranger, room.id, h.command()), fails('ROOM_UNAVAILABLE'));
  h.blocked.add(owner.sessionId);
  await assert.rejects(h.rooms.start(owner, room.id, h.command()), UnauthorizedError);
  h.blocked.clear();
  assert.equal((await h.rooms.read(owner, room.id)).routeSnapshotId, 'legacy_snapshot');
  await h.rooms.sharing(rider, room.id, h.command(), false);
  await assert.rejects(h.rooms.publicationLease(rider, room.id, lease.result.deviceEpoch), fails('SHARING_NOT_ACTIVE'));
  await h.rooms.leave(rider, room.id, h.command());
  const end = h.command();
  assert.equal((await h.rooms.end(owner, room.id, end)).room.state, 'ended');
  assert.equal((await h.rooms.end(owner, room.id, end)).room.state, 'ended');
  // Missing legacy reference is unknown, not an implicit free ride.
  const missing = await h.create(); delete h.records.get(missing.id).routeSnapshotId;
  await assert.rejects(h.rooms.start(owner, missing.id, h.command()), fails('ROUTE_UNAVAILABLE'));
});

test('HTTP route gate is no-store, budgeted and authenticated; null and omitted routes work', async () => {
  const h = setup(); let permits = 0;
  const api = createRoomApi({ rooms: h.rooms,
    authorize: async (header) => { if (header !== 'Bearer synthetic') throw new UnauthorizedError(); return h.actor('owner'); },
    consumeRoomBudget: async (operation) => { assert.equal(operation, 'create'); permits++; } });
  const request = (extra = {}) => ({ rawPath: '/v1/rooms', requestContext: { http: { method: 'POST' } },
    headers: { authorization: 'Bearer synthetic' },
    body: JSON.stringify({ command: h.command(), title: 'Ride', ...h.profile(), ...extra }) });
  const denied = await api(request({ routeSnapshotId: 'a'.repeat(32) }));
  assert.equal(denied.statusCode, 409); assert.deepEqual(JSON.parse(denied.body), { error: 'ROUTE_UNAVAILABLE' });
  assert.equal(denied.headers['Cache-Control'], 'no-store'); assert.equal(permits, 1); assert.equal(h.records.size, 0);
  assert.equal((await api({ ...request({ routeSnapshotId: 'unknown_snapshot' }), headers: {} })).statusCode, 401);
  assert.equal(permits, 1);
  assert.equal((await api(request({ routeSnapshotId: null }))).statusCode, 201);
  assert.equal((await api(request())).statusCode, 201);
  assert.equal(h.records.size, 2); assert.equal(permits, 3);
});
