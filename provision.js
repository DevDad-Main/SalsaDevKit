#!/usr/bin/env node
/**
 * SalsaDevKit M0 — DevKit provisioner
 * ────────────────────────────────────
 * Downloads portable runtimes into the DevKit root (default I:\Apps\DevKit,
 * override with DEVKIT_ROOT), verifies/pins sha256, extracts them with the
 * built-in Windows tar.exe, and generates bin shims. Idempotent: re-running
 * skips anything already installed (see <root>\state\<name>.json markers).
 *
 * Usage:  node provision.js [--list] [--only node,bun,...] [--force [names]]
 * No dependencies beyond Node ≥18 (global fetch) and Windows tar.exe.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

// ── Config & CLI ────────────────────────────────────────────────────
const ROOT = (process.env.DEVKIT_ROOT || 'I:\\Apps\\DevKit').replace(/\/+$/, '');
const HERE = __dirname;
const MANIFEST_PATH = path.join(HERE, 'manifest.json');
const STATE_DIR = path.join(ROOT, 'state');
const LOG_FILE = path.join(ROOT, 'devkit.log');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const onlyArg = args.find((a) => a.startsWith('--only='));
const forceArg = args.find((a) => a === '--force' || a.startsWith('--force='));
let ONLY = null;
if (onlyArg) ONLY = new Set(onlyArg.split('=').slice(1).join('=').split(',').map((s) => s.trim()).filter(Boolean));
const FORCE_NAMES = forceArg && String(forceArg).includes('=') ? new Set(String(forceArg).split('=').slice(1).join('=').split(',').map((s) => s.trim())) : null;

// ── Logging ─────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); fs.appendFileSync(LOG_FILE, line + '\n'); } catch { /* logging must never break provisioning */ }
}

// ── Small helpers ───────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchBuf(url, label, attempts = 2) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'SalsaDevKit-provisioner/0.1' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${label}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) { lastErr = e; log(`${label}: attempt ${i}/${attempts} failed (${String(e.message || e).split('\n')[0]})`); if (i < attempts) await sleep(2000 * i); }
  }
  throw new Error(`download failed after ${attempts} attempts: ${label} — ${lastErr?.message}`);
}
async function fetchText(url, label) { return (await fetchBuf(url, label)).toString('utf8'); }

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

async function download(url, destZip, label) {
  log(`${label}: downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'SalsaDevKit-provisioner/0.1' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${label}`);
  const total = Number(res.headers.get('content-length') || 0);
  let got = 0, lastPct = -1, lastT = 0;
  const chunks = [];
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    got += value.length;
    const now = Date.now();
    if (total && (now - lastT > 2000)) {
      lastT = now;
      const pct = Math.floor((got / total) * 100);
      if (pct !== lastPct) { lastPct = pct; log(`${label}: ${pct}% (${(got / 1e6).toFixed(1)} MB)`); }
    }
  }
  const buf = Buffer.concat(chunks);
  fs.mkdirSync(path.dirname(destZip), { recursive: true });
  fs.writeFileSync(destZip, buf);
  log(`${label}: done ${(buf.length / 1e6).toFixed(1)} MB`);
  return buf;
}

function runCmd(cmd, argsArr, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, argsArr, { windowsHide: true, timeout: opts.timeout || 30 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 }, (err, out, errOut) => {
      if (err) reject(new Error(`${path.basename(cmd)} failed: ${String(err.message || err).split('\n')[0]} ${(errOut || '').toString().trim().slice(0, 300)}`));
      else resolve(out);
    });
  });
}

async function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  await runCmd('tar', ['-xf', zipPath, '-C', destDir], { timeout: 30 * 60 * 1000 });
  if (!fs.readdirSync(destDir).length) throw new Error(`extraction produced nothing in ${destDir}`);
}

function findDirWith(root, markerRel, maxDepth = 3) {
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    if (fs.existsSync(path.join(dir, markerRel))) return dir;
    if (depth >= maxDepth) continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) stack.push([path.join(dir, e.name), depth + 1]);
    }
  }
  return null;
}

function moveTree(src, dest) {
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  fs.rmSync(src, { recursive: true, force: true });
}

function backupIfExists(p) {
  if (!fs.existsSync(p)) return;
  const bak = `${p}.bak-${Date.now()}`;
  try { fs.renameSync(p, bak); log(`backed up existing ${path.basename(p)} → ${path.basename(bak)}`); } catch { /* cross-volume or locked — leave it */ }
}

// ── Manifest & state ────────────────────────────────────────────────
function loadManifest() { return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')); }
function saveManifest(m) { fs.writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2) + '\n'); }
const markerPath = (name) => path.join(STATE_DIR, `${name}.json`);
function readMarker(name) { try { return JSON.parse(fs.readFileSync(markerPath(name), 'utf8')); } catch { return null; } }
function writeMarker(name, data) { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(markerPath(name), JSON.stringify(data, null, 2)); }

