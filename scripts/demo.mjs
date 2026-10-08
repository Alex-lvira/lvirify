#!/usr/bin/env node
/**
 * Demo mode: starts the hub with a throwaway secret and connects a handful of
 * fake colleagues that cycle through tracks, so you can look at the wall
 * without any Spotify or Slack credentials.
 *
 *   npm run demo            # hub on :3210 (override with PORT=...)
 *   open http://localhost:3210  and  http://localhost:3210/kiosk
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { WebSocket } from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 3210);
const SECRET = 'demo-secret';
const USERS = Number(process.env.DEMO_USERS ?? 5);

if (!fs.existsSync(path.join(root, 'packages/dashboard/dist/index.html')) || !fs.existsSync(path.join(root, 'packages/hub/dist/index.js'))) {
  console.error('Build first: npm run build');
  process.exit(1);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvirify-demo-'));
const hub = spawn(process.execPath, ['dist/index.js'], {
  cwd: path.join(root, 'packages/hub'),
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: String(PORT),
    HUB_NAME: process.env.HUB_NAME ?? 'Demo office',
    HUB_SECRET: SECRET,
    DATA_DIR: dataDir,
    KEEPALIVE: '0',
    // SPOTIFY_CLIENT_ID, SLACK_CLIENT_ID, SLACK_CLIENT_SECRET and PUBLIC_URL pass
    // through from your shell if set, so a real companion can log in against the demo hub.
    PUBLIC_URL: process.env.PUBLIC_URL ?? `http://localhost:${PORT}`,
  },
});
hub.on('exit', (code) => {
  console.error(`[demo] hub exited (${code})`);
  process.exit(code ?? 1);
});

/* ---------- fake catalogue ---------- */

function cover(a, b, text) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
    <rect width="300" height="300" fill="url(#g)"/>
    <circle cx="150" cy="150" r="88" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="18"/>
    <circle cx="150" cy="150" r="30" fill="rgba(0,0,0,.35)"/>
    <text x="150" y="270" text-anchor="middle" font-family="sans-serif" font-size="26" font-weight="700" fill="rgba(255,255,255,.85)">${text}</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const TRACKS = [
  { id: '4uLU6hMCjMI75M1A2tKUQC', title: 'Never Gonna Give You Up', artists: ['Rick Astley'], album: 'Whenever You Need Somebody', dur: 213000, art: 'https://i.scdn.co/image/ab67616d00001e0215ebbedaacef61af244262a8' },
  { id: '0VjIjW4GlUZAMYd2vXMi3b', title: 'Blinding Lights', artists: ['The Weeknd'], album: 'After Hours', dur: 200040, art: 'https://i.scdn.co/image/ab67616d00001e028863bc11d2aa12b54f5aeb36' },
  { id: 'demo-01', title: 'Midnight Freight', artists: ['Low Orbit Choir'], album: 'Terminal Dusk', dur: 254000, art: cover('#4a1d6b', '#e26d5a', 'LOC') },
  { id: 'demo-02', title: 'Kilowatt Heart', artists: ['Perpetua', 'Nadi Rune'], album: 'Voltage Bloom', dur: 187000, art: cover('#0b6e4f', '#f6c453', 'PERPETUA') },
  { id: 'demo-03', title: 'Paper Lanterns Over Hollins Street', artists: ['Quiet Machinery'], album: 'Late Shift', dur: 312000, art: cover('#1b3a6b', '#79c2d0', 'QM') },
  { id: 'demo-04', title: 'Second Coffee', artists: ['Marlow & The Understudies'], album: 'Weekday EP', dur: 164000, art: cover('#6b2d1b', '#f2b547', 'MARLOW') },
  { id: 'demo-05', title: 'Glasshouse', artists: ['Ines Varga'], album: 'Glasshouse', dur: 228000, art: cover('#2b2b2b', '#a1c4fd', 'IV') },
  { id: 'demo-06', title: 'Debugging at 2am (Live)', artists: ['Stack Overflow Orchestra'], album: 'Segfault Sessions', dur: 402000, art: cover('#14213d', '#fca311', 'SOO') },
  { id: 'demo-07', title: 'Tape Hiss Lullaby', artists: ['Cassette Youth'], album: 'Side B', dur: 176000, art: cover('#5c4b51', '#f7d6bf', 'CY') },
];

