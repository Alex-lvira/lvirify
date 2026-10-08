#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import {
  SPOTIFY_POLL_INTERVAL_MS,
  type HubPublicConfig,
  type Playback,
  type SlackSessionResponse,
} from '@lvirify/shared';
import {
  SlackError,
  SlackStatusTracker,
  SpotifyError,
  beginLogin,
  completeLogin,
  ensureFresh,
  fetchCurrentlyPlaying,
  whoAmI,
  type PendingLogin,
} from '@lvirify/clients';
import { ConfigStore, defaultConfigPath, type CompanionConfig } from './config.js';
import { HubClient } from './hub-client.js';
import { settingsPage } from './settings-page.js';

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', short: 'p' },
    config: { type: 'string', short: 'c' },
    hub: { type: 'string' },
    secret: { type: 'string' },
    'no-open': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (args.help) {
  console.log(`lvirify-companion

  --port, -p <n>     local settings port (default 48222, must match the Spotify redirect URI)
  --config, -c <f>   config file (default: ${defaultConfigPath()})
  --hub <url>        hub URL, saved to config
  --secret <s>       hub shared secret, saved to config
  --no-open          do not open the settings page in a browser on start
`);
  process.exit(0);
}

const config = new ConfigStore(args.config ?? defaultConfigPath());
{
  const patch: Partial<CompanionConfig> = {};
  if (args.port) patch.port = Number(args.port);
  if (args.hub) patch.hubUrl = args.hub.replace(/\/+$/, '');
  if (args.secret) patch.hubSecret = args.secret;
  if (Object.keys(patch).length) config.patch(patch);
}

const PORT = config.data.port;
const LOCAL_URL = `http://127.0.0.1:${PORT}`;
const SPOTIFY_REDIRECT = `${LOCAL_URL}/spotify/callback`;

/* ------------------------------------------------------------------ */
/* Runtime state                                                       */
/* ------------------------------------------------------------------ */

const logBuffer: { t: number; msg: string }[] = [];
function log(msg: string) {
  console.log(new Date().toISOString(), msg);
  logBuffer.push({ t: Date.now(), msg });
  if (logBuffer.length > 200) logBuffer.shift();
}

let playback: Playback | null = null;
let spotifyError: string | null = null;
let pendingSpotify: PendingLogin | null = null;

let hubPublic: HubPublicConfig | null = null;
let hubReachable = false;

let pendingSlackSession: string | null = null;
let slackError: string | null = null;

const hub = new HubClient(() => ({ url: config.data.hubUrl, secret: config.data.hubSecret }), log);

const slackStatus = new SlackStatusTracker({
  getToken: () => config.data.slack?.token ?? null,
  enabled: () => config.data.updateSlack,
  getEmoji: () => config.data.slackEmoji,
  log,
});

function effectiveSpotifyClientId(): string | null {
  return config.data.spotifyClientId || hubPublic?.spotifyClientId || null;
}

/* ------------------------------------------------------------------ */
/* Hub public config (Spotify client id, whether Slack is available)   */
/* ------------------------------------------------------------------ */

async function refreshHubPublicConfig() {
  if (!config.data.hubUrl) return;
  try {
    const res = await fetch(`${config.data.hubUrl}/api/public-config`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`hub answered ${res.status}`);
    hubPublic = (await res.json()) as HubPublicConfig;
    if (!hubReachable) log(`hub "${hubPublic.hubName}" reachable at ${config.data.hubUrl}`);
    hubReachable = true;
  } catch (e) {
    if (hubReachable || hubPublic === null) log(`cannot reach hub at ${config.data.hubUrl}: ${(e as Error).message}`);
    hubReachable = false;
  }
}

function syncHubBroadcast() {
  const auth = config.data.spotify;
  if (config.data.broadcastToHub && auth && config.data.hubUrl) hub.enable(auth.user);
  else hub.disable();
}

