# Emerald Table Blackjack — Multiplayer

Two parts:

- **`client/index.html`** — the whole website (menu, solo vs bots, lobby, multiplayer table). This is what goes on GitHub Pages. It's a single static file with no build step.
- **`server/`** — a small Node.js WebSocket server that runs the lobbies and multiplayer game logic. GitHub Pages can't run this (it only serves static files), so it needs to run somewhere else — see below.

## How multiplayer works

- **Create Lobby** generates a 5-character code and opens a table (max 5 seats).
- Anyone with the code can **Join** while the table is filling.
- A 20-second countdown starts as soon as the lobby is created. Any seats still empty when it hits 0 are filled with bots. If 5 humans join before the countdown ends, the table starts immediately.
- Betting → dealing → turn-based play (Hit / Stand / Double / Surrender) → dealer plays → payout, then the next round starts automatically.
- Each player's bankroll persists for the session. When a player's bankroll drops below the table minimum ($25), they're eliminated (spectator screen). When there are no humans left with chips, the table closes.
- Solo "vs Bots" mode is the original single-player game and needs no server at all — it runs entirely in the browser, decks/modes/side-bets included.
- Multiplayer mode is simplified: no splits, no side bets, fixed bet tiers ($25/$50/$100/$250), to keep the sync logic manageable. Let me know if you want any of that added back in.

## 1. Run the server

```bash
cd server
npm install
npm start
```

This starts a WebSocket server on port 8080 (or `$PORT`). Test it locally by pointing the client's server URL at `ws://localhost:8080`.

### Hosting it for real

GitHub Pages is static-only, so the server needs a separate host that can keep a Node process running. Any of these work well on free/cheap tiers and need almost no config beyond pointing them at `server/`:

- **Render** — "New Web Service", connect the repo, root directory `server`, build command `npm install`, start command `npm start`.
- **Railway** — same idea, auto-detects Node.
- **Fly.io** — `fly launch` from the `server` folder.
- A plain VPS — `npm install && npm start`, ideally behind `pm2` or a systemd service, with Nginx doing TLS termination.

Whichever you pick, once it's deployed you'll get a URL like `your-app.onrender.com`. Your WebSocket URL is that with `wss://` in front: `wss://your-app.onrender.com`.

## 2. Point the client at your server

Open the site → **Server Settings** (bottom right of the main menu) → paste in your `wss://…` URL → Save. It's stored in the browser's `localStorage`, so each visitor only has to do this once (or you can hardcode it — see below).

If you'd rather not make visitors paste a URL, open `client/index.html`, find:
```js
const SERVER_KEY = 'emeraldtable_server_url';
function getServerUrl() { return localStorage.getItem(SERVER_KEY) || ''; }
```
and hardcode your URL as the fallback: `return localStorage.getItem(SERVER_KEY) || 'wss://your-app.onrender.com';`

## 3. Publish the client on GitHub Pages

1. Create a new GitHub repo.
2. Upload `client/index.html` as `index.html` at the repo root (drag-and-drop upload works fine).
3. Repo → Settings → Pages → Source: "Deploy from a branch", branch `main`, folder `/ (root)` → Save.
4. Your site goes live at `https://yourusername.github.io/your-repo-name/` within a minute or two.

## Notes / limitations

- Server state is in-memory only — restarting the server clears all active lobbies and bankrolls. Fine for casual play; swap in a database if you want persistence across restarts.
- Free tiers on Render/Railway/Fly often spin the server down after inactivity, causing a several-second delay on the first connection after idle time.
- No accounts/auth — anyone with a lobby code can join. Codes are single-use per table and expire when the table closes.
