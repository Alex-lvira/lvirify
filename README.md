# lvirify

An office "now playing" wall. Everyone who joins shows up as a cassette on a
shared page (and on the TV in the office), with album art, track, artist,
spinning reels and a progress bar. It can also set your Slack status to the
current track. Each of those two things can be switched off independently.

There are two ways to join:

- **From the website** (default, easiest): open the hub's `/join` page, click
  *Connect Spotify*, done. The hub stores your Spotify (and optionally Slack)
  tokens and polls Spotify for you. Nothing to install.
- **With the companion** on your own machine: tokens never leave your laptop,
  and the companion pushes to the hub. More private, more setup.

```
 colleague's laptop                        office Raspberry Pi                  browsers / TV
┌──────────────────────┐   WebSocket     ┌──────────────────────┐   WebSocket   ┌──────────────┐
│ companion            │ ─────────────▶ │ hub                  │ ────────────▶ │ dashboard    │
│  · polls Spotify     │  (shared secret)│  · presence + history│               │  cassettes   │
│  · sets Slack status │                 │  · serves dashboard  │               │  /kiosk      │
│  · settings page     │ ◀────────────── │  · brokers Slack     │               └──────────────┘
│    127.0.0.1:48222   │  Slack token    │    OAuth (HTTPS)     │
└──────────────────────┘                 └──────────────────────┘
```

Packages (TypeScript, Node 20+, npm workspaces):

| package               | what                                                                     |
| --------------------- | ------------------------------------------------------------------------ |
| `packages/hub`        | Runs on the Pi. HTTP + WebSocket server, keeps who is online and their last tracks in `data/state.json`, brokers the Slack login. |
| `packages/dashboard`  | The cassette wall (Vite, vanilla TS). Built to static files the hub serves at `/` and `/kiosk`. |
| `packages/companion`  | Optional CLI for colleagues who want tokens on their own machine. Watches Spotify, pushes to the hub, updates Slack, serves a local settings page. |
| `packages/clients`    | Spotify and Slack API clients plus the Slack-status state machine, shared by hub and companion. |
| `packages/shared`     | Message types shared by everything.                                       |

## How it fits together

- **Spotify** is read through the Web API with OAuth PKCE, so no client
  secret is needed anywhere. Joining from the site uses the redirect
  `<PUBLIC_URL>/spotify/callback`; the companion uses the loopback redirect
  `http://127.0.0.1:48222/spotify/callback`. Register both in the Spotify app.
- **Website members** are identified by a signed cookie after the Spotify
  login. `/me` has the two toggles, Slack connect, and *Leave*, which deletes
  the person's tokens from the hub. Tokens live in `data/members.json`
  (mode 600) on the hub.
- **Slack** requires an HTTPS redirect URL, which a local companion cannot
  offer. For website members the hub simply does the OAuth and keeps the
  token. For companions it registers a one-time session, the browser goes to
  the hub's `/slack/connect`, the hub receives Slack's callback, exchanges the
  code, and hands the user token back to the companion once, then forgets it.
- **Each person's Slack status is set with their own user token**, obtained
  when they themselves clicked *Connect Slack*. There is no shared token, so
  one person's music can never land on someone else's status.
- **Companion → hub** uses a WebSocket with a shared secret. Anyone on the
  LAN can look at the wall; only companions with the secret can publish.
- **Opt out**: the settings page has two toggles, *Show me on the office wall*
  and *Update my Slack status*. Turning the wall off closes the hub connection
  so the cassette disappears immediately. Slack-only users still need the hub
  reachable once to complete the Slack login.
- **Slack status** is `🎧 Track – Artist` with an expiry set to the rest of
  the track plus 90 s, so it clears by itself if the companion dies. Two
  minutes after playback stops the companion clears it, but only if the
  status is still the one it wrote. Podcast episodes show the show name as
  the artist.
- **Wall behaviour**: paused or idle people stay as greyed, stopped
  cassettes. A person disappears 20 s after their companion disconnects.
  Clicking a cassette opens the track in Spotify. Up to four previous tracks
  are listed under each cassette and survive hub restarts.

## One-time setup: the two apps

### Spotify developer app

1. <https://developer.spotify.com/dashboard> → *Create app*.
2. Redirect URIs (add both):
   - `https://<your hub URL>/spotify/callback` for joining from the site
   - `http://127.0.0.1:48222/spotify/callback` for the companion (one per
     port if anyone runs it on a different `--port`)
3. API used: *Web API*. Save. Copy the **Client ID** (the secret is not used).
4. While the app is in *Development mode*, add each colleague's Spotify account
   email under *User Management* (max 25). This is the step people forget;
   without it their login fails with "user not registered".

### Slack app

