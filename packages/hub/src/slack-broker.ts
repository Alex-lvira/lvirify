import crypto from 'node:crypto';
import type { SlackSessionResponse } from '@lvirify/shared';
import { SlackError, authorizeUrl, exchangeCode } from '@lvirify/clients';

const SESSION_TTL_MS = 10 * 60_000;

/** Who started the login and where the token should go. */
export type SessionOwner = { kind: 'companion' } | { kind: 'member'; userId: string };

interface Session {
  createdAt: number;
  owner: SessionOwner;
  result: SlackSessionResponse;
  /** First time a finished result was handed out; dropped 60 s later. */
  deliveredAt?: number;
}

interface SlackConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  teamId: string | null;
}

/**
 * Slack only accepts HTTPS redirect URLs, so a companion on localhost cannot
 * complete OAuth alone. The hub does the browser dance and either hands the
 * user token back to the companion exactly once (then forgets it), or stores
 * it for a website member.
 */
export class SlackBroker {
  private sessions = new Map<string, Session>();

  constructor(private config: SlackConfig) {
    setInterval(() => this.sweep(), 60_000).unref();
  }

  private sweep() {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (s.createdAt < now - SESSION_TTL_MS || (s.deliveredAt && s.deliveredAt < now - 60_000)) this.sessions.delete(id);
    }
  }

  static newSessionId(): string {
    return crypto.randomBytes(24).toString('base64url');
  }

  /** Step 1: register a session id before opening the browser. */
  register(sessionId: string, owner: SessionOwner) {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(sessionId)) throw new Error('invalid session id');
    this.sessions.set(sessionId, { createdAt: Date.now(), owner, result: { status: 'pending' } });
  }

  /** Step 2: the browser arrives at /slack/connect; send it on to Slack. */
  authorizeUrl(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    if (!session || session.result.status !== 'pending') throw new Error('unknown or expired session, start again');
    return authorizeUrl(this.config.clientId, this.config.redirectUri, sessionId);
  }

  /** Step 3: Slack redirected back with ?code=&state=. Returns the owner and outcome. */
  async complete(
    state: string,
    code: string | undefined,
    error: string | undefined,
  ): Promise<{ owner: SessionOwner | null; ok: boolean; message: string; token?: { token: string; slackUserId: string; teamName: string } }> {
    const session = this.sessions.get(state);
    if (!session) return { owner: null, ok: false, message: 'Unknown or expired session. Start again.' };
    if (error || !code) {
      session.result = { status: 'error', message: error ?? 'Slack returned no code' };
      return { owner: session.owner, ok: false, message: session.result.message };
    }
    try {
      const token = await exchangeCode({ ...this.config, code });
      if (this.config.teamId && token.teamId !== this.config.teamId) {
        session.result = { status: 'error', message: `wrong Slack workspace (${token.teamName}); only the office workspace is allowed` };
        return { owner: session.owner, ok: false, message: session.result.message };
      }
      session.result = { status: 'done', ...token };
      if (session.owner.kind === 'member') this.sessions.delete(state); // token is stored elsewhere; nothing to poll
      return { owner: session.owner, ok: true, message: 'ok', token };
    } catch (e) {
      const message = e instanceof SlackError ? e.code : (e as Error).message;
      session.result = { status: 'error', message };
      return { owner: session.owner, ok: false, message };
    }
  }

  /** Step 4 (companions): poll. A finished token is handed out once, then dropped. */
  poll(sessionId: string): SlackSessionResponse {
    const session = this.sessions.get(sessionId);
    if (!session) return { status: 'error', message: 'unknown or expired session' };
    if (session.owner.kind !== 'companion') return { status: 'error', message: 'not a companion session' };
    // Keep a finished result briefly: a slow host can make the companion's first read time out.
    if (session.result.status === 'done' && !session.deliveredAt) session.deliveredAt = Date.now();
    return session.result;
  }
}
