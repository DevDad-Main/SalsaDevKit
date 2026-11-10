'use strict';
/**
 * SalsaDevKit — child-process environment injection (shared by all modules).
 * Every process we spawn gets: DevKit tools first on PATH, package caches pinned
 * to the persistent root, and git pointed at the portable config so credentials
 * (state\git-credentials) + identity work no matter how many times C: is wiped.
 */
const fs = require('fs');
const path = require('path');

function devkitEnv(rootPaths) {
  const env = { ...process.env };
  const dirs = [
    rootPaths.bin,
    path.join(rootPaths.root, 'runtimes', 'node'),
    path.join(rootPaths.root, 'runtimes', 'bun'),
    path.join(rootPaths.root, 'runtimes', 'git', 'cmd'),
    path.join(rootPaths.root, 'runtimes', 'python'),
  ];
  env.PATH = [...dirs, ...(env.PATH ? [env.PATH] : [])].join(';');
  env.npm_config_cache = rootPaths.cacheNpm;
  env.PIP_CACHE_DIR = path.join(rootPaths.root, 'cache', 'pip');
  // Only when it exists (i.e. after GitHub sign-in) — a missing file is fine for git too,
  // but pointing at one that isn't there yet would hide any future system config.
  if (rootPaths.gitconfig && fs.existsSync(rootPaths.gitconfig)) {
    env.GIT_CONFIG_GLOBAL = rootPaths.gitconfig;
  }
  return env;
}

/** Portable MinGit, or null when not provisioned yet. */
function gitExe(rootPaths) {
  const p = path.join(rootPaths.root, 'runtimes', 'git', 'cmd', 'git.exe');
  return fs.existsSync(p) ? p : null;
}

module.exports = { devkitEnv, gitExe };
