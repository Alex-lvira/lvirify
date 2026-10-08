import fs from 'node:fs';
import path from 'node:path';
import { SPOTIFY_POLL_INTERVAL_MS, type Playback, type UserIdentity } from '@lvirify/shared';
import {
  SlackError,
  SlackStatusTracker,
  SpotifyError,
  ensureFresh,
  fetchCurrentlyPlaying,
  type SpotifyTokens,
} from '@lvirify/clients';
import type { Store } from './store.js';

/** A person who joined from the website: the hub polls Spotify on their behalf. */
export interface Member {
  user: UserIdentity;
  spotify: SpotifyTokens | null;
  /** Set when the last poll failed in a way the user must fix (login expired). */
  spotifyError: string | null;
  slack: { token: string; slackUserId: string; teamName: string } | null;
  slackError: string | null;
  showOnWall: boolean;
  updateSlack: boolean;
  emoji: string;
  joinedAt: number;
  lastPolledAt: number;
  playback: Playback | null;
}

/** What gets written to disk (no transient fields). */
type PersistedMember = Omit<Member, 'playback' | 'lastPolledAt' | 'spotifyError' | 'slackError'>;

interface MembersFile {
  version: 1;
  members: Record<string, PersistedMember>;
}

export class Members {
  private members = new Map<string, Member>();
  private trackers = new Map<string, SlackStatusTracker>();
  private timers = new Map<string, NodeJS.Timeout>();
  private file: string;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(
    dataDir: string,
    private store: Store,
    private clientId: () => string | null,
    private log: (msg: string) => void,
  ) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'members.json');
    this.load();
  }

  /* ---------------- persistence ---------------- */

  private load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as MembersFile;
      if (parsed.version !== 1) return;
      for (const [id, m] of Object.entries(parsed.members)) {
        this.members.set(id, { ...m, spotifyError: null, slackError: null, playback: null, lastPolledAt: 0 });
      }
    } catch {
      /* first run */
    }
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 300);
  }

  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const out: MembersFile = { version: 1, members: {} };
    for (const [id, m] of this.members) {
      const { playback: _p, lastPolledAt: _l, spotifyError: _se, slackError: _sl, ...rest } = m;
      out.members[id] = rest;
    }
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /* ---------------- accessors ---------------- */

  get(id: string): Member | undefined {
    return this.members.get(id);
  }

  count(): number {
    return this.members.size;
  }

  /** Called after a successful Spotify login on the website. */
  join(user: UserIdentity, tokens: SpotifyTokens): Member {
    const existing = this.members.get(user.id);
    const member: Member = existing
      ? { ...existing, user, spotify: tokens, spotifyError: null }
      : {
          user,
          spotify: tokens,
          spotifyError: null,
          slack: null,
          slackError: null,
          showOnWall: true,
          updateSlack: true,
          emoji: ':headphones:',
          joinedAt: Date.now(),
          lastPolledAt: 0,
          playback: null,
        };
    this.members.set(user.id, member);
    this.scheduleSave();
    this.log(`${existing ? 'rejoined' : 'joined'}: ${user.name} (${user.id})`);
    this.schedule(user.id, 0);
    return member;
  }

  update(id: string, patch: Partial<Pick<Member, 'showOnWall' | 'updateSlack' | 'emoji'>>) {
    const m = this.members.get(id);
    if (!m) return;
    Object.assign(m, patch);
    this.scheduleSave();
    if (patch.showOnWall === false) this.store.disconnect(id, true);
    // Apply immediately rather than waiting for the next poll.
    this.schedule(id, 0);
  }

  setSlack(id: string, auth: Member['slack']) {
    const m = this.members.get(id);
    if (!m) return;
    m.slack = auth;
    m.slackError = null;
    this.trackers.get(id)?.reset();
    this.scheduleSave();
    this.schedule(id, 0);
  }

  async disconnectSlack(id: string) {
    const m = this.members.get(id);
    if (!m) return;
    await this.clearSlackQuietly(id, 'slack disconnected');
    m.slack = null;
    this.trackers.get(id)?.reset();
    this.scheduleSave();
  }

  /** Remove the person entirely: tokens, wall presence, Slack status. */
  async leave(id: string) {
    const m = this.members.get(id);
    if (!m) return;
    await this.clearSlackQuietly(id, 'left');
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
    this.trackers.delete(id);
    this.members.delete(id);
    this.store.disconnect(id, true);
    this.scheduleSave();
    this.log(`left: ${m.user.name} (${id})`);
  }

  /* ---------------- polling ---------------- */

  start() {
    let i = 0;
    for (const id of this.members.keys()) this.schedule(id, 300 * i++); // stagger
    if (this.members.size) this.log(`polling Spotify for ${this.members.size} member(s)`);
  }

  private schedule(id: string, delay: number) {
    const existing = this.timers.get(id);
    if (existing) clearTimeout(existing);
    this.timers.set(id, setTimeout(() => void this.poll(id), delay));
  }

  private tracker(id: string): SlackStatusTracker {
    let t = this.trackers.get(id);
    if (!t) {
      t = new SlackStatusTracker({
        getToken: () => this.members.get(id)?.slack?.token ?? null,
        enabled: () => this.members.get(id)?.updateSlack ?? false,
        getEmoji: () => this.members.get(id)?.emoji ?? ':headphones:',
        log: (msg) => this.log(`[${this.members.get(id)?.user.name ?? id}] ${msg}`),
      });
      this.trackers.set(id, t);
    }
    return t;
  }

  private async poll(id: string) {
    const m = this.members.get(id);
    if (!m) return;
    let delay = SPOTIFY_POLL_INTERVAL_MS;
    const wants = m.showOnWall || (m.updateSlack && m.slack);
    try {
      if (m.spotify && wants) {
        const clientId = this.clientId();
        if (!clientId) throw new SpotifyError('hub has no SPOTIFY_CLIENT_ID', 0);
        const fresh = await ensureFresh(m.spotify, clientId);
        if (fresh !== m.spotify) {
          m.spotify = fresh;
          this.scheduleSave();
        }
        const next = await fetchCurrentlyPlaying(fresh.accessToken);
        m.spotifyError = null;
        m.playback = next;
        m.lastPolledAt = Date.now();
        if (m.showOnWall) {
          if (this.store.isConnected(id)) this.store.update(id, next);
          else this.store.connect(m.user, next);
        }
      } else if (!m.spotify || !wants) {
        m.playback = null;
        if (this.store.isConnected(id)) this.store.disconnect(id, true);
        delay = 30_000; // nothing to do; check back in case settings change
      }
      await this.slackTick(id, m);
    } catch (e) {
      if (e instanceof SpotifyError) {
        if (e.status === 429) {
          delay = Math.max(delay, e.retryAfterMs);
          this.log(`[${m.user.name}] spotify rate limited, waiting ${Math.round(delay / 1000)}s`);
        } else if (e.tokenStale && m.spotify) {
          m.spotify = { ...m.spotify, expiresAt: 0 }; // refresh on the next tick
          delay = 1_000;
        } else if (e.needsReauth) {
          m.spotify = null;
          m.spotifyError = 'Spotify login expired. Connect again.';
          m.playback = null;
          this.store.disconnect(id, true);
          this.scheduleSave();
          this.log(`[${m.user.name}] spotify auth failed (${e.message}); needs to reconnect`);
          await this.clearSlackQuietly(id, 'spotify login expired');
        } else {
          if (m.spotifyError !== e.message) this.log(`[${m.user.name}] spotify error: ${e.message}`);
          m.spotifyError = e.message;
          delay = Math.min(60_000, delay * 3);
        }
      } else {
        this.log(`[${m.user.name}] unexpected error: ${(e as Error).message}`);
        delay = 30_000;
      }
    } finally {
      if (this.members.has(id)) this.schedule(id, delay);
    }
  }

  private async slackTick(id: string, m: Member) {
    if (!m.slack) return;
    try {
      await this.tracker(id).tick(m.playback);
      m.slackError = null;
    } catch (e) {
      const code = e instanceof SlackError ? e.code : (e as Error).message;
      if (m.slackError !== code) this.log(`[${m.user.name}] slack error: ${code}`);
      m.slackError = code;
      if (e instanceof SlackError && e.needsReauth) {
        m.slack = null;
        m.slackError = 'Slack login expired. Connect again.';
        this.tracker(id).reset();
        this.scheduleSave();
      }
    }
  }

  private async clearSlackQuietly(id: string, reason: string) {
    try {
      await this.trackers.get(id)?.clearOwn(reason);
    } catch (e) {
      this.log(`[${id}] slack error while clearing: ${(e as Error).message}`);
    }
  }
}
