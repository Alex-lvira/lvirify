import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { serve } from '@hono/node-server';
import { WebSocketServer, WebSocket } from 'ws';
import type { CompanionMessage, DashboardMessage, HubPublicConfig, HubToCompanionMessage, Playback, UserIdentity } from '@lvirify/shared';
import { beginLogin, completeLogin, type PendingLogin } from '@lvirify/clients';
import { env } from './env.js';
import { Store } from './store.js';
import { SlackBroker } from './slack-broker.js';
import { Members } from './members.js';
import { joinPage, mePage, messagePage } from './pages.js';

const log = (...args: unknown[]) => console.log(new Date().toISOString(), '[hub]', ...args);

const store = new Store(env.dataDir);
const slack = env.slack ? new SlackBroker(env.slack) : null;
const members = new Members(env.dataDir, store, () => env.spotifyClientId, (m) => log(m));
const app = new Hono();

app.onError((err, c) => {
  log(`http error on ${c.req.path}: ${err.message}`);
  return c.text('internal error', 500);
});

/* ------------------------------------------------------------------ */
/* Validation of what companions send                                  */
/* ------------------------------------------------------------------ */

const isStr = (v: unknown, max = 500): v is string => typeof v === 'string' && v.length <= max;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isHttpsUrl = (v: unknown): v is string => isStr(v, 2000) && /^https:\/\//.test(v);

function validUser(u: unknown): u is UserIdentity {
  if (!u || typeof u !== 'object') return false;
  const x = u as Record<string, unknown>;
  return isStr(x.id, 200) && x.id.length > 0 && isStr(x.name, 200) && x.name.length > 0 && (x.avatarUrl === null || isHttpsUrl(x.avatarUrl));
}

function validPlayback(p: unknown): p is Playback | null {
  if (p === null || p === undefined) return true;
  if (typeof p !== 'object') return false;
  const x = p as Record<string, unknown>;
  return (
    typeof x.isPlaying === 'boolean' &&
    isStr(x.trackId, 300) &&
    isStr(x.title, 500) &&
    Array.isArray(x.artists) &&
    x.artists.every((a) => isStr(a, 300)) &&
    isStr(x.album, 500) &&
    (x.albumArtUrl === null || isHttpsUrl(x.albumArtUrl)) &&
    isNum(x.durationMs) &&
    isNum(x.progressMs) &&
    (x.url === null || (isHttpsUrl(x.url) && x.url.startsWith('https://open.spotify.com/'))) &&
    isNum(x.fetchedAt)
  );
}

/* ------------------------------------------------------------------ */
/* Auth helpers                                                        */
/* ------------------------------------------------------------------ */

function companionAuthorized(req: Request): boolean {
  const header = req.headers.get('authorization') ?? '';
  return safeEqual(header, `Bearer ${env.hubSecret}`);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/* Member identity: a signed cookie carrying the Spotify user id. */
const COOKIE = 'lv_member';
function sign(userId: string): string {
  return crypto.createHmac('sha256', env.hubSecret).update(`member:${userId}`).digest('base64url');
}
function memberIdFrom(c: Context): string | null {
  const raw = getCookie(c, COOKIE);
  if (!raw) return null;
  const idx = raw.lastIndexOf('.');
  if (idx <= 0) return null;
  const id = decodeURIComponent(raw.slice(0, idx));
  const sig = raw.slice(idx + 1);
  return safeEqual(sig, sign(id)) ? id : null;
}
function setMemberCookie(c: Context, userId: string) {
  setCookie(c, COOKIE, `${encodeURIComponent(userId)}.${sign(userId)}`, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: env.isHttps,
    path: '/',
    maxAge: 365 * 24 * 3600,
  });
}

/* Optional wall password: DASHBOARD_KEY=... makes the wall itself private. */
const WALL_COOKIE = 'lv_wall';
function wallAllowed(c: Context): boolean {
  if (!env.dashboardKey) return true;
  const key = c.req.query('key');
  if (key && safeEqual(key, env.dashboardKey)) {
    setCookie(c, WALL_COOKIE, sign(`wall:${env.dashboardKey}`), { httpOnly: true, sameSite: 'Lax', secure: env.isHttps, path: '/', maxAge: 365 * 24 * 3600 });
    return true;
  }
  const cookie = getCookie(c, WALL_COOKIE);
  return !!cookie && safeEqual(cookie, sign(`wall:${env.dashboardKey}`));
}
function wallAllowedRaw(req: IncomingMessage): boolean {
  if (!env.dashboardKey) return true;
  const m = /(?:^|;\s*)lv_wall=([^;]+)/.exec(req.headers.cookie ?? '');
  return !!m && safeEqual(decodeURIComponent(m[1]!), sign(`wall:${env.dashboardKey}`));
}

