# Combat Pubs Bot

A Discord bot for [EchoVRCE](https://echovrce.com) that polls the Nakama matchmaker and posts live embeds showing:

- **Combat queue** — who is currently searching for a match
- **Active matches** — one pinned embed per live Combat game with team rosters and an [echo.taxi](https://echo.taxi) join link

Message IDs are persisted to `state.json` so embeds are edited in-place across restarts rather than reposted.

## Requirements

- [Node.js](https://nodejs.org/) v18 or later
- A Discord webhook URL
- An EchoVRCE account (username + password)

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
| `NAKAMA_HTTP_KEY` | Yes | Nakama HTTP key |
| `NAKAMA_USERNAME` | Yes | Your EchoVRCE username |
| `NAKAMA_PASSWORD` | Yes | Your EchoVRCE password |
| `DISCORD_WEBHOOK_URL` | Yes | Webhook URL for the target channel |
| `DISCORD_BOT_TOKEN` | Optional | Bot token — enables automatic message pinning |
| `POLL_INTERVAL_MS` | Optional | Poll frequency in ms (default: `10000`) |
| `FILTER_GUILD_ID` | Optional | Restrict embeds to one guild/group ID |

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

Console output is change-driven — poll counts are only logged when the queue size or number of active matches changes.

## Authentication

The bot uses the same proactive token refresh pattern as [echovrce-web](https://github.com/EchoTools/nevr-portal):

1. On startup it logs in via `account/authenticate/password` to get a JWT + refresh token
2. Before each API call it decodes the JWT and checks the `exp` claim — if the token expires within 5 minutes it calls `device/auth/refresh` proactively, rotating both tokens
3. If the refresh token itself has expired (~7 days), it falls back to a fresh password login automatically

The bot never needs manual token updates — credentials in `.env` are enough.
