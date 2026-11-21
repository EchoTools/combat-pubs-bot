/**
 * Nakama Session Authentication
 *
 * Handles session token acquisition and refresh for the Nakama game server.
 *
 * Authentication flow (mirrors echovrce-web pattern):
 *   1. Authenticate with account/authenticate/password RPC using bot credentials
 *      → receives session token (1h) + refresh token (30d)
 *   2. Before each API call, check if token is expiring soon (5 min buffer)
 *   3. If expiring, call device/auth/refresh RPC to get a new token pair
 *   4. On 401 responses, attempt one refresh then retry
 *
 * Token pair is persisted to state.json so sessions survive restarts.
 * Refresh tokens are rotated on each use (Nakama server-side behavior).
 *
 * Reference: echovrce-web src/lib/apiClient.js (refreshSession, apiFetch)
 */

// ── JWT helpers (no external dependencies) ───────────────────────────────────

/**
 * Decode the payload section of a JWT without verifying the signature.
 * JWT format: header.payload.signature — payload is base64url-encoded JSON.
 */
function decodeJwtPayload(jwt) {
    try {
        if (!jwt || typeof jwt !== 'string') return null;
        const parts = jwt.split('.');
        if (parts.length !== 3) return null;

        let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const padding = 4 - (base64.length % 4);
        if (padding !== 4) base64 += '='.repeat(padding);

        const decoded = Buffer.from(base64, 'base64').toString('utf8');
        return JSON.parse(decoded);
    } catch {
        return null;
    }
}

/**
 * Check if a JWT expires within `bufferSeconds` from now.
 * Returns true if the token is invalid, missing, or expiring soon.
 */
function isTokenExpiringSoon(jwt, bufferSeconds = 300) {
    const payload = decodeJwtPayload(jwt);
    if (!payload || typeof payload.exp !== 'number') return true;
    const nowSec = Math.floor(Date.now() / 1000);
    return nowSec >= payload.exp - bufferSeconds;
}

// ── NakamaSession ────────────────────────────────────────────────────────────

export class NakamaSession {
    /**
     * @param {object} opts
     * @param {string} opts.nakamaUrl    - Base URL (no trailing slash, no /v2)
     * @param {string} opts.httpKey      - Nakama HTTP key for unauthenticated RPCs
     * @param {string} opts.username     - Bot account username
     * @param {string} opts.password     - Bot account password
     * @param {function} opts.onTokensChanged - Called with { token, refreshToken } when tokens change
     */
    constructor({ nakamaUrl, httpKey, username, password, onTokensChanged }) {
        if (!nakamaUrl) throw new Error('[nakama-auth] nakamaUrl is required');
        if (!httpKey) throw new Error('[nakama-auth] httpKey is required');
        if (!username) throw new Error('[nakama-auth] username is required');
        if (!password) throw new Error('[nakama-auth] password is required');

        this._nakamaUrl = nakamaUrl.replace(/\/+$/, '').replace(/\/v2\/?$/, '');
        this._httpKey = httpKey;
        this._username = username;
        this._password = password;
        this._onTokensChanged = onTokensChanged || (() => {});

        this._token = null;
        this._refreshToken = null;

        // Single-flight refresh guard (same pattern as echovrce-web apiClient.js)
        this._refreshPromise = null;
    }

    /** Restore a previously persisted token pair (e.g. from state.json). */
    restoreTokens(token, refreshToken) {
        if (token) this._token = token;
        if (refreshToken) this._refreshToken = refreshToken;
    }

    /** Current session token (may be null if not yet authenticated). */
    get token() { return this._token; }

    /** Whether the session has a token at all. */
    get isAuthenticated() { return !!this._token; }

    // ── Public API ───────────────────────────────────────────────────────────

    /**
     * Ensure we have a valid session. Tries, in order:
     *   1. If current token is still valid, return immediately
     *   2. If we have a refresh token, try refreshing
     *   3. Otherwise, authenticate from scratch with username/password
     *
     * Call this before each polling cycle — it is cheap when the token is valid.
     */
    async ensureSession() {
        // Token still fresh — nothing to do
        if (this._token && !isTokenExpiringSoon(this._token, 300)) {
            return;
        }

        // Try refresh first (cheaper than full auth)
        if (this._refreshToken && !isTokenExpiringSoon(this._refreshToken, 60)) {
            const refreshed = await this._refreshSession();
            if (refreshed) return;
            // Refresh failed — fall through to full auth
            console.warn('[nakama-auth] Refresh failed, falling back to full authentication');
        }

        // Full authentication
        await this._authenticate();
    }

