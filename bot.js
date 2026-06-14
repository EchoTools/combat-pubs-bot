/**
 * Combat Pubs Discord Bot
 *
 * Polls the Nakama matchmaker and active match endpoints, then posts/edits
 * pinned Discord embeds showing:
 *   - Who is currently queued for Combat
 *   - One pinned message per active Combat match (supports multiple games)
 *
 * Uses a Discord webhook for posting/editing.
 * An optional DISCORD_BOT_TOKEN enables automatic pinning.
 * Message IDs are persisted to state.json so edits survive restarts.
 */

import 'dotenv/config';
import { WebhookClient, EmbedBuilder } from 'discord.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { NakamaSession } from './nakama-auth.js';

// ── Config ────────────────────────────────────────────────────────────────────

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || ''; // optional — enables pinning
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '10000', 10);
const STATE_FILE = process.env.STATE_FILE || './state.json';
const FILTER_GUILD_ID = process.env.FILTER_GUILD_ID || '';
// Public status endpoint — no auth required, fallback when Nakama auth is unavailable
const STATUS_URL = 'https://g.echovrce.com/status/matches';

// Nakama authentication (optional — enables authenticated API access)
const NAKAMA_URL = process.env.NAKAMA_URL || '';
const NAKAMA_HTTP_KEY = process.env.NAKAMA_HTTP_KEY || '';
const NAKAMA_USERNAME = process.env.NAKAMA_USERNAME || '';
const NAKAMA_PASSWORD = process.env.NAKAMA_PASSWORD || '';

if (!DISCORD_WEBHOOK_URL) { console.error('[config] DISCORD_WEBHOOK_URL is required'); process.exit(1); }

// Parse webhook ID + token from URL (needed to resolve channel ID for pinning)
const _webhookParts = DISCORD_WEBHOOK_URL.match(/webhooks\/(\d+)\/([^/?]+)/);
const WEBHOOK_ID = _webhookParts?.[1] || '';
const WEBHOOK_TOKEN = _webhookParts?.[2] || '';

// ── Persistent state ──────────────────────────────────────────────────────────

/**
 * @type {{
 *   queueMessageId: string|null,
 *   matchMessages: Record<string, string>,
 *   nakamaToken: string|null,
 *   nakamaRefreshToken: string|null
 * }}
 */
let state = { queueMessageId: null, matchMessages: {}, nakamaToken: null, nakamaRefreshToken: null };

function loadState() {
    try {
        if (existsSync(STATE_FILE)) {
            const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
            state = { ...state, ...saved };
            // Migrate legacy single matchMessageId to new map
            if (state.matchMessageId) {
                console.log('[state] Migrating legacy matchMessageId — deleting old message');
                deleteDiscordMessage(state.matchMessageId).catch(() => { });
                delete state.matchMessageId;
            }
            if (!state.matchMessages) state.matchMessages = {};
            console.log('[state] Loaded state from state.json');
        }
    } catch (e) {
        console.warn('[state] Failed to load state.json, starting fresh:', e.message);
    }
    if (!state.matchMessages) state.matchMessages = {};
}

