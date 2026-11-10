'use strict';
/**
 * SalsaDevKit M2 — project registry + git operations.
 *
 * Registry: <root>\projects.json — metadata only; the code itself lives where the user put it.
 * Git ops run portable MinGit under devkitEnv(): PATH has DevKit tools first and, once you've
 * signed in to GitHub, GIT_CONFIG_GLOBAL points at data\gitconfig so private repos authenticate
 * via state\git-credentials and commits carry your identity. HTTPS only (no SSH in v1).
 */
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const pathsLib = require('./paths');
const envLib = require('./env');

// ── registry ────────────────────────────────────────────────────────
function registryPath(rootPaths) { return path.join(rootPaths.root, 'projects.json'); }

function readRegistry(rootPaths) {
  const data = pathsLib.readJson(registryPath(rootPaths), []);
  return Array.isArray(data) ? data : [];
}

function writeRegistry(rootPaths, list) {
  if (!pathsLib.writeJson(registryPath(rootPaths), list)) throw new Error(`could not write ${registryPath(rootPaths)}`);
}

function slugify(name) {
  const s = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'project';
}

/** Register an existing folder (never touches the folder itself). */
function registerFolder(rootPaths, folderPath, extra = {}) {
  const list = readRegistry(rootPaths);
  if (list.some((x) => x.path.toLowerCase() === folderPath.toLowerCase())) throw new Error('that folder is already registered');
  const base = slugify(path.basename(folderPath));
  let id = base, n = 2;
  while (list.some((x) => x.id === id)) id = `${base}-${n++}`;
  const proj = {
    id, name: path.basename(folderPath), path: folderPath,
    originUrl: null, addedAt: new Date().toISOString(), lastOpenedAt: null, ...extra,
  };
  list.push(proj);
  writeRegistry(rootPaths, list);
  return proj;
}

function addProject(rootPaths, folderPathRaw) {
  const p = String(folderPathRaw || '').trim().replace(/\/+$/, '');
  if (!/^[A-Za-z]:[\\]/.test(p)) throw new Error('path must be an absolute drive path like I:\\devdad\\Projects\\myrepo');
  let st;
  try { st = fs.statSync(p); } catch { throw new Error(`no such folder: ${p}`); }
  if (!st.isDirectory()) throw new Error(`not a folder: ${p}`);
  return registerFolder(rootPaths, p);
}

function findProject(rootPaths, id) {
  const proj = readRegistry(rootPaths).find((x) => x.id === String(id));
  if (!proj) throw new Error(`unknown project "${id}"`);
  return proj;
}

/** Removes the registry entry only — files on disk stay put. */
function removeProject(rootPaths, id) {
  const list = readRegistry(rootPaths);
  const next = list.filter((x) => x.id !== String(id));
  if (next.length === list.length) throw new Error(`unknown project "${id}"`);
  writeRegistry(rootPaths, next);
  return true;
}

function listProjects(rootPaths) {
  return readRegistry(rootPaths).slice().reverse(); // newest first
}