/* ------------------------------------------------------------------ */
/* HTTP API                                                            */
/* ------------------------------------------------------------------ */

app.get('/healthz', (c) => c.text('ok'));

app.get('/api/public-config', (c) => {
  const body: HubPublicConfig = { hubName: env.hubName, spotifyClientId: env.spotifyClientId, slackEnabled: slack !== null };
  return c.json(body);
});

app.get('/api/state', (c) => {
  if (!wallAllowed(c)) return c.text('unauthorized', 401);
  return c.json({ hubName: env.hubName, users: store.snapshot() });
});

/* ---- Slack broker (companions + members) ---- */

app.post('/api/slack/session/:id', (c) => {
  if (!companionAuthorized(c.req.raw)) return c.text('unauthorized', 401);
  if (!slack) return c.json({ status: 'error', message: 'Slack not configured on hub' }, 503);
  try {
    slack.register(c.req.param('id'), { kind: 'companion' });
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ ok: false, message: (e as Error).message }, 400);
  }
});

app.get('/api/slack/session/:id', (c) => {
  if (!companionAuthorized(c.req.raw)) return c.text('unauthorized', 401);
  if (!slack) return c.json({ status: 'error', message: 'Slack not configured on hub' }, 503);
  return c.json(slack.poll(c.req.param('id')));
});

app.get('/slack/connect', (c) => {
  if (!slack) return c.html(messagePage({ hubName: env.hubName, ok: false, title: 'Slack not configured', message: 'This hub has no Slack app configured.' }), 503);
  const session = c.req.query('session');
  if (!session) return c.text('missing session', 400);
  try {
    return c.redirect(slack.authorizeUrl(session));
  } catch (e) {
    return c.html(messagePage({ hubName: env.hubName, ok: false, title: 'Session expired', message: (e as Error).message }), 400);
  }
});

app.get('/slack/callback', async (c) => {
  if (!slack) return c.text('Slack is not configured on this hub.', 503);
  const outcome = await slack.complete(c.req.query('state') ?? '', c.req.query('code'), c.req.query('error'));
  log('slack oauth', outcome.ok ? 'completed' : `failed: ${outcome.message}`, outcome.owner ? `(${outcome.owner.kind})` : '');
  if (outcome.ok && outcome.owner?.kind === 'member' && outcome.token) {
    members.setSlack(outcome.owner.userId, outcome.token);
    return c.redirect('/me?notice=' + encodeURIComponent('Slack connected'));
  }
  if (!outcome.ok && outcome.owner?.kind === 'member') {
    return c.html(messagePage({ hubName: env.hubName, ok: false, title: 'Slack login failed', message: outcome.message, link: { href: '/me', label: 'Back to settings' } }), 400);
  }
  return c.html(
    messagePage({
      hubName: env.hubName,
      ok: outcome.ok,
      title: outcome.ok ? 'Slack connected' : 'Slack login failed',
      message: outcome.ok ? 'You can close this tab and go back to the companion.' : outcome.message,
    }),
    outcome.ok ? 200 : 400,
  );
});

/* ---- Join from the website ---- */

const pendingSpotify = new Map<string, PendingLogin>();
setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [k, v] of pendingSpotify) if (v.createdAt < cutoff) pendingSpotify.delete(k);
}, 60_000).unref();

app.get('/join', (c) => {
  if (!env.webJoin) return c.html(messagePage({ hubName: env.hubName, ok: false, title: 'Joining from the site is off', message: 'Run the companion on your machine instead.' }), 404);
  const id = memberIdFrom(c);
  if (id && members.get(id)) return c.redirect('/me');
  return c.html(joinPage({ hubName: env.hubName, spotifyReady: !!env.spotifyClientId, slackReady: slack !== null, error: c.req.query('error') }));
});

app.get('/spotify/login', (c) => {
  if (!env.webJoin) return c.text('disabled', 404);
  if (!env.spotifyClientId) return c.redirect('/join?error=' + encodeURIComponent('Hub has no SPOTIFY_CLIENT_ID'));
  const { url, pending } = beginLogin(env.spotifyClientId, env.spotifyRedirectUri);
  pendingSpotify.set(pending.state, pending);
  return c.redirect(url);
});

app.get('/spotify/callback', async (c) => {
  const state = c.req.query('state') ?? '';
  const pending = pendingSpotify.get(state);
  pendingSpotify.delete(state);
  const fail = (msg: string) => c.redirect('/join?error=' + encodeURIComponent(msg));
  if (!pending) return fail('Login expired or state mismatch. Try again.');
  const error = c.req.query('error');
  const code = c.req.query('code');
  if (error || !code) return fail(`Spotify: ${error ?? 'no code returned'}`);
  try {
    const { tokens, user } = await completeLogin(pending, code);
    members.join(user, tokens);
    setMemberCookie(c, user.id);
    return c.redirect('/me?notice=' + encodeURIComponent(`Welcome, ${user.name}`));
  } catch (e) {
    log(`spotify join failed: ${(e as Error).message}`);
    return fail((e as Error).message);
  }
});

