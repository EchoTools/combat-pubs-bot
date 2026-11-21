# AGENTS.md — Combat Pubs Bot

## This IS

A Discord bot for the [EchoVRCE](https://echovrce.com) community. It polls
the public match status API at `https://g.echovrce.com/status/matches` on a
configurable interval (default 10s) and posts live Discord messages showing:

- How many players are currently queued for Combat matchmaking — a
  **Components V2** message (container, text displays, separators). It is
  deleted when nobody is queued and posted fresh (at the bottom of the
  channel) when someone queues again.
- One pinned **embed** per active public Combat match — score, clock, map,
  region, team rosters — with the [echo.taxi](https://echo.taxi) join link as
  raw text in the message content, outside the embed (see below for why).

Messages are edited in-place (not re-posted) and survive restarts via message
IDs persisted to `state.json` (`format: 3`; messages from older formats are
deleted and re-posted once on upgrade). The bot uses a Discord webhook for
posting/editing and an optional bot token for auto-pinning and cleanup.

**Language:** JavaScript (Node.js, ES modules)
**Runtime:** Node.js >= 18
**Dependencies:** `discord.js` >= 14.19 (webhook client, Components V2 builders), `dotenv`
(`.env` loading for local development)
**Deployment:** Render Background Worker (`render.yaml`), or `node bot.js`
anywhere

## This is NOT

- **Not a Discord gateway bot.** It does not use the Discord gateway, does
  not listen to messages, does not respond to commands. It is a
  poll-and-post webhook client. The optional bot token is used over REST
  only: pinning, deleting pin system notifications, startup recovery, and
  (when enabled) next-match reactions — not for gateway features.
- **Nakama is optional.** By default the bot uses only the public
  unauthenticated status endpoint. With `NAKAMA_*` set it can also use the
  authenticated status RPCs and the next-match feature.
  `get-discord-token.js` and `setup-token.bat` are legacy artifacts.
- **Not part of Metis core infrastructure.** It does not touch Logos, the
  Privacy Gate, the Write Router, or any memory substrates. The Metis
  non-negotiable constraints (NC-1 through NC-7) do not apply directly.
  Standard ecosystem engineering discipline applies.
- **Not a multi-server bot.** It posts to a single Discord channel via a
  single webhook. It does not manage multiple guilds, channels, or webhooks.

## You MUST

- **Read metis-core first.** Start with
  [EXPERTISE-METIS-NATURE.md](/srv/src/metis-core/EXPERTISE-METIS-NATURE.md),
  then [GENERIC-PROJECT-ADDENDUM.md](/srv/src/metis-core/GENERIC-PROJECT-ADDENDUM.md).
  The generic addendum defines the engineering standards this project
  follows.
- **Read the full `bot.js` before making changes.** The entire bot is a
  single 470-line file. Read it. There are no hidden modules, no build
  step, no abstraction layers. The code is the documentation for what it
  does at runtime.
- **Preserve edit-in-place semantics.** The bot MUST edit existing messages
  rather than deleting and re-posting. Discord rate limits punish
  create/delete patterns. Users see flicker. Pinned messages lose their
  pin. The state file exists to make edits survive restarts.
- **Preserve the startup recovery logic.** On startup, the bot scans the
  channel for existing Combat Queue embeds posted by its webhook and adopts
  them. This handles ephemeral-disk deployments (Render free tier) where
  `state.json` is wiped. Do not remove or weaken this recovery.
- **Test error paths.** Network failures (status API down, Discord API
  errors, webhook deleted), malformed API responses, and state file
  corruption are the primary failure modes. These paths must be tested.
- **Use conventional commits.** `feat:`, `fix:`, `security:`, `test:`,
  `docs:`. Security fixes use `security:` prefix.
- **Keep the `.env.example` in sync.** Any new configuration value gets a
  corresponding entry in `.env.example` with a comment explaining it.

## You must NEVER

- **Never expose the Discord bot token or webhook URL in logs, error
  messages, or source code.** The webhook URL contains a secret token. The
  bot token grants message management permissions. Both are credentials.
- **Never change the public status endpoint without confirming the new
  endpoint exists and is unauthenticated.** The bot's zero-auth design is
  intentional. Adding authenticated endpoints re-introduces the token
  lifecycle complexity that was deliberately removed.
- **Never post new messages when an edit would suffice.** Duplicate embeds
  in the channel are a user-facing defect. The concurrency guard
  (`queuePostInProgress`) and state tracking exist to prevent this.
- **Never ignore the `state.json` persistence contract.** Message IDs saved
  to state are used on subsequent polls and across restarts. Dropping state
  means orphaned pinned messages in the channel that nobody can edit or
  clean up.
- **Never add interactive components (select menus, non-link buttons).**
  A plain channel webhook can only send non-interactive components
  (`withComponents: true`), and handling interactions needs an
  application/gateway.
- **Never move the echo.taxi join link out of the message content.** It
  must stay a raw, clickable `https://echo.taxi/...` URL in the message
  `content`, outside the embed — not a button, masked link, embed field, or
  V2 text display. Another bot reads message content, detects the link, and
  reacts with 🚕 so players can haul a join request. This is also why match
  messages are embeds, not Components V2: V2 messages cannot have content.
- **Never add gateway intents or event listeners.** The bot is a webhook
  client. If a feature requires the Discord gateway, that is a design
  change that requires discussion, not an incremental addition.
- **Never use the bot's operator privilege on anyone but the person who
  asked.** Next-match reactions (`NEXT_MATCH_ENABLED`, approved by the
  project owner 2026-11-21) call `player/setnextmatch`, which only lets
  Global Operators target other users — and the bot's Nakama account is one.
  The target MUST always be the reacting user's own Discord ID and the match
  MUST be the one the message is for. If the Discord ID isn't linked, the
  server silently targets the caller (the bot) and returns success; that
  case must stay detected and reported as "not linked"
  (`classifySetNextMatchResult`).

## Common Mistakes

**Making Nakama required.** The public status endpoint is sufficient for
queue counts and active match data; the bot must keep working with no
`NAKAMA_*` values set. Authenticated features (currently: next-match
reactions) stay optional: they only activate when the `NAKAMA_*` values
are set. Do not add more without
explicit approval. `get-discord-token.js` and `setup-token.bat` are legacy.

**Over-engineering the single-file structure.** The bot is 470 lines in one
file. That is appropriate for its complexity. Do not split it into
modules/classes/layers unless the functionality genuinely warrants it. A
poll loop, some API calls, and some embed builders do not need an
architecture.

**Ignoring Discord rate limits.** The Discord API rate-limits webhook
operations. The poll interval (default 10s) and edit-in-place pattern are
designed to stay within limits. Faster polling or frequent message
creation/deletion will hit rate limits.

**Hardcoding match mode detection.** The `isCombat()` function checks for
"combat" in the mode string. EchoVRCE could add new combat-related modes.
The check should remain inclusive (substring match) not exclusive
(exact match).

---

## Directory Layout

```
bot.js                  # The entire bot — poll loop, Discord webhook,
                        #   embed builders, state management
package.json            # Node.js project config, dependencies
package-lock.json       # Pinned dependency versions (committed)
.env.example            # Configuration template with documentation
.gitignore              # Excludes node_modules/, .env, state.json
render.yaml             # Render.com Background Worker deployment config
get-discord-token.js    # LEGACY — Nakama token setup (not used by current bot)
setup-token.bat         # LEGACY — Windows wrapper for get-discord-token.js
start-bot.bat           # Windows convenience launcher
test/bot.test.js        # node:test suite — builders, parsing, error paths
state.json              # Runtime state — message IDs (gitignored, ephemeral)
AGENTS.md               # This file
CLAUDE.md               # Points here
```

## Build / Test / Run

### Install

```bash
npm install
```

### Run locally

```bash
cp .env.example .env
# Edit .env — set DISCORD_WEBHOOK_URL at minimum
node bot.js
```

### Run on Render

Push to GitHub. Connect repo as a Render Blueprint. Set `DISCORD_WEBHOOK_URL`
and optionally `DISCORD_BOT_TOKEN` in the Render dashboard. The
`render.yaml` handles the rest.

### Tests

```bash
npm test
```

`bot.js` only starts the bot when run directly, so its pure helpers can be
imported by tests. When extending the suite:
- Use the Node.js built-in test runner (`node:test`)
- Test error paths: API failures, malformed responses, state corruption
- Mock `fetch` and the Discord webhook client at the boundary
- Do not test Discord API behavior — test the bot's response to Discord
  API results

---

## Configuration

The bot reads configuration from environment variables (mapped from `.env`
in local dev, injected by Render in production).

| Variable | Required | Default | Description |
|---|---|---|---|
| `DISCORD_WEBHOOK_URL` | Yes | — | Webhook URL for the target channel |
| `DISCORD_BOT_TOKEN` | No | — | Bot token for auto-pinning, recovery, next-match reactions (Manage Messages, Add Reactions, Read Message History) |
| `POLL_INTERVAL_MS` | No | `10000` | Poll frequency in milliseconds (min `5000`) |
| `STATE_FILE` | No | `./state.json` | Path to the message ID persistence file |
| `FILTER_GUILD_ID` | No | — | Restrict embeds to one guild/group ID |
| `NAKAMA_URL` / `NAKAMA_HTTP_KEY` / `NAKAMA_USERNAME` / `NAKAMA_PASSWORD` | No | — | Bot's Nakama account (authenticated status path, next-match) |
| `NEXT_MATCH_ENABLED` | No | `true` | ⏭️ reactions set the reactor's next match; needs bot token + `NAKAMA_*` + Global Operator account |

### Note on environment variables

The current bot reads config from environment variables via `dotenv`. This
predates the ecosystem's config-from-files standard
([GENERIC-PROJECT-ADDENDUM.md](/srv/src/metis-core/GENERIC-PROJECT-ADDENDUM.md)).
The env-var pattern is acceptable here because (a) the Render deployment
platform injects config as environment variables, and (b) the bot has only
a handful of configuration values, all validated at startup. If the configuration
grows beyond this, migrate to a config file with env-var override as the
platform adaptation layer.

---

## Metis Ecosystem References

- [EXPERTISE-METIS-NATURE.md](/srv/src/metis-core/EXPERTISE-METIS-NATURE.md) — read first
- [GENERIC-PROJECT-ADDENDUM.md](/srv/src/metis-core/GENERIC-PROJECT-ADDENDUM.md) — engineering standards for non-core projects
- [WEB-ADDENDUM-GENERIC.md](/srv/src/metis-core/WEB-ADDENDUM-GENERIC.md) — JavaScript/TypeScript standards (applicable if the project grows)
