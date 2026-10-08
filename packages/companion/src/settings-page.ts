/** The companion's local settings page. Plain HTML + inline JS, polls /api/status. */
export function settingsPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>lvirify companion</title>
<style>
  :root{
    --bg:#14110e; --panel:#1f1a15; --panel-2:#2a231c; --line:#3a3128;
    --ink:#f3ead9; --muted:#a4957f; --accent:#f2b547; --ok:#7fd39a; --bad:#e2645a; --warn:#f2b547;
    --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
  main{max-width:720px;margin:0 auto;padding:32px 16px 64px}
  header{display:flex;align-items:center;gap:14px;margin-bottom:28px}
  header .logo{width:44px;height:28px;border-radius:6px;background:linear-gradient(180deg,#3b3129,#241e18);border:1px solid var(--line);position:relative}
  header .logo::before,header .logo::after{content:"";position:absolute;top:8px;width:10px;height:10px;border-radius:50%;border:2px solid var(--accent)}
  header .logo::before{left:8px} header .logo::after{right:8px}
  h1{font-size:20px;margin:0;font-weight:600;letter-spacing:.01em}
  h1 small{color:var(--muted);font-weight:400;margin-left:8px;font-family:var(--mono);font-size:12px}
  section{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin-bottom:16px}
  section h2{margin:0 0 12px;font-size:13px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);display:flex;align-items:center;gap:10px}
  .dot{width:9px;height:9px;border-radius:50%;background:var(--muted);display:inline-block;flex:none}
  .dot.ok{background:var(--ok);box-shadow:0 0 0 3px rgba(127,211,154,.15)} .dot.bad{background:var(--bad)} .dot.warn{background:var(--warn)}
  .row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
  .row+.row{margin-top:10px}
  label{display:block;font-size:12px;color:var(--muted);margin-bottom:4px}
  input[type=text],input[type=password],input[type=url]{width:100%;background:var(--panel-2);border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:9px 11px;font:inherit;font-family:var(--mono);font-size:13px}
  input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:transparent}
  .field{flex:1 1 220px}
  button{background:var(--accent);color:#1b1408;border:0;border-radius:8px;padding:9px 14px;font:inherit;font-weight:600;cursor:pointer}
  button.ghost{background:transparent;color:var(--ink);border:1px solid var(--line)}
  button:disabled{opacity:.5;cursor:default}
  .muted{color:var(--muted)} .mono{font-family:var(--mono);font-size:13px}
  .status-line{display:flex;align-items:center;gap:10px;min-height:32px}
  .avatar{width:32px;height:32px;border-radius:50%;background:var(--panel-2);object-fit:cover}
  .switch{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-top:1px solid var(--line)}
  .switch:first-of-type{border-top:0}
  .switch .desc{font-size:13px;color:var(--muted)}
  .toggle{position:relative;width:44px;height:26px;flex:none}
  .toggle input{opacity:0;width:0;height:0;position:absolute}
  .toggle span{position:absolute;inset:0;background:var(--panel-2);border:1px solid var(--line);border-radius:26px;transition:.15s}
  .toggle span::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:var(--muted);transition:.15s}
  .toggle input:checked+span{background:rgba(242,181,71,.25);border-color:var(--accent)}
  .toggle input:checked+span::after{transform:translateX(18px);background:var(--accent)}
  .now{display:flex;gap:14px;align-items:center}
  .now img{width:64px;height:64px;border-radius:8px;object-fit:cover;background:var(--panel-2)}
  .now .t{font-weight:600} .now .a{color:var(--muted)}
  .bar{height:4px;background:var(--panel-2);border-radius:2px;overflow:hidden;margin-top:8px}
  .bar i{display:block;height:100%;background:var(--accent);width:0}
  pre.log{margin:0;max-height:220px;overflow:auto;background:#0f0d0a;border-radius:8px;padding:12px;font:12px/1.5 var(--mono);color:#cbbfa9;white-space:pre-wrap}
  .hint{font-size:12px;color:var(--muted);margin-top:8px}
  code{font-family:var(--mono);font-size:12px;background:var(--panel-2);padding:1px 5px;border-radius:4px}
  .toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);background:var(--panel-2);border:1px solid var(--line);padding:8px 14px;border-radius:999px;font-size:13px;opacity:0;transition:.2s;pointer-events:none}
  .toast.show{opacity:1}
