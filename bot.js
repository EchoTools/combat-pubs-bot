/**
 * Combat Pubs Discord Bot
 *
 * Polls the EchoVRCE match status endpoint every POLL_INTERVAL_MS (default
 * 10s) and posts/edits Discord Components V2 messages showing:
 *   - How many players are currently queued for Combat
 *   - One pinned message per active public Combat match
 *
 * Uses a Discord webhook for posting/editing (with_components=true, so the
 * non-interactive V2 components — containers, sections, text displays,
 * separators — are allowed on a plain channel webhook).
 * An optional DISCORD_BOT_TOKEN enables automatic pinning and startup
 * recovery. Message IDs are persisted to state.json so edits survive restarts.
 */

import 'dotenv/config';
import {
    WebhookClient,
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    MessageFlags,
    escapeMarkdown,
} from 'discord.js';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { pathToFileURL } from 'url';
import { NakamaSession } from './nakama-auth.js';

// ── Config ────────────────────────────────────────────────────────────────────

const DEFAULT_POLL_INTERVAL_MS = 10_000;
const MIN_POLL_INTERVAL_MS = 5_000; // below this the per-message edit rate limits bite

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || ''; // optional — enables pinning
const POLL_INTERVAL_MS = parsePollInterval(process.env.POLL_INTERVAL_MS);
const STATE_FILE = process.env.STATE_FILE || './state.json';
const FILTER_GUILD_ID = process.env.FILTER_GUILD_ID || '';
// Public status endpoint — no auth required, fallback when Nakama auth is unavailable
const STATUS_URL = 'https://g.echovrce.com/status/matches';

// Nakama authentication (optional — enables authenticated API access)
const NAKAMA_URL = process.env.NAKAMA_URL || '';
const NAKAMA_HTTP_KEY = process.env.NAKAMA_HTTP_KEY || '';
const NAKAMA_USERNAME = process.env.NAKAMA_USERNAME || '';
const NAKAMA_PASSWORD = process.env.NAKAMA_PASSWORD || '';

// Any single HTTP call that takes longer than this is abandoned, so one hung
// request can never freeze the poll loop (Node's fetch has no default timeout).
const HTTP_TIMEOUT_MS = 8_000;
// Unchanged messages are still re-edited this often so "updated …" stays fresh.
const HEARTBEAT_MS = 60_000;

// Parse webhook ID + token from URL (needed to resolve channel ID for pinning)
const _webhookParts = DISCORD_WEBHOOK_URL.match(/webhooks\/(\d+)\/([^/?]+)/);
const WEBHOOK_ID = _webhookParts?.[1] || '';
const WEBHOOK_TOKEN = _webhookParts?.[2] || '';

export function parsePollInterval(raw) {
    if (raw == null || raw === '') return DEFAULT_POLL_INTERVAL_MS;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) {
        console.warn(`[config] Invalid POLL_INTERVAL_MS "${raw}", using ${DEFAULT_POLL_INTERVAL_MS}`);
        return DEFAULT_POLL_INTERVAL_MS;
    }
    if (n < MIN_POLL_INTERVAL_MS) {
        console.warn(`[config] POLL_INTERVAL_MS ${n} is below ${MIN_POLL_INTERVAL_MS}, clamping`);
        return MIN_POLL_INTERVAL_MS;
    }
    return n;
}

// ── Persistent state ──────────────────────────────────────────────────────────

/**
 * State format history:
 *   1 (implicit, no `format` key) — legacy embed messages
 *   2 — Components V2 messages
 * Legacy embed messages cannot be reliably converted in place, so on upgrade
 * they are deleted once and re-posted in the new format.
 */
const STATE_FORMAT = 2;

function defaultState() {
    return {
        format: STATE_FORMAT,
        queueMessageId: null,
        matchMessages: {},
        nakamaToken: null,
        nakamaRefreshToken: null,
    };
}

/**
 * @type {{
 *   format: number,
 *   queueMessageId: string|null,
 *   matchMessages: Record<string, string>,
 *   nakamaToken: string|null,
 *   nakamaRefreshToken: string|null
 * }}
 */
let state = defaultState();

const isSnowflake = (v) => typeof v === 'string' && /^\d{5,25}$/.test(v);
const isStringOrNull = (v) => v == null || typeof v === 'string';

/**
 * Parse and sanitise raw state.json contents. Pure — never throws.
 * @returns {{ state: ReturnType<typeof defaultState>, legacyMessageIds: string[], error: string|null }}
 */
