import { RoomRateLimitedError } from './roomBudget.mjs';
import { RoomError } from './rooms.mjs';
import { UnauthorizedError } from './authorizer.mjs';
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const result = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });
function body(event, fields) {
  const raw = event.body ?? '';
  if (typeof raw !== 'string' || raw.length > 12_000) throw new RoomError('INVALID_BODY');
  let value;
  try { value = raw ? JSON.parse(event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw) : {}; }
  catch { throw new RoomError('INVALID_BODY'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key))) throw new RoomError('INVALID_BODY');
  return value;
}
/** Private HTTP API; local deployment preparation, not evidence of a live service. */
export function createRoomApi({ authorize, rooms, locations, consumeRoomBudget, lobbyOnly = false }) {
  if (typeof authorize !== 'function' || typeof consumeRoomBudget !== 'function' || !rooms) throw new Error('Private rooms must be configured.');
  return async function handler(event) {
    const method = event.requestContext?.http?.method, path = event.rawPath ?? '';
    const match = /^\/v1\/rooms\/([a-f0-9]{64})(?:\/(invites|members|start|end|sharing|profile|fix)(?:\/([A-Za-z0-9_-]{1,256}))?)?$/.exec(path);
    if (path !== '/v1/rooms' && !match) return result(404, { error: 'NOT_FOUND' });
    if (event.rawQueryString) return result(400, { error: 'INVALID_REQUEST' });
    try {
      const actor = await authorize(event.headers?.authorization ?? event.headers?.Authorization);
      if (lobbyOnly && match && ['start', 'sharing', 'fix'].includes(match[2])) return result(409, { error: 'LIVE_SHARING_UNAVAILABLE' });
      if (path === '/v1/rooms' && method === 'POST') {
        const input = body(event, ['command', 'title', 'displayName', 'motorcycleType', 'routeSnapshotId', 'durationMs']);
        await consumeRoomBudget('create', actor.userId);
        const { command, ...profile } = input; return result(201, { room: await rooms.create(actor, command, profile) });
      }
      if (!match) return result(404, { error: 'NOT_FOUND' });
      const [, id, operation, target] = match;
      if (method === 'GET' && !operation) { body(event, []); await consumeRoomBudget('snapshot', actor.userId); return result(200, { room: await (!lobbyOnly && locations ? locations.read(actor, id) : rooms.read(actor, id)) }); }
      if (method === 'POST' && operation === 'invites' && !target) { body(event, []); await consumeRoomBudget('invite', actor.userId); return result(200, await rooms.invite(actor, id)); }
      if (method === 'POST' && operation === 'members' && !target) {
        const input = body(event, ['inviteToken', 'displayName', 'motorcycleType']);
        await consumeRoomBudget('redeem', actor.userId);
        return result(200, { room: await rooms.join(actor, id, input.inviteToken, input) });
      }
      if (method === 'POST' && ['start', 'end'].includes(operation) && !target) {
        const input = body(event, ['command']);
        if (operation === 'start') await consumeRoomBudget('control', actor.userId);
        return result(200, await rooms[operation](actor, id, input.command));
      }
      if (method === 'PUT' && operation === 'fix' && !target && locations) {
        const input = body(event, ['version', 'fix']);
        await consumeRoomBudget('fix', actor.userId);
        return result(200, await locations.publish(actor, id, input));
      }
      if (method === 'PUT' && operation === 'sharing' && !target) {
        const input = body(event, ['command', 'enabled']);
        if (input.enabled !== false) await consumeRoomBudget('control', actor.userId);
        return result(200, await rooms.sharing(actor, id, input.command, input.enabled));
      }
      if (method === 'PUT' && operation === 'profile' && !target) {
        const input = body(event, ['command', 'displayName', 'motorcycleType']);
        await consumeRoomBudget('control', actor.userId);
        return result(200, await rooms.updateProfile(actor, id, input.command, input));
      }
      if (method === 'DELETE' && operation === 'members' && target) {
        const input = body(event, ['command']);
        return result(200, target === 'me' ? await rooms.leave(actor, id, input.command) : await rooms.remove(actor, id, input.command, target));
      }
      return result(404, { error: 'NOT_FOUND' });
    } catch (error) {
      if (error instanceof RoomRateLimitedError) return { ...result(429, { error: 'ROOM_RATE_LIMITED' }), headers: { ...headers, 'Retry-After': String(error.retryAfter) } };
      if (error instanceof UnauthorizedError) return result(401, { error: 'UNAUTHORIZED' });
      if (error instanceof RoomError) return result(error.status, { error: error.code });
      return result(503, { error: 'GROUP_SERVICE_UNAVAILABLE' });
    }
  };
}
