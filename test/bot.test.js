import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags, ComponentType } from 'discord.js';
import {
    parsePollInterval,
    parseState,
    isValidStatus,
    isStaleSnapshot,
    countCombatQueue,
    selectCombatLabels,
    buildQueueMessage,
    buildMatchMessage,
    classifyOwnMessage,
    extractComponentText,
    safePlayerName,
    formatClock,
} from '../bot.js';

const UUID = '93e2d27b-791f-4050-912e-d14cc7ab2bba';
const FULL_ID = `${UUID}.nakama2_us-east`;

function label(overrides = {}) {
    return {
        id: FULL_ID,
        open: true,
        lobby_type: 'public',
        mode: 'echo_combat',
        level: 'mpl_combat_dyson',
        player_count: 2,
        player_limit: 8,
        group_id: 'g1',
        created_at: '2026-11-21T20:13:25Z',
        start_time: '2026-11-21T20:14:25Z',
        broadcaster: { region: 'Saxony', country_code: 'DE' },
        players: [
            { display_name: 'alpha', team: 'blue' },
            { display_name: 'bravo', team: 'orange' },
        ],
        ...overrides,
    };
}

const allText = (built) => extractComponentText([built.container.toJSON()]);

// ── Config ───────────────────────────────────────────────────────────────────

test('poll interval defaults to 10s and rejects junk / too-fast values', () => {
    assert.equal(parsePollInterval(undefined), 10_000);
    assert.equal(parsePollInterval(''), 10_000);
    assert.equal(parsePollInterval('abc'), 10_000);
    assert.equal(parsePollInterval('-5'), 10_000);
    assert.equal(parsePollInterval('1000'), 5_000);
    assert.equal(parsePollInterval('15000'), 15_000);
});

// ── State file corruption ────────────────────────────────────────────────────

test('corrupt state JSON starts fresh instead of crashing', () => {
    const r = parseState('{"queueMessageId": "12');
    assert.match(r.error, /invalid JSON/);
    assert.equal(r.state.queueMessageId, null);
    assert.deepEqual(r.state.matchMessages, {});
});

test('non-object state is rejected', () => {
    for (const raw of ['null', '[]', '42', '"x"']) {
        assert.ok(parseState(raw).error, raw);
    }
});

test('wrongly typed state fields are sanitised', () => {
    const r = parseState(JSON.stringify({
        format: 2,
        queueMessageId: 12345,
        matchMessages: { a: '123456789012345678', b: 7, c: null },
        nakamaToken: { bad: true },
    }));
    assert.equal(r.error, null);
    assert.equal(r.state.queueMessageId, null);
    assert.deepEqual(r.state.matchMessages, { a: '123456789012345678' });
    assert.equal(r.state.nakamaToken, null);
});

test('legacy (embed-era) state yields message IDs to replace and keeps tokens', () => {
    const r = parseState(JSON.stringify({
        queueMessageId: '111111111111111111',
        matchMessages: { [FULL_ID]: '222222222222222222' },
        matchMessageId: '333333333333333333',
        nakamaToken: 'tok',
    }));
    assert.deepEqual(r.legacyMessageIds.sort(), ['111111111111111111', '222222222222222222', '333333333333333333']);
    assert.equal(r.state.queueMessageId, null);
    assert.deepEqual(r.state.matchMessages, {});
    assert.equal(r.state.nakamaToken, 'tok');
    assert.equal(r.state.format, 2);
});

test('current-format state round-trips', () => {
    const saved = { format: 2, queueMessageId: '111111111111111111', matchMessages: { [FULL_ID]: '222222222222222222' } };
    const r = parseState(JSON.stringify(saved));
    assert.deepEqual(r.legacyMessageIds, []);
    assert.equal(r.state.queueMessageId, saved.queueMessageId);
    assert.deepEqual(r.state.matchMessages, saved.matchMessages);
});

// ── Malformed API responses ──────────────────────────────────────────────────

test('status validation rejects non-objects', () => {
    assert.equal(isValidStatus(null), false);
    assert.equal(isValidStatus([]), false);
    assert.equal(isValidStatus('oops'), false);
    assert.equal(isValidStatus({}), true);
});

