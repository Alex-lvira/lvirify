import type { DashboardMessage, HistoryEntry, WallUser } from '@lvirify/shared';
import './style.css';

const wall = document.getElementById('wall') as HTMLElement;
const hubName = document.getElementById('hub-name') as HTMLElement;
const countEl = document.getElementById('count') as HTMLElement;
const connEl = document.getElementById('conn') as HTMLElement;

const KIOSK = location.pathname.replace(/\/+$/, '') === '/kiosk' || new URLSearchParams(location.search).has('kiosk');
if (KIOSK) document.body.classList.add('kiosk');

/* Shell colours, picked per user by a stable hash of their id. */
const SHELLS: { shell: string; stripe: string }[] = [
  { shell: '#3a3f63', stripe: '#f2b547' }, // slate blue
  { shell: '#5b3b3b', stripe: '#f0d29c' }, // oxblood
  { shell: '#2f4a44', stripe: '#f28f6b' }, // deep teal
  { shell: '#6c5a2e', stripe: '#3a3f63' }, // mustard
  { shell: '#4a3d5c', stripe: '#8fd1b2' }, // plum
  { shell: '#3d3d3d', stripe: '#e2645a' }, // graphite
  { shell: '#5b4a3a', stripe: '#8fb7d1' }, // walnut
  { shell: '#2f4f6b', stripe: '#f2e9d8' }, // navy
];
function shellFor(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return SHELLS[h % SHELLS.length]!;
}

const users = new Map<string, WallUser>();
const cards = new Map<string, HTMLElement>();

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

const REEL_EMPTY = 22;
const REEL_FULL = 46;

