/** Server-rendered pages for joining from the website. Same palette as the wall. */

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

const STYLE = `
  :root{--bg:#14110e;--panel:#1f1a15;--panel-2:#2a231c;--line:#3a3128;--ink:#f3ead9;--muted:#a4957f;--accent:#f2b547;--ok:#7fd39a;--bad:#e2645a;--warn:#f2b547;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
  *{box-sizing:border-box}
  body{margin:0;background:radial-gradient(900px 500px at 20% -10%,#24190f 0%,transparent 60%),var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;min-height:100vh}
  main{max-width:560px;margin:0 auto;padding:40px 16px 64px}
  header{display:flex;align-items:center;gap:14px;margin-bottom:28px}
  header a{color:inherit;text-decoration:none}
  .logo{width:44px;height:28px;border-radius:6px;background:linear-gradient(180deg,#3b3129,#241e18);border:1px solid var(--line);position:relative;flex:none}
  .logo::before,.logo::after{content:"";position:absolute;top:8px;width:10px;height:10px;border-radius:50%;border:2px solid var(--accent)}
  .logo::before{left:8px}.logo::after{right:8px}
  h1{font-size:20px;margin:0;font-weight:600}
  h1 small{color:var(--muted);font-weight:400;margin-left:8px}
  section{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin-bottom:16px}
  section h2{margin:0 0 12px;font-size:13px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);display:flex;align-items:center;gap:10px}
  .dot{width:9px;height:9px;border-radius:50%;background:var(--muted);display:inline-block}
  .dot.ok{background:var(--ok);box-shadow:0 0 0 3px rgba(127,211,154,.15)}.dot.bad{background:var(--bad)}
  p{margin:0 0 10px}.muted{color:var(--muted)}.mono{font-family:var(--mono);font-size:13px}
  .row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
  button,a.btn{background:var(--accent);color:#1b1408;border:0;border-radius:8px;padding:10px 16px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block}
  button.ghost,a.btn.ghost{background:transparent;color:var(--ink);border:1px solid var(--line)}
  button.danger{background:transparent;color:var(--bad);border:1px solid var(--line)}
  button:disabled{opacity:.5;cursor:default}
  .who{display:flex;align-items:center;gap:12px}
  .avatar{width:40px;height:40px;border-radius:50%;object-fit:cover;background:var(--panel-2);display:grid;place-items:center;font-weight:600;color:var(--muted)}
  .switch{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-top:1px solid var(--line)}
  .switch:first-of-type{border-top:0}.switch .desc{font-size:13px;color:var(--muted)}
  .toggle{position:relative;width:44px;height:26px;flex:none}
  .toggle input{opacity:0;width:0;height:0;position:absolute}
  .toggle span{position:absolute;inset:0;background:var(--panel-2);border:1px solid var(--line);border-radius:26px;transition:.15s}
  .toggle span::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:var(--muted);transition:.15s}
  .toggle input:checked+span{background:rgba(242,181,71,.25);border-color:var(--accent)}
  .toggle input:checked+span::after{transform:translateX(18px);background:var(--accent)}
  input[type=text]{background:var(--panel-2);border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:9px 11px;font:inherit;font-family:var(--mono);font-size:13px;width:160px}
  .now{display:flex;gap:14px;align-items:center}.now img{width:56px;height:56px;border-radius:8px;object-fit:cover}
  .err{color:var(--bad);font-size:13px}
  ol{padding-left:20px;margin:0}ol li{margin-bottom:6px}
  .toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);background:var(--panel-2);border:1px solid var(--line);padding:8px 14px;border-radius:999px;font-size:13px;opacity:0;transition:.2s;pointer-events:none}
  .toast.show{opacity:1}
`;

