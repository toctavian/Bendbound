export type GroupMember = { userId: string; displayName: string; motorcycleType: string; role: 'owner' | 'member'; sharing: boolean };
export type GroupRoom = { version: 1; id: string; title: string; state: 'lobby' | 'riding' | 'ended'; expiresAt: number; members: GroupMember[] };
export type GroupCommand = { id: string; createdAt: number };
export const validRoomId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
export class GroupRequestError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(({ UNAUTHORIZED: 'Sign in again to use your group. Your pilot access may have expired.', INVITE_UNAVAILABLE: 'This invite has expired or been replaced. Ask the host for a new invite.', ROOM_UNAVAILABLE: 'This group has ended or is no longer available.', GROUP_FULL: 'This group already has 10 riders.', ROOM_RATE_LIMITED: 'Please wait before trying again.', OWNER_REQUIRED: 'Only the host can send invitations or end this group.', INVALID_COMMAND: 'Check your device clock, then try again.' } as Record<string, string>)[code] ?? 'Could not update your group. Please retry.');
  }
}
export function parseRoom(value: unknown): GroupRoom {
  const r = value as GroupRoom;
  if (r?.version !== 1 || !validRoomId(r.id) || typeof r.title !== 'string' || !['lobby', 'riding', 'ended'].includes(r.state)
    || !Number.isSafeInteger(r.expiresAt) || !Array.isArray(r.members) || r.members.length > 10 || r.members.some(m => !m || typeof m.userId !== 'string' || typeof m.displayName !== 'string' || typeof m.motorcycleType !== 'string' || !['owner', 'member'].includes(m.role))) throw new Error('The group service returned an invalid group.');
  return r;
}
export function createRoomClient(endpoint: string | undefined, getToken: () => Promise<string>, request: typeof fetch = fetch) {
  let base: string;
  try { const u = new URL(endpoint ?? ''); if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash || u.pathname !== '/') return null; base = u.origin; } catch { return null; }
  const path = (id: string) => { if (!validRoomId(id)) throw new Error('Invalid group.'); return `/v1/rooms/${id}`; };
  async function send(method: string, resource: string, body?: object) {
    const token = await getToken();
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    try {
      const r = await request(base + resource, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', cache: 'no-store', signal: controller.signal });
      const value = await r.json();
      if (!r.ok) throw new GroupRequestError(typeof value?.error === 'string' ? value.error : 'UNAVAILABLE', r.status);
      return value;
    } finally { clearTimeout(timer); }
  }
  return {
    baseUrl: base,
    async create(input: { command: GroupCommand; title: string; displayName: string; motorcycleType: string }) { return parseRoom((await send('POST', '/v1/rooms', input)).room); },
    async read(id: string) { return parseRoom((await send('GET', path(id))).room); },
    async invite(id: string) {
      const result = await send('POST', path(id) + '/invites', {});
      if (!/^[A-Za-z0-9_-]{43}$/.test(result?.token) || !Number.isSafeInteger(result.expiresAt)) throw new Error('Invalid invite.');
      return { token: result.token as string, expiresAt: result.expiresAt as number, room: parseRoom(result.room) };
    },
    async join(id: string, token: string, displayName: string, motorcycleType: string) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid invite.');
      return parseRoom((await send('POST', path(id) + '/members', { inviteToken: token, displayName, motorcycleType })).room);
    },
    async profile(id: string, command: GroupCommand, displayName: string, motorcycleType: string) { return parseRoom((await send('PUT', path(id) + '/profile', { command, displayName, motorcycleType })).room); },
    async end(id: string, command: GroupCommand) { await send('POST', path(id) + '/end', { command }); },
    async leave(id: string, command: GroupCommand) { await send('DELETE', path(id) + '/members/me', { command }); },
  };
}
/** Fragment keeps bearer invite capabilities out of HTTP query strings. */
export function groupInviteLink(roomId: string, token: string, routeId?: string) {
  if (!validRoomId(roomId) || !/^[A-Za-z0-9_-]{43}$/.test(token) || routeId && !/^[a-f0-9]{32}$/.test(routeId)) throw new Error('Invalid invite.');
  return `bendbound://group/${roomId}#invite=${token}${routeId ? `&route=${routeId}` : ''}`;
}
export function parseGroupInvite(url: string | null, roomId: string) {
  try {
    const u = new URL(url ?? '');
    if (u.protocol !== 'bendbound:' || u.hostname !== 'group' || u.pathname !== `/${roomId}` || u.search || !validRoomId(roomId)) return null;
    const parts = new URLSearchParams(u.hash.slice(1)), token = parts.get('invite'), routeId = parts.get('route');
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token) || routeId && !/^[a-f0-9]{32}$/.test(routeId)) return null;
    return { token, routeId: routeId ?? undefined };
  } catch { return null; }
}
