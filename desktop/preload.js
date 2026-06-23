'use strict';
/**
 * preload - security bridge
 *
 * Exposes a limited window.api object to the renderer process via contextBridge.
 * The renderer process can only call the methods listed here and cannot access Node / file system directly.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  status: () => ipcRenderer.invoke('account:status'),
  list: () => ipcRenderer.invoke('account:list'),
  capture: (opts) => ipcRenderer.invoke('account:capture', opts),
  use: (id) => ipcRenderer.invoke('account:use', id),
  remove: (id) => ipcRenderer.invoke('account:delete', id),
  rename: (id, label) => ipcRenderer.invoke('account:rename', id, label),
  exportAccounts: (ids) => ipcRenderer.invoke('account:export', ids),
  importAccounts: () => ipcRenderer.invoke('account:import'),
  // OAuth add account (CLI OAuth + system browser redirect)
  oauthStart: (opts) => ipcRenderer.invoke('account:oauth-start', opts),
  oauthCancel: () => ipcRenderer.invoke('account:oauth-cancel'),
  // Flow event subscription (returns unsubscribe function)
  // cb receives event: {type: 'browser-open'|'waiting-login'|'exchanging'|'saved'|'error', ...}
  onFlowEvent: (cb) => {
    const handler = (_e, event) => cb(event);
    ipcRenderer.on('oauth:flow-event', handler);
    return () => ipcRenderer.removeListener('oauth:flow-event', handler);
  },
  quota: () => ipcRenderer.invoke('account:quota'),
  accountQuota: (id) => ipcRenderer.invoke('account:quota-one', id),
  accountQuotas: (ids) => ipcRenderer.invoke('account:quota-many', ids),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  rollback: () => ipcRenderer.invoke('account:rollback'),
});