    /**
     * Make an authenticated fetch to Nakama. Handles proactive refresh and
     * automatic retry on 401 (same pattern as echovrce-web apiFetch).
     *
     * @param {string} path    - Path relative to the Nakama base URL (e.g. "/v2/rpc/some/rpc")
     * @param {object} [opts]  - fetch() options (method, body, headers, etc.)
     * @returns {Promise<Response>}
     */
    async fetch(path, opts = {}) {
        // Proactive refresh if token is expiring soon
        await this.ensureSession();

        const url = path.startsWith('http') ? path : `${this._nakamaUrl}${path}`;
        const headers = {
            'Content-Type': 'application/json',
            ...opts.headers,
        };
        if (this._token) {
            headers['Authorization'] = `Bearer ${this._token}`;
        }

        let res = await fetch(url, { ...opts, headers });

        // On 401, try one refresh + retry (echovrce-web pattern)
        if (res.status === 401) {
            const newToken = await this._refreshSession();
            if (newToken) {
                headers['Authorization'] = `Bearer ${newToken}`;
                res = await fetch(url, { ...opts, headers });
            }
        }

        return res;
    }

    /**
     * Call a Nakama RPC (authenticated).
     * @param {string} rpcId  - RPC endpoint ID (e.g. "match/public")
     * @param {object} [body] - Request payload
     * @returns {Promise<object>} Parsed JSON response
     */
    async callRpc(rpcId, body = {}) {
        const res = await this.fetch(`/v2/rpc/${rpcId}?unwrap`, {
            method: 'POST',
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`[nakama-auth] RPC ${rpcId} failed: HTTP ${res.status} ${text}`);
        }
        return res.json();
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    /**
     * Authenticate with username/password via account/authenticate/password RPC.
     * This is a public RPC (RequireAuth: false), authenticated by http_key.
     */
    async _authenticate() {
        console.log('[nakama-auth] Authenticating with username/password...');
        try {
            const res = await fetch(
                `${this._nakamaUrl}/v2/rpc/account/authenticate/password?unwrap&http_key=${encodeURIComponent(this._httpKey)}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        username: this._username,
                        password: this._password,
                    }),
                },
            );
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}: ${data.message || JSON.stringify(data)}`);
            }
            if (!data.token) {
                throw new Error('No token in authentication response');
            }

            this._setTokens(data.token, data.refresh_token || data.refreshToken);
            console.log('[nakama-auth] Authenticated successfully');
        } catch (e) {
            console.error('[nakama-auth] Authentication failed:', e.message);
            throw e;
        }
    }

    /**
     * Refresh the session using device/auth/refresh RPC.
     * Uses single-flight pattern to prevent concurrent refresh storms.
     *
     * Reference: echovrce-web src/lib/apiClient.js refreshSession()
     */
    async _refreshSession() {
        if (this._refreshPromise) {
            return this._refreshPromise;
        }

        this._refreshPromise = (async () => {
            if (!this._refreshToken) {
                console.warn('[nakama-auth] No refresh token available');
                return null;
            }
            try {
                const res = await fetch(
                    `${this._nakamaUrl}/v2/rpc/device/auth/refresh?unwrap&http_key=${encodeURIComponent(this._httpKey)}`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ token: this._refreshToken }),
                    },
                );
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    console.error('[nakama-auth] Refresh returned', res.status, data.message || data);
                    return null;
                }
                if (data.token) {
                    this._setTokens(data.token, data.refresh_token || data.refreshToken);
                    console.log('[nakama-auth] Session refreshed successfully');
                    return data.token;
                }
                return null;
            } catch (e) {
                // Network errors are transient — don't clear tokens
                console.error('[nakama-auth] Refresh network error:', e.message);
                return null;
            }
        })();

        try {
            return await this._refreshPromise;
        } finally {
            this._refreshPromise = null;
        }
    }

    /** Update stored tokens and notify the persistence callback. */
    _setTokens(token, refreshToken) {
        this._token = token;
        if (refreshToken) this._refreshToken = refreshToken;
        this._onTokensChanged({
            token: this._token,
            refreshToken: this._refreshToken,
        });
    }
}
