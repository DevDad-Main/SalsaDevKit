'use strict';
/**
 * SalsaDevKit — main process.
 * Frameless premium window + tray + hotkey, settings hub IPC, toolchain
 * orchestration and GitHub auth. Plain JS, no build step (SalsaSpotlight style).
 * All app state lives under the DevKit root on I: so it survives GFN wipes.
 */
const { app, BrowserWindow, Tray, Menu, globalShortcut, nativeTheme, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const pathsLib = require('./lib/paths');
const toolchain = require('./lib/toolchain');
const gh = require('./lib/github-auth');
const projects = require('./lib/projects');

// One OAuth App registered for the whole project (no secret needed — PKCE).
// Register under DevDad-Main: github.com/settings/developers → New OAuth App,
// name "SalsaDevKit", callback URL http://127.0.0.1, no homepage required.
// Until it's registered, users can paste their own client_id in the GitHub page (persisted in settings).
const DEFAULT_GITHUB_CLIENT_ID = '';

// ── root + userData (must happen before ready) ──────────────────────
const ROOT = pathsLib.resolveRoot();
const P = pathsLib.pathsFor(ROOT);
pathsLib.ensureDirs(P);
app.setName('SalsaDevKit');
try { app.setPath('userData', P.appData); } catch { /* fall back to default */ }

// ── error log (never crash silently) ────────────────────────────────
const ERROR_LOG = path.join(P.appData, 'error.log');
function logError(where, err) {
  const line = `[${new Date().toISOString()}] ${where}: ${err && err.stack ? err.stack : String(err)}`;
  try { fs.mkdirSync(path.dirname(ERROR_LOG), { recursive: true }); fs.appendFileSync(ERROR_LOG, line + '\n'); } catch { /* ignore */ }
}
process.on('uncaughtException', (e) => logError('uncaughtException', e));
process.on('unhandledRejection', (e) => logError('unhandledRejection', e));

// ── settings ────────────────────────────────────────────────────────
const SETTINGS_FILE = path.join(P.appData, 'settings.json');
const DEFAULTS = {
  root: ROOT,
  theme: 'dark',            // dark | light | system
  accent: '#6e7bff',        // electric indigo (spec §5)
  hotkey: 'Ctrl+Shift+D',   // SalsaSpotlight owns Alt+Space + Ctrl+Space
  reduceMotion: false,
  githubClientId: '',
  // SalsaDevKit's standard loopback redirect URI — register this exact URL as your
  // OAuth App's callback (Settings → OAuth Apps → Edit). Fixed port so it always matches.
  githubCallback: 'http://127.0.0.1:8465/callback',
  // Only needed if the user clicked "Generate client secret" when creating the app —
  // GitHub then requires it at token exchange (confidential client).
  githubClientSecret: '',
};
let settings = { ...DEFAULTS };
try { Object.assign(settings, pathsLib.readJson(SETTINGS_FILE, {})); } catch { /* first run */ }

function saveSettings() { pathsLib.writeJson(SETTINGS_FILE, settings); }

// ── window / tray / hotkey ──────────────────────────────────────────
let win = null;
let tray = null;
let currentHotkey = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 720, minWidth: 960, minHeight: 620,
    frame: false, show: false, center: true,
    backgroundColor: '#0e1013',
    icon: path.join(__dirname, 'assets', 'logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { win.show(); popIn(); });
  win.on('closed', () => { win = null; });
}

function popIn() {
  if (win && !win.isDestroyed()) win.webContents.send('window:shown');
}

function toggleWindow() {
  if (!win) return createWindow();
  if (win.isVisible() && win.isFocused()) win.hide();
  else { win.show(); win.focus(); popIn(); }
}

function applyTheme() { nativeTheme.themeSource = settings.theme; }

function registerHotkey() {
  globalShortcut.unregisterAll();
  currentHotkey = null;
  if (!settings.hotkey) return false;
  const ok = globalShortcut.register(settings.hotkey, toggleWindow);
  if (ok) currentHotkey = settings.hotkey;
  return ok;
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'assets', 'logo.png'));
  tray.setToolTip('SalsaDevKit — a dev box that fits in a folder');
  const codeCmd = path.join(P.bin, 'code.cmd');
  const menu = Menu.buildFromTemplate([
    { label: 'Open SalsaDevKit', click: toggleWindow },
    {
      label: 'Open VS Code', enabled: fs.existsSync(codeCmd),
      click: () => { try { require('child_process').spawn(codeCmd, [], { detached: true, windowsHide: false }).unref(); } catch (e) { logError('tray-vscode', e); } },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', toggleWindow);
}

// ── IPC ─────────────────────────────────────────────────────────────
// ── preferred browser: Brave first, system default fallback ────────────
// Order matters for SalsaNOW users: many run portable browsers on the persistent
// drive (e.g. I:\Apps\cloudstore\brave) while the OS default is Waterfox.
function findBrave() {
  const candidates = [];
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'BraveSoftware', 'BraveBrowser', 'Application', 'brave.exe'));
  for (const pf of [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)']]) {
    if (pf) candidates.push(path.join(pf, 'BraveSoftware', 'BraveBrowser', 'Application', 'brave.exe'));
  }
  // portable layout on the same persistent drive as the DevKit root
  const m = P.root.match(/^[A-Za-z]:/);
  if (m) candidates.push(path.join(m[0], 'Apps', 'cloudstore', 'brave', 'brave.exe'));
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch { /* ignore */ } }
  return null;
}