export function layout(opts: { title: string; hubName: string; body: string; script?: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><title>${escapeHtml(opts.title)} · ${escapeHtml(opts.hubName)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><style>${STYLE}</style></head>
<body><main>
<header><a href="/" title="Back to the wall"><div class="logo"></div></a><h1>${escapeHtml(opts.hubName)} <small>${escapeHtml(opts.title)}</small></h1></header>
${opts.body}
</main><div class="toast" id="toast"></div>${opts.script ? `<script>${opts.script}</script>` : ''}</body></html>`;
}

export function joinPage(opts: { hubName: string; spotifyReady: boolean; slackReady: boolean; error?: string }): string {
  const body = `
<section>
  <h2>How it works</h2>
  <ol>
    <li>Connect your Spotify account. That's the only required step.</li>
    <li>You appear as a cassette on the wall while you play music.</li>
    <li>Optionally connect Slack so your status shows the current track.</li>
  </ol>
  <p class="muted" style="margin-top:12px">You can switch either of those off, or leave entirely, from your settings page afterwards.</p>
</section>
<section>
  ${opts.error ? `<p class="err">${escapeHtml(opts.error)}</p>` : ''}
  ${
    opts.spotifyReady
      ? `<a class="btn" href="/spotify/login">Connect Spotify</a>`
      : `<p class="err">This hub has no Spotify client id configured yet (SPOTIFY_CLIENT_ID).</p>`
  }
  ${opts.slackReady ? '' : `<p class="muted" style="margin-top:10px">Slack is not set up on this hub, so only the wall works for now.</p>`}
</section>
<p class="muted">Already joined? <a href="/me" style="color:var(--accent)">Open your settings</a>.</p>`;
  return layout({ title: 'join', hubName: opts.hubName, body });
}

export interface MePageData {
  hubName: string;
  user: { id: string; name: string; avatarUrl: string | null };
  spotifyConnected: boolean;
  spotifyError: string | null;
  slackReady: boolean;
  slack: { teamName: string } | null;
  slackError: string | null;
  showOnWall: boolean;
  updateSlack: boolean;
  emoji: string;
  playback: { title: string; artists: string[]; albumArtUrl: string | null; isPlaying: boolean } | null;
  notice?: string;
}

export function mePage(d: MePageData): string {
  const initials = d.user.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
  const body = `
<section>
  <h2><span class="dot ${d.spotifyConnected ? 'ok' : 'bad'}"></span> Spotify</h2>
  <div class="who">
    ${d.user.avatarUrl ? `<img class="avatar" src="${escapeHtml(d.user.avatarUrl)}" alt="">` : `<span class="avatar">${escapeHtml(initials)}</span>`}
    <div><div><b>${escapeHtml(d.user.name)}</b></div><div class="muted mono">${escapeHtml(d.user.id)}</div></div>
  </div>
  ${d.spotifyError ? `<p class="err" style="margin-top:10px">${escapeHtml(d.spotifyError)}</p>` : ''}
  <div class="row" style="margin-top:14px">
    <a class="btn ghost" href="/spotify/login">${d.spotifyConnected ? 'Reconnect Spotify' : 'Connect Spotify'}</a>
  </div>
</section>

<section>
  <h2><span class="dot ${d.slack ? 'ok' : ''}"></span> Slack</h2>
  ${
    d.slack
      ? `<p>Connected to <b>${escapeHtml(d.slack.teamName)}</b>.</p>`
      : `<p class="muted">Not connected.${d.slackReady ? '' : ' This hub has no Slack app configured.'}</p>`
  }
  ${d.slackError ? `<p class="err">${escapeHtml(d.slackError)}</p>` : ''}
  <div class="row">
    ${d.slackReady ? `<a class="btn ${d.slack ? 'ghost' : ''}" href="/me/slack/login">${d.slack ? 'Reconnect Slack' : 'Connect Slack'}</a>` : ''}
    ${d.slack ? `<button class="ghost" id="slack-disconnect">Disconnect</button>` : ''}
  </div>
</section>

<section>
  <h2>What to share</h2>
  <div class="switch">
    <div><div>Show me on the office wall</div><div class="desc">Your cassette appears while you play music.</div></div>
    <label class="toggle"><input type="checkbox" id="showOnWall" ${d.showOnWall ? 'checked' : ''}><span></span></label>
  </div>
  <div class="switch">
    <div><div>Update my Slack status</div><div class="desc">Status becomes the current track; cleared 2 minutes after you stop.</div></div>
    <label class="toggle"><input type="checkbox" id="updateSlack" ${d.updateSlack ? 'checked' : ''}><span></span></label>
  </div>
  <div class="row" style="margin-top:10px">
    <label class="muted" for="emoji">Status emoji</label>
    <input type="text" id="emoji" value="${escapeHtml(d.emoji)}" placeholder=":headphones:">
    <button class="ghost" id="saveEmoji">Save</button>
  </div>
</section>

<section>
  <h2>Now playing</h2>
  <div class="now" id="now">${
    d.playback
      ? `${d.playback.albumArtUrl ? `<img src="${escapeHtml(d.playback.albumArtUrl)}" alt="">` : ''}<div><div><b>${escapeHtml(d.playback.title)}</b></div><div class="muted">${escapeHtml(d.playback.artists.join(', '))}${d.playback.isPlaying ? '' : ' · paused'}</div></div>`
      : `<span class="muted">Nothing playing (checked every 5 seconds).</span>`
  }</div>
</section>

<section>
  <h2>Leave</h2>
  <p class="muted">Removes your Spotify and Slack tokens from this hub and takes you off the wall.</p>
  <button class="danger" id="leave">Leave the wall</button>
</section>
<p class="muted"><a href="/" style="color:var(--accent)">← Back to the wall</a></p>`;

  const script = `
const $=(id)=>document.getElementById(id);
function toast(m){const t=$('toast');t.textContent=m;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),1600)}
async function api(path,body){const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});if(!r.ok){alert(await r.text());throw new Error('failed')}return r.json()}
$('showOnWall').onchange=async(e)=>{await api('/api/me',{showOnWall:e.target.checked});toast(e.target.checked?'You are on the wall':'Hidden from the wall')};
$('updateSlack').onchange=async(e)=>{await api('/api/me',{updateSlack:e.target.checked});toast(e.target.checked?'Slack status on':'Slack status off')};
$('saveEmoji').onclick=async()=>{await api('/api/me',{emoji:$('emoji').value.trim()});toast('Saved')};
const sd=$('slack-disconnect'); if(sd) sd.onclick=async()=>{await api('/api/me/slack/disconnect');location.reload()};
$('leave').onclick=async()=>{if(!confirm('Remove your tokens from the hub and leave the wall?'))return;await api('/api/me/leave');location.href='/join'};
${d.notice ? `toast(${JSON.stringify(d.notice)});` : ''}
setInterval(async()=>{try{const r=await fetch('/api/me');if(!r.ok)return;const m=await r.json();const p=m.playback;$('now').innerHTML=p?(p.albumArtUrl?'<img src="'+p.albumArtUrl.replace(/"/g,'&quot;')+'" alt="">':'')+'<div><div><b>'+esc(p.title)+'</b></div><div class="muted">'+esc(p.artists.join(', '))+(p.isPlaying?'':' · paused')+'</div></div>':'<span class="muted">Nothing playing (checked every 5 seconds).</span>'}catch{}},5000);
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
`;
  return layout({ title: 'your settings', hubName: d.hubName, body, script });
}

export function messagePage(opts: { hubName: string; ok: boolean; title: string; message: string; link?: { href: string; label: string } }): string {
  const body = `<section>
  <h2><span class="dot ${opts.ok ? 'ok' : 'bad'}"></span> ${escapeHtml(opts.title)}</h2>
  <p>${escapeHtml(opts.message)}</p>
  ${opts.link ? `<a class="btn" href="${escapeHtml(opts.link.href)}">${escapeHtml(opts.link.label)}</a>` : ''}
</section>`;
  return layout({ title: opts.ok ? 'done' : 'problem', hubName: opts.hubName, body });
}