// ── git plumbing ────────────────────────────────────────────────────
/** Spawn a process and stream its output line-by-line to onLine. Resolves { code }. */
function runStreamed(cmd, args, opts, onLine) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, opts); }
    catch (e) { onLine(`FATAL: could not start ${path.basename(cmd)} — ${e.message}`); resolve({ code: -1 }); return; }
    let bufOut = '', bufErr = '';
    const pump = (buf, acc) => { // same line-buffering pattern as toolchain.runProvision
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

function runGit(rootPaths, args, cwd, onLine) {
  const git = envLib.gitExe(rootPaths);
  if (!git) return Promise.resolve((onLine('FATAL: portable git not found — provision the toolchain first'), { code: -1 }));
  return runStreamed(git, args, { cwd, env: envLib.devkitEnv(rootPaths), windowsHide: true }, onLine);
}

/** Quick non-streaming git query. Resolves trimmed stdout, or null on any failure. */
function gitQuery(rootPaths, cwd, args) {
  return new Promise((resolve) => {
    const git = envLib.gitExe(rootPaths);
    if (!git) return resolve(null);
    execFile(git, args, { cwd, env: envLib.devkitEnv(rootPaths), windowsHide: true, timeout: 10 * 1000 }, (err, out) => {
      resolve(err ? null : String(out).trim());
    });
  });
}

// ── clone / pull / status / open ────────────────────────────────────
/** Accepts `owner/repo` or an https://github.com/… URL. Returns { url, repoName }. */
function normalizeRepoInput(raw) {
  const s = String(raw || '').trim();
  if (!s) throw new Error('paste a repo first');
  if (/^(git@|ssh:)/i.test(s)) throw new Error('SSH remotes are not supported yet — use the HTTPS URL (repo page → Code → HTTPS)');
  let owner, repo;
  const urlMatch = s.match(/^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  if (urlMatch) { [owner, repo] = urlMatch.slice(1, 3); }
  else {
    const short = s.match(/^([\w.-]+)\/([\w.-]+)$/);
    if (!short) throw new Error('paste owner/repo or an https://github.com/… URL');
    [owner, repo] = short.slice(1, 3);
  }
  return { url: `https://github.com/${owner}/${repo}.git`, repoName: repo };
}

async function cloneFromGithub(rootPaths, rawInput, onLine) {
  const { url, repoName } = normalizeRepoInput(rawInput);
  const destDir = path.join(rootPaths.root, 'projects');
  const dest = path.join(destDir, repoName);
  if (fs.existsSync(dest)) throw new Error(`${repoName} already exists at ${dest}`);
  fs.mkdirSync(destDir, { recursive: true });
  onLine(`── git clone ${url} ──`);
  const res = await runGit(rootPaths, ['clone', '--progress', url, dest], rootPaths.root, onLine);
  if (res.code !== 0) {
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* leave partial for inspection */ }
    throw new Error(`git clone exited with code ${res.code} — see log above`);
  }
  const proj = registerFolder(rootPaths, dest, { originUrl: url });
  onLine(`── done → registered as "${proj.id}" ──`);
  return { code: 0, project: proj };
}

async function pullProject(rootPaths, id, onLine) {
  const proj = findProject(rootPaths, id);
  if (!fs.existsSync(path.join(proj.path, '.git'))) throw new Error('not a git repo');
  onLine(`── git -C ${proj.path} pull ──`);
  const res = await runGit(rootPaths, ['pull', '--ff-only'], proj.path, onLine);
  if (res.code !== 0) throw new Error(`git pull exited with code ${res.code} — see log above`);
  return { code: 0 };
}

/** Launch VS Code (via the bin\code.cmd shim, which pins user-data + git config) on this project. */
function openInEditor(rootPaths, id) {
  const proj = findProject(rootPaths, id);
  const codeCmd = path.join(rootPaths.bin, 'code.cmd');
  if (!fs.existsSync(codeCmd)) throw new Error('VS Code shim not found — provision the toolchain first (Toolchain page → Provision all)');
  spawn(codeCmd, [proj.path], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  const list = readRegistry(rootPaths);
  const p2 = list.find((x) => x.id === proj.id);
  if (p2) { p2.lastOpenedAt = new Date().toISOString(); writeRegistry(rootPaths, list); }
  return true;
}

/** Lightweight per-project git status for the card pills. Never throws. */
async function gitStatus(rootPaths, id) {
  const proj = findProject(rootPaths, id);
  if (!fs.existsSync(path.join(proj.path, '.git'))) return { isGit: false };
  const [branch, status] = await Promise.all([
    gitQuery(rootPaths, proj.path, ['rev-parse', '--abbrev-ref', 'HEAD']),
    gitQuery(rootPaths, proj.path, ['status', '--porcelain']),
  ]);
  const dirty = status == null ? null : status.split(/\r?\n/).filter((l) => l.trim()).length;
  return { isGit: true, branch: branch || null, dirty };
}

module.exports = { listProjects, addProject, removeProject, cloneFromGithub, pullProject, openInEditor, gitStatus, normalizeRepoInput };
