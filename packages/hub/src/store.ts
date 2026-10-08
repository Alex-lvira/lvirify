import fs from 'node:fs';
import path from 'node:path';
import {
  HISTORY_LENGTH,
  HUB_DISCONNECT_GRACE_MS,
  type HistoryEntry,
  type Playback,
  type UserIdentity,
  type WallUser,
} from '@lvirify/shared';

interface PersistedUser {
  user: UserIdentity;
  history: HistoryEntry[];
  lastSeen: number;
}

interface PersistedState {
  version: 1;
  users: Record<string, PersistedUser>;
}

interface LiveUser {
  user: UserIdentity;
  playback: Playback | null;
  connectedAt: number;
  lastSeen: number;
  /** Set while the socket is down and we are waiting to see if it comes back. */
  removeTimer: NodeJS.Timeout | null;
}

type Listener = (event: { type: 'user'; user: WallUser } | { type: 'remove'; userId: string }) => void;

/**
 * In-memory presence for connected companions plus a small JSON file for
 * things that should survive a restart (who we have seen, their history).
 */
export class Store {
  private live = new Map<string, LiveUser>();
  private persisted: PersistedState;
  private file: string;
  private listeners = new Set<Listener>();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'state.json');
    this.persisted = this.load();
  }

  private load(): PersistedState {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as PersistedState;
      if (parsed.version === 1 && parsed.users) return parsed;
    } catch {
      /* first run or corrupt file: start fresh */
    }
    return { version: 1, users: {} };
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 500);
  }

  /** Write now. Called on shutdown so a pending save is not lost. */
  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.persisted, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error(`[hub] could not write ${this.file}: ${(e as Error).message}`);
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emitUser(id: string) {
    const wall = this.toWallUser(id);
    if (!wall) return;
    for (const l of this.listeners) l({ type: 'user', user: wall });
  }

  private toWallUser(id: string): WallUser | null {
    const live = this.live.get(id);
    if (!live) return null;
    return {
      user: live.user,
      playback: live.playback,
      history: this.persisted.users[id]?.history ?? [],
      connectedAt: live.connectedAt,
      lastSeen: live.lastSeen,
    };
  }

  snapshot(): WallUser[] {
    return [...this.live.keys()]
      .map((id) => this.toWallUser(id))
      .filter((u): u is WallUser => u !== null)
      .sort((a, b) => a.connectedAt - b.connectedAt);
  }

  /** A companion said hello (or re-said hello after a reconnect). */
  connect(user: UserIdentity, playback: Playback | null) {
    const now = Date.now();
    const existing = this.live.get(user.id);
    if (existing?.removeTimer) {
      clearTimeout(existing.removeTimer);
      existing.removeTimer = null;
    }
    const live: LiveUser = {
      user,
      playback: null,
      connectedAt: existing?.connectedAt ?? now,
      lastSeen: now,
      removeTimer: null,
    };
    this.live.set(user.id, live);

    const p = (this.persisted.users[user.id] ??= { user, history: [], lastSeen: now });
    p.user = user;
    p.lastSeen = now;
    this.scheduleSave();

    this.update(user.id, playback);
  }

  update(id: string, playback: Playback | null) {
    const live = this.live.get(id);
    if (!live) return;
    const now = Date.now();
    live.lastSeen = now;
    if (live.removeTimer) {
      // A state message proves the companion is alive; cancel a pending removal.
      clearTimeout(live.removeTimer);
      live.removeTimer = null;
    }
    live.playback = playback;

    const p = this.persisted.users[id];
    if (p) {
      p.lastSeen = now;
      if (playback && playback.isPlaying) {
        const last = p.history[0];
        if (!last || last.trackId !== playback.trackId) {
          p.history.unshift({
            trackId: playback.trackId,
            title: playback.title,
            artists: playback.artists,
            albumArtUrl: playback.albumArtUrl,
            url: playback.url,
            playedAt: now,
          });
          p.history = p.history.slice(0, HISTORY_LENGTH);
        }
      }
      this.scheduleSave();
    }
    this.emitUser(id);
  }

  /** Socket dropped: keep the cassette for a grace period in case it reconnects. */
  disconnect(id: string, immediate = false) {
    const live = this.live.get(id);
    if (!live) return;
    if (live.removeTimer) clearTimeout(live.removeTimer);
    const remove = () => {
      this.live.delete(id);
      for (const l of this.listeners) l({ type: 'remove', userId: id });
    };
    if (immediate) {
      remove();
    } else {
      live.removeTimer = setTimeout(remove, HUB_DISCONNECT_GRACE_MS);
    }
  }

  isConnected(id: string): boolean {
    const live = this.live.get(id);
    return !!live && live.removeTimer === null;
  }
}
