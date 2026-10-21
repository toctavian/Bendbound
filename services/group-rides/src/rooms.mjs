import { createHash, randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { UnauthorizedError } from './authorizer.mjs';
const HOUR = 60 * 60_000, MAX_DURATION = 12 * HOUR;
const bikes = new Set(['sports', 'adventure', 'cruiser', 'motocross', 'funventure', 'scooter', 'bogdan', 'radu', 'petre', 'foca']);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const uuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export class RoomError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
function nickname(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\x00-\x1f]/.test(value)) throw new RoomError('INVALID_NAME');
  return value.trim();
}
function bike(value) { if (!bikes.has(value)) throw new RoomError('INVALID_MOTORCYCLE'); return value; }
// A syntactically valid ID (including a public share ID) proves neither route
// immutability nor authorisation. Fixed routes stay disabled until both exist.
function requireFreeRide(routeSnapshotId) {
  if (routeSnapshotId !== null) throw new RoomError('ROUTE_UNAVAILABLE', 409);
}
function member(actor, profile, now) { return { userId: actor.userId, displayName: nickname(profile.displayName), motorcycleType: bike(profile.motorcycleType), joinedAt: now, sharing: false, deviceEpoch: null, deviceFamily: null, deviceStartedAt: null }; }
/** Metadata-only engine; latest location storage/fan-out intentionally separate. */
export function createRoomService({ store, sessionActive, now = Date.now }) {
  if (![store?.read, store?.create, store?.replace, sessionActive].every((value) => typeof value === 'function')) throw new Error('Room persistence and live session checks are required.');
  async function principal(actor) {
    if (!actor?.userId || !actor.sessionId || !Number.isFinite(actor.expiresAt) || actor.expiresAt <= now()
      || !await sessionActive({ subject: actor.userId, familyId: actor.sessionId, expiresAt: actor.expiresAt })) throw new UnauthorizedError();
  }
  function live(room) { if (!room || room.state === 'ended' || room.expiresAt <= now()) throw new RoomError('ROOM_UNAVAILABLE', 404); }
  function joined(room, actor) { const value = room.members.find((m) => m.userId === actor.userId); if (!value) throw new RoomError('ROOM_UNAVAILABLE', 404); return value; }
  function owner(room, actor) { joined(room, actor); if (room.ownerId !== actor.userId) throw new RoomError('OWNER_REQUIRED', 403); }
  function snapshot(room) {
    return { version: 1, id: room.id, revision: room.revision, title: room.title, state: room.state, expiresAt: room.expiresAt, routeSnapshotId: room.routeSnapshotId,
      members: room.members.map((m) => ({ userId: m.userId, displayName: m.displayName, motorcycleType: m.motorcycleType,
        role: room.ownerId === m.userId ? 'owner' : 'member', sharing: m.sharing, fix: null })) };
  }
  async function change(actor, id, command, payload, permission, mutate) {
    if (!uuid(command?.id) || !Number.isFinite(command.createdAt) || Math.abs(now() - command.createdAt) > 120_000) throw new RoomError('INVALID_COMMAND');
    const key = hash(`${actor.userId}\0${command.id}`), fingerprint = hash(JSON.stringify(payload));
    for (let attempt = 0; attempt < 6; attempt++) {
      await principal(actor);
      const stored = await store.read(id);
      if (!stored || stored.expiresAt <= now()) throw new RoomError('ROOM_UNAVAILABLE', 404);
      const room = structuredClone(stored);
      const previous = room.commands.find((c) => c.key === key);
      // A retry of one's own completed leave acknowledges it without exposing
      // any room state after membership ended.
      if (previous && payload.type === 'leave' && previous.fingerprint === fingerprint) return { room: null, result: null };
      permission(room, actor);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new RoomError('COMMAND_CONFLICT', 409);
        const result = payload.type === 'sharing' && previous.result
          && joined(room, actor).deviceEpoch !== previous.result.deviceEpoch ? null : previous.result;
        return { room: snapshot(room), result };
      }
      live(room);
      const result = mutate(room, actor) ?? null;
      room.commands = room.commands.filter((c) => now() - c.at < 120_000);
      if (room.commands.length >= 128) throw new RoomError('ROOM_BUSY', 429);
      room.commands.push({ key, fingerprint, at: now(), result }); room.revision++;
      if (await store.replace(room, stored.revision, actor)) return { room: payload.type === 'leave' ? null : snapshot(room), result };
    }
    throw new RoomError('ROOM_BUSY', 409);
  }
  return {
    async create(actor, command, { title, displayName, motorcycleType, routeSnapshotId = null, durationMs = MAX_DURATION }) {
      await principal(actor);
      if (!uuid(command?.id) || !Number.isFinite(command.createdAt) || Math.abs(now() - command.createdAt) > 120_000
        || !Number.isSafeInteger(durationMs) || durationMs < 60_000 || durationMs > MAX_DURATION
        || (routeSnapshotId !== null && (typeof routeSnapshotId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(routeSnapshotId)))) throw new RoomError('INVALID_ROOM');
      const input = { title: nickname(title), displayName: nickname(displayName), motorcycleType: bike(motorcycleType), routeSnapshotId, durationMs };
      requireFreeRide(routeSnapshotId);
      const id = hash(`${actor.userId}\0${command.id}`), fingerprint = hash(JSON.stringify(input));
      const room = { id, revision: 1, ...input, ownerId: actor.userId, state: 'lobby', createdAt: now(), expiresAt: now() + durationMs,
        members: [member(actor, input, now())], invite: null, commands: [], creationFingerprint: fingerprint };
      if (!await store.create(room, actor)) {
        await principal(actor);
        const existing = await store.read(id); live(existing); joined(existing, actor);
        if (existing.creationFingerprint !== fingerprint) throw new RoomError('COMMAND_CONFLICT', 409);
        return snapshot(existing);
      }
      return snapshot(room);
    },
    async read(actor, id) { await principal(actor); const room = await store.read(id); live(room); joined(room, actor); return snapshot(room); },
    async invite(actor, id) {
      // Capabilities are returned only to the owner, persisted only as hashes.
      const token = randomBytes(32).toString('base64url');
      for (let attempt = 0; attempt < 6; attempt++) {
        await principal(actor); const stored = await store.read(id); live(stored); owner(stored, actor);
        const room = structuredClone(stored); room.invite = { hash: hash(token), expiresAt: Math.min(now() + HOUR, room.expiresAt) }; room.revision++;
        if (await store.replace(room, stored.revision, actor)) return { token, expiresAt: room.invite.expiresAt, room: snapshot(room) };
      }
      throw new RoomError('ROOM_BUSY', 409);
    },
    async join(actor, id, token, profile) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new RoomError('INVITE_UNAVAILABLE', 404);
      const entrant = member(actor, profile, now());
      for (let attempt = 0; attempt < 6; attempt++) {
        await principal(actor); const stored = await store.read(id); live(stored);
        if (!stored.invite || stored.invite.expiresAt <= now() || !timingSafeEqual(Buffer.from(stored.invite.hash, 'hex'), Buffer.from(hash(token), 'hex')))
          throw new RoomError('INVITE_UNAVAILABLE', 404);
        if (stored.members.some((m) => m.userId === actor.userId)) return snapshot(stored);
        if (stored.members.length >= 10) throw new RoomError('GROUP_FULL', 409);
        const room = structuredClone(stored); room.members.push(entrant); room.revision++;
        if (await store.replace(room, stored.revision, actor)) return snapshot(room);
      }
      throw new RoomError('ROOM_BUSY', 409);
    },
    start: (actor, id, command) => change(actor, id, command, { type: 'start' }, (room, user) => {
      owner(room, user);
      // Also guard retained legacy rooms and already-completed command retries.
      requireFreeRide(room.routeSnapshotId);
    }, (room) => { room.state = 'riding'; }),
    end: (actor, id, command) => change(actor, id, command, { type: 'end' }, owner, (room) => {
      room.state = 'ended'; room.endedAt = now(); room.invite = null;
      for (const m of room.members) { m.sharing = false; m.deviceEpoch = null; m.deviceFamily = null; m.deviceStartedAt = null; }
    }),
    sharing(actor, id, command, enabled) {
      if (typeof enabled !== 'boolean') throw new RoomError('INVALID_SHARING');
      const epoch = randomUUID();
      return change(actor, id, command, { type: 'sharing', enabled }, joined, (room, user) => {
        const m = joined(room, user); m.sharing = enabled; m.deviceEpoch = enabled ? epoch : null; m.deviceFamily = enabled ? user.sessionId : null; m.deviceStartedAt = enabled ? now() : null;
        return enabled ? { roomId: room.id, deviceEpoch: epoch, expiresAt: room.expiresAt } : null;
      });
    },
    updateProfile: (actor, id, command, profile) => {
      const normalized = { displayName: nickname(profile.displayName), motorcycleType: bike(profile.motorcycleType) };
      return change(actor, id, command, { type: 'profile', ...normalized }, joined, (room, user) => { Object.assign(joined(room, user), normalized); });
    },
    remove(actor, id, command, userId) {
      return change(actor, id, command, { type: 'remove', userId }, owner, (room) => {
        if (userId === room.ownerId) throw new RoomError('OWNER_MUST_LEAVE');
        room.members = room.members.filter((m) => m.userId !== userId); room.invite = null; // old invite cannot re-admit removed member
      });
    },
    leave(actor, id, command) {
      return change(actor, id, command, { type: 'leave' }, joined, (room, user) => {
        room.members = room.members.filter((m) => m.userId !== user.userId); room.invite = null;
        if (!room.members.length) { room.state = 'ended'; room.endedAt = now(); }
        else if (room.ownerId === user.userId) room.ownerId = room.members[0].userId; // earliest joined remaining member
      });
    },
    async publicationLease(actor, id, deviceEpoch) {
      await principal(actor); const room = await store.read(id); live(room); const m = joined(room, actor);
      if (room.state !== 'riding' || !m.sharing || m.deviceEpoch !== deviceEpoch || m.deviceFamily !== actor.sessionId) throw new RoomError('SHARING_NOT_ACTIVE', 403);
      return { revision: room.revision, roomId: room.id, userId: actor.userId, expiresAt: room.expiresAt, startedAt: m.deviceStartedAt };
      // This read is a guard, not a write grant. Future location writes must
      // condition on this room revision atomically to close removal/stop races.
    },
  };
}