test('older snapshots are flagged stale; unparseable times are not', () => {
    const last = Date.parse('2026-11-21T20:13:28Z');
    assert.equal(isStaleSnapshot('2026-11-21T20:13:20Z', last), true);
    assert.equal(isStaleSnapshot('2026-11-21T20:13:28Z', last), false);
    assert.equal(isStaleSnapshot('2026-11-21T20:13:38Z', last), false);
    assert.equal(isStaleSnapshot(undefined, last), false);
    assert.equal(isStaleSnapshot('garbage', last), false);
    assert.equal(isStaleSnapshot('2026-11-21T20:13:20Z', null), false);
});

test('queue count tolerates malformed matchmaking data', () => {
    assert.equal(countCombatQueue(undefined), 0);
    assert.equal(countCombatQueue('x'), 0);
    assert.equal(countCombatQueue({ g1: null, g2: 'x' }), 0);
    assert.equal(countCombatQueue({ g1: { echo_combat: '3', echo_arena: 9 }, g2: { echo_combat: 'NaN', combat_x: -2 } }), 3);
});

test('guild filter returns 0 when that guild has nobody queued (no fallback to all guilds)', () => {
    const counts = { other: { echo_combat: 5 } };
    assert.equal(countCombatQueue(counts, 'mine'), 0);
    assert.equal(countCombatQueue({ ...counts, mine: { echo_combat: 2 } }, 'mine'), 2);
    assert.equal(countCombatQueue(counts, ''), 5);
});

test('label selection skips private, empty, non-combat, other-guild and malformed entries', () => {
    const labels = [
        label(),
        label({ id: 'b', lobby_type: 'private' }),
        label({ id: 'c', mode: 'echo_combat_private' }),
        label({ id: 'd', player_count: 0, players: [] }),
        label({ id: 'e', mode: 'echo_arena' }),
        label({ id: 'f', group_id: 'g2' }),
        label({ id: undefined }),
        null,
        'junk',
    ];
    assert.deepEqual(selectCombatLabels(labels, 'g1').map((l) => l.id), [FULL_ID]);
    assert.deepEqual(selectCombatLabels(labels).map((l) => l.id), [FULL_ID, 'f']);
    assert.deepEqual(selectCombatLabels(undefined), []);
    assert.deepEqual(selectCombatLabels({}), []);
});

test('labels are ordered oldest first regardless of API order', () => {
    const a = label({ id: 'a', created_at: '2026-11-21T20:00:00Z' });
    const b = label({ id: 'b', created_at: '2026-11-21T19:00:00Z' });
    assert.deepEqual(selectCombatLabels([a, b]).map((l) => l.id), ['b', 'a']);
});

// ── Message builders ─────────────────────────────────────────────────────────

test('match message builds valid Components V2 JSON with a Join link button', () => {
    const built = buildMatchMessage(label(), { updatedAt: Date.parse('2026-11-21T20:14:00Z') });
    const json = built.container.toJSON();
    assert.equal(json.type, ComponentType.Container);
    const section = json.components.find((c) => c.type === ComponentType.Section);
    assert.ok(section, 'header section present');
    assert.equal(section.accessory.url, `https://echo.taxi/spark://c/${UUID}`);
    const body = allText(built);
    assert.match(body, /Combat · Dyson/);
    assert.match(body, /🇩🇪 Saxony/);
    assert.match(body, /👥 2\/8/);
    assert.match(body, /Starts <t:\d+:R>/);
    assert.match(body, new RegExp(`Match \`${FULL_ID.replace('.', '\\.')}\``));
    assert.equal(built.fullMatchId, FULL_ID);
});

test('match message survives malformed fields without throwing', () => {
    const weird = label({
        id: 'not-a-uuid',
        players: [null, 7, { team: 3 }, { display_name: '', user_id: 42 }],
        payload: { distance: 'far', checkpoint: { nested: true }, blue_points: 'x' },
        game_state: { session_scoreboard: { game_time_ns: 'soon' } },
        broadcaster: { region: 123, country_code: 'XYZ' },
        level: 42,
        start_time: 'whenever',
        player_count: 'many',
    });
    const built = buildMatchMessage(weird);
    const json = built.container.toJSON();
    assert.ok(!json.components.some((c) => c.type === ComponentType.Section), 'no Join button for an invalid match id');
    assert.match(allText(built), /Unknown map/);
});

