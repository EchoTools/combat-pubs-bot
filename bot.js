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

// ── Config ────────────────────────────────────────────────────────────────────

const NAKAMA_URL = (process.env.NAKAMA_URL || 'http://localhost:7350').replace(/\/$/, '');
const NAKAMA_HTTP_KEY = process.env.NAKAMA_HTTP_KEY || '';
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || ''; // optional — enables pinning
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '10000', 10);
const STATE_FILE = './state.json';
const FILTER_GUILD_ID = process.env.FILTER_GUILD_ID || '';
// Public status endpoint — no auth required, used for active match data
const STATUS_URL = 'https://g.echovrce.com/status/matches';

if (!DISCORD_WEBHOOK_URL) { console.error('[config] DISCORD_WEBHOOK_URL is required'); process.exit(1); }

// Parse webhook ID + token from URL (needed to resolve channel ID for pinning)
const _webhookParts = DISCORD_WEBHOOK_URL.match(/webhooks\/(\d+)\/([^/?]+)/);
const WEBHOOK_ID = _webhookParts?.[1] || '';
const WEBHOOK_TOKEN = _webhookParts?.[2] || '';

// ── Persistent state ──────────────────────────────────────────────────────────

/**
 * @type {{
 *   queueMessageId: string|null,
 *   matchMessages: Record<string, string>,  // fullMatchId -> discordMessageId
 *   token: string|null,
 *   refreshToken: string|null
 * }}
 */
let state = { queueMessageId: null, matchMessages: {}, token: null, refreshToken: null };

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

// Public endpoint — no auth required
async function fetchPublicStatus() {
    try {
        const res = await fetch(STATUS_URL);
        if (!res.ok) { console.error(`[status] HTTP ${res.status}`); return null; }
        return res.json().catch(() => null);
    } catch (e) { console.error('[status] Fetch error:', e.message); return null; }
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
    mpl_combat_gauss: 'Gauss',
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

function buildQueueEmbed(playerCount) {
    const embed = new EmbedBuilder()
        .setColor(COMBAT_RED)
        .setTitle('⚔️ Combat Queue')
        .setDescription(`# ${playerCount}\nplayer${playerCount === 1 ? '' : 's'} searching for a Combat match`)
        .setFooter({ text: 'Last updated' })
        .setTimestamp(new Date());
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

async function handleQueueMessage(playerCount) {
    if (playerCount === 0) {
        if (state.queueMessageId) {
            await deleteDiscordMessage(state.queueMessageId);
            state.queueMessageId = null;
            saveState();
        }
        return;
    }

    const embed = buildQueueEmbed(playerCount);
    try {
        if (state.queueMessageId) {
            await webhook.editMessage(state.queueMessageId, { embeds: [embed] });
        } else {
            const msg = await webhook.send({ embeds: [embed] });
            state.queueMessageId = msg.id;
            saveState();
            console.log('[discord] Posted queue message:', msg.id);
            await pinMessage(msg.id);
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

async function poll() {
    try {
        const statusData = await fetchPublicStatus();
        if (!statusData) return;

        // ── Queue count (from public status) ──────────────────────────────────
        const mmCounts = statusData.active_matchmaking_counts || {};
        let queueCount = 0;
        for (const groupCounts of Object.values(mmCounts)) {
            for (const [mode, count] of Object.entries(groupCounts)) {
                if (isCombat(mode)) queueCount += count;
            }
        }
        if (FILTER_GUILD_ID && mmCounts[FILTER_GUILD_ID]) {
            queueCount = 0;
            for (const [mode, count] of Object.entries(mmCounts[FILTER_GUILD_ID])) {
                if (isCombat(mode)) queueCount += count;
            }
        }
        if (queueCount !== lastPoll.tickets) {
            console.log(`[poll] Combat queue: ${queueCount}`);
            lastPoll.tickets = queueCount;
        }
        await handleQueueMessage(queueCount);

        // ── Active matches (public) ───────────────────────────────────────────
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
    }
}

// ── Startup cleanup ───────────────────────────────────────────────────────────

/**
 * Scan the channel for any webhook-owned "Combat Queue" embed messages that
 * the bot no longer tracks and delete them, preventing duplicate queue posts
 * after restarts.
 */
async function cleanupOrphanedQueueMessages() {
    if (!DISCORD_BOT_TOKEN || !channelId || !WEBHOOK_ID) return;
    try {
        const res = await fetch(
            `https://discord.com/api/v10/channels/${channelId}/messages?limit=50`,
            { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } }
        );
        if (!res.ok) return;
        const messages = await res.json().catch(() => []);
        for (const msg of messages) {
            if (
                msg.webhook_id === WEBHOOK_ID &&
                msg.embeds?.[0]?.title?.includes('Combat Queue') &&
                msg.id !== state.queueMessageId
            ) {
                console.log('[discord] Deleting orphaned queue message:', msg.id);
                await deleteDiscordMessage(msg.id);
            }
        }
    } catch (e) {
        console.warn('[discord] Could not clean up orphaned queue messages:', e.message);
    }
}

// ── Startup ───────────────────────────────────────────────────────────────────

console.log(`[bot] Combat Pubs Bot starting…`);
console.log(`[bot] Matches + queue: ${STATUS_URL} (no auth required)`);
console.log(`[bot] Poll interval: ${POLL_INTERVAL_MS}ms`);
console.log(`[bot] Pinning: ${DISCORD_BOT_TOKEN ? 'enabled' : 'disabled (set DISCORD_BOT_TOKEN to enable)'}`);

loadState();
fetchChannelId().then(async () => {
    await cleanupOrphanedQueueMessages();
    poll();
    setInterval(poll, POLL_INTERVAL_MS);
});