function saveState() {
    try {
        writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (e) {
        console.warn('[state] Failed to save state.json:', e.message);
    }
}

// ── Nakama session ───────────────────────────────────────────────────────────

/** @type {NakamaSession|null} */
let nakamaSession = null;
let authDisabledPermanently = false;

function disableAuthPermanently(reason) {
    authDisabledPermanently = true;
    nakamaSession = null;
    console.warn(`[nakama] Auth permanently disabled: ${reason}`);
}

function initNakamaSession() {
    if (!NAKAMA_URL || !NAKAMA_HTTP_KEY || !NAKAMA_USERNAME || !NAKAMA_PASSWORD) {
        console.log('[nakama] Auth not configured — using public status endpoint only');
        return;
    }

    nakamaSession = new NakamaSession({
        nakamaUrl: NAKAMA_URL,
        httpKey: NAKAMA_HTTP_KEY,
        username: NAKAMA_USERNAME,
        password: NAKAMA_PASSWORD,
        onTokensChanged({ token, refreshToken }) {
            // Persist tokens alongside message IDs so they survive restarts
            state.nakamaToken = token;
            state.nakamaRefreshToken = refreshToken;
            saveState();
        },
    });

    // Restore tokens from previous session (avoids re-auth on restart)
    if (state.nakamaToken || state.nakamaRefreshToken) {
        nakamaSession.restoreTokens(state.nakamaToken, state.nakamaRefreshToken);
        console.log('[nakama] Restored session tokens from state.json');
    }
}

// ── Discord client + pinning ──────────────────────────────────────────────────

const webhook = new WebhookClient({ url: DISCORD_WEBHOOK_URL });
let channelId = null;

async function fetchChannelId() {
    if (!WEBHOOK_ID || !WEBHOOK_TOKEN) return;
    try {
        const res = await fetch(`https://discord.com/api/v10/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`);
        const data = await res.json().catch(() => ({}));
        channelId = data.channel_id || null;
        if (channelId) console.log(`[discord] Channel ID resolved: ${channelId}`);
    } catch (e) {
        console.warn('[discord] Could not resolve channel ID:', e.message);
    }
}

async function pinMessage(messageId) {
    if (!DISCORD_BOT_TOKEN || !channelId || !messageId) return;
    try {
        const res = await fetch(
            `https://discord.com/api/v10/channels/${channelId}/pins/${messageId}`,
            { method: 'PUT', headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } }
        );
        if (res.ok || res.status === 204) {
            console.log('[discord] Pinned message:', messageId);
            // Small delay so the system notification has time to appear
            await new Promise((r) => setTimeout(r, 1000));
            await deletePinSystemMessage();
        } else {
            const text = await res.text().catch(() => '');
            console.warn(`[discord] Could not pin ${messageId}:`, res.status, text);
        }
    } catch (e) {
        console.warn('[discord] Pin error:', e.message);
    }
}

async function deletePinSystemMessage() {
    if (!DISCORD_BOT_TOKEN || !channelId) return;
    try {
        const res = await fetch(
            `https://discord.com/api/v10/channels/${channelId}/messages?limit=5`,
            { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } }
        );
        if (!res.ok) return;
        const messages = await res.json().catch(() => []);
        // Type 6 = channel pinned message system notification
        const sysMsg = messages.find((m) => m.type === 6);
        if (!sysMsg) return;
        await fetch(
            `https://discord.com/api/v10/channels/${channelId}/messages/${sysMsg.id}`,
            { method: 'DELETE', headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } }
        );
        console.log('[discord] Deleted pin system message:', sysMsg.id);
    } catch (e) {
        console.warn('[discord] Could not delete pin system message:', e.message);
    }
}

async function unpinMessage(messageId) {
    if (!DISCORD_BOT_TOKEN || !channelId || !messageId) return;
    try {
        await fetch(
            `https://discord.com/api/v10/channels/${channelId}/pins/${messageId}`,
            { method: 'DELETE', headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } }
        );
    } catch (_) { }
}

async function deleteDiscordMessage(messageId) {
    if (!messageId) return;
    try {
        await unpinMessage(messageId);
        await webhook.deleteMessage(messageId);
        console.log('[discord] Deleted message:', messageId);
    } catch (e) {
        if (e.code !== 10008 && !String(e.message).includes('Unknown Message')) {
            console.warn('[discord] Could not delete message:', e.message);
        }
    }
}

// ── Nakama API ────────────────────────────────────────────────────────────────

/**
 * Fetch match status via authenticated Nakama RPC.
 * Uses the match/public RPC which returns the same data as the public status
 * endpoint but through the authenticated API path.
 */
async function fetchAuthenticatedStatus() {
    if (!nakamaSession || authDisabledPermanently) return null;
    try {
        const data = await nakamaSession.callRpc('match/public');
        return data;
    } catch (e) {
        const message = e.message || 'authenticated fetch failed';
        if (/HTTP 401/.test(message)) {
            disableAuthPermanently(message);
        } else {
            console.error('[status] Authenticated fetch failed:', message);
            disableAuthPermanently(message);
        }
        return null;
    }
}

