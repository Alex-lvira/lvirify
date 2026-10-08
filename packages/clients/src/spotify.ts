import crypto from 'node:crypto';
import type { Playback, UserIdentity } from '@lvirify/shared';

export const SPOTIFY_SCOPES = ['user-read-currently-playing', 'user-read-playback-state'];

/** Overridable so tests can point at a fake Spotify. */
const ACCOUNTS = (process.env.SPOTIFY_ACCOUNTS_URL ?? 'https://accounts.spotify.com').replace(/\/+$/, '');
const API = (process.env.SPOTIFY_API_URL ?? 'https://api.spotify.com/v1').replace(/\/+$/, '');

export interface SpotifyTokens {
  accessToken: string;
  refreshToken: string;
  /** Unix ms. */
  expiresAt: number;
}

export class SpotifyError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryAfterMs = 0,
    /** A 401 from the API only means "refresh now"; from the token endpoint it means "log in again". */
    public source: 'api' | 'token' = 'api',
  ) {
    super(message);
    this.name = 'SpotifyError';
  }
  /** True when the user must log in again (refresh token revoked, app access removed). */
  get needsReauth() {
    return this.status === 401 && this.source === 'token';
  }
  /** Access token rejected by the API; refresh it and retry. */
  get tokenStale() {
    return this.status === 401 && this.source === 'api';
  }
}

/* ---------------- PKCE login ---------------- */

export interface PendingLogin {
  state: string;
  verifier: string;
  redirectUri: string;
  clientId: string;
  createdAt: number;
}

export function beginLogin(clientId: string, redirectUri: string): { url: string; pending: PendingLogin } {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('base64url');
  const url = new URL(`${ACCOUNTS}/authorize`);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', SPOTIFY_SCOPES.join(' '));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('state', state);
  return { url: url.toString(), pending: { state, verifier, redirectUri, clientId, createdAt: Date.now() } };
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  error?: string;
  error_description?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || json.error) {
    // invalid_grant = refresh token revoked (user removed the app, or the dev-mode allowlist changed).
    const status = json.error === 'invalid_grant' ? 401 : res.status;
    throw new SpotifyError(`${json.error ?? res.status}: ${json.error_description ?? 'token request failed'}`, status, 0, 'token');
  }
  return json;
}

export async function completeLogin(pending: PendingLogin, code: string): Promise<{ tokens: SpotifyTokens; user: UserIdentity }> {
  const t = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: pending.redirectUri,
    client_id: pending.clientId,
    code_verifier: pending.verifier,
  });
  if (!t.refresh_token) throw new SpotifyError('Spotify did not return a refresh token', 500);
  const tokens: SpotifyTokens = {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: Date.now() + t.expires_in * 1000,
  };
  const user = await fetchProfile(tokens.accessToken);
  return { tokens, user };
}

export async function refresh(tokens: SpotifyTokens, clientId: string): Promise<SpotifyTokens> {
  const t = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: clientId,
  });
  return {
    accessToken: t.access_token,
    // Spotify may rotate the refresh token; keep the old one if it does not.
    refreshToken: t.refresh_token ?? tokens.refreshToken,
    expiresAt: Date.now() + t.expires_in * 1000,
  };
}

/** Returns the same object if still valid, a refreshed one otherwise. */
export async function ensureFresh(tokens: SpotifyTokens, clientId: string): Promise<SpotifyTokens> {
  if (tokens.expiresAt - 60_000 > Date.now()) return tokens;
  return refresh(tokens, clientId);
}

/* ---------------- API calls ---------------- */

async function apiGet<T>(token: string, pathAndQuery: string): Promise<{ status: number; body: T | null }> {
  const res = await fetch(`${API}${pathAndQuery}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 204) return { status: 204, body: null };
  if (res.status === 429) {
    const retry = Number(res.headers.get('retry-after') ?? '5');
    throw new SpotifyError('rate limited', 429, retry * 1000);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new SpotifyError(`spotify ${res.status}: ${text.slice(0, 200)}`, res.status);
  }
  return { status: res.status, body: (await res.json()) as T };
}

interface SpotifyProfile {
  id: string;
  display_name: string | null;
  images?: { url: string; width: number | null }[];
}

export async function fetchProfile(token: string): Promise<UserIdentity> {
  const { body } = await apiGet<SpotifyProfile>(token, '/me');
  if (!body) throw new SpotifyError('empty profile', 500);
  const avatar = [...(body.images ?? [])].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url ?? null;
  return { id: body.id, name: body.display_name || body.id, avatarUrl: avatar };
}

interface CurrentlyPlaying {
  is_playing: boolean;
  progress_ms: number | null;
  currently_playing_type: 'track' | 'episode' | 'ad' | 'unknown';
  item: null | {
    id: string | null;
    name: string;
    duration_ms: number;
    external_urls?: { spotify?: string };
    artists?: { name: string }[];
    album?: { name: string; images?: { url: string; width: number | null }[] };
    show?: { name: string; publisher?: string };
    images?: { url: string; width: number | null }[];
  };
}

/** Returns null when nothing is playing (Spotify 204), the item is an ad, or it is a local file without an id. */
export async function fetchCurrentlyPlaying(token: string): Promise<Playback | null> {
  const { body } = await apiGet<CurrentlyPlaying>(token, '/me/player/currently-playing?additional_types=track,episode');
  if (!body || !body.item) return null;
  const item = body.item;
  const isEpisode = body.currently_playing_type === 'episode';
  const images = (isEpisode ? item.images : item.album?.images) ?? [];
  // Medium-ish image is plenty for a cassette; pick the largest under ~640px.
  const art =
    [...images].filter((i) => (i.width ?? 0) <= 640).sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url ??
    images[0]?.url ??
    null;
  return {
    isPlaying: body.is_playing,
    // Local files have no id; make one from the name so track changes are still detected.
    trackId: item.id ?? `local:${item.name}`,
    title: item.name,
    artists: isEpisode ? [item.show?.name ?? 'Podcast'] : (item.artists ?? []).map((a) => a.name),
    album: isEpisode ? item.show?.publisher ?? '' : item.album?.name ?? '',
    albumArtUrl: art,
    durationMs: item.duration_ms,
    progressMs: body.progress_ms ?? 0,
    url: item.external_urls?.spotify ?? null,
    fetchedAt: Date.now(),
  };
}
