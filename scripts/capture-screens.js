#!/usr/bin/env electron
/**
 * SalsaDevKit — README screenshot capture.
 * A mini main process: renders the real renderer with REAL data (same libs as main.js)
 * and captures each page to assets/screenshots/<page>.png via webContents.capturePage().
 *
 * Run (close the normal app first so there's only one window):
 *   node_modules\electron\dist\electron.exe scripts\capture-screens.js [page,...]
 * Default pages: toolchain,projects,github,settings
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');

process.env.DEVKIT_ROOT = process.env.DEVKIT_ROOT || 'I:\\Apps\\DevKit';
const pathsLib = require('../lib/paths');
const toolchain = require('../lib/toolchain');
const projects = require('../lib/projects');
const gh = require('../lib/github-auth');

const P = pathsLib.pathsFor(pathsLib.resolveRoot());
pathsLib.ensureDirs(P);
app.setName('SalsaDevKit');
try { app.setPath('userData', P.appData); } catch { /* fall back */ }

// ── thin IPC: same data sources as main.js, nothing else ────────────
const SETTINGS_FILE = path.join(P.appData, 'settings.json');
const DEFAULTS = { root: P.root, theme: 'dark', accent: '#6e7bff', hotkey: 'Ctrl+Shift+D', reduceMotion: false, githubClientId: '' };

ipcMain.handle('settings:get', () => ({ ...DEFAULTS, ...pathsLib.readJson(SETTINGS_FILE, {}) }));
ipcMain.handle('app:info', () => ({ version: app.getVersion(), root: P.root, platform: process.platform }));
ipcMain.handle('toolchain:status', () => ({ root: P.root, ...toolchain.toolchainStatus(P), logTail: toolchain.logTail(P, 200) }));
ipcMain.handle('projects:list', () => projects.listProjects(P));
ipcMain.handle('projects:gitStatus', (_e, id) => projects.gitStatus(P, String(id)));
ipcMain.handle('github:status', () => gh.status(P));

// ── capture ─────────────────────────────────────────────────────────
const PAGES = (process.argv[2] || 'toolchain,projects,github,settings').split(',').map((s) => s.trim()).filter(Boolean);
const OUT_DIR = path.join(__dirname, '..', 'assets', 'screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1100, height: 720, show: false, center: true,
    backgroundColor: '#0e1013',
    icon: path.join(__dirname, '..', 'assets', 'logo.png'),
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise((r) => win.once('ready-to-show', r));
  win.show();
  await sleep(2500); // let IPC data render + fonts settle

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const page of PAGES) {
    try { await win.webContents.executeJavaScript(`setNav(${JSON.stringify(page)})`); } catch { /* unknown page */ }
    if (page === 'toolchain') {
      // scroll past the how-it-works card so the runtime status cards are in frame
      try { await win.webContents.executeJavaScript(`document.querySelector('.content').scrollTo({ top: 430 })`); } catch { /* ignore */ }
    }
    await sleep(900); // nav transition + per-page data (git status pills etc.)
    const img = await win.webContents.capturePage();
    const out = path.join(OUT_DIR, `${page}.png`);
    fs.writeFileSync(out, img.toPNG());
    console.log(`captured ${out}`);
  }
  app.quit();
});
