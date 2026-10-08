import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_HUB_PORT } from '@lvirify/shared';

/** Minimal .env loader; never overrides variables already in the environment. */
function loadDotEnv(file: string) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(path.resolve(process.cwd(), '.env'));

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[hub] missing required env var ${name} (see .env.example)`);
    process.exit(1);
  }
  return v;
}

const port = Number(process.env.PORT ?? DEFAULT_HUB_PORT);
// Render sets RENDER_EXTERNAL_URL automatically; use it unless PUBLIC_URL is given explicitly.
const publicUrl = (process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? `http://localhost:${port}`).replace(/\/+$/, '');
const onRender = !!process.env.RENDER;

export const env = {
  port,
  hubName: process.env.HUB_NAME ?? 'Office',
  hubSecret: required('HUB_SECRET'),
  publicUrl,
  isHttps: publicUrl.startsWith('https://'),
  spotifyClientId: process.env.SPOTIFY_CLIENT_ID || null,
  spotifyRedirectUri: `${publicUrl}/spotify/callback`,
  slack:
    process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET
      ? {
          clientId: process.env.SLACK_CLIENT_ID,
          clientSecret: process.env.SLACK_CLIENT_SECRET,
          redirectUri: `${publicUrl}/slack/callback`,
          /** Optional. Only tokens from this workspace (team id, e.g. T0123ABCD) are accepted. */
          teamId: process.env.SLACK_TEAM_ID || null,
        }
      : null,
  dataDir: path.resolve(process.cwd(), process.env.DATA_DIR ?? './data'),
  /** Directory with the built dashboard (index.html + assets). */
  dashboardDir: path.resolve(
    process.env.DASHBOARD_DIR ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../dashboard/dist'),
  ),
  /**
   * Optional site password. When set, every page (wall, join, settings) needs a login
   * first; the browser then keeps a signed cookie. Companions use HUB_SECRET instead.
   */
  accessPassword: process.env.ACCESS_PASSWORD || null,
  /**
   * Free hosts (Render) put the service to sleep after ~15 min without inbound HTTP.
   * When on, the hub fetches its own /healthz every 10 min. Default: on when running on Render.
   */
  keepalive: process.env.KEEPALIVE ? process.env.KEEPALIVE !== '0' && process.env.KEEPALIVE !== 'false' : onRender,
  /** Allow colleagues to join from the website (hub stores their tokens). Default on. */
  webJoin: process.env.WEB_JOIN ? process.env.WEB_JOIN !== '0' && process.env.WEB_JOIN !== 'false' : true,
};

if (env.hubSecret === 'change-me') {
  console.warn('[hub] HUB_SECRET is still the example value. Change it before letting colleagues connect.');
}