export function parseState(raw) {
    const fresh = defaultState();
    let saved;
    try {
        saved = JSON.parse(raw);
    } catch (e) {
        return { state: fresh, legacyMessageIds: [], error: `invalid JSON (${e.message})` };
    }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
        return { state: fresh, legacyMessageIds: [], error: 'not a JSON object' };
    }

    const next = { ...fresh };
    if (isStringOrNull(saved.nakamaToken)) next.nakamaToken = saved.nakamaToken ?? null;
    if (isStringOrNull(saved.nakamaRefreshToken)) next.nakamaRefreshToken = saved.nakamaRefreshToken ?? null;

    const queueId = isSnowflake(saved.queueMessageId) ? saved.queueMessageId : null;
    const matchMessages = {};
    if (saved.matchMessages && typeof saved.matchMessages === 'object' && !Array.isArray(saved.matchMessages)) {
        for (const [matchId, msgId] of Object.entries(saved.matchMessages)) {
            if (matchId && isSnowflake(msgId)) matchMessages[matchId] = msgId;
        }
    }

    if (saved.format !== STATE_FORMAT) {
        // Legacy embed messages: delete them, re-post as Components V2.
        const legacyMessageIds = [queueId, ...Object.values(matchMessages)];
        if (isSnowflake(saved.matchMessageId)) legacyMessageIds.push(saved.matchMessageId);
        return { state: next, legacyMessageIds: legacyMessageIds.filter(Boolean), error: null };
    }

    next.queueMessageId = queueId;
    next.matchMessages = matchMessages;
    return { state: next, legacyMessageIds: [], error: null };
}

/** @returns {string[]} legacy message IDs that should be deleted */
function loadState() {
    if (!existsSync(STATE_FILE)) return [];
    let raw;
    try {
        raw = readFileSync(STATE_FILE, 'utf8');
    } catch (e) {
        console.warn('[state] Failed to read state file, starting fresh:', e.message);
        return [];
    }
    const parsed = parseState(raw);
    state = parsed.state;
    if (parsed.error) {
        console.warn(`[state] State file is corrupt (${parsed.error}), starting fresh`);
    } else if (parsed.legacyMessageIds.length) {
        console.log(`[state] Upgrading to Components V2 — replacing ${parsed.legacyMessageIds.length} legacy message(s)`);
    } else {
        console.log('[state] Loaded state file');
    }
    return parsed.legacyMessageIds;
}

function saveState() {
    // Write-then-rename so a crash mid-write can't leave a truncated state file.
    const tmp = `${STATE_FILE}.tmp`;
    try {
        writeFileSync(tmp, JSON.stringify(state, null, 2));
        renameSync(tmp, STATE_FILE);
    } catch (e) {
        console.warn('[state] Failed to save state file:', e.message);
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
        console.log('[nakama] Restored session tokens from state file');
    }
}

// ── Discord client + pinning ──────────────────────────────────────────────────

/** @type {WebhookClient|null} */
let webhook = null;
let channelId = null;

const timeoutSignal = () => AbortSignal.timeout(HTTP_TIMEOUT_MS);
const botHeaders = () => ({ Authorization: `Bot ${DISCORD_BOT_TOKEN}` });

const isUnknownMessage = (e) => e?.code === 10008 || String(e?.message).includes('Unknown Message');
const isUnknownWebhook = (e) => e?.code === 10015 || String(e?.message).includes('Unknown Webhook');

function logDiscordError(context, e) {
    if (isUnknownWebhook(e)) {
        console.error(`[discord] ${context}: the webhook no longer exists — create a new one and update DISCORD_WEBHOOK_URL`);
    } else {
        // e.message only — DiscordAPIError#url contains the webhook token
        console.error(`[discord] ${context}:`, e?.message || e);
    }
}

async function fetchChannelId() {
    if (!WEBHOOK_ID || !WEBHOOK_TOKEN) return;
    try {
        const res = await fetch(`https://discord.com/api/v10/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`, { signal: timeoutSignal() });
        if (!res.ok) {
            console.warn(`[discord] Could not resolve channel ID: HTTP ${res.status}`);
            return;
        }
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
            { method: 'PUT', headers: botHeaders(), signal: timeoutSignal() }
        );
        if (res.ok) {
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
            { headers: botHeaders(), signal: timeoutSignal() }
        );
        if (!res.ok) return;
        const messages = await res.json().catch(() => []);
        if (!Array.isArray(messages)) return;
        // Type 6 = channel pinned message system notification
        const sysMsg = messages.find((m) => m?.type === 6);
        if (!sysMsg) return;
        await fetch(
            `https://discord.com/api/v10/channels/${channelId}/messages/${sysMsg.id}`,
            { method: 'DELETE', headers: botHeaders(), signal: timeoutSignal() }
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
            { method: 'DELETE', headers: botHeaders(), signal: timeoutSignal() }
        );
    } catch (_) { }
}

