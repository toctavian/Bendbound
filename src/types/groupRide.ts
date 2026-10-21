import type { Coordinate, MotorcycleType } from '@/types';
export const GROUP_PROTOCOL_VERSION = 1 as const;
export const GROUP_LIMITS = {
  members: 10, roomDurationMs: 12 * 60 * 60_000, movingUploadMs: 5_000,
  maxCaptureAgeMs: 15_000, futureToleranceMs: 1_000, staleAfterMs: 20_000,
  offlineAfterMs: 60_000, hideAfterMs: 5 * 60_000, maxAccuracyM: 100,
} as const;
export type GroupFix = Coordinate & {
  accuracyM: number; headingDeg: number | null; speedMps: number | null;
  capturedAt: number; sessionEpoch: string; sequence: number;
};
export type ReceivedGroupFix = GroupFix & { receivedAt: number };
export type GroupMember = {
  userId: string; displayName: string; motorcycleType: MotorcycleType;
  role: 'owner' | 'member'; sharing: boolean; fix: ReceivedGroupFix | null;
};
export type GroupRoom = {
  version: typeof GROUP_PROTOCOL_VERSION; id: string; revision: number;
  title: string; state: 'lobby' | 'riding' | 'ended'; expiresAt: number;
  routeSnapshotId: string | null; members: GroupMember[];
};
export type GroupEvent =
  | { version: 1; type: 'snapshot'; room: GroupRoom }
  | { version: 1; type: 'member.updated'; roomId: string; revision: number; member: GroupMember }
  | { version: 1; type: 'member.removed'; roomId: string; revision: number; userId: string }
  | { version: 1; type: 'room.ended'; roomId: string; revision: number };
