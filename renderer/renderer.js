'use strict';
/* SalsaDevKit — renderer. Plain JS, talks to main via window.devkit (preload). */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let settings = null;
let provisioning = false;

// ── helpers ───────────────────────────────────────────────────
function toast(msg, isErr = false, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${isErr ? ' err' : ''}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

function applySettings(s) {
  settings = s;
  document.documentElement.dataset.theme = s.theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : s.theme;
  document.documentElement.style.setProperty('--accent', s.accent);
  const rgb = s.accent.replace('#', '');
  document.documentElement.style.setProperty('--accent-soft', `rgba(${parseInt(rgb.slice(0, 2), 16)}, ${parseInt(rgb.slice(2, 4), 16)}, ${parseInt(rgb.slice(4, 6), 16)}, .14)`);
  document.documentElement.dataset.motion = s.reduceMotion ? 'off' : 'on';
}

function setNav(page) {
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${page}`));
  if (history.replaceState) history.replaceState(null, '', `#/${page}`);
  if (page === 'projects') refreshProjects(); // re-check git status when returning to the page
}

// ── toolchain page ────────────────────────────────────────────
const STATUS_META = {
  installed: { pill: 'pill-ok', label: 'Installed' },
  assumed: { pill: 'pill-warn', label: 'On disk (unverified)' },
  missing: { pill: 'pill-err', label: 'Missing' },
};

function renderToolchain(st) {
  $('#tcRoot').textContent = st.root;
  const grid = $('#rtGrid');
  grid.innerHTML = '';
  for (const rt of st.runtimes) {
    const meta = STATUS_META[rt.status] || STATUS_META.missing;
    const card = document.createElement('div');
    card.className = 'rt-card';
    card.innerHTML = `
      <div class="rt-top">
        <span class="rt-name">${rt.name}</span>
        <span class="pill ${meta.pill}"><span class="dot"></span>${meta.label}</span>
      </div>
      <div class="rt-ver mono">${rt.installedVersion ? `installed: ${rt.installedVersion}` : `manifest: ${rt.version}`}</div>
      <div class="rt-foot">
        <span class="sha-pin" title="SHA-256 pinned in manifest.json (trust-on-first-use)">
          <svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 1.5l5 2v3.5c0 3.2-2.1 5.7-5 7-2.9-1.3-5-3.8-5-7V3.5l5-2z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M5.8 8l1.6 1.6L10.4 6.6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
          ${rt.sha256Pinned ? 'sha pinned' : 'no pin yet'}
        </span>
        <button class="btn btn-ghost sm rt-force" data-name="${rt.name}">Reinstall</button>
      </div>`;
    grid.appendChild(card);
  }
  const shims = $('#shimRow');
  shims.innerHTML = '';
  for (const s of st.shims) {
    const chip = document.createElement('span');
    chip.className = 'shim-chip';
    chip.textContent = s;
    chip.title = `Copy ${st.root}\\bin\\${s}`;
    chip.onclick = () => { navigator.clipboard.writeText(`${st.root}\\bin\\${s}`).then(() => toast(`Copied ${s} path`)); };
    shims.appendChild(chip);
  }
  // sidebar env status
  const missing = st.runtimes.filter((r) => r.status === 'missing').length;
  $('#envDot').className = `dot ${missing ? 'dot-warn' : 'dot-ok'}`;
  $('#envLabel').textContent = missing ? `${st.runtimes.length - missing}/${st.runtimes.length} runtimes ready` : 'Environment ready';
}

function appendLog(line) {
  const el = $('#tcLog');
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  el.textContent += line + '\n';
  if (nearBottom) el.scrollTop = el.scrollHeight;
}

async function refreshToolchain() {
  try { renderToolchain(await window.devkit.toolchainStatus()); } catch (e) { toast(`status failed: ${e.message}`, true); }
}

function setProvisioning(on, label) {
  provisioning = on;
  const btn = $('#btnTcProvision');
  btn.disabled = on;
  $$('.rt-force').forEach((b) => (b.disabled = on));
  if (label) btn.lastChild.textContent = ` ${label}`;
}

async function runProvision(args, label) {
  if (provisioning) return;
  setProvisioning(true, label || 'Working…');
  appendLog('');
  try {
    const res = await window.devkit.provision(args);
    toast(res.code === 0 ? 'Provisioning finished' : `Provisioner exited with code ${res.code}`, res.code !== 0);
  } catch (e) {
    toast(`provision failed: ${e.message}`, true);
  } finally {
    setProvisioning(false, '');
    $('#btnTcProvision').lastChild.textContent = ' Provision all';
    refreshToolchain();
  }
}

// ── projects page ─────────────────────────────────────────────
let projBusy = false;

function appendProjLog(line) {
  const el = $('#projLog');
  if (line === '') { el.textContent = ''; return; }
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  el.textContent += line + '\n';
  if (nearBottom) el.scrollTop = el.scrollHeight;
}

function setProjBusy(on, label) {
  projBusy = on;
  $('#btnProjClone').disabled = on;
  $('#btnProjAdd').disabled = on;
  $$('.proj-pull').forEach((b) => (b.disabled = on));
  if (label) $('#btnProjClone').lastChild.textContent = ` ${label}`;
}

async function refreshProjects() {
  let list = [];
  try { list = await window.devkit.projectsList(); } catch (e) { toast(`projects failed: ${e.message}`, true); return; }
  const wrap = $('#projList');
  wrap.innerHTML = '';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'proj-empty';
    empty.textContent = 'No projects yet — clone a repo or add a folder above.';
    wrap.appendChild(empty);
    return;
  }
  for (const p of list) {
    const card = document.createElement('div');
    card.className = 'card proj-card';
    card.innerHTML = `
      <div class="proj-top">
        <span class="proj-name">${p.name}</span>
        <span class="pill" data-role="branch"><span class="dot"></span>…</span>
      </div>
      <div class="proj-path mono" title="${p.path}">${p.path}</div>
      ${p.originUrl ? `<div class="proj-origin mono" title="${p.originUrl}">↗ ${p.originUrl.replace(/^https:\/\//, '')}</div>` : ''}
      <div class="proj-foot">
        <button class="btn btn-ghost sm proj-open" data-id="${p.id}">Open in VS Code</button>
        <span class="proj-foot-actions">
          <button class="btn btn-ghost sm proj-pull" data-id="${p.id}" title="git pull --ff-only">Pull</button>
          <button class="btn btn-ghost sm danger proj-remove" data-id="${p.id}">Remove</button>
        </span>
      </div>`;
    wrap.appendChild(card);
  }
  // git status pills (best effort, in parallel — never blocks the list)
  for (const p of list) {
    window.devkit.projectGitStatus(p.id).then((st) => {
      const card = $(`.proj-open[data-id="${p.id}"]`)?.closest('.proj-card');
      if (!card) return;
      const pill = card.querySelector('[data-role="branch"]');
      if (st.isGit && st.branch) {
        pill.className = `pill ${st.dirty ? 'pill-warn' : 'pill-ok'}`;
        pill.innerHTML = `<span class="dot"></span>${st.branch}${st.dirty ? ` · ${st.dirty} changed` : ''}`;
      } else if (st.isGit) {
        pill.className = 'pill';
        pill.textContent = 'git repo';
      } else {
        pill.remove(); // plain folder — no git badge
      }
    }).catch(() => {});
  }
}

async function runClone() {
  if (projBusy) return;
  const url = $('#projCloneUrl').value.trim();
  if (!url) return toast('Paste a repo first — owner/repo or a full URL', true);
  setProjBusy(true, 'Cloning…');
  appendProjLog('');
  try {
    await window.devkit.projectClone(url);
    $('#projCloneUrl').value = '';
    toast('Clone finished — project registered');
  } catch (e) { toast(e.message, true); }
  finally { setProjBusy(false, ''); refreshProjects(); }
}

async function runAdd() {
  if (projBusy) return;
  const folder = $('#projFolderPath').value.trim();
  if (!folder) return toast('Paste the folder path first', true);
  try {
    await window.devkit.projectAdd(folder);
    $('#projFolderPath').value = '';
    toast('Folder registered');
    refreshProjects();
  } catch (e) { toast(e.message, true); }
}

// ── github page ───────────────────────────────────────────────
function renderGithub(st) {
  const authed = !!st;
  $('#ghUnauth').classList.toggle('hidden', authed);
  $('#ghAuthed').classList.toggle('hidden', !authed);
  if (!authed) return;
  $('#ghAvatar').src = st.avatarUrl || '';
  $('#ghLogin').textContent = `@${st.login}`;
  $('#ghTypePill').textContent = st.type === 'device' ? 'OAuth device flow' : 'Personal access token';
  const since = new Date(st.createdAt).toLocaleDateString();
  $('#ghMeta').textContent = [st.name, st.email, `signed in ${since}`].filter(Boolean).join(' · ');
  const scopes = $('#ghScopes');
  scopes.innerHTML = '';
  for (const s of String(st.scopes || '').split(/\s+/).filter(Boolean)) {
    const p = document.createElement('span');
    p.className = 'pill';
    p.textContent = s;
    scopes.appendChild(p);
  }
}

function ghMsg(text, isErr) {
  const el = $('#ghMsg');
  if (!text) { el.classList.add('hidden'); return; }
  el.textContent = text;
  el.className = `msg-line${isErr ? ' err' : ''}`;
}

let ghBusy = false;

function resetDeviceBox() {
  $('#ghDeviceBox').classList.add('hidden');
  $('#ghDeviceCode').classList.add('hidden');
}

function setGhStatus(text) {
  if (!text) { $('#ghStatusBox').classList.add('hidden'); return; }
  $('#ghStatusText').textContent = text;
  $('#ghStatusBox').classList.remove('hidden');
}

async function startGithubSignIn() {
  if (ghBusy) return;
  ghBusy = true;
  $('#btnGhSignIn').disabled = true;
  $('#ghSetupBox').classList.add('hidden');
  setGhStatus('Opening your browser…');
  try {
    const res = await window.devkit.startBrowser();
    if (res && res.needsClientId) {
      // one-time setup needed — show the OAuth App instructions + client ID field, and make it impossible to miss
      const box = $('#ghSetupBox');
      box.classList.remove('hidden');
      setGhStatus('One-time setup needed first — paste your Client ID below (2 minutes)');
      setTimeout(() => box.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
    } else {
      setGhStatus('Waiting for the browser sign-in — approve it at github.com (opens in Brave when installed)');
    }
  } catch (e) {
    setGhStatus('');
    ghMsg(e.message, true);
  } finally {
    ghBusy = false;
    $('#btnGhSignIn').disabled = false;
  }
}

// ── settings page ─────────────────────────────────────────────
const ACCENTS = ['#6e7bff', '#22d3ee', '#3dd68c', '#f472b6', '#ffb454'];

function renderSettings() {
  $('#setRoot').value = settings.root;
  $('#setTheme').value = settings.theme;
  $('#setHotkey').value = settings.hotkey || '';
  $('#setMotion').checked = !!settings.reduceMotion;
  const row = $('#accentRow');
  row.innerHTML = '';
  for (const a of ACCENTS) {
    const sw = document.createElement('span');
    sw.className = `swatch${a === settings.accent ? ' active' : ''}`;
    sw.style.background = a;
    sw.title = a;
    sw.onclick = () => window.devkit.setSetting('accent', a).then(applySettings);
    row.appendChild(sw);
  }
  const custom = document.createElement('label');
  custom.className = 'swatch swatch-custom';
  custom.title = 'Custom colour';
  custom.innerHTML = '<input type="color" value="' + settings.accent + '">';
  custom.querySelector('input').oninput = (e) => window.devkit.setSetting('accent', e.target.value).then(applySettings);
  row.appendChild(custom);
}

function checkRootWarn() {
  const v = $('#setRoot').value.trim();
  $('#rootWarn').classList.toggle('hidden', !/^c:/i.test(v));
}

// ── init ──────────────────────────────────────────────────────
(async function init() {
  // window controls
  $('#btnMin').onclick = () => window.devkit.minimizeWindow();
  $('#btnClose').onclick = () => window.devkit.closeWindow();

  // pop animation on summon
  window.devkit.onWindowShown(() => {
    const app = $('#app');
    app.classList.remove('pop');
    void app.offsetWidth; // reflow to restart animation
    app.classList.add('pop');
  });

  try {
    const info = await window.devkit.appInfo();
    $('#verChip').textContent = `v${info.version}`;
    $('#rootChip').textContent = info.root;
    $('#rootChip').title = info.root;
  } catch (e) { /* non-fatal */ }

  try { applySettings(await window.devkit.getSettings()); } catch (e) { toast(`settings failed: ${e.message}`, true); return; }

  // nav
  $$('.nav-item').forEach((b) => (b.onclick = () => setNav(b.dataset.page)));
  const hash = location.hash.replace('#/', '');
  if (['projects', 'services', 'toolchain', 'github', 'settings'].includes(hash)) setNav(hash);

  // projects (M2)
  if (settings) $('#projCloneDest').textContent = `${settings.root}\\projects`;
  window.devkit.onProjectsLog(appendProjLog);
  $('#btnProjClone').onclick = runClone;
  $('#projCloneUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') runClone(); });
  $('#btnProjAdd').onclick = runAdd;
  $('#projFolderPath').addEventListener('keydown', (e) => { if (e.key === 'Enter') runAdd(); });
  $('#projList').addEventListener('click', async (e) => {
    const openBtn = e.target.closest('.proj-open');
    const pullBtn = e.target.closest('.proj-pull');
    const rmBtn = e.target.closest('.proj-remove');
    try {
      if (openBtn) { await window.devkit.projectOpen(openBtn.dataset.id); toast('Opening in VS Code…'); }
      else if (pullBtn && !projBusy) {
        setProjBusy(true, 'Pulling…'); appendProjLog('');
        try { await window.devkit.projectPull(pullBtn.dataset.id); toast('Pulled — up to date'); }
        catch (err2) { toast(err2.message, true); }
        finally { setProjBusy(false, ''); refreshProjects(); }
      } else if (rmBtn) {
        if (!confirm(`Remove "${rmBtn.dataset.id}" from the registry? Files on disk are not touched.`)) return;
        await window.devkit.projectRemove(rmBtn.dataset.id);
        toast('Removed from registry');
        refreshProjects();
      }
    } catch (err2) { toast(err2.message, true); }
  });
  refreshProjects();

  // toolchain
  $('#btnTcRefresh').onclick = refreshToolchain;
  $('#btnTcProvision').onclick = () => runProvision([], 'Working…');
  $('#rtGrid').addEventListener('click', (e) => {
    const btn = e.target.closest('.rt-force');
    if (btn && !provisioning) runProvision(['--force=' + btn.dataset.name], `Reinstalling ${btn.dataset.name}…`);
  });
  window.devkit.onToolchainLog(appendLog);
  refreshToolchain();

  // github — one-click browser sign-in (PKCE), device code + PAT as fallbacks
  if (settings) $('#ghCallback').value = settings.githubCallback || 'http://127.0.0.1';
  const ghStatus = () => window.devkit.githubStatus().then(renderGithub).catch(() => {});
  await ghStatus();
  window.devkit.onGithubEvent((ev) => {
    if (ev.type === 'authed') {
      setGhStatus('');
      resetDeviceBox();
      renderGithub(ev.store);
      toast(`Signed in as @${ev.store.login} — git is wired to this account`);
    } else if (ev.type === 'failed') {
      setGhStatus('');
      resetDeviceBox();
      ghMsg(ev.message, true);
    } else if (ev.type === 'cancelled') {
      setGhStatus('');
      resetDeviceBox();
      toast('Sign-in cancelled');
    } else if (ev.type === 'code') {
      // device flow: show the one-time code
      $('#ghDeviceBox').classList.remove('hidden');
      const c = $('#ghDeviceCode');
      c.textContent = ev.userCode;
      c.classList.remove('hidden');
      $('#ghDeviceStatus').textContent = `Enter this code at ${ev.verificationUri} — or use the button below`;
    } else if (ev.type === 'success') {
      $('#ghDeviceStatus').textContent = 'Approved — fetching your token…';
    }
  });
  $('#btnGhSignIn').onclick = () => startGithubSignIn();
  $('#btnGhCancel').onclick = () => { window.devkit.cancelDevice(); setGhStatus(''); };
  $('#ghHowto').onclick = (e) => { e.preventDefault(); window.devkit.openUrl('https://github.com/settings/developers'); };
  $('#btnGhSaveId').onclick = async () => {
    const id = $('#ghClientId').value.trim();
    if (!id) return ghMsg('Paste the Client ID first', true);
    try {
      applySettings(await window.devkit.setSetting('githubClientId', id));
      applySettings(await window.devkit.setSetting('githubCallback', $('#ghCallback').value.trim() || 'http://127.0.0.1:8465/callback'));
      const sec = $('#ghClientSecret').value.trim();
      if (sec || (settings && settings.githubClientSecret)) {
        applySettings(await window.devkit.setSetting('githubClientSecret', sec)); // only touch it when relevant, so re-saving never silently wipes a stored secret
      }
      ghMsg('', false);
      toast('Saved — starting sign-in…');
      startGithubSignIn(); // their intent was to sign in; continue straight through
    } catch (e) { ghMsg(e.message, true); }
  };

  // device flow — no callback URL involved, works with any OAuth App setup
  $('#btnGhDevice').onclick = async () => {
    const id = ($('#ghClientId').value.trim()) || (settings && settings.githubClientId) || '';
    if (!id) return ghMsg('Save your Client ID first (box above), then try the device code', true);
    resetDeviceBox();
    $('#ghDeviceBox').classList.remove('hidden');
    $('#ghDeviceStatus').textContent = 'Requesting a one-time code…';
    try { await window.devkit.startDevice(id); }
    catch (e) { ghMsg(e.message, true); resetDeviceBox(); }
  };
  $('#btnGhDeviceOpen').onclick = () => window.devkit.openUrl('https://github.com/login/device');
  $('#btnGhDeviceCancel').onclick = () => { window.devkit.cancelDevice(); resetDeviceBox(); };
  $('#btnGhPat').onclick = async () => {
    ghMsg('Validating token…', false);
    try { renderGithub(await window.devkit.setPat($('#ghPat').value)); ghMsg('', false); toast('Connected to GitHub'); }
    catch (e) { ghMsg(e.message, true); }
  };
  $('#btnGhSignout').onclick = async () => { await window.devkit.signOut(); renderGithub(null); toast('Signed out of GitHub'); };

  // reset controls (GitHub page + Settings)
  const doGithubReset = async (msg) => {
    if (!confirm(msg)) return;
    try {
      await window.devkit.resetGithub();
      applySettings(await window.devkit.getSettings());
      $('#ghClientId').value = '';
      $('#ghClientSecret').value = '';
      toast('GitHub reset — saved Client ID / Secret cleared');
    } catch (e) { toast(e.message, true); }
  };
  $('#btnGhReset').onclick = () => doGithubReset('Cancel any in-progress sign-in and clear the saved GitHub Client ID + Secret?');
  $('#btnSetGhSignout').onclick = async () => { await window.devkit.signOut(); renderGithub(null); toast('Signed out of GitHub'); };
  $('#btnSetGhReset').onclick = () => doGithubReset('Clear the saved GitHub Client ID + Secret? (You can paste them again any time.)');

  // settings
  $('#setRoot').addEventListener('input', checkRootWarn);
  $('#btnSetRoot').onclick = async () => {
    const v = $('#setRoot').value.trim();
    if (!v) return;
    try { applySettings(await window.devkit.setSetting('root', v)); }
    catch (e) {
      if (String(e.message).includes('__RELAUNCHING__')) { toast('Restarting with new root…'); setTimeout(() => document.body.style.opacity = '.4', 600); }
      else toast(`Could not change root: ${e.message}`, true);
    }
  };
  $('#setTheme').onchange = (e) => window.devkit.setSetting('theme', e.target.value).then(applySettings);
  $('#setMotion').onchange = (e) => window.devkit.setSetting('reduceMotion', e.target.checked).then(applySettings);
  $('#btnSetHotkey').onclick = async () => {
    try { applySettings(await window.devkit.setSetting('hotkey', $('#setHotkey').value.trim())); toast('Hotkey saved'); }
    catch (e) { toast(e.message, true); }
  };
  renderSettings();
})();
