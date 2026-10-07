import type { Coordinate, Tour, TrackPoint } from '@/types';
import { distanceBetween, routeDistance } from '@/utils/routes';

export type RecordingSession = {
  startedAt: number;
  activeSince: number | null;
  elapsedMs: number;
  segments: TrackPoint[][];
};

export function startRecording(now: number): RecordingSession {
  return { startedAt: now, activeSince: now, elapsedMs: 0, segments: [[]] };
}

export function recordingSeconds(session: RecordingSession, now: number) {
  return Math.floor((session.elapsedMs + (session.activeSince == null ? 0 : Math.max(0, now - session.activeSince))) / 1000);
}

export function pauseRecording(session: RecordingSession, now: number): RecordingSession {
  if (session.activeSince == null) return session;
  return { ...session, elapsedMs: session.elapsedMs + Math.max(0, now - session.activeSince), activeSince: null };
}

export function resumeRecording(session: RecordingSession, now: number): RecordingSession {
  if (session.activeSince != null) return session;
  return { ...session, activeSince: now, segments: [...session.segments, []] };
}

export function appendRecordingFix(session: RecordingSession, point: TrackPoint, now: number, maxAgeMs = 15000): RecordingSession {
  if (session.activeSince == null || !Number.isFinite(point.latitude) || Math.abs(point.latitude) > 90
    || !Number.isFinite(point.longitude) || Math.abs(point.longitude) > 180
    || !Number.isFinite(point.accuracy) || point.accuracy < 0 || point.accuracy > 50
    || !Number.isFinite(point.timestamp) || point.timestamp < session.activeSince
    || now - point.timestamp > maxAgeMs || point.timestamp > now + 1000) return session;
  const segment = session.segments[session.segments.length - 1] ?? [];
  const previous = segment[segment.length - 1];
  if (previous && point.timestamp <= previous.timestamp) return session;
  // Never invent a connecting road through a GPS outage or a pause.
  if (previous && point.timestamp - previous.timestamp > 30000) {
    return { ...session, segments: [...session.segments, [point]] };
  }
  if (previous) {
    const distanceKm = distanceBetween(previous, point);
    if (distanceKm < 0.003 || distanceKm / ((point.timestamp - previous.timestamp) / 3600000) > 250) return session;
  }
  return { ...session, segments: [...session.segments.slice(0, -1), [...segment, { ...point }]] };
}

export function recordedDistance(segments: Coordinate[][]) {
  return segments.reduce((sum, segment) => sum + routeDistance(segment), 0);
}

export function tourFromRecording(session: RecordingSession, endedAt: number, title?: string): Tour {
  const segments = session.segments.filter((segment) => segment.length > 0).map((segment) => segment.map((point) => ({ ...point })));
  const durationSeconds = recordingSeconds(session, endedAt);
  return {
    id: `ride-${session.startedAt}-${endedAt}`,
    title: title ?? `Ride ${new Date(session.startedAt).toLocaleDateString('en-GB')}`,
    place: 'Recorded in Bendbound',
    date: new Date(session.startedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
    distanceKm: Math.round(recordedDistance(segments) * 100) / 100,
    durationMin: durationSeconds / 60,
    curves: 0,
    elevationM: 0,
    author: 'Octavian',
    saved: false,
    completed: true,
    route: segments.flat(),
    recording: { startedAt: session.startedAt, endedAt, durationSeconds, segments },
  };
}

export function formatRidingTime(seconds: number) {
  const duration = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(duration / 3600);
  const minutes = Math.floor(duration / 60) % 60;
  return `${hours ? `${hours}:` : ''}${minutes.toString().padStart(2, '0')}:${(duration % 60).toString().padStart(2, '0')}`;
}

export function toursForCollection(tours: Tour[], collection: 'rides' | 'saved') {
  return tours.filter((tour) => collection === 'rides' ? tour.completed : tour.saved);
}