function reelSvg(side: 'left' | 'right'): string {
  const teeth = Array.from({ length: 6 }, (_, i) => {
    const a = (i * 60 * Math.PI) / 180;
    const x = 50 + Math.cos(a) * 14;
    const y = 50 + Math.sin(a) * 14;
    return `<rect class="hub-teeth" x="${x - 2.2}" y="${y - 5}" width="4.4" height="10" rx="1.4" transform="rotate(${i * 60} ${x} ${y})"/>`;
  }).join('');
  return `<svg viewBox="0 0 100 100" aria-hidden="true">
    <circle class="tape" cx="50" cy="50" r="${side === 'left' ? REEL_FULL : REEL_EMPTY}"/>
    <g class="hub">
      <circle class="hub-body" cx="50" cy="50" r="20"/>
      ${teeth}
      <circle class="hub-center" cx="50" cy="50" r="6"/>
    </g>
  </svg>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function createCard(u: WallUser): HTMLElement {
  const el = document.createElement('article');
  el.className = 'cassette';
  el.dataset.id = u.user.id;
  const colours = shellFor(u.user.id);
  el.style.setProperty('--shell', colours.shell);
  el.style.setProperty('--stripe', colours.stripe);
  el.innerHTML = `
    <a class="shell-link" target="_blank" rel="noopener">
      <div class="shell">
        <span class="screw tl"></span><span class="screw tr"></span><span class="screw bl"></span><span class="screw br"></span>
        <div class="label">
          <img class="art" alt="" width="64" height="64">
          <div class="text"><div class="title"></div><div class="artist"></div></div>
          <div class="side">A</div>
          <div class="window">
            <div class="reel left">${reelSvg('left')}</div>
            <div class="tape-run"></div>
            <div class="reel right">${reelSvg('right')}</div>
          </div>
        </div>
        <div class="foot">
          <span class="t-cur">0:00</span>
          <div class="progress"><i></i></div>
          <span class="t-dur">0:00</span>
        </div>
      </div>
    </a>
    <footer class="who">
      <span class="avatar-slot"></span>
      <span class="name"></span>
      <span class="state"></span>
    </footer>
    <ul class="history"></ul>`;
  return el;
}

function upsert(u: WallUser) {
  users.set(u.user.id, u);
  let el = cards.get(u.user.id);
  if (!el) {
    el = createCard(u);
    cards.set(u.user.id, el);
    wall.appendChild(el);
  }
  el.classList.remove('leaving');

  const p = u.playback;
  const mode = p ? (p.isPlaying ? 'playing' : 'paused') : 'idle';
  el.classList.toggle('playing', mode === 'playing');
  el.classList.toggle('paused', mode === 'paused');
  el.classList.toggle('idle', mode === 'idle');

  const link = el.querySelector<HTMLAnchorElement>('.shell-link')!;
  if (p?.url) {
    link.href = p.url;
    link.title = `Open in Spotify`;
  } else {
    link.removeAttribute('href');
    link.removeAttribute('title');
  }

  const art = el.querySelector<HTMLImageElement>('.art')!;
  const artUrl = p?.albumArtUrl ?? u.history[0]?.albumArtUrl ?? '';
  if (art.dataset.src !== artUrl) {
    art.dataset.src = artUrl;
    if (artUrl) art.src = artUrl;
    else art.removeAttribute('src');
  }
  el.querySelector('.title')!.textContent = p ? p.title : 'Nothing playing';
  el.querySelector('.artist')!.textContent = p ? p.artists.join(', ') : u.history[0] ? `last: ${u.history[0].title}` : '';
  el.querySelector('.t-dur')!.textContent = p ? fmt(p.durationMs) : '--:--';

  // who
  const slot = el.querySelector('.avatar-slot')!;
  const wantAvatar = u.user.avatarUrl ?? '';
  if ((slot as HTMLElement).dataset.src !== wantAvatar) {
    (slot as HTMLElement).dataset.src = wantAvatar;
    slot.innerHTML = wantAvatar
      ? `<img class="avatar" src="${esc(wantAvatar)}" alt="">`
      : `<span class="avatar placeholder">${esc(initials(u.user.name))}</span>`;
  }
  el.querySelector('.name')!.textContent = u.user.name;
  el.querySelector('.state')!.textContent = mode === 'playing' ? 'playing' : mode === 'paused' ? 'paused' : 'idle';

  // history (skip the currently playing track so the list reads as "before this")
  const hist = el.querySelector('.history')!;
  const items = u.history.filter((h) => h.trackId !== p?.trackId).slice(0, 4);
  const key = items.map((h) => h.trackId).join('|');
  if ((hist as HTMLElement).dataset.key !== key) {
    (hist as HTMLElement).dataset.key = key;
    hist.innerHTML = items.map(historyItem).join('');
  }

  tickCard(el, u);
  updateCount();
}

function historyItem(h: HistoryEntry): string {
  const thumb = h.albumArtUrl ? `<img src="${esc(h.albumArtUrl)}" alt="">` : `<span class="thumb"></span>`;
  const text = `<span><b>${esc(h.title)}</b> · ${esc(h.artists.join(', '))}</span>`;
  return `<li>${thumb}${h.url ? `<a href="${esc(h.url)}" target="_blank" rel="noopener">${text}</a>` : text}</li>`;
}

function remove(id: string) {
  users.delete(id);
  const el = cards.get(id);
  if (!el) return;
  cards.delete(id);
  el.classList.add('leaving');
  el.addEventListener('animationend', () => el.remove(), { once: true });
  setTimeout(() => el.remove(), 600);
  updateCount();
}

/** Progress interpolation between hub updates. */
function tickCard(el: HTMLElement, u: WallUser) {
  const p = u.playback;
  let ratio = 0;
  let pos = 0;
  if (p) {
    pos = p.isPlaying ? Math.min(p.durationMs, p.progressMs + (Date.now() - p.fetchedAt)) : p.progressMs;
    ratio = p.durationMs > 0 ? pos / p.durationMs : 0;
  }
  el.querySelector<HTMLElement>('.progress i')!.style.width = `${(ratio * 100).toFixed(2)}%`;
  el.querySelector('.t-cur')!.textContent = p ? fmt(pos) : '--:--';
  const left = el.querySelector('.reel.left .tape')!;
  const right = el.querySelector('.reel.right .tape')!;
  const span = REEL_FULL - REEL_EMPTY;
  left.setAttribute('r', String(REEL_EMPTY + span * (1 - ratio)));
  right.setAttribute('r', String(REEL_EMPTY + span * ratio));
}

setInterval(() => {
  for (const [id, el] of cards) {
    const u = users.get(id);
    if (u?.playback?.isPlaying) tickCard(el, u);
  }
}, 250);

function updateCount() {
  const n = users.size;
  const playing = [...users.values()].filter((u) => u.playback?.isPlaying).length;
  countEl.textContent = n === 0 ? '' : `${playing} playing · ${n} online`;
  wall.classList.toggle('empty', n === 0);
  let empty = wall.querySelector('.empty-state');
  if (n === 0 && !empty) {
    empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `
      <div class="ghost">no tape</div>
      <h2>Nobody is playing anything</h2>
      <p><a href="/join">Join from this site</a> with your Spotify account, or run the companion on your machine.</p>`;
    wall.appendChild(empty);
  } else if (n > 0 && empty) {
    empty.remove();
  }
  if (KIOSK) {
    const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 6 ? 3 : n <= 12 ? 4 : 5;
    const rows = Math.max(1, Math.ceil(n / cols));
    wall.style.setProperty('--cols', String(cols));
    wall.style.setProperty('--rows', String(rows));
  }
}

/* ------------------------------------------------------------------ */
/* WebSocket                                                           */
/* ------------------------------------------------------------------ */

let backoff = 1000;
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/dashboard`);
  ws.onopen = () => {
    backoff = 1000;
    connEl.hidden = true;
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data) as DashboardMessage;
    switch (msg.type) {
      case 'snapshot': {
        hubName.textContent = msg.hubName;
        document.title = `${msg.hubName} · now playing`;
        const seen = new Set(msg.users.map((u) => u.user.id));
        for (const id of [...cards.keys()]) if (!seen.has(id)) remove(id);
        for (const u of msg.users) upsert(u);
        updateCount();
        break;
      }
      case 'user':
        upsert(msg.user);
        break;
      case 'remove':
        remove(msg.userId);
        break;
    }
  };
  ws.onclose = () => {
    connEl.hidden = false;
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 15_000);
  };
  ws.onerror = () => ws.close();
}

updateCount();
connect();