function requireMember(c: Context) {
  const id = memberIdFrom(c);
  const m = id ? members.get(id) : undefined;
  return m ?? null;
}

app.get('/me', (c) => {
  const m = requireMember(c);
  if (!m) return c.redirect('/join');
  return c.html(
    mePage({
      hubName: env.hubName,
      user: m.user,
      spotifyConnected: !!m.spotify,
      spotifyError: m.spotifyError,
      slackReady: slack !== null,
      slack: m.slack ? { teamName: m.slack.teamName } : null,
      slackError: m.slackError,
      showOnWall: m.showOnWall,
      updateSlack: m.updateSlack,
      emoji: m.emoji,
      playback: m.playback,
      notice: c.req.query('notice'),
    }),
  );
});

app.get('/api/me', (c) => {
  const m = requireMember(c);
  if (!m) return c.text('unauthorized', 401);
  return c.json({
    user: m.user,
    spotifyConnected: !!m.spotify,
    spotifyError: m.spotifyError,
    slack: m.slack ? { teamName: m.slack.teamName } : null,
    slackError: m.slackError,
    showOnWall: m.showOnWall,
    updateSlack: m.updateSlack,
    emoji: m.emoji,
    playback: m.playback,
  });
});

app.post('/api/me', async (c) => {
  const m = requireMember(c);
  if (!m) return c.text('unauthorized', 401);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const patch: Parameters<Members['update']>[1] = {};
  if (typeof body.showOnWall === 'boolean') patch.showOnWall = body.showOnWall;
  if (typeof body.updateSlack === 'boolean') patch.updateSlack = body.updateSlack;
  if (typeof body.emoji === 'string') patch.emoji = normaliseEmoji(body.emoji);
  members.update(m.user.id, patch);
  return c.json({ ok: true });
});

app.get('/me/slack/login', (c) => {
  const m = requireMember(c);
  if (!m) return c.redirect('/join');
  if (!slack) return c.text('Slack is not configured on this hub.', 503);
  const session = SlackBroker.newSessionId();
  slack.register(session, { kind: 'member', userId: m.user.id });
  return c.redirect(slack.authorizeUrl(session));
});

app.post('/api/me/slack/disconnect', async (c) => {
  const m = requireMember(c);
  if (!m) return c.text('unauthorized', 401);
  await members.disconnectSlack(m.user.id);
  return c.json({ ok: true });
});

app.post('/api/me/leave', async (c) => {
  const m = requireMember(c);
  if (!m) return c.text('unauthorized', 401);
  await members.leave(m.user.id);
  deleteCookie(c, COOKIE, { path: '/' });
  return c.json({ ok: true });
});

function normaliseEmoji(s: string): string {
  const t = s.trim().replace(/^:+|:+$/g, '');
  return t ? `:${t}:` : ':headphones:';
}

/* ------------------------------------------------------------------ */
/* Static dashboard                                                    */
/* ------------------------------------------------------------------ */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