/* ------------------------------------------------------------------ */
/* Spotify polling                                                     */
/* ------------------------------------------------------------------ */

let pollTimer: NodeJS.Timeout | null = null;
let polling = false;

async function poll() {
  if (polling) return; // a login just kicked off a poll while one is in flight
  polling = true;
  let delay = SPOTIFY_POLL_INTERVAL_MS;
  try {
    const auth = config.data.spotify;
    if (auth) {
      const clientId = effectiveSpotifyClientId();
      if (!clientId) throw new SpotifyError('no Spotify client id available to refresh the token', 0);
      const fresh = await ensureFresh(auth, clientId);
      if (fresh !== auth) config.patch({ spotify: { ...auth, ...fresh } });

      const next = await fetchCurrentlyPlaying(fresh.accessToken);
      if (spotifyError) log('spotify ok again');
      spotifyError = null;
      const changed =
        (next?.trackId ?? null) !== (playback?.trackId ?? null) || (next?.isPlaying ?? false) !== (playback?.isPlaying ?? false);
      playback = next;
      if (changed) log(next ? `${next.isPlaying ? '▶' : '⏸'} ${next.title} – ${next.artists.join(', ')}` : '⏹ nothing playing');
      if (config.data.broadcastToHub) hub.publish(playback);
    }
    await slackTick();
  } catch (e) {
    if (e instanceof SpotifyError) {
      if (e.status === 429) {
        delay = Math.max(delay, e.retryAfterMs);
        log(`spotify rate limited, waiting ${Math.round(delay / 1000)}s`);
      } else if (e.tokenStale && config.data.spotify) {
        // Access token rejected (clock skew / early expiry): force a refresh on the next tick.
        config.patch({ spotify: { ...config.data.spotify, expiresAt: 0 } });
        delay = 1_000;
      } else if (e.needsReauth) {
        spotifyError = 'Spotify login expired, connect again';
        log(`spotify auth failed (${e.message}); reconnect needed`);
        config.patch({ spotify: null });
        playback = null;
        hub.disable();
        await clearSlackQuietly('spotify login expired');
      } else {
        if (spotifyError !== e.message) log(`spotify error: ${e.message}`);
        spotifyError = e.message;
        delay = Math.min(60_000, delay * 3);
        await slackTick(); // still lets an old status clear after the grace period
      }
    } else {
      log(`unexpected error: ${(e as Error).message}`);
    }
  } finally {
    polling = false;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => void poll(), delay);
  }
}

/* ------------------------------------------------------------------ */
/* Slack status                                                        */
/* ------------------------------------------------------------------ */

async function slackTick() {
  if (!config.data.slack) return;
  try {
    await slackStatus.tick(playback);
    if (slackError) log('slack ok again');
    slackError = null;
  } catch (e) {
    const msg = e instanceof SlackError ? e.code : (e as Error).message;
    if (slackError !== msg) log(`slack error: ${msg}`);
    slackError = msg;
    if (e instanceof SlackError && e.needsReauth) {
      log('slack token no longer valid, connect again');
      config.patch({ slack: null });
      slackStatus.reset();
    }
  }
}

async function clearSlackQuietly(reason: string) {
  try {
    await slackStatus.clearOwn(reason);
  } catch (e) {
    log(`slack error while clearing: ${(e as Error).message}`);
  }
}