</style>
</head>
<body>
<main>
  <header>
    <div class="logo"></div>
    <h1>lvirify companion <small id="cfgpath"></small></h1>
  </header>

  <section id="sec-hub">
    <h2><span class="dot" id="hub-dot"></span> Office hub</h2>
    <div class="row">
      <div class="field"><label>Hub URL</label><input type="url" id="hubUrl" placeholder="http://lvirify.local:3000"></div>
      <div class="field"><label>Shared secret</label><input type="password" id="hubSecret" placeholder="ask whoever runs the hub"></div>
    </div>
    <div class="row" style="margin-top:12px">
      <button id="saveHub">Save hub settings</button>
      <span class="muted mono" id="hub-status"></span>
    </div>
  </section>

  <section id="sec-spotify">
    <h2><span class="dot" id="sp-dot"></span> Spotify</h2>
    <div class="status-line" id="sp-line"></div>
    <div class="row" style="margin-top:12px">
      <button id="sp-connect">Connect Spotify</button>
      <button class="ghost" id="sp-disconnect">Disconnect</button>
    </div>
    <details style="margin-top:12px"><summary class="muted" style="cursor:pointer;font-size:13px">Advanced: Spotify client id</summary>
      <div class="row" style="margin-top:8px">
        <div class="field"><label>Client id override (blank = use the hub's)</label><input type="text" id="spotifyClientId"></div>
        <button class="ghost" id="saveSp" style="align-self:flex-end">Save</button>
      </div>
      <p class="hint">The Spotify app must list <code id="redirect"></code> as a redirect URI.</p>
    </details>
  </section>

  <section id="sec-slack">
    <h2><span class="dot" id="sl-dot"></span> Slack</h2>
    <div class="status-line" id="sl-line"></div>
    <div class="row" style="margin-top:12px">
      <button id="sl-connect">Connect Slack</button>
      <button class="ghost" id="sl-disconnect">Disconnect</button>
      <span class="muted mono" id="sl-status"></span>
    </div>
  </section>

  <section>
    <h2>What to share</h2>
    <div class="switch">
      <div><div>Show me on the office wall</div><div class="desc">Sends what you play to the hub so it appears as a cassette.</div></div>
      <label class="toggle"><input type="checkbox" id="broadcastToHub"><span></span></label>
    </div>
    <div class="switch">
      <div><div>Update my Slack status</div><div class="desc">Sets your status to the current track while it plays. Cleared 2 minutes after you stop.</div></div>
      <label class="toggle"><input type="checkbox" id="updateSlack"><span></span></label>
    </div>
    <div class="row" style="margin-top:10px">
      <div class="field" style="max-width:220px"><label>Slack status emoji</label><input type="text" id="slackEmoji" placeholder=":headphones:"></div>
      <button class="ghost" id="saveEmoji" style="align-self:flex-end">Save</button>
    </div>
  </section>

  <section>
    <h2>Now playing</h2>
    <div class="now" id="now"><span class="muted">Nothing playing.</span></div>
  </section>

  <section>
    <h2>Log</h2>
    <pre class="log" id="log"></pre>
  </section>
</main>
<div class="toast" id="toast"></div>

<script>
const $ = (id) => document.getElementById(id);
let state = null;
let dirty = new Set();

function toast(msg){ const t=$('toast'); t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),1800); }

async function api(path, body){
  const r = await fetch(path, body ? {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)} : undefined);
  if(!r.ok) throw new Error(await r.text());
  return r.json();
}

function setDot(id, level){ const d=$(id); d.className='dot'+(level?' '+level:''); }

