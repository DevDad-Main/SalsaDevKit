#!/usr/bin/env node
/**
 * SalsaDevKit — headless smoke test for the M2 projects layer (registry + git ops).
 * Clones a tiny public GitHub repo into <root>\projects through the same code path
 * the app uses, checks registry entry + git status + pull, then cleans up
 * (removes the folder and the registry entry). Safe to re-run.
 *
 * Run:  I:\Apps\DevKit\runtimes\node\node.exe scripts\smoke-projects.js [owner/repo]
 */
'use strict';

const fs = require('fs');
process.env.DEVKIT_ROOT = process.env.DEVKIT_ROOT || 'I:\\Apps\\DevKit';
const pathsLib = require('../lib/paths');
const projects = require('../lib/projects');

const P = pathsLib.pathsFor(pathsLib.resolveRoot());
const REPO = process.argv[2] || 'octocat/Hello-World';

(async () => {
  console.log('root:', P.root);
  const onLine = (l) => { if (/FATAL|fatal|error/i.test(l)) console.log('  |', l); };

  await projects.cloneFromGithub(P, REPO, onLine);
  console.log('clone: OK');

  const proj = projects.listProjects(P)[0]; // newest first
  if (!proj || !proj.originUrl) throw new Error('registry entry missing or has no originUrl');
  console.log('registry:', JSON.stringify(proj));

  const st = await projects.gitStatus(P, proj.id);
  console.log('git status:', JSON.stringify(st));
  if (!st.isGit || !st.branch) throw new Error('git status did not report a branch');

  await projects.pullProject(P, proj.id, onLine); // fresh clone → no-op success
  console.log('pull: OK');

  // cleanup — leave the root exactly as we found it
  projects.removeProject(P, proj.id);
  fs.rmSync(proj.path, { recursive: true, force: true });
  if (projects.listProjects(P).length) throw new Error('cleanup left registry entries behind');
  console.log('cleanup: OK — SMOKE TEST PASSED');
})().catch((e) => { console.error('SMOKE TEST FAILED:', e.message); process.exit(1); });