// ── URL/version resolvers (per source type) ─────────────────────────
async function resolveDirect(entry) {
  let expected = entry.sha256 || null;
  if (!expected && entry.hashUrl) {
    const txt = (await fetchText(entry.hashUrl, `${entry.name}-hash`)).trim();
    if (entry.hashFile) {
      // SHASUMS256.txt style: "<hash>  <filename>" per line
      for (const line of txt.split(/\r?\n/)) {
        const m = line.match(/^([a-f0-9]{64})\s+\*?(\S+)$/);
        if (m && m[2] === entry.hashFile) { expected = m[1]; break; }
      }
    } else if (/^[a-f0-9]{64}$/i.test(txt)) expected = txt.toLowerCase(); // VS Code sha endpoint returns bare hex
  }
  return { url: entry.url, version: entry.version || 'unknown', expected };
}

async function resolveGithub(entry) {
  const info = JSON.parse(await fetchText(`https://api.github.com/repos/${entry.repo}/releases/latest`, `${entry.name}-github`));
  if (!info.tag_name) throw new Error(`no latest release for ${entry.repo}`);
  const assets = Array.isArray(info.assets) ? info.assets : [];
  let asset = assets.find((a) => new RegExp(entry.assetPattern).test(a.name));
  if (!asset && entry.fallbackAssetPattern) asset = assets.find((a) => new RegExp(entry.fallbackAssetPattern).test(a.name));
  if (!asset) throw new Error(`no release asset matching ${entry.assetPattern} in ${info.tag_name}`);
  return { url: asset.browser_download_url, version: `${info.tag_name} (${asset.name})`, expected: entry.sha256 || null };
}

async function resolvePythonFtp(entry) {
  const minor = entry.minor || '3.13';
  const base = 'https://www.python.org/ftp/python/';
  const listing = await fetchText(base, `${entry.name}-listing`);
  const vers = [...new Set([...listing.matchAll(new RegExp(`href="(${minor}\\.\\d+)/"`, 'g')).map((m) => m[1])])]
    .sort((a, b) => a.split('.').map(Number).reduce((x, y) => x * 100 + y, 0) - b.split('.').map(Number).reduce((x, y) => x * 100 + y, 0));
  for (let i = vers.length - 1; i >= 0; i--) {
    const v = vers[i];
    const fname = `python-${v}-embed-amd64.zip`;
    try {
      const dirListing = await fetchText(base + v + '/', `${entry.name}-${v}`);
      if (dirListing.includes(`"${fname}"`)) return { url: base + v + '/' + fname, version: v, expected: entry.sha256 || null };
    } catch { /* try older patch */ }
  }
  throw new Error(`could not find ${minor}.x embeddable zip on python.org`);
}

const RESOLVERS = { direct: resolveDirect, 'github-latest': resolveGithub, 'python-ftp': resolvePythonFtp };

// ── Post-install steps ──────────────────────────────────────────────
async function postEnableSite(dest) {
  // Embeddable Python ships with site-packages disabled — flip the _pth switch.
  // Embeddable zips ship e.g. "python313._pth" — digits, dot, then _pth.
  const pth = fs.readdirSync(dest).find((f) => /^python\d+\._pth$/i.test(f));
  if (!pth) throw new Error('no python*_pth file found');
  const p = path.join(dest, pth);
  let txt = fs.readFileSync(p, 'utf8');
  if (txt.includes('#import site')) { txt = txt.replace('#import site', 'import site'); fs.writeFileSync(p, txt); log(`${pth}: enabled "import site"`); }
}

async function postGetPip(dest) {
  const py = path.join(dest, 'python.exe');
  const getpip = path.join(os.tmpdir(), `devkit-get-pip-${Date.now()}.py`);
  fs.writeFileSync(getpip, await fetchBuf('https://bootstrap.pypa.io/get-pip.py', 'get-pip'));
  try {
    const out = await runCmd(py, [getpip, '--no-warn-script-location'], { timeout: 10 * 60 * 1000 });
    log(`pip installed: ${String(out).trim().split('\n').pop()}`);
  } finally { try { fs.rmSync(getpip, { force: true }); } catch { /* ignore */ } }
}

const POST_STEPS = { 'enable-site': postEnableSite, 'get-pip': postGetPip };

