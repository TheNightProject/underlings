const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ccViewer', {
  run: (verb) => ipcRenderer.send('viewer:run', String(verb)),
  onState: (listener) => {
    ipcRenderer.on('viewer:state', (_event, state) => listener(state));
    ipcRenderer.send('viewer:ready');
  },
});