function openInPreferredBrowser(url) {
  const brave = findBrave();
  if (brave) {
    try {
      console.log(`[browser] opening via Brave: ${brave}`);
      require('child_process').spawn(brave, [url], { detached: true, stdio: 'ignore' }).unref();
      return Promise.resolve();
    } catch (e) { logError('open-brave', e); /* fall through to system default */ }
  }
  console.log('[browser] Brave not found — using system default');
  return shell.openExternal(url);
}

const { ipcMain } = require('electron');

function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }

ipcMain.handle('settings:get', () => ({ ...settings }));

ipcMain.handle('settings:set', (_e, key, value) => {
  if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) throw new Error(`unknown setting: ${key}`);
  switch (key) {
    case 'root': {
      const next = String(value || '').trim().replace(/\/+$/, '');
      if (!next || !/^[A-Za-z]:[\\]/.test(next)) throw new Error('root must be an absolute drive path like I:\\Apps\\DevKit');
      try { fs.mkdirSync(path.join(next, 'data', 'salsadevkit'), { recursive: true }); } catch (e) { throw new Error(`cannot write to ${next}: ${e.message}`); }
      if (next.toLowerCase() === P.root.toLowerCase()) return settings;
      // migrate settings into the new root, then relaunch from there
      const nextP = pathsLib.pathsFor(next);
      pathsLib.ensureDirs(nextP);
      const migrated = { ...settings, root: next };
      pathsLib.writeJson(path.join(nextP.appData, 'settings.json'), migrated);
      saveSettings(); // record intent in the old root too (harmless)
      setTimeout(() => { app.relaunch(); app.quit(); }, 300);
      throw new Error('__RELAUNCHING__'); // renderer treats this as "restarting"
    }
    case 'theme':
      if (!['dark', 'light', 'system'].includes(value)) throw new Error('bad theme');
      settings.theme = value; applyTheme(); break;
    case 'accent':
      if (!/^#[0-9a-fA-F]{6}$/.test(String(value))) throw new Error('accent must be #rrggbb');
      settings.accent = String(value).toLowerCase(); break;
    case 'hotkey': {
      const prev = settings.hotkey;
      globalShortcut.unregisterAll();
      const ok = value ? globalShortcut.register(value, toggleWindow) : false;
      if (!ok && value) { // restore previous
        if (prev) globalShortcut.register(prev, toggleWindow);
        throw new Error(`hotkey "${value}" is unavailable`);
      }
      settings.hotkey = value || ''; currentHotkey = ok ? value : null; break;
    }
    case 'reduceMotion':
      settings.reduceMotion = !!value; break;
    case 'githubClientId':
      settings.githubClientId = String(value || '').trim(); break;
    case 'githubClientSecret':
      settings.githubClientSecret = String(value || '').trim(); break;
    case 'githubCallback': {
      const v = String(value || '').trim() || 'http://127.0.0.1';
      try { if (new URL(v).protocol !== 'http:') throw new Error('x'); } catch { throw new Error('callback must be an http:// URL like http://127.0.0.1'); }
      settings.githubCallback = v; break;
    }
  }
  saveSettings();
  return { ...settings };
});

