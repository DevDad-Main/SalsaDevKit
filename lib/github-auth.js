'use strict';
/**
 * SalsaDevKit — GitHub authentication.
 *
 * Two ways in, both token-based (no SSH in v1):
 *  1. OAuth2 DEVICE FLOW (primary) — user pastes a client_id from their own
 *     GitHub OAuth App once; we show a one-time code + github.com/login/device,
 *     poll for the grant. No client secret ever touches this machine.
 *  2. Personal Access Token (fallback) — paste, validate against api.github.com.
 *
 * Everything persists under the DevKit root on I: so it survives GFN wipes:
 *   <root>\state\github.json        auth state + token
 *   <root>\data\gitconfig           git config (credential helper → file store)
 *   <root>\state\git-credentials    https://x-access-token:<token>@github.com
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const API = 'https://api.github.com';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const DEFAULT_SCOPES = 'repo read:user';

// ── store ───────────────────────────────────────────────────────────
function loadStore(rootPaths) {
  try { return JSON.parse(fs.readFileSync(rootPaths.githubStore, 'utf8')); } catch { return null; }
}
function saveStore(rootPaths, obj) {
  fs.mkdirSync(path.dirname(rootPaths.githubStore), { recursive: true });
  fs.writeFileSync(rootPaths.githubStore, JSON.stringify(obj, null, 2));
}
function clearStore(rootPaths) {
  try { fs.rmSync(rootPaths.githubStore, { force: true }); } catch { /* ignore */ }
}

// ── git wiring ──────────────────────────────────────────────────────
/** Write/refresh the portable gitconfig so any git we spawn uses I:-based credentials. */
function writeGitConfig(rootPaths, user) {
  const lines = [
    '[credential]',
    `\thelper = store --file ${rootPaths.gitCredentials}`,
    '[init]',
    '\tdefaultBranch = main',
    '[safe]',
    '\tdirectory = *',
  ];
  if (user && user.name) {
    lines.push('[user]', `\tname = ${user.name}`);
    if (user.email) lines.push(`\temail = ${user.email}`);
  }
  fs.mkdirSync(path.dirname(rootPaths.gitconfig), { recursive: true });
  fs.writeFileSync(rootPaths.gitconfig, lines.join('\n') + '\n');
}

function writeCredentialLine(rootPaths, token) {
  const line = `https://x-access-token:${token}@github.com`;
  let existing = '';
  try { existing = fs.readFileSync(rootPaths.gitCredentials, 'utf8'); } catch { /* new file */ }
  const kept = existing.split(/\r?\n/).filter((l) => l.trim() && !l.includes('@github.com'));
  fs.mkdirSync(path.dirname(rootPaths.gitCredentials), { recursive: true });
  fs.writeFileSync(rootPaths.gitCredentials, [...kept, line].join('\n') + '\n');
}

function removeCredentialLine(rootPaths) {
  try {
    const existing = fs.readFileSync(rootPaths.gitCredentials, 'utf8');
    const kept = existing.split(/\r?\n/).filter((l) => l.trim() && !l.includes('@github.com'));
    if (kept.length) fs.writeFileSync(rootPaths.gitCredentials, kept.join('\n') + '\n');
    else fs.rmSync(rootPaths.gitCredentials, { force: true });
  } catch { /* ignore */ }
}

// ── http helpers ────────────────────────────────────────────────────
async function postForm(url, fields) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(fields).toString(),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-json error body */ }
  return { ok: res.ok, status: res.status, json };
}

async function fetchUser(token) {
  const res = await fetch(`${API}/user`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'SalsaDevKit' } });
  if (!res.ok) throw new Error(`GitHub API /user → HTTP ${res.status}`);
  return res.json();
}

/** Persist a token + profile, wire git. Returns the stored state. */
async function commitAuth(rootPaths, { type, token }) {
  const user = await fetchUser(token);
  const store = {
    type, token,
    login: user.login, name: user.name || null, email: user.email || null,
    avatarUrl: user.avatar_url, scopes: DEFAULT_SCOPES,
    createdAt: new Date().toISOString(),
  };
  saveStore(rootPaths, store);
  writeGitConfig(rootPaths, { name: user.name || user.login, email: user.email });
  writeCredentialLine(rootPaths, token);
  return store;
}

// ── device flow state machine ───────────────────────────────────────
// ── sign-in flows (shared "active" slot) ───────────────────────
let active = null; // { cancel() }

