# Combat Pubs Bot

[![Build, push, and deploy combat-pubs-bot](https://github.com/EchoTools/combat-pubs-bot/actions/workflows/deploy.yml/badge.svg)](https://github.com/EchoTools/combat-pubs-bot/actions/workflows/deploy.yml)

A Discord bot for [EchoVRCE](https://echovrce.com) that polls the public match status API and posts live embeds showing:

- **Combat queue** — number of players currently searching for a Combat match
- **Active matches** — one pinned embed per live Combat game with team rosters, match time, region, and an [echo.taxi](https://echo.taxi) join link

Embeds are edited in-place across restarts using message IDs persisted to `state.json`. No login or API tokens required.

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
| `POLL_INTERVAL_MS`    | Optional | Poll frequency in ms (default: `10000`)       |
| `FILTER_GUILD_ID`     | Optional | Restrict embeds to one guild/group ID         |

#### Creating a Discord webhook

In your Discord channel: **Settings → Integrations → Webhooks → New Webhook** → copy the URL.

#### Enabling auto-pinning (optional)

Create a bot at [discord.com/developers/applications](https://discord.com/developers/applications), invite it to your server with the **Manage Messages** permission, and set `DISCORD_BOT_TOKEN`.

### 3. Run the bot

```bash
node bot.js
```

Or on Windows, double-click `start-bot.bat`.

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
3. Posts or edits pinned Discord embeds for the queue count and each active match
4. Deletes embeds for matches that have ended

Console output is change-driven — counts are only logged when the queue size or number of active matches changes.
