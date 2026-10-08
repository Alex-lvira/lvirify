import { SLACK_CLEAR_GRACE_MS, type Playback } from '@lvirify/shared';
import { clearStatus, getStatus, sameStatusText, setStatus, statusTextFor } from './slack.js';

/** Expiry buffer past the end of the track; if the process dies the status still clears. */
const EXPIRY_BUFFER_MS = 90_000;
/** Re-set the status when its expiry gets this close (track on repeat, long pause then resume). */
const REFRESH_MARGIN_MS = 60_000;

export interface StatusTrackerOptions {
  /** Current token, or null when Slack is not connected. */
  getToken: () => string | null;
  /** Whether the user wants status updates right now. */
  enabled: () => boolean;
  getEmoji: () => string;
  log: (msg: string) => void;
}

/**
 * One per user. Mirrors playback into the Slack status and takes care of the
 * only tricky part: clearing it again, and only if it is still ours.
 *
 * Errors from the Slack API propagate to the caller as SlackError.
 */
export class SlackStatusTracker {
  /** Text we last wrote; null when we have nothing to clean up. */
  private setText: string | null = null;
  private expiresAt = 0;
  private lastActiveAt = 0;

  constructor(private opts: StatusTrackerOptions) {}

  get currentText(): string | null {
    return this.setText;
  }

  async tick(playback: Playback | null): Promise<void> {
    const token = this.opts.getToken();
    if (!token) {
      this.setText = null;
      return;
    }
    const now = Date.now();
    if (this.opts.enabled() && playback?.isPlaying) {
      this.lastActiveAt = now;
      const text = statusTextFor(playback);
      const remaining = Math.max(0, playback.durationMs - playback.progressMs);
      const expiresAt = now + remaining + EXPIRY_BUFFER_MS;
      if (text !== this.setText || this.expiresAt - now < REFRESH_MARGIN_MS) {
        await setStatus(token, text, this.opts.getEmoji() || ':headphones:', Math.floor(expiresAt / 1000));
        if (text !== this.setText) this.opts.log(`slack status → ${text}`);
        this.setText = text;
        this.expiresAt = expiresAt;
      }
      return;
    }
    if (this.setText) {
      const idleLongEnough = now - this.lastActiveAt > SLACK_CLEAR_GRACE_MS;
      const forced = !this.opts.enabled();
      if (idleLongEnough || forced) await this.clearOwn(forced ? 'updates turned off' : 'nothing playing');
    }
  }

  /** Clears the status only if it is still the one we wrote. Safe to call any time. */
  async clearOwn(reason: string): Promise<void> {
    const token = this.opts.getToken();
    if (!token || !this.setText) {
      this.setText = null;
      return;
    }
    const mine = this.setText;
    // Forget first so a failure here does not retry forever.
    this.setText = null;
    this.expiresAt = 0;
    const current = await getStatus(token);
    if (sameStatusText(current.status_text, mine)) {
      await clearStatus(token);
      this.opts.log(`slack status cleared (${reason})`);
    } else {
      this.opts.log('slack status was changed by hand, leaving it alone');
    }
  }

  /** Forget without touching Slack (token gone). */
  reset() {
    this.setText = null;
    this.expiresAt = 0;
  }
}
