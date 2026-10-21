import { createHash } from 'node:crypto';
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const locationKey = (roomId, userId) => ({ pk: `ROOM#${roomId}`, sk: `RIDER#${hash(userId)}` });
export function conditionalConflict(error) {
  return error?.name === 'ConditionalCheckFailedException' || (error?.name === 'TransactionCanceledException'
    && error.CancellationReasons?.some((reason) => ['ConditionalCheckFailed', 'TransactionConflict'].includes(reason.Code)));
}

export const LOCATION_RETENTION_MS = 14 * 60_000;