function cancelActive() {
  if (active && typeof active.cancel === 'function') active.cancel();
}

// ── browser flow: authorization code + PKCE (one-click button) ────
/**
 * The "Sign in with GitHub" button. Opens the system browser to github.com;
 * GitHub redirects back to a loopback server on 127.0.0.1 (random port —
 * GitHub allows any port for loopback callbacks). PKCE means no client
 * secret is needed or stored anywhere.
 */
/**
 * opts: { clientId, callbackBase?, clientSecret? }
 * clientSecret matters when the OAuth App has one generated — GitHub then treats it as a
 * confidential client and REQUIRES the secret at token exchange (authorize works without it,
 * which is why this failure only shows up after approval).
 */
async function startBrowserFlow(rootPaths, opts, openExternal, onEvent) {
  const clientId = String(opts.clientId || '').trim();
  const callbackBase = opts.callbackBase;
  const clientSecret = String(opts.clientSecret || '').trim();
  // A new attempt supersedes any stale one (e.g. user went off to fix their OAuth App and came back)
  if (active) { try { active.cancel(); } catch { /* ignore */ } active = null; }
  const verifier = crypto.randomBytes(32).toString('base64url'); // 43 chars — within GitHub's 43–128
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  // Match the app's registered callback URL as closely as GitHub allows: keep its host +
  // path, and only add a random free port when none was registered (loopback any-port).
  let baseHost = '127.0.0.1', basePath = '/', fixedPort = null;
  try {
    const u = new URL(String(callbackBase || '').trim() || 'http://127.0.0.1');
    if (u.protocol !== 'http:') throw new Error('callback must be http://');
    baseHost = u.hostname; // localhost or 127.0.0.1 — both reach our loopback server
    basePath = u.pathname || '/';
    fixedPort = u.port ? Number(u.port) : null;
  } catch (e) { throw new Error(`bad callback URL "${callbackBase}" — use e.g. http://127.0.0.1`); }

  let server;
  try {
    server = await new Promise((resolve, reject) => {
      const s = http.createServer();
      s.once('error', (e) => reject(new Error(fixedPort ? `port ${fixedPort} is busy — ${e.message}` : e.message)));
      s.listen(fixedPort || 0, '127.0.0.1', () => resolve(s)); // port 0 → OS picks a free one
    });
  } catch (e) { throw new Error(`could not open loopback server: ${e.message}`); }

  const port = server.address().port;
  const redirectUri = `http://${baseHost}:${port}${basePath === '' ? '/' : basePath}`;
  const authUrl = 'https://github.com/login/oauth/authorize'
    + `?client_id=${encodeURIComponent(clientId.trim())}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&scope=${encodeURIComponent(DEFAULT_SCOPES)}`
    + `&state=${crypto.randomBytes(16).toString('hex')}`
    + `&code_challenge=${challenge}&code_challenge_method=S256`;

  let settled = false;
  const finish = (fn) => { if (!settled) { settled = true; clearTimeout(timer); try { server.close(); } catch { /* ignore */ } fn(); } };
  const timer = setTimeout(() => finish(() => onEvent({ type: 'failed', message: 'Timed out waiting for the browser sign-in.' })), 5 * 60 * 1000);

  server.on('request', (req, res) => {
    let u;
    try { u = new URL(req.url, `http://127.0.0.1:${port}`); } catch { res.writeHead(400).end(); return; }
    // Accept the callback on ANY path — we don't know exactly which one GitHub will honor.
    const code = u.searchParams.get('code');
    const err = u.searchParams.get('error');
    if (!code && !err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('unknown request — close this tab.'); return; }
    const html = `<!doctype html><html><body style="margin:0;font-family:system-ui;background:#0e1013;color:#f2f3f7;display:grid;place-items:center;height:100vh"><div style="text-align:center;padding:24px">${err ? 'Sign-in was declined. You can close this tab.' : '✓ Signed in — you can close this tab and return to SalsaDevKit.'}</div></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(html);

    if (err) return finish(() => onEvent({ type: 'failed', message: err === 'access_denied' ? 'You declined the sign-in request.' : `GitHub returned an error: ${err}` }));
    if (!code) return finish(() => onEvent({ type: 'failed', message: 'No authorization code received from GitHub.' }));
    const tokenFields = { client_id: clientId, code, redirect_uri: redirectUri, code_verifier: verifier };
    if (clientSecret) tokenFields.client_secret = clientSecret;
    postForm(ACCESS_TOKEN_URL, tokenFields)
      .then((t) => {
        if (t.json && t.json.access_token) finish(() => commitAuth(rootPaths, { type: 'browser', token: t.json.access_token }).then((store) => onEvent({ type: 'authed', store })));
        else finish(() => onEvent({ type: 'failed', message: (t.json && (t.json.error_description || t.json.error)) || `token exchange failed (HTTP ${t.status})` }));
      })
      .catch((e) => finish(() => onEvent({ type: 'failed', message: String(e.message || e) })));
  });

  active = { cancel: () => finish(() => onEvent({ type: 'cancelled' })) };
  try {
    await openExternal(authUrl); // throws if the browser can't be opened — clean up below
  } catch (e) {
    return finish(() => onEvent({ type: 'failed', message: `could not open the browser: ${e.message}` }));
  }
  if (!settled) onEvent({ type: 'opened' });
}

async function startDeviceFlow(rootPaths, opts, onEvent) {
  const clientId = String(opts.clientId || '').trim();
  const clientSecret = String(opts.clientSecret || '').trim();
  if (active) { try { active.cancel(); } catch { /* ignore */ } active = null; }
  const r = await postForm(DEVICE_CODE_URL, { client_id: clientId, scope: DEFAULT_SCOPES });
  if (!r.ok || !r.json || !r.json.device_code) {
    const msg = (r.json && (r.json.error_description || r.json.error)) || `HTTP ${r.status}`;
    throw new Error(`device code request failed: ${msg}`);
  }
  const d = r.json;
  onEvent({ type: 'code', userCode: d.user_code, verificationUri: d.verification_uri, interval: d.interval || 5 });

  let attempts = Math.floor((d.expires_in || 900) / (d.interval || 5));
  active = { cancelled: false };
  active.cancel = () => { clearTimeout(active.timer); active.cancelled = true; onEvent({ type: 'cancelled' }); };
  const poll = async () => {
    if (!active || active.cancelled) return;
    attempts -= 1;
    try {
      const pollFields = { client_id: clientId, device_code: d.device_code };
      if (clientSecret) pollFields.client_secret = clientSecret;
      const t = await postForm(ACCESS_TOKEN_URL, pollFields);
      if (t.json && t.json.access_token) {
        onEvent({ type: 'success' });
        const store = await commitAuth(rootPaths, { type: 'device', token: t.json.access_token });
        active = null;
        onEvent({ type: 'authed', store });
        return;
      }
      const err = (t.json && t.json.error) || '';
      if (err === 'authorization_pending' || err === 'slow_down') {
        if (attempts <= 0) throw new Error('expired');
        active.timer = setTimeout(poll, ((t.json && t.json.interval) || d.interval || 5) * 1000);
      } else if (err === 'expired_token' || err === 'access_denied') {
        onEvent({ type: 'failed', message: err === 'access_denied' ? 'You declined the sign-in request.' : 'The code expired before you finished. Try again.' });
        active = null;
      } else {
        throw new Error(err || `HTTP ${t.status}`);
      }
    } catch (e) {
      onEvent({ type: 'failed', message: String(e.message || e) });
      active = null;
    }
  };
  active.timer = setTimeout(poll, (d.interval || 5) * 1000);
  return d;
}

// kept for API compatibility — cancels whichever flow is running
function cancelDeviceFlow() { cancelActive(); }

// ── PAT flow ────────────────────────────────────────────────────────
async function setPat(rootPaths, tokenRaw) {
  const token = String(tokenRaw || '').trim();
  if (!token) throw new Error('empty token');
  await fetchUser(token); // throws on bad token
  return commitAuth(rootPaths, { type: 'pat', token });
}

// ── status / sign-out ───────────────────────────────────────────────
function status(rootPaths) {
  const store = loadStore(rootPaths);
  if (!store || !store.token) return null;
  const { token, ...pub } = store; // never ship the raw token to the renderer
  return pub;
}

async function signOut(rootPaths) {
  cancelActive();
  clearStore(rootPaths);
  removeCredentialLine(rootPaths);
  writeGitConfig(rootPaths, null); // keep [credential]/[init]/[safe], drop identity
  return true;
}

module.exports = { startBrowserFlow, startDeviceFlow, cancelDeviceFlow, cancelActive, setPat, status, signOut, loadStore };
