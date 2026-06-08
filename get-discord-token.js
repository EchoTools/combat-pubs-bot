/**
 * One-time setup: get a Nakama session token using your EchoVRCE password.
 * Ref: https://github.com/EchoTools/nakama/wiki#obtaining-a-session-token
 *
 * After running this once, the bot refreshes tokens automatically.
 * Only re-run if the bot has been offline for 7+ consecutive days.
 *
 * Usage: node get-discord-token.js
 */

import 'dotenv/config';
import { createInterface } from 'readline';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const NAKAMA_URL = (process.env.NAKAMA_URL || 'https://g.echovrce.com:7350/v2').replace(/\/$/, '');
const NAKAMA_HTTP_KEY = process.env.NAKAMA_HTTP_KEY || '';
const STATE_FILE = './state.json';

if (!NAKAMA_HTTP_KEY) {
    console.error('[error] NAKAMA_HTTP_KEY not set in .env');
    process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

console.log('\n=== EchoVRCE Token Setup ===\n');
console.log('Enter your EchoVRCE login. You can use username, Discord ID, or Nakama user_id.\n');

const identifier = (await ask('Username / Discord ID / User ID: ')).trim();
const password = (await ask('Password: ')).trim();
rl.close();

if (!identifier || !password) {
    console.error('[error] Both fields are required.');
    process.exit(1);
}

// Pick the right field per the wiki
let body;
if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier)) {
    body = { user_id: identifier, password };          // Nakama UUID
} else if (/^\d{17,20}$/.test(identifier)) {
    body = { discord_id: identifier, password };       // Discord snowflake
} else {
    body = { username: identifier, password };         // username
}

console.log('\nAuthenticating...');

const url = `${NAKAMA_URL}/rpc/account/authenticate/password?unwrap&http_key=${encodeURIComponent(NAKAMA_HTTP_KEY)}`;
let res;
try {
    res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
} catch (e) {
    console.error('[error] Could not reach server:', e.message);
    process.exit(1);
}

const data = await res.json().catch(() => ({}));
if (!res.ok) {
    console.error('[error] Authentication failed:', data?.message || res.statusText);
    process.exit(1);
}
if (!data.token || !data.refresh_token) {
    console.error('[error] No tokens in response:', JSON.stringify(data));
    process.exit(1);
}

let savedState = {};
try {
    if (existsSync(STATE_FILE)) savedState = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
} catch (_) { }

savedState.token = data.token;
savedState.refreshToken = data.refresh_token;
delete savedState.discordRefreshToken;

writeFileSync(STATE_FILE, JSON.stringify(savedState, null, 2));

console.log('\nTokens saved to state.json - start the bot now.\n');