async function deleteDiscordMessage(messageId) {
    if (!messageId || !webhook) return;
    lastRender.delete(messageId);
    try {
        await unpinMessage(messageId);
        await webhook.deleteMessage(messageId);
        console.log('[discord] Deleted message:', messageId);
    } catch (e) {
        if (!isUnknownMessage(e)) logDiscordError(`Could not delete message ${messageId}`, e);
    }
}

// ── Status API ────────────────────────────────────────────────────────────────

/**
 * Fetch match status via authenticated Nakama RPC.
 * Uses the match/public RPC which returns the same data as the public status
 * endpoint but through the authenticated API path.
 */
async function fetchAuthenticatedStatus() {
    if (!nakamaSession || authDisabledPermanently) return null;
    try {
        return await nakamaSession.callRpc('match/public');
    } catch (e) {
        const message = e.message || 'authenticated fetch failed';
        if (!/HTTP 401/.test(message)) console.error('[status] Authenticated fetch failed:', message);
        disableAuthPermanently(message);
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
        // Non-fatal — queue message falls back to count-only
        return null;
    }
}

/** Public endpoint — no auth required, used as fallback */
async function fetchPublicStatus() {
    try {
        const res = await fetch(STATUS_URL, {
            signal: timeoutSignal(),
            headers: { 'Cache-Control': 'no-cache', Accept: 'application/json' },
        });
        if (!res.ok) { console.error(`[status] HTTP ${res.status}`); return null; }
        return await res.json();
    } catch (e) {
        console.error('[status] Fetch error:', e.name === 'TimeoutError' ? `timed out after ${HTTP_TIMEOUT_MS}ms` : e.message);
        return null;
    }
}

/**
 * Fetch status data. Prefers authenticated API when available,
 * falls back to public endpoint on failure or when auth is not configured.
 */
async function fetchStatus() {
    if (nakamaSession && !authDisabledPermanently) {
        const data = await fetchAuthenticatedStatus();
        if (data) return { statusData: data, usedAuthenticatedPath: true };
        console.warn('[status] Falling back to public endpoint');
    }
    return { statusData: await fetchPublicStatus(), usedAuthenticatedPath: false };
}

/** A status payload must at least be an object; anything else is treated as a failed fetch. */
export function isValidStatus(data) {
    return !!data && typeof data === 'object' && !Array.isArray(data);
}

/**
 * The status endpoint carries its own snapshot time (`update_time`). If a poll
 * returns a snapshot older than one we've already rendered (e.g. switching
 * between the authenticated and public paths, or a lagging backend node), it
 * must be ignored — otherwise the messages briefly roll back to old data.
 */
export function isStaleSnapshot(updateTime, lastSeenMs) {
    const t = Date.parse(updateTime);
    if (!Number.isFinite(t) || lastSeenMs == null) return false;
    return t < lastSeenMs;
}

// ── Data helpers ──────────────────────────────────────────────────────────────

