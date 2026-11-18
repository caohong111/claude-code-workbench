const { contextBridge, ipcRenderer } = require('electron');

const invoke = channel => (...args) => ipcRenderer.invoke(`panel:${channel}`, ...args);
contextBridge.exposeInMainWorld('claudePanel', {
  getState: invoke('state'),
  openWorkspace: invoke('open-workspace'),
  selectWorkspace: invoke('open-workspace'),
  newSession: invoke('new-session'),
  selectSession: invoke('select-session'),
  deleteSession: invoke('delete-session'),
  listSessions: invoke('list-sessions'),
  listDirectory: invoke('list-directory'),
  readFile: invoke('read-file'),
  sendMessage: invoke('send-message'),
  stopRun: invoke('stop'),
  respondPermission: invoke('permission'),
  pickAttachments: invoke('attachments'),
  chooseAttachments: invoke('attachments'),
  pasteImage: invoke('paste-image'),
  getChatAsset: invoke('chat-asset'),
  openChatAsset: invoke('open-chat-asset'),
  saveChatAsset: invoke('save-chat-asset'),
  revealFile: invoke('reveal-file'),
  openInExplorer: invoke('reveal-file'),
  openConfigDirectory: invoke('open-config'),
  openSettings: invoke('connection'),
  refreshModels: invoke('models'),
  pickAppearance: invoke('appearance-pick'),
  resetAppearance: invoke('appearance-reset'),
  getCommands: invoke('commands'),
  executeCommand: invoke('command'),
  savePreferences: invoke('preferences'),
  clearError: invoke('clear-error'),
  onState(callback) {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('panel:state', listener);
    return () => ipcRenderer.removeListener('panel:state', listener);
  },
});