ipcMain.handle('toolchain:status', () => ({
  root: P.root,
  ...toolchain.toolchainStatus(P),
  logTail: toolchain.logTail(P, 200),
}));

ipcMain.handle('toolchain:provision', async (_e, args = []) => {
  const safeArgs = Array.isArray(args) ? args.filter((a) => typeof a === 'string' && /^--(only|force)(=.*)?$/.test(a)) : [];
  send('toolchain:log', `── provision ${safeArgs.join(' ') || '(all)'} ──`);
  const { code } = await toolchain.runProvision(P, safeArgs, (line) => send('toolchain:log', line));
  send('toolchain:log', `── exit code ${code} ──`);
  return { code };
});

ipcMain.handle('github:status', () => gh.status(P));

ipcMain.handle('github:start-device', async (_e, clientId) => {
  const id = String(clientId || settings.githubClientId || '').trim();
  if (!id) throw new Error('paste your GitHub OAuth App client_id first');
  await gh.startDeviceFlow(P, { clientId: id, clientSecret: settings.githubClientSecret }, (ev) => {
    if (ev.store && ev.store.token) delete ev.store.token; // never ship raw tokens to the renderer
    send('github:event', ev);
  });
  return { started: true };
});

ipcMain.handle('github:start-browser', async (_e, clientId) => {
  const id = String(clientId || settings.githubClientId || DEFAULT_GITHUB_CLIENT_ID || '').trim();
  if (!id) return { needsClientId: true }; // renderer shows the one-time setup box (no console error)
  await gh.startBrowserFlow(P, { clientId: id, callbackBase: settings.githubCallback, clientSecret: settings.githubClientSecret }, openInPreferredBrowser, (ev) => {
    if (ev.store && ev.store.token) delete ev.store.token; // never ship raw tokens to the renderer
    send('github:event', ev);
  });
  return { started: true };
});

ipcMain.handle('github:cancel-device', () => { gh.cancelActive(); return true; });

ipcMain.handle('github:set-pat', async (_e, token) => {
  const store = await gh.setPat(P, token);
  send('github:event', { type: 'authed', store });
  return gh.status(P);
});

ipcMain.handle('github:signout', () => gh.signOut(P));

// Full GitHub reset: cancel any in-progress flow + wipe saved client credentials (keeps callback default)
ipcMain.handle('github:reset', () => {
  gh.cancelActive();
  settings.githubClientId = '';
  settings.githubClientSecret = '';
  saveSettings();
  return true;
});

// ── M2: projects registry + git ops (clone / pull / open) ───────────
ipcMain.handle('projects:list', () => projects.listProjects(P));
ipcMain.handle('projects:add', (_e, folderPath) => projects.addProject(P, folderPath));
ipcMain.handle('projects:remove', (_e, id) => projects.removeProject(P, String(id)));
ipcMain.handle('projects:open', (_e, id) => projects.openInEditor(P, String(id)));
ipcMain.handle('projects:gitStatus', (_e, id) => projects.gitStatus(P, String(id)));

async function streamedGit(channel, fn) {
  send(`${channel}:log`, '');
  try {
    const res = await fn((line) => send(`${channel}:log`, line));
    return res;
  } catch (e) {
    send(`${channel}:log`, `FATAL: ${e.message}`);
    throw e;
  }
}

ipcMain.handle('projects:clone', (_e, rawUrl) => streamedGit('projects', (onLine) => projects.cloneFromGithub(P, rawUrl, onLine)));
ipcMain.handle('projects:pull', (_e, id) => streamedGit('projects', (onLine) => projects.pullProject(P, String(id), onLine)));

ipcMain.handle('shell:open', (_e, url) => {
  const u = String(url || '');
  if (/^https:\/\/(www\.)?github\.com\//.test(u) || /^https:\/\/docs\.github\.com\//.test(u)) return openInPreferredBrowser(u);
  throw new Error('URL not allowed');
});

ipcMain.handle('window:minimize', () => { if (win) win.minimize(); });
ipcMain.handle('window:close', () => { if (win) win.close(); });

ipcMain.handle('app:info', () => ({ version: app.getVersion(), root: P.root, platform: process.platform }));

// ── lifecycle ───────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => toggleWindow());
  app.whenReady().then(() => {
    applyTheme();
    createWindow();
    createTray();
    registerHotkey();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { /* stay in tray */ });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
