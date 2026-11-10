'use strict';
/**
 * SalsaDevKit — path & state resolution.
 * Everything the app persists lives under the DevKit root (default I:\Apps\DevKit)
 * so it survives GeForce NOW session wipes. C: is never trusted for state.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = 'I:\\Apps\\DevKit';

function resolveRoot() {
  const fromEnv = (process.env.DEVKIT_ROOT || '').trim().replace(/\/+$/, '');
  return fromEnv || DEFAULT_ROOT;
}

/** Build the full path map for a root. Dirs are created lazily by ensureDirs(). */
function pathsFor(root) {
  const dataDir = path.join(root, 'data');
  return {
    root,
    runtimes: path.join(root, 'runtimes'),
    bin: path.join(root, 'bin'),
    cacheNpm: path.join(root, 'cache', 'npm'),
    state: path.join(root, 'state'),
    dataDir,
    appData: path.join(dataDir, 'salsadevkit'), // Electron userData (settings.json)
    gitconfig: path.join(dataDir, 'gitconfig'),
    gitCredentials: path.join(root, 'state', 'git-credentials'),
    githubStore: path.join(root, 'state', 'github.json'),
    logFile: path.join(root, 'devkit.log'),
    nodeExe: path.join(root, 'runtimes', 'node', 'node.exe'),
  };
}

function ensureDirs(p) {
  for (const d of [p.state, p.dataDir, p.appData]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch { /* best effort */ }
  }
}

/** Read a JSON file or return fallback. Never throws. */
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** Write JSON atomically-ish (tmp + rename). Returns true on success. */
function writeJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

module.exports = { DEFAULT_ROOT, resolveRoot, pathsFor, ensureDirs, readJson, writeJson };
