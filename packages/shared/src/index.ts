/**
 * Types and constants shared by the hub, the companion and the dashboard.
 * Keep this file dependency-free: it is imported by browser code too.
 */

export const DEFAULT_COMPANION_PORT = 48222;
export const DEFAULT_HUB_PORT = 3000;

/** How often the companion asks Spotify what is playing. */
export const SPOTIFY_POLL_INTERVAL_MS = 5_000;

/** How long the hub keeps a user on the wall after their socket drops. */
export const HUB_DISCONNECT_GRACE_MS = 20_000;

/** Nothing has played for this long -> the Slack status is cleared. */
export const SLACK_CLEAR_GRACE_MS = 2 * 60_000;

/** Number of past tracks the hub remembers per user. */
export const HISTORY_LENGTH = 5;

export interface UserIdentity {
  /** Stable id, the Spotify user id. */
  id: string;
  name: string;
  avatarUrl: string | null;
}

export interface Playback {
  isPlaying: boolean;
  trackId: string;
  title: string;
  artists: string[];
  album: string;
  albumArtUrl: string | null;
  durationMs: number;
  /** Position at `fetchedAt`. Consumers interpolate from there. */
  progressMs: number;
  /** Deep link into Spotify (open.spotify.com URL). */
  url: string | null;
  /** Unix ms when the companion observed this state. */
  fetchedAt: number;
}

export interface HistoryEntry {
  trackId: string;
  title: string;
  artists: string[];
  albumArtUrl: string | null;
  url: string | null;
  /** Unix ms when the track was first seen playing. */
  playedAt: number;
}

/** What the dashboard renders for one connected user. */
export interface WallUser {
  user: UserIdentity;
  /** null = connected but nothing is playing. */
  playback: Playback | null;
  history: HistoryEntry[];
  connectedAt: number;
  lastSeen: number;
}

/* ---------- companion -> hub ---------- */

export type CompanionMessage =
  | { type: 'hello'; user: UserIdentity; playback: Playback | null }
  | { type: 'state'; playback: Playback | null }
  | { type: 'bye' };

/* ---------- hub -> companion ---------- */

export type HubToCompanionMessage =
  | { type: 'welcome'; hubName: string }
  | { type: 'error'; message: string };

/* ---------- hub -> dashboard ---------- */

export type DashboardMessage =
  | { type: 'snapshot'; hubName: string; users: WallUser[] }
  | { type: 'user'; user: WallUser }
  | { type: 'remove'; userId: string };

/* ---------- hub HTTP API ---------- */

/** GET /api/public-config — safe to expose to anyone on the LAN. */
export interface HubPublicConfig {
  hubName: string;
  spotifyClientId: string | null;
  slackEnabled: boolean;
}

/** GET /api/slack/session/:id (companion polls this during Slack OAuth). */
export type SlackSessionResponse =
  | { status: 'pending' }
  | { status: 'error'; message: string }
  | {
      status: 'done';
      token: string;
      slackUserId: string;
      teamName: string;
    };

export function formatArtists(artists: string[]): string {
  return artists.join(', ');
}