export function isCombat(modeStr) {
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

function toFinite(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/** Display name, markdown-escaped so names like `*x*` or `a_b_c` render literally. */
export function safePlayerName(p) {
    const raw = p?.display_name || p?.displayName || p?.username
        || (typeof p?.user_id === 'string' ? p.user_id.slice(0, 8) : '') || 'Unknown';
    return escapeMarkdown(String(raw).replace(/\s+/g, ' ').trim().slice(0, 32)) || 'Unknown';
}

const MAP_NAMES = {
    mpl_combat_fission: 'Fission',
    mpl_combat_combustion: 'Combustion',
    mpl_combat_dyson: 'Dyson',
    mpl_combat_gauss: 'Surge',
    mpl_combat_rise: 'Rise',
    mpl_combat_archaic: 'Archaic',
    mpl_combat_harvest: 'Harvest',
};

export function formatMapName(level) {
    if (!level || typeof level !== 'string') return null;
    return MAP_NAMES[level] || level.replace(/^mpl_combat_/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function flagEmoji(countryCode) {
    if (typeof countryCode !== 'string' || !/^[A-Za-z]{2}$/.test(countryCode)) return '';
    return String.fromCodePoint(...[...countryCode.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/** Discord timestamp markup — rendered and kept ticking by each viewer's client. */
const discordTime = (ms, style = 'R') => `<t:${Math.floor(ms / 1000)}:${style}>`;

export function formatClock(ns) {
    const n = toFinite(ns);
    if (n == null) return null;
    const secs = Math.trunc(n / 1e9);
    const abs = Math.abs(secs);
    return { negative: secs < 0, text: `${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')}` };
}

/** Sum queued Combat players, scoped to FILTER_GUILD_ID when set. */
export function countCombatQueue(mmCounts, filterGuildId = '') {
    if (!mmCounts || typeof mmCounts !== 'object') return 0;
    // When filtering, a guild with nobody queued is simply absent — that means 0,
    // not "fall back to every guild's count".
    const groups = filterGuildId ? [mmCounts[filterGuildId]] : Object.values(mmCounts);
    let total = 0;
    for (const group of groups) {
        if (!group || typeof group !== 'object') continue;
        for (const [mode, count] of Object.entries(group)) {
            const n = toFinite(count);
            if (isCombat(mode) && n != null && n > 0) total += n;
        }
    }
    return total;
}

/** Active, public, non-empty Combat labels, oldest first (stable post order). */
export function selectCombatLabels(labels, filterGuildId = '') {
    if (!Array.isArray(labels)) return [];
    return labels
        .filter((label) =>
            label && typeof label === 'object' &&
            typeof label.id === 'string' && label.id &&
            isCombat(label.mode) &&
            label.lobby_type !== 'private' &&
            !String(label.mode || '').toLowerCase().includes('private') &&
            (toFinite(label.player_count) || (Array.isArray(label.players) ? label.players.length : 0)) > 0 &&
            (!filterGuildId || label.group_id === filterGuildId)
        )
        .sort((a, b) => (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0));
}

// ── Components V2 builders ────────────────────────────────────────────────────

const COMBAT_RED = 0xdc2626;
const TEAM_BLUE = 0x3b82f6;
const TEAM_ORANGE = 0xf97316;
const IDLE_GREY = 0x6b7280;

const MAX_LISTED_PLAYERS = 12;
const MAX_LISTED_TICKETS = 20;
const QUEUE_TITLE = '## ⚔️ Combat Queue';
// Footer marker used by startup recovery to map a message back to its match.
const MATCH_ID_RE = /Match `([^`\s]+)`/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const text = (content) => new TextDisplayBuilder().setContent(content);
const divider = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const gap = () => new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small);

/**
 * Builders return the container plus a `signature` of the data portion
 * (everything except the "updated …" footer). Matching signatures mean
 * nothing visible changed, so the edit can be skipped to save rate limit.
 */
function finalize(container, footer) {
    const signature = JSON.stringify(container.toJSON());
    container.addSeparatorComponents(gap()).addTextDisplayComponents(text(footer));
    return { container, signature };
}

function bulletList(items, max) {
    const lines = items.slice(0, max);
    if (items.length > max) lines.push(`-# +${items.length - max} more`);
    return lines.join('\n');
}

/**
 * @param {number} playerCount
 * @param {Array|null} tickets - authenticated ticket data, or null for count-only mode
 * @param {{ activeMatches?: number, updatedAt?: number }} [opts]
 */
export function buildQueueMessage(playerCount, tickets = null, { activeMatches = 0, updatedAt = Date.now() } = {}) {
    const count = Math.max(0, toFinite(playerCount) ?? 0);
    const container = new ContainerBuilder()
        .setAccentColor(count > 0 ? COMBAT_RED : IDLE_GREY)
        .addTextDisplayComponents(
            text(QUEUE_TITLE),
            text(`# ${count}\nplayer${count === 1 ? '' : 's'} searching for a Combat match`),
        );

    if (Array.isArray(tickets) && tickets.length > 0) {
        const lines = tickets.map((t) => {
            const name = safePlayerName({
                display_name: t?.StringProperties?.display_name,
                username: t?.Presences?.[0]?.username,
            });
            const partySize = Array.isArray(t?.Presences) ? t.Presences.length : 1;
            const partyStr = partySize > 1 ? ` (+${partySize - 1})` : '';
            // CreatedAt is nanoseconds; a relative timestamp keeps the wait ticking client-side
            const createdMs = toFinite(t?.CreatedAt) != null ? t.CreatedAt / 1e6 : null;
            const wait = createdMs && createdMs > 0 && createdMs <= updatedAt + 60_000 ? ` — queued ${discordTime(createdMs)}` : '';
            return `• **${name}**${partyStr}${wait}`;
        });
        container
            .addSeparatorComponents(divider())
            .addTextDisplayComponents(text(`**Searching**\n${bulletList(lines, MAX_LISTED_TICKETS)}`));
    }

    container
        .addSeparatorComponents(divider())
        .addTextDisplayComponents(text(activeMatches > 0
            ? `🎮 **${activeMatches}** active public Combat match${activeMatches === 1 ? '' : 'es'} — see pinned messages to join`
            : '🎮 No public Combat matches running right now'));

    return finalize(container, `-# Refreshes every ${Math.round(POLL_INTERVAL_MS / 1000)}s · updated ${discordTime(updatedAt)}`);
}

/**
 * @param {object} label - one entry of statusData.labels
 * @param {{ updatedAt?: number }} [opts]
 */
export function buildMatchMessage(label, { updatedAt = Date.now() } = {}) {
    const players = Array.isArray(label?.players) ? label.players.filter((p) => p && typeof p === 'object') : [];
    const blueTeam = players.filter((p) => normalizeTeam(p) === 'blue');
    const orangeTeam = players.filter((p) => normalizeTeam(p) === 'orange');
    const spectators = players.filter((p) => !['blue', 'orange'].includes(normalizeTeam(p)));

    const fullMatchId = String(label?.id || '');
    const matchUuid = fullMatchId.split('.')[0];
    const taxiUrl = UUID_RE.test(matchUuid) ? `https://echo.taxi/spark://c/${matchUuid}` : null;

    // ── Scores (payload is combat-specific; game_state is the generic fallback)
    const gs = label?.game_state && typeof label.game_state === 'object' ? label.game_state : null;
    const payload = label?.payload && typeof label.payload === 'object' ? label.payload : null;
    let blueScore = toFinite(payload?.blue_points);
    let orangeScore = toFinite(payload?.orange_points);
    let round = null;
    if (blueScore != null || orangeScore != null) {
        blueScore ??= 0;
        orangeScore ??= 0;
        round = (toFinite(payload?.total_round_count) ?? 0) + 1;
    } else {
        blueScore = toFinite(gs?.blue_score);
        orangeScore = toFinite(gs?.orange_score);
    }

    let accent = COMBAT_RED;
    if (blueScore != null && orangeScore != null && blueScore !== orangeScore) {
        accent = blueScore > orangeScore ? TEAM_BLUE : TEAM_ORANGE;
    }

    // ── Header: map, region, capacity, lobby state
    const mapName = formatMapName(label?.level) || 'Unknown map';
    const region = typeof label?.broadcaster?.region === 'string' ? escapeMarkdown(label.broadcaster.region) : null;
    const flag = flagEmoji(label?.broadcaster?.country_code);
    const playerCount = toFinite(label?.player_count) ?? (blueTeam.length + orangeTeam.length);
    const playerLimit = toFinite(label?.player_limit);
    const headerBits = [];
    if (region) headerBits.push(`${flag ? `${flag} ` : ''}${region}`);
    headerBits.push(`👥 ${playerCount}/${playerLimit ?? '?'}`);
    if (typeof label?.open === 'boolean') headerBits.push(label.open ? '🟢 Open' : '🔴 Closed');
    const header = text(`## 🎮 Combat · ${mapName}\n${headerBits.join(' · ')}`);

    const container = new ContainerBuilder().setAccentColor(accent).addTextDisplayComponents(header);

    // ── Join link: deliberately a plain, raw URL in the text — NOT a link button.
    // Another bot watches for echo.taxi links and reacts with 🚕 so players can
    // press it to haul a join request; it needs the clickable URL in the text.
    if (taxiUrl) container.addTextDisplayComponents(text(`🚕 **Join:** ${taxiUrl}`));

    // ── Live state: score, clock, start time, payload progress
    const stateLines = [];
    if (blueScore != null && orangeScore != null) {
        stateLines.push(`### 🔵 ${blueScore}  –  ${orangeScore} 🟠${round != null ? `  ·  Round ${round}` : ''}`);
    }
    const sb = gs?.session_scoreboard;
    const clock = formatClock(sb?.game_time_ns);
    if (clock) {
        const roundLen = formatClock(sb?.round_duration_ns);
        stateLines.push(clock.negative
            ? `⏱️ Starting in **${clock.text}**`
            : `⏱️ **${clock.text}**${roundLen && !roundLen.negative && roundLen.text !== '0:00' ? ` / ${roundLen.text}` : ''}`);
    }
    const startMs = Date.parse(label?.start_time);
    if (Number.isFinite(startMs) && startMs > 0) {
        stateLines.push(startMs > updatedAt ? `🕒 Starts ${discordTime(startMs)}` : `🕒 Started ${discordTime(startMs)}`);
    }
    const distance = toFinite(payload?.distance);
    if (distance != null) stateLines.push(`📦 Payload distance **${distance.toFixed(2)}**`);
    if (payload?.checkpoint != null && ['string', 'number'].includes(typeof payload.checkpoint)) {
        stateLines.push(`🚩 Checkpoint **${escapeMarkdown(String(payload.checkpoint))}**`);
    }
    if (stateLines.length) {
        container.addSeparatorComponents(divider()).addTextDisplayComponents(text(stateLines.join('\n')));
    }

    // ── Rosters
    const roster = (list) => bulletList(list.map((p) => `• ${safePlayerName(p)}`), MAX_LISTED_PLAYERS) || '-# No players';
    if (blueTeam.length || orangeTeam.length) {
        container
            .addSeparatorComponents(divider())
            .addTextDisplayComponents(
                text(`**🔵 Blue Team · ${blueTeam.length}**\n${roster(blueTeam)}`),
                text(`**🟠 Orange Team · ${orangeTeam.length}**\n${roster(orangeTeam)}`),
            );
    }
    if (spectators.length) {
        const names = spectators.slice(0, MAX_LISTED_PLAYERS).map(safePlayerName).join(', ');
        const more = spectators.length > MAX_LISTED_PLAYERS ? ` +${spectators.length - MAX_LISTED_PLAYERS} more` : '';
        container.addTextDisplayComponents(text(`-# 👁 Spectators (${spectators.length}): ${names}${more}`));
    }

    const built = finalize(container, `-# Match \`${fullMatchId}\` · updated ${discordTime(updatedAt)}`);
    return { ...built, fullMatchId };
}

// ── Startup recovery helpers ──────────────────────────────────────────────────

/** Concatenate every text display's content in a raw API components tree. */
export function extractComponentText(components) {
    const out = [];
    const walk = (list) => {
        if (!Array.isArray(list)) return;
        for (const c of list) {
            if (!c || typeof c !== 'object') continue;
            if (typeof c.content === 'string') out.push(c.content);
            walk(c.components);
        }
    };
    walk(components);
    return out.join('\n');
}

/**
 * Classify a raw channel message posted by our webhook.
 * @returns {{ kind: 'queue' } | { kind: 'match', matchId: string } | { kind: 'legacy' } | null}
 */
export function classifyOwnMessage(msg) {
    if (!msg || typeof msg !== 'object') return null;
    const isV2 = ((Number(msg.flags) || 0) & MessageFlags.IsComponentsV2) !== 0;
    if (!isV2) {
        const title = msg.embeds?.[0]?.title || '';
        return /Combat Queue|Active Combat Match/.test(title) ? { kind: 'legacy' } : null;
    }
    const body = extractComponentText(msg.components);
    if (body.includes(QUEUE_TITLE)) return { kind: 'queue' };
    const m = body.match(MATCH_ID_RE);
    return m ? { kind: 'match', matchId: m[1] } : null;
}

// ── Discord message management ────────────────────────────────────────────────

/** messageId → { signature, at } of the last successful post/edit */
const lastRender = new Map();

function needsEdit(messageId, signature, now) {
    const last = lastRender.get(messageId);
    return !last || last.signature !== signature || now - last.at >= HEARTBEAT_MS;
}

function v2Payload(container) {
    return {
        components: [container],
        flags: MessageFlags.IsComponentsV2,
        withComponents: true, // required for components on a non-application webhook
        allowedMentions: { parse: [] }, // player names must never ping anyone
    };
}

// Guard against concurrent queue message posts
let queuePostInProgress = false;

async function handleQueueMessage(playerCount, tickets, activeMatches, now) {
    // The queue message is kept even at 0 and edited in place — deleting it at 0
    // and re-posting at 1 caused flicker, lost pins, and re-ordering.
    const { container, signature } = buildQueueMessage(playerCount, tickets, { activeMatches, updatedAt: now });
    try {
        if (state.queueMessageId) {
            if (!needsEdit(state.queueMessageId, signature, now)) return;
            await webhook.editMessage(state.queueMessageId, v2Payload(container));
            lastRender.set(state.queueMessageId, { signature, at: now });
        } else {
            if (queuePostInProgress) return; // another poll is already posting
            queuePostInProgress = true;
            try {
                const msg = await webhook.send(v2Payload(container));
                state.queueMessageId = msg.id;
                saveState();
                lastRender.set(msg.id, { signature, at: now });
                console.log('[discord] Posted queue message:', msg.id);
                await pinMessage(msg.id);
            } finally {
                queuePostInProgress = false;
            }
        }
    } catch (e) {
        if (isUnknownMessage(e)) {
            console.warn('[discord] Queue message deleted externally, will re-post next poll.');
            lastRender.delete(state.queueMessageId);
            state.queueMessageId = null;
            saveState();
        } else {
            logDiscordError('Queue message error', e);
        }
    }
}

async function handleAllMatchMessages(builtMatches, now) {
    const activeIds = new Set(builtMatches.map((r) => r.fullMatchId));

    // Delete messages for games that ended
    for (const [matchId, msgId] of Object.entries(state.matchMessages)) {
        if (!activeIds.has(matchId)) {
            await deleteDiscordMessage(msgId);
            delete state.matchMessages[matchId];
            saveState();
        }
    }

    // Post or edit a message for each active game
    for (const { container, signature, fullMatchId } of builtMatches) {
        const shortId = fullMatchId.slice(0, 8);
        const existingMsgId = state.matchMessages[fullMatchId];
        try {
            if (existingMsgId) {
                if (!needsEdit(existingMsgId, signature, now)) continue;
                await webhook.editMessage(existingMsgId, v2Payload(container));
                lastRender.set(existingMsgId, { signature, at: now });
            } else {
                const msg = await webhook.send(v2Payload(container));
                state.matchMessages[fullMatchId] = msg.id;
                saveState();
                lastRender.set(msg.id, { signature, at: now });
                console.log(`[discord] Posted match message for ${shortId}:`, msg.id);
                await pinMessage(msg.id);
            }
        } catch (e) {
            if (isUnknownMessage(e)) {
                console.warn(`[discord] Match message for ${shortId} deleted externally, will re-post next poll.`);
                lastRender.delete(existingMsgId);
                delete state.matchMessages[fullMatchId];
                saveState();
            } else {
                logDiscordError(`Match message error for ${shortId}`, e);
            }
        }
    }
}

// ── Main poll loop ────────────────────────────────────────────────────────────

const lastPoll = { tickets: -1, games: -1 };
let lastSnapshotMs = null;
let pollRunning = false;

async function poll() {
    if (pollRunning) return; // skip if previous poll hasn't finished
    pollRunning = true;
    try {
        const { statusData, usedAuthenticatedPath } = await fetchStatus();
        if (!isValidStatus(statusData)) {
            if (statusData != null) console.error('[status] Malformed status response, skipping poll');
            return; // leave messages as-is; their "updated …" footer shows the age
        }

        if (isStaleSnapshot(statusData.update_time, lastSnapshotMs)) {
            console.warn(`[status] Ignoring stale snapshot (${statusData.update_time})`);
            return;
        }
        const snapshotMs = Date.parse(statusData.update_time);
        if (Number.isFinite(snapshotMs)) lastSnapshotMs = snapshotMs;

        const now = Date.now();

        // ── Active matches (built first so the queue message can show the count)
        const hasLabels = Array.isArray(statusData.labels);
        const combatLabels = selectCombatLabels(statusData.labels, FILTER_GUILD_ID);
        const builtMatches = [];
        for (const label of combatLabels) {
            try {
                builtMatches.push(buildMatchMessage(label, { updatedAt: now }));
            } catch (e) {
                // One odd label must not stop every other message from updating
                console.error(`[poll] Could not build message for match ${String(label.id).slice(0, 8)}:`, e.message);
            }
        }
        if (combatLabels.length !== lastPoll.games) {
            console.log(`[poll] Active combat games: ${combatLabels.length}`);
            lastPoll.games = combatLabels.length;
        }

        // ── Queue count
        const queueCount = countCombatQueue(statusData.active_matchmaking_counts, FILTER_GUILD_ID);
        if (queueCount !== lastPoll.tickets) {
            console.log(`[poll] Combat queue: ${queueCount}`);
            lastPoll.tickets = queueCount;
        }
        const tickets = (usedAuthenticatedPath && queueCount > 0) ? await fetchMatchmakerTickets() : null;
        await handleQueueMessage(queueCount, tickets, combatLabels.length, now);

        // Only reconcile match messages when the payload actually had a labels
        // array — a partial response must not delete every live match message.
        if (hasLabels) await handleAllMatchMessages(builtMatches, now);
    } catch (e) {
        console.error('[poll] Unhandled error:', e.message);
    } finally {
        pollRunning = false;
    }
}

/**
 * Fixed-cadence loop: the next poll is scheduled POLL_INTERVAL_MS after the
 * previous one *started*. Unlike setInterval it can never stack overlapping
 * polls, and unlike a skip-if-busy interval it doesn't silently drop a whole
 * cycle (leaving 20s gaps) whenever a poll runs a little long.
 */
async function pollLoop() {
    const started = Date.now();
    try {
        await poll();
    } finally {
        const delay = Math.max(0, POLL_INTERVAL_MS - (Date.now() - started));
        setTimeout(pollLoop, delay);
    }
}

// ── Startup recovery ──────────────────────────────────────────────────────────

async function fetchChannelMessagesForRecovery() {
    const headers = botHeaders();
    const seen = new Map();
    const add = (list) => {
        if (!Array.isArray(list)) return;
        for (const m of list) if (m?.id) seen.set(m.id, m);
    };

    const recent = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=100`, { headers, signal: timeoutSignal() });
    if (!recent.ok) throw new Error(`HTTP ${recent.status} listing channel messages`);
    add(await recent.json().catch(() => []));

    // Pinned messages can be older than the last 100; include them too.
    const pins = await fetch(`https://discord.com/api/v10/channels/${channelId}/pins`, { headers, signal: timeoutSignal() }).catch(() => null);
    if (pins?.ok) {
        const data = await pins.json().catch(() => []);
        add(Array.isArray(data) ? data : data?.items?.map((i) => i?.message));
    }
    return [...seen.values()];
}

const newestFirst = (a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1);

/**
 * On startup, scan the channel (last 100 messages + pins) for messages posted
 * by this webhook and adopt them, so the bot edits instead of re-posting even
 * when state.json was wiped (e.g. Render ephemeral disk):
 *   - Queue message: adopt the newest, delete duplicates.
 *   - Match messages: adopt by the match ID in the footer, delete duplicates.
 *     Messages for matches that have since ended are removed on the first poll.
 *   - Legacy embed messages from before Components V2: delete (re-posted fresh).
 */
async function recoverMessages() {
    if (!DISCORD_BOT_TOKEN || !channelId || !WEBHOOK_ID) return;
    let messages;
    try {
        messages = await fetchChannelMessagesForRecovery();
    } catch (e) {
        console.warn('[discord] Could not scan channel for recovery:', e.message);
        return;
    }

    const own = messages.filter((m) => m.webhook_id === WEBHOOK_ID).sort(newestFirst);
    const queueMsgs = [];
    const matchMsgs = new Map(); // matchId → messages (newest first)
    for (const msg of own) {
        const kind = classifyOwnMessage(msg);
        if (!kind) continue;
        if (kind.kind === 'legacy') {
            console.log('[discord] Deleting legacy embed message:', msg.id);
            await deleteDiscordMessage(msg.id);
        } else if (kind.kind === 'queue') {
            queueMsgs.push(msg);
        } else {
            if (!matchMsgs.has(kind.matchId)) matchMsgs.set(kind.matchId, []);
            matchMsgs.get(kind.matchId).push(msg);
        }
    }

    if (queueMsgs.length) {
        const [keep, ...dupes] = queueMsgs;
        for (const msg of dupes) {
            console.log('[discord] Deleting duplicate queue message:', msg.id);
            await deleteDiscordMessage(msg.id);
        }
        if (state.queueMessageId && state.queueMessageId !== keep.id && !dupes.some((d) => d.id === state.queueMessageId)) {
            await deleteDiscordMessage(state.queueMessageId);
        }
        state.queueMessageId = keep.id;
        console.log('[discord] Adopted existing queue message:', keep.id);
    }
    // If none were found, keep any ID from state.json: it may simply be older
    // than the scan window, and a stale ID is handled (re-post) on first edit.

    for (const [matchId, list] of matchMsgs) {
        const [keep, ...dupes] = list;
        for (const msg of dupes) {
            console.log(`[discord] Deleting duplicate match message for ${matchId.slice(0, 8)}:`, msg.id);
            await deleteDiscordMessage(msg.id);
        }
        const known = state.matchMessages[matchId];
        if (known && known !== keep.id && !dupes.some((d) => d.id === known)) await deleteDiscordMessage(known);
        state.matchMessages[matchId] = keep.id;
        console.log(`[discord] Adopted existing match message for ${matchId.slice(0, 8)}:`, keep.id);
    }

    saveState();
}

// ── Startup ───────────────────────────────────────────────────────────────────

async function main() {
    if (!DISCORD_WEBHOOK_URL || !WEBHOOK_ID || !WEBHOOK_TOKEN) {
        console.error('[config] DISCORD_WEBHOOK_URL is missing or not a valid Discord webhook URL');
        process.exit(1);
    }

    console.log('[bot] Combat Pubs Bot starting…');
    const nakamaConfigured = NAKAMA_URL && NAKAMA_HTTP_KEY && NAKAMA_USERNAME && NAKAMA_PASSWORD;
    console.log(`[bot] Status: ${nakamaConfigured ? `${NAKAMA_URL} (authenticated)` : `${STATUS_URL} (public)`}`);
    console.log(`[bot] Poll interval: ${POLL_INTERVAL_MS}ms`);
    console.log(`[bot] Pinning: ${DISCORD_BOT_TOKEN ? 'enabled' : 'disabled (set DISCORD_BOT_TOKEN to enable)'}`);

    webhook = new WebhookClient({ url: DISCORD_WEBHOOK_URL });

    const legacyIds = loadState();
    initNakamaSession();
    await fetchChannelId();

    if (legacyIds.length) {
        for (const id of legacyIds) await deleteDiscordMessage(id);
        saveState(); // persist format: 2 so this only happens once
    }

    // Establish Nakama session before first poll (if configured)
    if (nakamaSession) {
        if (state.nakamaToken || state.nakamaRefreshToken) {
            console.log('[bot] Nakama session ready (restored from state file)');
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

    await recoverMessages();
    pollLoop();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
