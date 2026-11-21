# Combat Pubs Bot

[![Build, push, and deploy combat-pubs-bot](https://github.com/EchoTools/combat-pubs-bot/actions/workflows/deploy.yml/badge.svg)](https://github.com/EchoTools/combat-pubs-bot/actions/workflows/deploy.yml)

A Discord bot for [EchoVRCE](https://echovrce.com) that polls the public match status API every 10 seconds and posts live messages showing:

- **Combat queue** — a [Components V2](https://discord.com/developers/docs/components/reference) message with the number of players currently searching for a Combat match. It is removed when nobody is queued and re-posted at the bottom of the channel when someone queues.
- **Active matches** — one pinned embed per live Combat game with score, clock, map, region and team rosters. The [echo.taxi](https://echo.taxi) join link is posted as a raw clickable URL in the message text, outside the embed, so other bots can detect it.

Messages are edited in-place across restarts using message IDs persisted to `state.json`.
The bot can also optionally authenticate with Nakama for richer queue details if you provide Nakama credentials.

## Requirements

- [Node.js](https://nodejs.org/) v18 or later
- A Discord webhook URL

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

| Variable              | Required | Description                                   |
| --------------------- | -------- | --------------------------------------------- |
| `DISCORD_WEBHOOK_URL` | Yes      | Webhook URL for the target channel            |
| `DISCORD_BOT_TOKEN`   | Optional | Bot token — enables automatic message pinning |
| `POLL_INTERVAL_MS`    | Optional | Poll frequency in ms (default: `10000`, min `5000`) |
| `FILTER_GUILD_ID`     | Optional | Restrict embeds to one guild/group ID         |
| `NAKAMA_URL`          | Optional | Nakama base URL (no trailing slash, no /v2)   |
| `NAKAMA_HTTP_KEY`     | Optional | Nakama runtime http key for account RPCs      |
| `NAKAMA_USERNAME`     | Optional | Bot account username for Nakama auth          |
| `NAKAMA_PASSWORD`     | Optional | Bot account password for Nakama auth          |

When all four Nakama values are set, the bot authenticates with Nakama and uses the authenticated API path. If auth fails, it automatically falls back to the public endpoint.

#### Creating a Discord webhook

In your Discord channel: **Settings → Integrations → Webhooks → New Webhook** → copy the URL.

#### Enabling auto-pinning (optional)

Create a bot at [discord.com/developers/applications](https://discord.com/developers/applications), invite it to your server with the **Manage Messages** permission, and set `DISCORD_BOT_TOKEN`.

### 3. Run the bot

```bash
node bot.js
```

Or on Windows, double-click `start-bot.bat`.

### 4. Run with Docker

```bash
docker compose up -d
```

This uses the local `Dockerfile` and mounts `./data` for persistent `state.json`.

## Deploying to Render

The repo includes a `render.yaml` for one-click deployment as a Background Worker:

1. Push the repo to GitHub
2. Go to [render.com](https://render.com) → **New → Blueprint** → connect your repo
3. Set the required env vars in the Render dashboard

Free tier Background Workers run 24/7 with no sleep.

## How it works

Every `POLL_INTERVAL_MS` the bot fetches `https://g.echovrce.com/status/matches` (public, no auth) and:

1. Reads `active_matchmaking_counts` to get the number of players queuing for Combat
2. Filters `labels` for active public Combat matches (optionally by `FILTER_GUILD_ID`)
3. Posts or edits pinned Discord messages for the queue count and each active match (unchanged messages are not re-edited, to save rate limit)
4. Deletes messages for matches that have ended, and the queue message when nobody is queued

Each message shows a live "updated …" Discord timestamp, so if the bot or the API stalls, viewers can see how old the data is. Snapshots older than the last one rendered are ignored.

### Tests

```bash
npm test
```

Console output is change-driven — counts are only logged when the queue size or number of active matches changes.