1. <https://api.slack.com/apps> → *Create New App* → *From scratch*, pick your
   workspace.
2. *OAuth & Permissions* → **User Token Scopes**: add `users.profile:write` and
   `users.profile:read`. No bot scopes are needed.
3. *Redirect URLs*: add `https://<your-hub-public-url>/slack/callback` (see
   below for what that URL is locally vs on the Pi). Save.
4. *Basic Information* → copy **Client ID** and **Client Secret**.

## Just want to see it?

```sh
npm install && npm run build
npm run demo          # hub on http://localhost:3210 with fake colleagues, no credentials needed
```

Open <http://localhost:3210> (or `/kiosk` for the TV layout). Set `PORT=…` or
`DEMO_USERS=8` to change the port or the number of fake people.

To put *yourself* on the demo wall, run a real companion against it in a
second terminal (the demo hub's secret is `demo-secret`):

```sh
SPOTIFY_CLIENT_ID=<your client id> npm run demo          # terminal 1
npm run companion -- --hub http://localhost:3210 --secret demo-secret   # terminal 2
```

The settings page opens at <http://127.0.0.1:48222>; click *Connect Spotify*.
Slack works too if you also export `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`
and a `PUBLIC_URL` tunnel before starting the demo.

## Hosting the hub on Render (free) for a live trial

Render's free web service gives the hub an HTTPS URL, which is all Spotify and
Slack need. It sleeps after 15 minutes without HTTP traffic, so the hub pings
its own `/healthz` every 10 minutes while running there (`KEEPALIVE`). The
free disk is wiped on every deploy, which means **members have to click
*Connect Spotify* again after each deploy**; nothing else is lost.

1. Push this repo to GitHub.
2. <https://dashboard.render.com> → *New* → *Blueprint* → pick the repo.
   `render.yaml` creates a free web service called `lvirify` and generates
   `HUB_SECRET`. It asks for `SPOTIFY_CLIENT_ID`, `SLACK_CLIENT_ID` and
   `SLACK_CLIENT_SECRET`; Slack ones can stay empty to start without Slack.
3. Wait for the first deploy, note the URL (`https://lvirify-xxxx.onrender.com`).
4. In the Spotify app add `https://lvirify-xxxx.onrender.com/spotify/callback`
   as a redirect URI and add each colleague's Spotify email under
   *User Management*.
5. If using Slack, add `https://lvirify-xxxx.onrender.com/slack/callback` as
   the Slack app's redirect URL.
6. Send colleagues `https://lvirify-xxxx.onrender.com/join`.

Anyone with the URL can see the wall. To make it private set
`DASHBOARD_KEY=<something>` in Render's environment and share
`https://…/?key=<something>` instead; the browser remembers it in a cookie.

## Running everything on your own machine

You need one terminal for the hub, one for a tunnel (only for the Slack
login), and one per companion.

```sh
npm install
npm run build
```

### 1. Tunnel (needed for joining from the site and for Slack)

Spotify's and Slack's redirects back to the hub must be HTTPS, so expose the hub:

```sh
ngrok http 3000            # or: cloudflared tunnel --url http://localhost:3000
```

Copy the `https://…` URL. Free tunnel URLs change on every restart; when they
do, update `PUBLIC_URL` below and the redirect URLs in the Spotify and Slack
apps. The companion's own Spotify login needs no tunnel.

### 2. Hub

```sh
cp packages/hub/.env.example packages/hub/.env
$EDITOR packages/hub/.env       # HUB_SECRET, PUBLIC_URL, SPOTIFY_CLIENT_ID, SLACK_CLIENT_ID/SECRET
cd packages/hub && node dist/index.js     # or from the root: npm run dev:hub
```

Open <http://localhost:3000>. You should see the empty wall. Open the tunnel
URL + `/join` to join from the site.

If port 3000 is busy, change `PORT` in `.env` and point the tunnel at the new
port. The kiosk view is at <http://localhost:3000/kiosk>.

### 3. Companion (optional)

```sh
node packages/companion/dist/index.js --hub http://localhost:3000 --secret <HUB_SECRET>
# dev, with reload: npm run dev:companion -- --hub http://localhost:3000 --secret <HUB_SECRET>
```

The settings page opens at <http://127.0.0.1:48222>:

1. *Office hub* shows a green dot once the hub answers.
2. *Connect Spotify* → log in → you are back on the settings page and your
   cassette appears on the wall within a few seconds of playing something.
3. *Connect Slack* → the browser goes hub → Slack → hub; the companion picks
   the token up within two seconds. Play a track and check your Slack status.

To pretend to be a second colleague on the same machine, run another
companion with its own port and config file, logged into another Spotify
account:

```sh
node packages/companion/dist/index.js --port 48223 --config ~/.config/lvirify/second.json
```

(and add `http://127.0.0.1:48223/spotify/callback` to the Spotify app.)

The companion's config lives at `~/.config/lvirify/companion.json` on Linux,
`~/Library/Application Support/lvirify/companion.json` on macOS and
`%APPDATA%\lvirify\companion.json` on Windows. It contains the Spotify and
Slack tokens, so it is written with mode 600.

### Dashboard development

```sh
npm run dev:dashboard     # Vite on :5173, proxies /api and /ws to the hub on :3000
```

## Deploying the hub on the Raspberry Pi

```sh
sudo apt install nodejs npm git        # Node 20+ (use nodesource if apt is older)
git clone <this repo> ~/lvirify && cd ~/lvirify
npm install && npm run build
cp packages/hub/.env.example packages/hub/.env && nano packages/hub/.env
sudo cp deploy/lvirify-hub.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now lvirify-hub
```

`PUBLIC_URL` on the Pi must be a stable HTTPS URL for the Slack callback. The
simplest is Tailscale:

```sh
sudo tailscale up
sudo tailscale serve --bg 3000       # gives https://<pi>.<tailnet>.ts.net
```

Then `PUBLIC_URL=https://<pi>.<tailnet>.ts.net` and the same URL +
`/slack/callback` in the Slack app. Colleagues on the tailnet can also use
that URL as their hub URL; on the office LAN `http://<pi-hostname>.local:3000`
works too. Any reverse proxy with a certificate (Caddy, nginx + certbot) does
the same job.

`deploy/kiosk.md` covers starting Chromium in kiosk mode on the Pi's TV.

## Companion CLI

```
lvirify-companion [--port 48222] [--config <file>] [--hub <url>] [--secret <s>] [--no-open]
```

`--hub` and `--secret` are saved to the config file, so they are only needed
once. Everything else is done from the settings page.

## Hub configuration (`packages/hub/.env`)

| var                 | meaning                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| `PORT`              | listen port (default 3000)                                              |
| `HUB_NAME`          | shown in the dashboard header                                           |
| `HUB_SECRET`        | shared secret companions must present                                   |
| `PUBLIC_URL`        | HTTPS URL the browser can reach the hub at; used for the Slack redirect |
| `SPOTIFY_CLIENT_ID` | handed to companions so nobody has to copy it                           |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | Slack app credentials; leave empty to disable Slack |
| `DATA_DIR`          | where `state.json` and `members.json` live (default `./data`)           |
| `WEB_JOIN`          | `0` disables joining from the site (companion only)                      |
| `DASHBOARD_KEY`     | optional; when set the wall needs `?key=` once                           |
| `KEEPALIVE`         | self-ping every 10 min; defaults to on when running on Render           |

## HTTP / WebSocket surface

| route                         | who         | auth   |
| ----------------------------- | ----------- | ------ |
| `GET /`, `GET /kiosk`         | browsers    | none, or `DASHBOARD_KEY` |
| `GET /join`, `/spotify/login`, `/spotify/callback` | browsers | none (login flow) |
| `GET /me`, `GET/POST /api/me*` | members    | signed cookie |
| `GET /api/state`              | browsers    | none   |
| `GET /api/public-config`      | companions  | none   |
| `WS /ws/dashboard`            | browsers    | none   |
| `WS /ws/companion`            | companions  | `Authorization: Bearer <HUB_SECRET>` |
| `POST /api/slack/session/:id` | companion   | bearer |
| `GET /slack/connect?session=` | browser     | none (session must be registered) |
| `GET /slack/callback`         | Slack       | none   |
| `GET /api/slack/session/:id`  | companion   | bearer |

## Troubleshooting

- **"user not registered" from Spotify**: add the person's Spotify email in
  the Spotify app's *User Management* (dev-mode allowlist).
- **Spotify login says redirect URI mismatch**: the companion's port is not
  registered; add `http://127.0.0.1:<port>/spotify/callback`.
- **Slack "redirect_uri did not match"**: `PUBLIC_URL` (hub) and the Slack
  app's redirect URL differ. Restart the hub after changing `.env`.
- **Companion shows "hub rejected the secret (401)"**: `HUB_SECRET` mismatch.
- **Cassette shows but never updates**: Spotify only reports the device that
  is actively playing; the free tier is fine, but private sessions hide
  playback.
- **Nothing on the wall after a hub restart**: expected. Companions reconnect
  within seconds, website members are polled again right away; history is
  restored from `data/state.json`. On Render's free disk the member tokens are
  gone after a *deploy*, so people must connect Spotify again.
- **"Spotify login expired" on /me**: Spotify revoked the refresh token
  (usually the person was removed from the app's user list). Reconnect.