app.get('*', (c) => {
  let rel: string;
  try {
    rel = decodeURIComponent(new URL(c.req.url).pathname).replace(/^\/+/, '');
  } catch {
    return c.text('bad request', 400);
  }
  const dir = env.dashboardDir;
  let file = path.resolve(dir, rel);
  if (file !== dir && !file.startsWith(dir + path.sep)) return c.text('forbidden', 403);
  const isAsset = rel.startsWith('assets/') || rel === 'favicon.svg';
  if (!rel || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (isAsset) return c.text('not found', 404);
    // SPA fallback: "/" and "/kiosk" both render the dashboard.
    if (!wallAllowed(c)) return c.html(messagePage({ hubName: env.hubName, ok: false, title: 'Private wall', message: 'This wall needs a key. Ask whoever runs the hub for the link with ?key=…' }), 401);
    file = path.join(dir, 'index.html');
    if (!fs.existsSync(file)) return c.text('Dashboard not built. Run `npm run build`.', 503);
  }
  const ext = path.extname(file);
  return c.body(fs.readFileSync(file), 200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
});

/* ------------------------------------------------------------------ */
/* Server + WebSockets                                                 */
/* ------------------------------------------------------------------ */

const server = serve({ fetch: app.fetch, port: env.port, hostname: '0.0.0.0' }, () => {
  log(`listening on http://0.0.0.0:${env.port}  (public: ${env.publicUrl})`);
  log(`dashboard dir: ${env.dashboardDir}${fs.existsSync(env.dashboardDir) ? '' : '  (missing, build it)'}`);
  log(`slack broker: ${slack ? 'enabled' : 'disabled (no SLACK_CLIENT_ID/SECRET)'}`);
  log(`join from site: ${env.webJoin ? (env.spotifyClientId ? 'enabled' : 'enabled but no SPOTIFY_CLIENT_ID') : 'off'}`);
  log(`wall: ${env.dashboardKey ? 'private (DASHBOARD_KEY set)' : 'open to anyone with the URL'}`);
  members.start();
  if (env.keepalive) {
    log('keepalive: on');
    setInterval(() => fetch(`${env.publicUrl}/healthz`, { signal: AbortSignal.timeout(10_000) }).catch(() => {}), 10 * 60_000).unref();
  }
});

const wss = new WebSocketServer({ noServer: true });
const dashboards = new Set<WebSocket>();
/** Which socket currently speaks for a user id (companions). */
const owners = new Map<string, WebSocket>();

type Tracked = WebSocket & { isAlive?: boolean };

function track(ws: Tracked) {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
}

function sendDashboard(ws: WebSocket, msg: DashboardMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(msg: DashboardMessage) {
  for (const ws of dashboards) sendDashboard(ws, msg);
}
store.subscribe((event) => broadcast(event));

server.on('upgrade', (req: IncomingMessage, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/ws/dashboard') {
    if (!wallAllowedRaw(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleDashboard(ws));
    return;
  }
  if (url.pathname === '/ws/companion') {
    const header = req.headers.authorization ?? '';
    if (!safeEqual(header, `Bearer ${env.hubSecret}`)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleCompanion(ws, req));
    return;
  }
  socket.destroy();
});

function handleDashboard(ws: WebSocket) {
  track(ws);
  dashboards.add(ws);
  sendDashboard(ws, { type: 'snapshot', hubName: env.hubName, users: store.snapshot() });
  ws.on('close', () => dashboards.delete(ws));
  ws.on('error', () => dashboards.delete(ws));
}

function handleCompanion(ws: WebSocket, req: IncomingMessage) {
  track(ws);
  let userId: string | null = null;
  let strikes = 0;
  const from = req.headers['x-forwarded-for'] ?? req.socket.remoteAddress;

  const reply = (msg: HubToCompanionMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  const bad = (message: string) => {
    reply({ type: 'error', message });
    if (++strikes >= 5) ws.close(1008, 'too many bad messages');
  };

  ws.on('message', (data) => {
    let msg: CompanionMessage;
    try {
      msg = JSON.parse(data.toString()) as CompanionMessage;
    } catch {
      return bad('invalid json');
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return bad('invalid message');
    switch (msg.type) {
      case 'hello': {
        if (!validUser(msg.user)) return bad('hello needs a valid user {id, name, avatarUrl}');
        if (!validPlayback(msg.playback)) return bad('invalid playback');
        if (userId && userId !== msg.user.id) releaseOwnership();
        userId = msg.user.id;
        const previous = owners.get(userId);
        if (previous && previous !== ws) {
          // A newer companion for the same user: the old socket no longer speaks for them.
          previous.close(1000, 'superseded');
        }
        owners.set(userId, ws);
        store.connect(msg.user, msg.playback ?? null);
        reply({ type: 'welcome', hubName: env.hubName });
        log(`companion connected: ${msg.user.name} (${userId}) from ${from}`);
        break;
      }
      case 'state':
        if (!userId) return bad('say hello first');
        if (!validPlayback(msg.playback)) return bad('invalid playback');
        if (owners.get(userId) === ws) store.update(userId, msg.playback ?? null);
        break;
      case 'bye':
        if (userId && owners.get(userId) === ws) {
          log(`companion left: ${userId}`);
          owners.delete(userId);
          store.disconnect(userId, true);
        }
        userId = null;
        ws.close();
        break;
      default:
        bad('unknown message type');
    }
  });

  const releaseOwnership = () => {
    if (!userId) return;
    if (owners.get(userId) === ws) {
      owners.delete(userId);
      log(`companion socket closed: ${userId}`);
      store.disconnect(userId);
    }
    userId = null;
  };
  ws.on('close', releaseOwnership);
  ws.on('error', releaseOwnership);
}

/* Heartbeat: drop sockets whose peer vanished without a FIN. */
setInterval(() => {
  for (const client of wss.clients) {
    const ws = client as Tracked;
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000).unref();

/* ------------------------------------------------------------------ */

let stopping = false;
function shutdown() {
  if (stopping) return process.exit(0);
  stopping = true;
  log('shutting down');
  try {
    store.flush();
    members.flush();
  } catch (e) {
    log(`flush failed: ${(e as Error).message}`);
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (e) => log(`unhandled rejection: ${(e as Error)?.message ?? e}`));
