const { contextBridge, ipcRenderer } = require('electron');

const ORIGIN_ARG = '--cc-origin=';
const origin = process.argv.find((arg) => arg.startsWith(ORIGIN_ARG))?.slice(ORIGIN_ARG.length);

// Only the dashboard's own top frame gets the terminal, so a page it frames, or one it was sent to, cannot type into Claude Code.
if (origin && window.top === window && location.origin === origin) {
  contextBridge.exposeInMainWorld('ccTerminal', {
    write: (data) => ipcRenderer.send('terminal:write', String(data)),
    resize: (cols, rows) => ipcRenderer.send('terminal:resize', Number(cols), Number(rows)),
    attach: (cols, rows) => ipcRenderer.send('terminal:attach', Number(cols), Number(rows)),
    onData: (listener) => ipcRenderer.on('terminal:data', (_event, data) => listener(data)),
  });
}