/* Slack OAuth via the hub: poll the session until the token arrives. */
async function waitForSlackSession(session: string) {
  const deadline = Date.now() + 10 * 60_000;
  try {
    while (pendingSlackSession === session && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      let res: Response;
      try {
        res = await fetch(`${config.data.hubUrl}/api/slack/session/${session}`, {
          headers: { authorization: `Bearer ${config.data.hubSecret}` },
          signal: AbortSignal.timeout(5000),
        });
      } catch (e) {
        slackError = (e as Error).message;
        continue;
      }
      if (res.status === 401) {
        slackError = 'hub rejected the shared secret';
        log('slack connect failed: hub rejected the shared secret');
        return;
      }
      const body = (await res.json().catch(() => ({ status: 'pending' }))) as SlackSessionResponse;
      if (body.status === 'pending') continue;
      if (body.status === 'error') {
        slackError = body.message;
        log(`slack connect failed: ${body.message}`);
        return;
      }
      const me = await whoAmI(body.token).catch(() => null);
      config.patch({ slack: { token: body.token, slackUserId: body.slackUserId, teamName: me?.team ?? body.teamName } });
      slackError = null;
      slackStatus.reset();
      log(`slack connected (${config.data.slack!.teamName})`);
      return;
    }
    if (pendingSlackSession === session) log('slack connect timed out');
  } finally {
    if (pendingSlackSession === session) pendingSlackSession = null;
  }
}

/* ------------------------------------------------------------------ */
/* Local settings server                                               */
/* ------------------------------------------------------------------ */

const app = new Hono();

/* Only the local browser may talk to this server: block other hosts (DNS rebinding) and cross-site POSTs. */
app.use('*', async (c, next) => {
  const host = c.req.header('host') ?? '';
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return c.text('forbidden host', 403);
  if (c.req.method === 'POST') {
    const origin = c.req.header('origin');
    if (origin && new URL(origin).host !== host) return c.text('cross-site request blocked', 403);
    const site = c.req.header('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') return c.text('cross-site request blocked', 403);
    if (!(c.req.header('content-type') ?? '').startsWith('application/json')) return c.text('expected application/json', 415);
  }
  await next();
});

app.onError((err, c) => {
  log(`http error: ${err.message}`);
  return c.text(err.message, 500);
});

app.get('/', (c) => c.html(settingsPage()));

app.get('/api/status', (c) => {
  const { spotify: sp, slack: sl, ...rest } = config.data;
  return c.json({
    configPath: config.file,
    config: rest,
    spotifyRedirectUri: SPOTIFY_REDIRECT,
    spotifyClientIdInUse: effectiveSpotifyClientId(),
    hubReachable,
    hubSlackEnabled: hubPublic?.slackEnabled ?? null,
    hub: { status: hub.status, lastError: hub.lastError, hubName: hub.hubName },
    spotify: { connected: !!sp, user: sp?.user ?? null, error: spotifyError },
    slack: {
      connected: !!sl,
      teamName: sl?.teamName ?? null,
      error: slackError,
      pending: !!pendingSlackSession,
      lastSetText: slackStatus.currentText,
    },
    playback,
    log: logBuffer.slice(-60),
  });
});

app.post('/api/config', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<CompanionConfig>;
  const patch: Partial<CompanionConfig> = {};
  if (typeof body.hubUrl === 'string') patch.hubUrl = body.hubUrl.trim().replace(/\/+$/, '');
  if (typeof body.hubSecret === 'string') patch.hubSecret = body.hubSecret;
  if (typeof body.spotifyClientId === 'string') patch.spotifyClientId = body.spotifyClientId.trim();
  if (typeof body.slackEmoji === 'string') {
    const t = body.slackEmoji.trim().replace(/^:+|:+$/g, '');
    patch.slackEmoji = t ? `:${t}:` : ':headphones:';
  }
  if (typeof body.broadcastToHub === 'boolean') patch.broadcastToHub = body.broadcastToHub;
  if (typeof body.updateSlack === 'boolean') patch.updateSlack = body.updateSlack;
  const before = config.data;
  config.patch(patch);

  if (patch.hubUrl !== undefined || patch.hubSecret !== undefined) {
    await refreshHubPublicConfig();
    hub.reconnectNow();
  }
  if (patch.broadcastToHub !== undefined && patch.broadcastToHub !== before.broadcastToHub) {
    log(patch.broadcastToHub ? 'office wall: on' : 'office wall: off');
  }
  syncHubBroadcast();
  if (patch.updateSlack !== undefined && patch.updateSlack !== before.updateSlack) {
    log(patch.updateSlack ? 'slack status updates: on' : 'slack status updates: off');
    void slackTick(); // applies immediately: sets, or clears what we wrote
  }
  return c.json({ ok: true });
});