/**
 * Fetch matchmaker ticket data via authenticated RPC.
 * Returns an array of combat tickets, or null if unavailable.
 */
async function fetchMatchmakerTickets() {
    if (!nakamaSession) return null;
    try {
        const data = await nakamaSession.callRpc('matchmaker/state', {});
        const tickets = Array.isArray(data?.index) ? data.index : [];
        return tickets.filter((t) => isCombat(t?.StringProperties?.game_mode));
    } catch (e) {
        // Non-fatal — queue embed falls back to count-only
        return null;
    }
}

/** Public endpoint — no auth required, used as fallback */
async function fetchPublicStatus() {
    try {
        const res = await fetch(STATUS_URL);
        if (!res.ok) { console.error(`[status] HTTP ${res.status}`); return null; }
        return res.json().catch(() => null);
    } catch (e) { console.error('[status] Fetch error:', e.message); return null; }
}

/**
 * Fetch status data. Prefers authenticated API when available,
 * falls back to public endpoint on failure or when auth is not configured.
 */
async function fetchStatus() {
    if (authDisabledPermanently) {
        return {
            statusData: await fetchPublicStatus(),
            usedAuthenticatedPath: false,
        };
    }

    if (nakamaSession) {
        const data = await fetchAuthenticatedStatus();
        if (data) {
            return { statusData: data, usedAuthenticatedPath: true };
        }
        console.warn('[status] Falling back to public endpoint');
    }

    return {
        statusData: await fetchPublicStatus(),
        usedAuthenticatedPath: false,
    };
}



// ── Data helpers ──────────────────────────────────────────────────────────────

function isCombat(modeStr) {
    return String(modeStr || '').toLowerCase().includes('combat');
}

function normalizeTeam(player) {
    const t = player?.team ?? player?.team_id ?? player?.teamId ?? player?.role ?? null;
    if (typeof t === 'string') return t.toLowerCase();
    if (typeof t === 'number') {
        switch (t) {
            case 0: return 'blue';
            case 1: return 'orange';
            case 2: return 'spectator';
            default: return 'other';
        }
    }
    return 'other';
}

function playerName(p) {
    return p?.display_name || p?.displayName || p?.username || p?.user_id?.slice(0, 8) || 'Unknown';
}

