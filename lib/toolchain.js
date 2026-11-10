'use strict';
/**
 * SalsaDevKit — toolchain status + provisioning orchestration.
 * Reads manifest.json (next to this file's parent) and the state markers under
 * <root>\state, computes per-runtime status, and can spawn provision.js with
 * live log streaming. The provisioner runs under Electron-as-Node
 * (ELECTRON_RUN_AS_NODE=1) so it works even before a standalone node exists —
 * that is how other users bootstrap from zero.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const MANIFEST_PATH = path.join(__dirname, '..', 'manifest.json');
const PROVISION_PATH = path.join(__dirname, '..', 'provision.js');

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

/** Per-runtime status: installed (marker) / assumed (on disk, no marker) / missing. */
function toolchainStatus(rootPaths) {
  const manifest = readManifest();
  const out = [];
  for (const [name, entry] of Object.entries(manifest.runtimes)) {
    let marker = null;
    try { marker = JSON.parse(fs.readFileSync(path.join(rootPaths.state, `${name}.json`), 'utf8')); } catch { /* not installed */ }
    const destRoot = path.join(rootPaths.root, entry.dest);
    const onDisk = fs.existsSync(destRoot) && (entry.assumeInstalledIf ? fs.existsSync(path.join(destRoot, entry.assumeInstalledIf)) : fs.readdirSync(destRoot).length > 0);
    let status = 'missing';
    if (marker) status = marker.assumed ? 'assumed' : 'installed';
    else if (onDisk) status = 'assumed';
    out.push({
      name,
      version: entry.version || 'unknown',
      installedVersion: marker ? marker.version : null,
      status,
      sha256Pinned: !!(entry.sha256 && (!marker || marker.sha256)),
      dest: entry.dest,
    });
  }
  let shims = [];
  try { shims = fs.readdirSync(rootPaths.bin).filter((f) => f.endsWith('.cmd') || f.endsWith('.bat')); } catch { /* no bin yet */ }
  return { runtimes: out, shims };
}

/** Tail the last n lines of devkit.log. */
function logTail(rootPaths, n = 200) {
  try {
    const txt = fs.readFileSync(rootPaths.logFile, 'utf8');
    return txt.split(/\r?\n/).slice(-n);
  } catch { return []; }
}

/**
 * Run the provisioner. onLine(line) receives each stdout/stderr line as it arrives.
 * Returns a Promise resolving to { code }. args: e.g. ['--only=python'] or ['--force=node'].
 */
function runProvision(rootPaths, args, onLine) {
  return new Promise((resolve) => {
    const env = { ...process.env, DEVKIT_ROOT: rootPaths.root, ELECTRON_RUN_AS_NODE: '1' };
    delete env.ELECTRON_NO_ATTACH_CONSOLE; // keep output flowing to our pipes
    let child;
    try {
      child = execFile(process.execPath, [PROVISION_PATH, ...args], {
        env, windowsHide: true, timeout: 60 * 60 * 1000, maxBuffer: 32 * 1024 * 1024,
      });
    } catch (e) { onLine(`FATAL: could not spawn provisioner — ${e.message}`); resolve({ code: -1 }); return; }

    let bufOut = '', bufErr = '';
    const pump = (buf, acc) => {
      const text = acc + buf.toString();
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length - 1; i++) if (lines[i].trim()) onLine(lines[i]);
      return lines[lines.length - 1];
    };
    child.stdout.on('data', (d) => { bufOut = pump(d, bufOut); });
    child.stderr.on('data', (d) => { bufErr = pump(d, bufErr); });
    child.on('error', (e) => onLine(`FATAL: ${e.message}`));
    child.on('close', (code) => {
      if (bufOut.trim()) onLine(bufOut);
      if (bufErr.trim()) onLine(bufErr);
      resolve({ code: code == null ? -1 : code });
    });
  });
}

module.exports = { readManifest, toolchainStatus, logTail, runProvision };
