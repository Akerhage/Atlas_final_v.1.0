const { contextBridge, ipcRenderer } = require('electron'); // <-- FIXAT: Stort 'R'

contextBridge.exposeInMainWorld('electronAPI', {

// Hämtar all app-info (inkl. API-nyckel och versioner)
getAppInfo: () => ipcRenderer.invoke('get-app-info'),

// Chatt-funktioner
copyToClipboard: (text) => ipcRenderer.send('copy-to-clipboard', text),
onProcessClipboard: (callback) => {
ipcRenderer.on('process-clipboard-text', (event, text) => {
callback(text);
});
},
 
// Mall-funktioner
loadTemplates: () => ipcRenderer.invoke('load-templates'),
saveTemplates: (templates) => ipcRenderer.invoke('save-templates', templates)
});