function render(s){
  state = s;
  $('cfgpath').textContent = s.configPath;
  $('redirect').textContent = s.spotifyRedirectUri;
  for (const k of ['hubUrl','hubSecret','spotifyClientId','slackEmoji']) if(!dirty.has(k)) $(k).value = s.config[k] ?? '';
  for (const k of ['broadcastToHub','updateSlack']) $(k).checked = !!s.config[k];

  // hub
  const h = s.hub;
  setDot('hub-dot', h.status==='connected'?'ok':h.status==='error'?'bad':h.status==='connecting'?'warn':'');
  $('hub-status').textContent = h.status==='connected' ? 'connected to "'+h.hubName+'"' : h.status==='disabled' ? (s.config.broadcastToHub ? 'waiting for Spotify login' : 'broadcast off') : (h.lastError || h.status);

  // spotify
  const sp = s.spotify;
  setDot('sp-dot', sp.connected ? (sp.error?'warn':'ok') : '');
  $('sp-line').innerHTML = sp.connected
    ? (sp.user.avatarUrl?'<img class="avatar" src="'+esc(sp.user.avatarUrl)+'">':'<span class="avatar"></span>')+'<span>'+esc(sp.user.name)+'</span>'+(sp.error?'<span class="muted mono"> · '+esc(sp.error)+'</span>':'')
    : '<span class="muted">Not connected.'+(s.spotifyClientIdInUse?'':' The hub has no Spotify client id yet: set one under Advanced or ask the hub owner.')+'</span>';
  $('sp-connect').disabled = !s.spotifyClientIdInUse;
  $('sp-disconnect').style.display = sp.connected ? '' : 'none';
  $('sp-connect').textContent = sp.connected ? 'Reconnect Spotify' : 'Connect Spotify';

  // slack
  const sl = s.slack;
  setDot('sl-dot', sl.connected ? (sl.error?'warn':'ok') : '');
  $('sl-line').innerHTML = sl.connected ? '<span>Connected to <b>'+esc(sl.teamName)+'</b></span>' : '<span class="muted">Not connected.'+(s.hubSlackEnabled===false?' The hub has no Slack app configured.':'')+'</span>';
  $('sl-disconnect').style.display = sl.connected ? '' : 'none';
  $('sl-connect').textContent = sl.connected ? 'Reconnect Slack' : 'Connect Slack';
  $('sl-connect').disabled = s.hubSlackEnabled === false || s.hub.status==='error' && !s.hubReachable;
  $('sl-status').textContent = sl.pending ? 'waiting for you to finish in the browser…' : sl.lastSetText ? 'status: '+sl.lastSetText : (sl.error || '');

  // now
  const p = s.playback;
  if (p) {
    const pos = p.isPlaying ? Math.min(p.durationMs, p.progressMs + (Date.now()-p.fetchedAt)) : p.progressMs;
    $('now').innerHTML = (p.albumArtUrl?'<img src="'+esc(p.albumArtUrl)+'">':'<span></span>')+'<div style="flex:1;min-width:0"><div class="t">'+esc(p.title)+'</div><div class="a">'+esc(p.artists.join(', '))+(p.isPlaying?'':' · paused')+'</div><div class="bar"><i style="width:'+(100*pos/p.durationMs).toFixed(1)+'%"></i></div></div>';
  } else $('now').innerHTML = '<span class="muted">Nothing playing.</span>';

  $('log').textContent = s.log.map(e => new Date(e.t).toLocaleTimeString()+'  '+e.msg).join('\\n');
}
function esc(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

async function refresh(){ try { render(await api('/api/status')); } catch(e) { console.error(e); } }

for (const k of ['hubUrl','hubSecret','spotifyClientId','slackEmoji']) $(k).addEventListener('input', () => dirty.add(k));

$('saveHub').onclick = async () => { await api('/api/config',{hubUrl:$('hubUrl').value.trim(), hubSecret:$('hubSecret').value}); dirty.delete('hubUrl'); dirty.delete('hubSecret'); toast('Saved'); refresh(); };
$('saveSp').onclick = async () => { await api('/api/config',{spotifyClientId:$('spotifyClientId').value.trim()}); dirty.delete('spotifyClientId'); toast('Saved'); refresh(); };
$('saveEmoji').onclick = async () => { await api('/api/config',{slackEmoji:$('slackEmoji').value.trim()}); dirty.delete('slackEmoji'); toast('Saved'); refresh(); };
$('broadcastToHub').onchange = async (e) => { await api('/api/config',{broadcastToHub:e.target.checked}); refresh(); };
$('updateSlack').onchange = async (e) => { await api('/api/config',{updateSlack:e.target.checked}); refresh(); };
$('sp-connect').onclick = () => { location.href = '/spotify/login'; };
$('sp-disconnect').onclick = async () => { await api('/api/spotify/disconnect',{}); refresh(); };
$('sl-connect').onclick = () => { window.open('/slack/login','_blank'); setTimeout(refresh,500); };
$('sl-disconnect').onclick = async () => { await api('/api/slack/disconnect',{}); refresh(); };

const q = new URLSearchParams(location.search);
if (q.get('connected')) { toast(q.get('connected')+' connected'); history.replaceState(null,'','/'); }
if (q.get('error')) { alert(q.get('error')); history.replaceState(null,'','/'); }

refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;
}
