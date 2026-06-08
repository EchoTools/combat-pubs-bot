

import 'dotenv/config';
import { createServer } from 'http';

const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const PORT = 3000;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

if (!CLIENT_ID) {
    console.error('[error] DISCORD_CLIENT_ID not set in .env');
    process.exit(1);
}
if (!CLIENT_SECRET) {
    console.error('[error] DISCORD_CLIENT_SECRET not set in .env');
    process.exit(1);
}

const authUrl =
    `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code&scope=identify`;

console.log('\n=== Discord OAuth Token Helper ===\n');
console.log('Step 1 — Make sure this redirect URI is added to the Discord app:');
console.log(`  ${REDIRECT_URI}`);
console.log('  (Discord Developer Portal → Your App → OAuth2 → Redirects → Add)\n');
console.log('Step 2 — Open this URL in your browser and click Authorize:');
console.log(`  ${authUrl}\n`);
console.log('Waiting for redirect callback...\n');

const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end();
        return;
    }

    const code = url.searchParams.get('code');
    if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('No authorization code in callback URL.');
        console.error('[error] Callback received without a code.');
        server.close();
        return;
    }

    try {
        const tokenRes = await fetch('https://discord.com/api/v10/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                redirect_uri: REDIRECT_URI,
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
            }).toString(),
        });

        const data = await tokenRes.json();

        if (!tokenRes.ok) {
            const msg = data?.error_description || data?.error || 'Unknown error';
            console.error('[error] Token exchange failed:', msg);
            res.writeHead(500, { 'Content-Type': 'text/html' });
            res.end(`<h2>Error: ${msg}</h2><p>Check the terminal for details.</p>`);
            server.close();
            return;
        }

        console.log('✓ Success!\n');
        console.log('Add this line to your .env file:\n');
        console.log(`DISCORD_OAUTH_REFRESH_TOKEN=${data.refresh_token}`);
        console.log('\nThen restart the bot.\n');

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
            '<h2 style="font-family:sans-serif;color:green">&#10003; Success!</h2>' +
            '<p style="font-family:sans-serif">Check your terminal for the token value. You can close this tab.</p>'
        );
    } catch (e) {
        console.error('[error]', e.message);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error: ' + e.message);
    } finally {
        server.close();
    }
});

server.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}/callback ...`);
});
