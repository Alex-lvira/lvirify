import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_COMPANION_PORT, type UserIdentity } from '@lvirify/shared';
import type { SpotifyTokens } from '@lvirify/clients';

export interface SpotifyAuth extends SpotifyTokens {
  user: UserIdentity;
}

export interface SlackAuth {
  token: string;
  slackUserId: string;
  teamName: string;
}

export interface CompanionConfig {
  version: 1;
  port: number;
  hubUrl: string;
  hubSecret: string;
  /** Overrides the client id published by the hub, if set. */
  spotifyClientId: string;
  broadcastToHub: boolean;
  updateSlack: boolean;
  slackEmoji: string;
  spotify: SpotifyAuth | null;
  slack: SlackAuth | null;
}

export const defaultConfig: CompanionConfig = {
  version: 1,
  port: DEFAULT_COMPANION_PORT,
  hubUrl: 'http://localhost:3000',
  hubSecret: '',
  spotifyClientId: '',
  broadcastToHub: true,
  updateSlack: true,
  slackEmoji: ':headphones:',
  spotify: null,
  slack: null,
};

export function defaultConfigPath(): string {
  const home = os.homedir();
  let base: string;
  if (process.platform === 'darwin') base = path.join(home, 'Library', 'Application Support');
  else if (process.platform === 'win32') base = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  else base = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  return path.join(base, 'lvirify', 'companion.json');
}

export class ConfigStore {
  public data: CompanionConfig;

  constructor(public readonly file: string) {
    this.data = this.load();
  }

  private load(): CompanionConfig {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<CompanionConfig>;
      return { ...defaultConfig, ...parsed, version: 1 };
    } catch {
      return { ...defaultConfig };
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  patch(partial: Partial<CompanionConfig>) {
    this.data = { ...this.data, ...partial };
    this.save();
  }
}
