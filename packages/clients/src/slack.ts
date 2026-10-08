import { formatArtists, type Playback } from '@lvirify/shared';

const API = (process.env.SLACK_API_URL ?? 'https://slack.com/api').replace(/\/+$/, '');
/** Slack caps status_text at 100 characters. */
const MAX_STATUS = 100;

export class SlackError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = 'SlackError';
  }
  /** The token is dead; the user must connect Slack again. */
  get needsReauth() {
    return ['invalid_auth', 'token_revoked', 'account_inactive', 'not_authed', 'token_expired'].includes(this.code);
  }
}

async function call<T>(token: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}/${method}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }))) as { ok: boolean; error?: string } & T;
  if (!json.ok) throw new SlackError(json.error ?? `${method}_failed`);
  return json;
}

export function statusTextFor(p: Playback): string {
  const full = `${p.title} – ${formatArtists(p.artists)}`;
  const chars = [...full]; // code points, so an emoji is never cut in half
  return chars.length <= MAX_STATUS ? full : `${chars.slice(0, MAX_STATUS - 1).join('')}…`;
}

/** Slack HTML-escapes profile text on read (`&amp;`); normalise before comparing. */
export function sameStatusText(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
  return norm(a) === norm(b);
}

export interface StatusProfile {
  status_text: string;
  status_emoji: string;
  status_expiration: number;
}

export async function getStatus(token: string): Promise<StatusProfile> {
  const json = await call<{ profile: StatusProfile }>(token, 'users.profile.get');
  return json.profile;
}

export async function setStatus(token: string, text: string, emoji: string, expirationUnixSec: number) {
  await call(token, 'users.profile.set', {
    profile: { status_text: text, status_emoji: emoji, status_expiration: expirationUnixSec },
  });
}

export async function clearStatus(token: string) {
  await call(token, 'users.profile.set', {
    profile: { status_text: '', status_emoji: '', status_expiration: 0 },
  });
}

export async function whoAmI(token: string): Promise<{ user: string; team: string; user_id: string }> {
  return call<{ user: string; team: string; user_id: string }>(token, 'auth.test', {});
}

/** Exchange an OAuth code for a user token. Used by the hub's broker. */
export async function exchangeCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<{ token: string; slackUserId: string; teamName: string; teamId: string }> {
  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code: opts.code,
    redirect_uri: opts.redirectUri,
  });
  const res = await fetch(`${API}/oauth.v2.access`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({ ok: false }))) as {
    ok: boolean;
    error?: string;
    team?: { name?: string; id?: string };
    authed_user?: { id?: string; access_token?: string };
  };
  if (!json.ok || !json.authed_user?.access_token) throw new SlackError(json.error ?? 'oauth.v2.access failed');
  return {
    token: json.authed_user.access_token,
    slackUserId: json.authed_user.id ?? '',
    teamName: json.team?.name ?? 'Slack',
    teamId: json.team?.id ?? '',
  };
}

export function authorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL('https://slack.com/oauth/v2/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('user_scope', 'users.profile:write,users.profile:read');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}