function toFinite(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

const MAP_NAMES = {
    mpl_combat_fission: 'Fission',
    mpl_combat_combustion: 'Combustion',
    mpl_combat_dyson: 'Dyson',
    mpl_combat_gauss: 'Surge',
    mpl_combat_rise: 'Rise',
    mpl_combat_archaic: 'Archaic',
    mpl_combat_harvest: 'Harvest',
};

function formatMapName(level) {
    if (!level) return null;
    return MAP_NAMES[level] || level.replace(/^mpl_combat_/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Embed builders ────────────────────────────────────────────────────────────

const COMBAT_RED = 0xdc2626;
const COMBAT_ORANGE = 0xf97316;
const MATCH_BLUE = 0x3b82f6;

function formatWaitTime(createdAtNs) {
    if (!createdAtNs) return '';
    const secs = Math.floor((Date.now() - createdAtNs / 1e6) / 1000);
    if (secs < 0) return '';
    if (secs < 60) return `${secs}s`;
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}m ${s}s`;
}

/**
 * @param {number} playerCount
 * @param {Array|null} tickets - authenticated ticket data, or null for count-only mode
 */
function buildQueueEmbed(playerCount, tickets = null) {
    const embed = new EmbedBuilder()
        .setColor(COMBAT_RED)
        .setTitle('⚔️ Combat Queue')
        .setFooter({ text: 'Last updated' })
        .setTimestamp(new Date());

    if (tickets && tickets.length > 0) {
        embed.setDescription(`# ${playerCount}\nplayer${playerCount === 1 ? '' : 's'} searching for a Combat match`);
        const lines = tickets.map((t) => {
            const name = t?.StringProperties?.display_name
                || t?.Presences?.[0]?.username
                || 'Unknown';
            const wait = formatWaitTime(t?.CreatedAt);
            const partySize = t?.Presences?.length || 1;
            const partyStr = partySize > 1 ? ` (+${partySize - 1})` : '';
            return wait ? `• **${name}**${partyStr} — ${wait}` : `• **${name}**${partyStr}`;
        }).join('\n');
        embed.addFields({ name: 'Searching', value: lines.slice(0, 1024) || '—', inline: false });
    } else {
        embed.setDescription(`# ${playerCount}\nplayer${playerCount === 1 ? '' : 's'} searching for a Combat match`);
    }

    return embed;
}

function buildMatchEmbed(game) {
    const label = game.label;

    const players = Array.isArray(label?.players) ? label.players : [];
    const blueTeam = players.filter((p) => normalizeTeam(p) === 'blue');
    const orangeTeam = players.filter((p) => normalizeTeam(p) === 'orange');
    const spectators = players.filter((p) => ['spectator', 'other'].includes(normalizeTeam(p)));

    const fullMatchId = game.match_id || '';
    const matchUuid = fullMatchId.split('.')[0] || fullMatchId;
    const matchIdShort = matchUuid.slice(0, 8) || '?';
    const taxiUrl = matchUuid ? `https://echo.taxi/spark://c/${matchUuid}` : null;

    const embed = new EmbedBuilder()
        .setColor(COMBAT_RED)
        .setTitle('🎮 Active Combat Match')
        .setFooter({ text: `Match ${matchIdShort} · Last updated` })
        .setTimestamp(new Date());

    const gs = label?.game_state;
    const infoLines = [`**Players:** ${label?.player_count || players.length} / ${label?.player_limit || '?'}`];
    if (gs?.session_scoreboard?.game_time_ns != null) {
        const secs = Math.floor(gs.session_scoreboard.game_time_ns / 1_000_000_000);
        const m = Math.floor(Math.abs(secs) / 60);
        const s = Math.abs(secs) % 60;
        const timeStr = `${m}:${String(s).padStart(2, '0')}`;
        infoLines.push(`**Time:** ${secs < 0 ? `Starting in ${timeStr}` : timeStr}`);
    }
    if (label?.open != null) infoLines.push(`**Lobby:** ${label.open ? '🟢 Open' : '🔴 Closed'}`);
    const mapName = formatMapName(label?.level);
    if (mapName) infoLines.push(`**Map:** ${mapName}`);
    const region = label?.broadcaster?.region;
    if (region) infoLines.push(`**Region:** ${region}`);

    // Add payload fields if available (distance, checkpoint, scores)
    const payload = label?.payload;
    if (payload != null) {
        const payloadLines = [];
        if (payload.distance != null) payloadLines.push(`**Distance:** ${payload.distance.toFixed(2)}`);
        if (payload.checkpoint != null) payloadLines.push(`**Checkpoint:** ${payload.checkpoint}`);

        // Capture Point scores
        if (payload.blue_points != null || payload.orange_points != null) {
            const blueScore = payload.blue_points ?? 0;
            const orangeScore = payload.orange_points ?? 0;
            const round = (payload.total_round_count ?? 0) + 1;
            payloadLines.push(`**Score:** 🔵 ${blueScore} - 🟠 ${orangeScore} (Round ${round})`);
        }

        if (payloadLines.length > 0) {
            infoLines.push(payloadLines.join('\n'));
        }
    }

    embed.addFields({ name: 'Match Info', value: infoLines.join('\n'), inline: false });

    if (blueTeam.length > 0) embed.addFields({
        name: `🔵 Blue Team (${blueTeam.length})`,
        value: blueTeam.map((p) => `• ${playerName(p)}`).join('\n').slice(0, 1024) || '—',
        inline: true,
    });
    if (orangeTeam.length > 0) embed.addFields({
        name: `🟠 Orange Team (${orangeTeam.length})`,
        value: orangeTeam.map((p) => `• ${playerName(p)}`).join('\n').slice(0, 1024) || '—',
        inline: true,
    });
    if (spectators.length > 0) embed.addFields({
        name: `👁 Spectators (${spectators.length})`,
        value: spectators.map((p) => `• ${playerName(p)}`).join('\n').slice(0, 1024) || '—',
        inline: false,
    });

    return { embed, taxiUrl, fullMatchId };
}

// ── Discord message management ────────────────────────────────────────────────

// Guard against concurrent queue message posts
let queuePostInProgress = false;

async function handleQueueMessage(playerCount, tickets = null) {
    if (playerCount === 0) {
        if (state.queueMessageId) {
            await deleteDiscordMessage(state.queueMessageId);
            state.queueMessageId = null;
            saveState();
        }
        return;
    }

    const embed = buildQueueEmbed(playerCount, tickets);
    try {
        if (state.queueMessageId) {
            await webhook.editMessage(state.queueMessageId, { embeds: [embed] });
        } else {
            if (queuePostInProgress) return; // another poll is already posting
            queuePostInProgress = true;
            try {
                const msg = await webhook.send({ embeds: [embed] });
                state.queueMessageId = msg.id;
                saveState();
                console.log('[discord] Posted queue message:', msg.id);
                await pinMessage(msg.id);
            } finally {
                queuePostInProgress = false;
            }
        }
    } catch (e) {
        if (e.code === 10008 || String(e.message).includes('Unknown Message')) {
            console.warn('[discord] Queue message deleted externally, will re-post next poll.');
            state.queueMessageId = null;
            saveState();
        } else {
            console.error('[discord] Queue embed error:', e.message);
        }
    }
}

async function handleAllMatchMessages(activeResults) {
    const activeIds = new Set(activeResults.map((r) => r.fullMatchId));

    // Delete messages for games that ended
    for (const [matchId, msgId] of Object.entries(state.matchMessages)) {
        if (!activeIds.has(matchId)) {
            await deleteDiscordMessage(msgId);
            delete state.matchMessages[matchId];
            saveState();
        }
    }

    // Post or edit a message for each active game
    for (const { embed, taxiUrl, fullMatchId } of activeResults) {
        const content = taxiUrl ? `🚕 **Join:** ${taxiUrl}` : '';
        const existingMsgId = state.matchMessages[fullMatchId];
        try {
            if (existingMsgId) {
                await webhook.editMessage(existingMsgId, { content, embeds: [embed] });
            } else {
                const msg = await webhook.send({ content, embeds: [embed] });
                state.matchMessages[fullMatchId] = msg.id;
                saveState();
                console.log(`[discord] Posted match message for ${fullMatchId.slice(0, 8)}:`, msg.id);
                await pinMessage(msg.id);
            }
        } catch (e) {
            if (e.code === 10008 || String(e.message).includes('Unknown Message')) {
                console.warn(`[discord] Match message for ${fullMatchId.slice(0, 8)} deleted externally, will re-post next poll.`);
                delete state.matchMessages[fullMatchId];
                saveState();
            } else {
                console.error(`[discord] Match embed error for ${fullMatchId.slice(0, 8)}:`, e.message);
            }
        }
    }
}

// ── Main poll loop ────────────────────────────────────────────────────────────

const lastPoll = { tickets: -1, games: -1 };
let pollRunning = false;

async function poll() {
    if (pollRunning) return; // skip if previous poll hasn't finished
    pollRunning = true;
    try {
        const { statusData, usedAuthenticatedPath } = await fetchStatus();
        if (!statusData) return;

        // ── Queue count ───────────────────────────────────────────────────────
        const mmCounts = statusData.active_matchmaking_counts || {};
        let queueCount = 0;
        const source = (FILTER_GUILD_ID && mmCounts[FILTER_GUILD_ID]) ? mmCounts[FILTER_GUILD_ID] : null;
        if (source) {
            for (const [mode, count] of Object.entries(source)) {
                if (isCombat(mode)) queueCount += count;
            }
        } else {
            for (const groupCounts of Object.values(mmCounts)) {
                for (const [mode, count] of Object.entries(groupCounts)) {
                    if (isCombat(mode)) queueCount += count;
                }
            }
        }

        if (queueCount !== lastPoll.tickets) {
            console.log(`[poll] Combat queue: ${queueCount}`);
            lastPoll.tickets = queueCount;
        }
        const tickets = (usedAuthenticatedPath && queueCount > 0)
            ? await fetchMatchmakerTickets()
            : null;
        await handleQueueMessage(queueCount, tickets);

        // ── Active matches ────────────────────────────────────────────────────
        if (statusData?.labels) {
            let combatGames = statusData.labels
                .filter((label) =>
                    isCombat(label.mode) &&
                    label.lobby_type !== 'private' &&
                    !String(label.mode || '').toLowerCase().includes('private') &&
                    (label.player_count || label.players?.length || 0) > 0 &&
                    (!FILTER_GUILD_ID || label.group_id === FILTER_GUILD_ID)
                )
                .map((label) => ({ match_id: label.id, label }));

            if (combatGames.length !== lastPoll.games) {
                console.log(`[poll] Active combat games: ${combatGames.length}`);
                lastPoll.games = combatGames.length;
            }
            await handleAllMatchMessages(combatGames.map((g) => buildMatchEmbed(g)));
        }
    } catch (e) {
        console.error('[poll] Unhandled error:', e.message);
    } finally {
        pollRunning = false;
    }
}

// ── Startup cleanup ───────────────────────────────────────────────────────────

/**
 * On startup, scan the channel for any existing Combat Queue embeds posted by
 * this webhook. If exactly one is found, adopt its ID so the bot edits it going
 * forward instead of posting a new one. If multiple exist (e.g. from a previous
 * double-post), delete the extras and keep the newest. This means the bot
 * recovers cleanly even when state.json is wiped (e.g. Render ephemeral disk).
 */
async function recoverQueueMessageId() {
    if (!DISCORD_BOT_TOKEN || !channelId || !WEBHOOK_ID) return;
    try {
        const res = await fetch(
            `https://discord.com/api/v10/channels/${channelId}/messages?limit=50`,
            { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } }
        );
        if (!res.ok) return;
        const messages = await res.json().catch(() => []);
        const queueMsgs = messages.filter((msg) =>
            msg.webhook_id === WEBHOOK_ID &&
            msg.embeds?.[0]?.title?.includes('Combat Queue')
        );
        if (queueMsgs.length === 0) {
            state.queueMessageId = null;
        } else {
            // Sort newest first (Discord snowflake IDs are chronological)
            queueMsgs.sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
            // Delete duplicates, keep the newest
            for (const msg of queueMsgs.slice(1)) {
                console.log('[discord] Deleting duplicate queue message:', msg.id);
                await deleteDiscordMessage(msg.id);
            }
            state.queueMessageId = queueMsgs[0].id;
            console.log('[discord] Adopted existing queue message:', queueMsgs[0].id);
        }
        saveState();
    } catch (e) {
        console.warn('[discord] Could not recover queue message ID:', e.message);
    }
}

