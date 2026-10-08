import { WebSocket } from 'ws';
import type { CompanionMessage, HubToCompanionMessage, Playback, UserIdentity } from '@lvirify/shared';

type Status = 'disabled' | 'connecting' | 'connected' | 'error';

/** The hub pings every 30 s; if we hear nothing for this long the socket is dead. */
const WATCHDOG_MS = 90_000;

/**
 * Keeps a WebSocket to the hub alive with backoff, re-sends `hello` after a
 * reconnect, detects dead connections (laptop sleep, Wi-Fi change) and only
 * ever sends the latest state.
 */
export class HubClient {
  private ws: WebSocket | null = null;
  private wanted = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private backoffMs = 1_000;
  private user: UserIdentity | null = null;
  private lastPlayback: Playback | null = null;
  public status: Status = 'disabled';
  public lastError: string | null = null;
  public hubName: string | null = null;

  constructor(
    private getTarget: () => { url: string; secret: string },
    private log: (msg: string) => void,
  ) {}

  /** Start (or keep) broadcasting for this user. */
  enable(user: UserIdentity) {
    const changedUser = this.user?.id !== user.id;
    this.user = user;
    this.wanted = true;
    const state = this.ws?.readyState;
    if (!changedUser && (state === WebSocket.OPEN || state === WebSocket.CONNECTING)) return;
    if (!changedUser && this.reconnectTimer) return; // a retry is already scheduled
    this.reconnectNow();
  }

  /** Stop broadcasting: tell the hub goodbye so the cassette disappears now. */
  disable() {
    this.wanted = false;
    this.status = 'disabled';
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'bye' } satisfies CompanionMessage));
        } catch {
          /* ignore */
        }
      }
      this.discard(ws);
    }
  }

  /** Settings changed (hub url/secret): drop and reconnect. */
  reconnectNow() {
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) this.discard(ws);
    this.backoffMs = 1_000;
    if (this.wanted) this.connect();
  }

  publish(playback: Playback | null) {
    this.lastPlayback = playback;
    if (this.ws?.readyState === WebSocket.OPEN) this.send({ type: 'state', playback });
  }

  /* ---------------- internals ---------------- */

  private clearTimers() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  /** Detach a socket we no longer care about, keeping an error listener so it can never throw. */
  private discard(ws: WebSocket) {
    ws.removeAllListeners();
    ws.on('error', () => {});
    if (ws.readyState === WebSocket.OPEN) ws.close();
    else ws.terminate();
  }

  private send(msg: CompanionMessage) {
    try {
      this.ws?.send(JSON.stringify(msg));
    } catch (e) {
      this.fail((e as Error).message);
    }
  }

  private feedWatchdog(ws: WebSocket) {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      if (this.ws === ws) {
        this.log('hub silent for 90s, reconnecting');
        ws.terminate(); // fires 'close' -> reconnect path
      }
    }, WATCHDOG_MS);
  }

  private connect() {
    const { url, secret } = this.getTarget();
    if (!url || !this.user) {
      this.status = 'error';
      this.lastError = 'hub url not set';
      return;
    }
    const wsUrl = url.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws/companion';
    this.status = 'connecting';
    this.lastError = null;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${secret}` }, handshakeTimeout: 10_000 });
    } catch (e) {
      this.fail((e as Error).message);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.backoffMs = 1_000;
      this.feedWatchdog(ws);
      this.send({ type: 'hello', user: this.user!, playback: this.lastPlayback });
    });
    ws.on('ping', () => this.feedWatchdog(ws));
    ws.on('message', (data) => {
      this.feedWatchdog(ws);
      try {
        const msg = JSON.parse(data.toString()) as HubToCompanionMessage;
        if (msg.type === 'welcome') {
          this.status = 'connected';
          this.hubName = msg.hubName;
          this.log(`connected to hub "${msg.hubName}"`);
        } else if (msg.type === 'error') {
          this.lastError = msg.message;
          this.log(`hub error: ${msg.message}`);
        }
      } catch {
        /* ignore */
      }
    });
    ws.on('unexpected-response', (_req, res) => {
      this.fail(res.statusCode === 401 ? 'hub rejected the secret (401)' : `hub answered ${res.statusCode}`);
      ws.terminate();
    });
    ws.on('error', (err) => this.fail(err.message));
    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return; // superseded, nothing to do
      this.ws = null;
      if (this.watchdog) clearTimeout(this.watchdog);
      this.watchdog = null;
      if (!this.wanted) return;
      if (this.status === 'connected') this.log(`hub connection lost${reason.length ? ` (${reason.toString()})` : ''}, reconnecting`);
      if (this.status !== 'error') this.status = 'connecting';
      // Superseded by a newer companion for the same user: back off harder so the two do not fight.
      this.scheduleReconnect(code === 1000 && reason.toString() === 'superseded' ? 30_000 : undefined);
    });
  }

  private fail(message: string) {
    if (this.lastError !== message) this.log(`hub: ${message}`);
    this.status = 'error';
    this.lastError = message;
  }

  private scheduleReconnect(delay = this.backoffMs) {
    if (this.reconnectTimer || !this.wanted) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
  }
}