const PEOPLE = [
  { id: 'demo-alex', name: 'Alex', mode: 'playing' },
  { id: 'demo-sam', name: 'Sam Rivera', mode: 'playing' },
  { id: 'demo-priya', name: 'Priya Natarajan', mode: 'paused' },
  { id: 'demo-jonas', name: 'Jonas Lindqvist', mode: 'playing' },
  { id: 'demo-mei', name: 'Mei Tanaka', mode: 'idle' },
  { id: 'demo-tom', name: 'Tom Okafor', mode: 'playing' },
  { id: 'demo-lea', name: 'Léa Fontaine', mode: 'playing' },
  { id: 'demo-diego', name: 'Diego Marín', mode: 'paused' },
].slice(0, USERS);

/* ---------- fake companions ---------- */

function startCompanion(person, index) {
  let trackIdx = index % TRACKS.length;
  let progress = Math.floor(Math.random() * TRACKS[trackIdx].dur * 0.8);
  let mode = person.mode;
  let ws;

  const playback = () => {
    if (mode === 'idle') return null;
    const t = TRACKS[trackIdx];
    return {
      isPlaying: mode === 'playing',
      trackId: t.id, title: t.title, artists: t.artists, album: t.album, albumArtUrl: t.art,
      durationMs: t.dur, progressMs: progress,
      url: t.id.startsWith('demo-') ? null : `https://open.spotify.com/track/${t.id}`,
      fetchedAt: Date.now(),
    };
  };
  const send = (msg) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

  const connect = () => {
    ws = new WebSocket(`ws://localhost:${PORT}/ws/companion`, { headers: { authorization: `Bearer ${SECRET}` } });
    ws.on('open', () => send({ type: 'hello', user: { id: person.id, name: person.name, avatarUrl: null }, playback: playback() }));
    ws.on('error', () => {});
    ws.on('close', () => setTimeout(connect, 1500));
  };
  setTimeout(connect, 400 + index * 700);

  setInterval(() => {
    if (mode === 'playing') {
      progress += 5000;
      if (progress >= TRACKS[trackIdx].dur) {
        trackIdx = (trackIdx + 1) % TRACKS.length;
        progress = 0;
      }
    }
    // Occasionally change state so the wall is not static.
    const r = Math.random();
    if (mode === 'playing' && r < 0.02) mode = 'paused';
    else if (mode === 'paused' && r < 0.12) mode = 'playing';
    else if (mode === 'idle' && r < 0.04) { mode = 'playing'; progress = 0; }
    send({ type: 'state', playback: playback() });
  }, 5000);
}

setTimeout(() => {
  PEOPLE.forEach(startCompanion);
  console.log(`
[demo] wall:   http://localhost:${PORT}
[demo] kiosk:  http://localhost:${PORT}/kiosk
[demo] ${PEOPLE.length} fake colleagues connecting. Ctrl+C to stop.

[demo] To add yourself for real, in another terminal:
[demo]   node packages/companion/dist/index.js --hub http://localhost:${PORT} --secret ${SECRET}
[demo] then open http://127.0.0.1:48222 and connect Spotify.${process.env.SPOTIFY_CLIENT_ID ? '' : `
[demo]   (no SPOTIFY_CLIENT_ID in this shell: paste your client id under "Advanced" on that page,
[demo]    or restart with  SPOTIFY_CLIENT_ID=... npm run demo)`}
`);
}, 1200);

const stop = () => { hub.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
