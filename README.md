# Combat Pubs Bot

A Discord bot for [EchoVRCE](https://echovrce.com) that polls the Nakama matchmaker and posts live embeds showing:

- **Combat queue** — who is currently searching for a match
- **Active matches** — one pinned embed per live Combat game with team rosters and a [echo.taxi](https://echo.taxi) join link

Message IDs are persisted to `state.json` so embeds are edited in-place across restarts rather than reposted.

## Requirements

- [Node.js](https://nodejs.org/) v18 or later
- A Discord webhook URL
- A Nakama JWT + refresh token from [echovrce.com](https://echovrce.com)

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `NAKAMA_URL` | Yes | Nakama server URL (no trailing slash) |
| `NAKAMA_HTTP_KEY` | Yes | Nakama HTTP key for token refresh |
| `NAKAMA_TOKEN` | Yes | Your Nakama JWT — see below |
| `NAKAMA_REFRESH_TOKEN` | Recommended | Nakama refresh token — extends session automatically |
| `DISCORD_WEBHOOK_URL` | Yes | Webhook URL for the target channel |
| `DISCORD_BOT_TOKEN` | Optional | Bot token — enables automatic message pinning |
| `POLL_INTERVAL_MS` | Optional | Poll frequency in ms (default: `10000`) |
| `FILTER_GUILD_ID` | Optional | Restrict embeds to one guild/group ID |

#### Getting your Nakama tokens

1. Log into [echovrce.com](https://echovrce.com)
2. Open DevTools (`F12`) → **Application** → **Local Storage** → select the site
3. Copy the value of `jwt` → paste into `NAKAMA_TOKEN`
4. Copy the value of `refreshToken` → paste into `NAKAMA_REFRESH_TOKEN`

Tokens expire periodically. When they do, repeat the steps above, update `.env`, and restart the bot.

#### Creating a Discord webhook

In your Discord channel: **Settings → Integrations → Webhooks → New Webhook** → copy the URL.

#### Enabling auto-pinning (optional)

Create a bot at [discord.com/developers/applications](https://discord.com/developers/applications), invite it to your server with the **Manage Messages** permission, and set `DISCORD_BOT_TOKEN`.

### 3. Run the bot

```bash
node bot.js
```

Or on Windows, double-click `start-bot.bat`.

## How it works

Every `POLL_INTERVAL_MS` the bot:

1. Calls the Nakama matchmaker state RPC to get the current queue
2. Calls the Nakama match list endpoint to get active authoritative matches
3. Filters both for Combat game mode (and optionally by `FILTER_GUILD_ID`)
4. Posts or edits pinned Discord embeds for the queue and each active match
5. Deletes embeds for matches that have ended

If the Nakama session token expires, the bot attempts to refresh it automatically using `NAKAMA_REFRESH_TOKEN`. If that also fails, polling stops and an error is logged to the console.
