'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('devkit', {
  // settings hub
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),

  // toolchain page
  toolchainStatus: () => ipcRenderer.invoke('toolchain:status'),
  provision: (args) => ipcRenderer.invoke('toolchain:provision', args || []),
  onToolchainLog: (cb) => { const l = (_e, line) => cb(line); ipcRenderer.on('toolchain:log', l); return () => ipcRenderer.removeListener('toolchain:log', l); },

  // github page
  githubStatus: () => ipcRenderer.invoke('github:status'),
  startBrowser: (clientId) => ipcRenderer.invoke('github:start-browser', clientId),
  startDevice: (clientId) => ipcRenderer.invoke('github:start-device', clientId),
  cancelDevice: () => ipcRenderer.invoke('github:cancel-device'),
  setPat: (token) => ipcRenderer.invoke('github:set-pat', token),
  signOut: () => ipcRenderer.invoke('github:signout'),
  resetGithub: () => ipcRenderer.invoke('github:reset'),
  onGithubEvent: (cb) => { const l = (_e, ev) => cb(ev); ipcRenderer.on('github:event', l); return () => ipcRenderer.removeListener('github:event', l); },

  // projects page (M2)
  projectsList: () => ipcRenderer.invoke('projects:list'),
  projectAdd: (folderPath) => ipcRenderer.invoke('projects:add', folderPath),
  projectRemove: (id) => ipcRenderer.invoke('projects:remove', id),
  projectOpen: (id) => ipcRenderer.invoke('projects:open', id),
  projectGitStatus: (id) => ipcRenderer.invoke('projects:gitStatus', id),
  projectClone: (rawUrl) => ipcRenderer.invoke('projects:clone', rawUrl),
  projectPull: (id) => ipcRenderer.invoke('projects:pull', id),
  onProjectsLog: (cb) => { const l = (_e, line) => cb(line); ipcRenderer.on('projects:log', l); return () => ipcRenderer.removeListener('projects:log', l); },

  // window controls (frameless)
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),

  // misc
  openUrl: (url) => ipcRenderer.invoke('shell:open', url),
  appInfo: () => ipcRenderer.invoke('app:info'),
  onWindowShown: (cb) => { const l = () => cb(); ipcRenderer.on('window:shown', l); return () => ipcRenderer.removeListener('window:shown', l); },
});