test('match message with null/empty label still builds', () => {
    assert.doesNotThrow(() => buildMatchMessage({ id: FULL_ID }).container.toJSON());
    assert.doesNotThrow(() => buildMatchMessage(null).container.toJSON());
});

test('payload score, round, distance and checkpoint render', () => {
    const built = buildMatchMessage(label({
        payload: { blue_points: 2, orange_points: 1, total_round_count: 2, distance: 12.3456, checkpoint: 3 },
    }));
    const body = allText(built);
    assert.match(body, /🔵 2  –  1 🟠  ·  Round 3/);
    assert.match(body, /12\.35/);
    assert.match(body, /Checkpoint \*\*3\*\*/);
    assert.equal(built.container.toJSON().accent_color, 0x3b82f6, 'accent follows the leading team');
});

test('player names are markdown-escaped', () => {
    assert.equal(safePlayerName({ display_name: '*bold*' }), '\\*bold\\*');
    assert.equal(safePlayerName({ display_name: 'a_b_c' }), 'a\\_b\\_c');
    assert.equal(safePlayerName({}), 'Unknown');
    assert.equal(safePlayerName(null), 'Unknown');
});

test('signature ignores the "updated" timestamp but tracks real changes', () => {
    const a = buildMatchMessage(label(), { updatedAt: 1_800_000_000_000 });
    const b = buildMatchMessage(label(), { updatedAt: 1_800_000_010_000 });
    const c = buildMatchMessage(label({ player_count: 3 }), { updatedAt: 1_800_000_010_000 });
    assert.equal(a.signature, b.signature);
    assert.notEqual(a.signature, c.signature);
});

test('queue message builds for zero, counts and malformed tickets', () => {
    const zero = buildQueueMessage(0);
    assert.match(allText(zero), /# 0\nplayers searching/);
    assert.equal(zero.container.toJSON().accent_color, 0x6b7280);

    const built = buildQueueMessage(3, [
        { StringProperties: { display_name: '_x_' }, Presences: [{}, {}], CreatedAt: 1_700_000_000_000_000_000 },
        { CreatedAt: 'nope' },
        null,
    ], { activeMatches: 2, updatedAt: 1_800_000_000_000 });
    const body = allText(built);
    assert.match(body, /\\_x\\_\*\* \(\+1\) — queued <t:1700000000:R>/);
    assert.match(body, /\*\*2\*\* active public Combat matches/);
    assert.doesNotThrow(() => buildQueueMessage('NaN', 'not-an-array').container.toJSON());
});

test('clock formatting handles negatives and junk', () => {
    assert.deepEqual(formatClock(61_743_010_228), { negative: false, text: '1:01' });
    assert.deepEqual(formatClock(-5_000_000_000), { negative: true, text: '0:05' });
    assert.equal(formatClock('x'), null);
    assert.equal(formatClock(null), null);
});

// ── Startup recovery classification ──────────────────────────────────────────

test('recovery recognises our V2 queue and match messages', () => {
    const queueJson = buildQueueMessage(1).container.toJSON();
    const matchJson = buildMatchMessage(label()).container.toJSON();
    const flags = MessageFlags.IsComponentsV2;
    assert.deepEqual(classifyOwnMessage({ flags, components: [queueJson] }), { kind: 'queue' });
    assert.deepEqual(classifyOwnMessage({ flags, components: [matchJson] }), { kind: 'match', matchId: FULL_ID });
});

test('recovery flags legacy embed messages and ignores unrelated ones', () => {
    assert.deepEqual(classifyOwnMessage({ flags: 0, embeds: [{ title: '⚔️ Combat Queue' }] }), { kind: 'legacy' });
    assert.deepEqual(classifyOwnMessage({ embeds: [{ title: '🎮 Active Combat Match' }] }), { kind: 'legacy' });
    assert.equal(classifyOwnMessage({ flags: 0, content: 'hello' }), null);
    assert.equal(classifyOwnMessage({ flags: MessageFlags.IsComponentsV2, components: [{ type: 10, content: 'hi' }] }), null);
    assert.equal(classifyOwnMessage(null), null);
    assert.equal(classifyOwnMessage({ flags: MessageFlags.IsComponentsV2, components: 'bad' }), null);
});