// ── Per-runtime install ─────────────────────────────────────────────
async function installRuntime(name, entry) {
  const destRoot = path.join(ROOT, entry.dest);
  const marker = readMarker(name);

  if (marker && !(FORCE_NAMES && FORCE_NAMES.has(name))) { log(`${name}: up to date (${marker.version}) — skip`); return 'skip'; }

  // Already on disk from a manual install? Record it and move on.
  if (!marker && entry.assumeInstalledIf && fs.existsSync(path.join(destRoot, entry.assumeInstalledIf)) && !(FORCE_NAMES && FORCE_NAMES.has(name))) {
    writeMarker(name, { name, version: entry.version, sha256: null, assumed: true, installedAt: new Date().toISOString() });
    log(`${name}: found existing install at ${destRoot} — recorded as ${entry.version}`);
    return 'assumed';
  }

  const resolver = RESOLVERS[entry.source];
  if (!resolver) throw new Error(`unknown source type "${entry.source}" for ${name}`);
  const { url, version, expected } = await resolver({ ...entry, name });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-'));
  try {
    const zipPath = path.join(tmp, `${name}.zip`);
    await download(url, zipPath, name);

    // Verify / pin hash (trust-on-first-use)
    const actual = await sha256File(zipPath);
    if (expected && expected.toLowerCase() !== actual) throw new Error(`sha256 MISMATCH for ${name}: manifest=${expected} actual=${actual}`);
    if (!entry.sha256 || !readMarker(name)) {
      const m = loadManifest();
      m.runtimes[name].sha256 = actual;
      saveManifest(m);
      log(`${name}: pinned sha256 ${actual.slice(0, 16)}… into manifest.json`);
    }

    // Extract (staging dir first so a failure never leaves a half tree in place)
    const stage = path.join(tmp, 'stage');
    await extractZip(zipPath, stage);
    let sourceDir = stage;
    if (entry.extract.type === 'zip-inner') {
      const tops = fs.readdirSync(stage, { withFileTypes: true }).filter((e) => e.isDirectory());
      if (tops.length !== 1) throw new Error(`expected a single top-level folder in ${name}.zip, found: ${tops.map((t) => t.name).join(', ') || '(none)'}`);
      sourceDir = path.join(stage, tops[0].name);
    } else if (entry.extract.type === 'zip-find-file') {
      const found = findDirWith(stage, entry.extract.markerFile, 3);
      if (!found) throw new Error(`could not locate ${entry.extract.markerFile} inside ${name}.zip`);
      sourceDir = found;
    }

    let target = destRoot;
    if (entry.extract.subfolder) target = path.join(destRoot, entry.extract.subfolder);
    backupIfExists(target);
    moveTree(sourceDir, target);
    log(`${name}: installed to ${target}`);

    for (const step of entry.post || []) {
      const fn = POST_STEPS[step];
      if (!fn) throw new Error(`unknown post step "${step}"`);
      await fn(target);
    }

    writeMarker(name, { name, version, sha256: actual, installedAt: new Date().toISOString() });
    return 'installed';
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ── Bin shims ───────────────────────────────────────────────────────
function generateShims(manifest) {
  const binDir = path.join(ROOT, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  for (const [file, spec] of Object.entries(manifest.shims || {})) {
    if (!Array.isArray(spec) || spec.length < 2 || !spec[0] || !spec[1]) {
      log(`shims: skipping "${file}" — malformed spec in manifest.json (expected [pathAdd, target])`);
      continue;
    }
    // spec: [pathAdd, target] or [pathAdd, target, extraEnvSetLine]
    const [pathAdd, targetRaw, extraEnv] = spec;
    const target = targetRaw.replace(/<root>/g, ROOT);
    const pathEntry = pathAdd.replace(/<root>/g, ROOT);
    // Split "exe extra args" for the call line
    const m = target.match(/^(\S+?)(?:\s+(.*))?$/);
    const exe = m[1], extraArgs = (m[2] || '').replace(/<root>/g, ROOT);
    const lines = ['@echo off'];
    if (typeof extraEnv === 'string' && extraEnv.trim()) lines.push(extraEnv.replace(/<root>/g, ROOT)); // e.g. cache dirs on the persistent drive
    lines.push(
      `set "PATH=${pathEntry};%PATH%"`,
      `"${exe}" ${extraArgs} %*`.trim(),
    );
    fs.writeFileSync(path.join(binDir, file), lines.join('\r\n') + '\r\n');
  }
  log(`shims: wrote ${Object.keys(manifest.shims || {}).length} launchers to ${binDir}`);
}

// ── Main ────────────────────────────────────────────────────────────
(async () => {
  const manifest = loadManifest();
  const names = Object.keys(manifest.runtimes).filter((n) => !ONLY || ONLY.has(n));

  if (flag('--list')) {
    for (const n of names) {
      const mk = readMarker(n);
      console.log(`${n.padEnd(9)} ${mk ? `installed (${mk.version})` : 'not installed'}`);
    }
    return;
  }

  log(`DevKit root: ${ROOT} — provisioning [${names.join(', ')}]`);
  const results = {};
  for (const n of names) {
    try { results[n] = await installRuntime(n, manifest.runtimes[n]); }
    catch (e) { results[n] = `FAILED: ${String(e.message || e).split('\n')[0]}`; log(`${n}: ${results[n]}`); }
  }
  generateShims(manifest);

  console.log('\n── Summary ─────────────────────────────');
  for (const [k, v] of Object.entries(results)) console.log(`  ${k.padEnd(9)} ${v}`);
  const failed = Object.values(results).filter((v) => String(v).startsWith('FAILED'));
  if (failed.length) { log(`${failed.length} runtime(s) failed — see devkit.log`); process.exitCode = 1; }
  else log('all runtimes OK');
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