// ── Startup ───────────────────────────────────────────────────────────────────

console.log(`[bot] Combat Pubs Bot starting…`);
const nakamaConfigured = NAKAMA_URL && NAKAMA_HTTP_KEY && NAKAMA_USERNAME && NAKAMA_PASSWORD;
console.log(`[bot] Status: ${nakamaConfigured ? `${NAKAMA_URL} (authenticated)` : `${STATUS_URL} (public)`}`);
console.log(`[bot] Poll interval: ${POLL_INTERVAL_MS}ms`);
console.log(`[bot] Pinning: ${DISCORD_BOT_TOKEN ? 'enabled' : 'disabled (set DISCORD_BOT_TOKEN to enable)'}`);

loadState();
initNakamaSession();

fetchChannelId().then(async () => {
    // Establish Nakama session before first poll (if configured)
    if (nakamaSession) {
        if (state.nakamaToken || state.nakamaRefreshToken) {
            console.log('[bot] Nakama session ready (restored from state.json)');
        } else {
            try {
                await nakamaSession.ensureSession();
                console.log('[bot] Nakama session established');
            } catch (e) {
                disableAuthPermanently(e.message || 'initial authentication failed');
                console.warn('[bot] Could not establish Nakama session, falling back to public endpoint');
            }
        }
    }

    await recoverQueueMessageId();
    poll();
    setInterval(poll, POLL_INTERVAL_MS);
});