app.get('/spotify/login', (c) => {
  const clientId = effectiveSpotifyClientId();
  if (!clientId) return c.text('No Spotify client id. Set one in Advanced or configure it on the hub.', 400);
  const { url, pending } = beginLogin(clientId, SPOTIFY_REDIRECT);
  pendingSpotify = pending;
  return c.redirect(url);
});

app.get('/spotify/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');
  if (!pendingSpotify || state !== pendingSpotify.state) return c.redirect('/?error=' + encodeURIComponent('Spotify login state mismatch, try again'));
  if (error || !code) return c.redirect('/?error=' + encodeURIComponent(`Spotify: ${error ?? 'no code'}`));
  try {
    const { tokens, user } = await completeLogin(pendingSpotify, code);
    pendingSpotify = null;
    config.patch({ spotify: { ...tokens, user } });
    spotifyError = null;
    log(`spotify connected as ${user.name}`);
    syncHubBroadcast();
    void poll();
    return c.redirect('/?connected=Spotify');
  } catch (e) {
    return c.redirect('/?error=' + encodeURIComponent((e as Error).message));
  }
});

app.post('/api/spotify/disconnect', async (c) => {
  config.patch({ spotify: null });
  playback = null;
  hub.disable();
  await clearSlackQuietly('spotify disconnected');
  log('spotify disconnected');
  return c.json({ ok: true });
});

app.get('/slack/login', async (c) => {
  if (!config.data.hubUrl) return c.text('Set the hub URL first; the hub handles the Slack login.', 400);
  await refreshHubPublicConfig();
  if (!hubReachable) return c.text(`Cannot reach the hub at ${config.data.hubUrl}.`, 502);
  if (hubPublic && !hubPublic.slackEnabled) return c.text('The hub has no Slack app configured.', 503);
  const session = crypto.randomBytes(24).toString('base64url');
  try {
    const res = await fetch(`${config.data.hubUrl}/api/slack/session/${session}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.data.hubSecret}` },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 401) return c.text('The hub rejected the shared secret. Check it under Office hub.', 401);
    if (!res.ok) return c.text(`Hub refused to start a Slack login (${res.status}).`, 502);
  } catch (e) {
    return c.text(`Cannot reach the hub: ${(e as Error).message}`, 502);
  }
  pendingSlackSession = session;
  slackError = null;
  void waitForSlackSession(session);
  return c.redirect(`${config.data.hubUrl}/slack/connect?session=${session}`);
});

app.post('/api/slack/disconnect', async (c) => {
  await clearSlackQuietly('slack disconnected');
  config.patch({ slack: null });
  pendingSlackSession = null;
  slackStatus.reset();
  log('slack disconnected');
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const cmdArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* no browser available, the URL is printed anyway */
  }
}

const server = serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, async () => {
  log(`settings page: ${LOCAL_URL}`);
  log(`config: ${config.file}`);
  await refreshHubPublicConfig();
  syncHubBroadcast();
  void poll();
  setInterval(() => void refreshHubPublicConfig(), 60_000).unref();
  if (!args['no-open'] && !config.data.spotify) openBrowser(LOCAL_URL);
});
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Is another companion running? Use --port to pick another (and register it in the Spotify app).`);
  } else {
    console.error(err.message);
  }
  process.exit(1);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) process.exit(0); // second signal: leave now
  shuttingDown = true;
  log('shutting down');
  hub.disable();
  await Promise.race([clearSlackQuietly('companion stopped'), new Promise((r) => setTimeout(r, 4000))]);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.on('unhandledRejection', (e) => log(`unhandled rejection: ${(e as Error)?.message ?? e}`));
