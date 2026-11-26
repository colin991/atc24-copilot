// The only things the overlay page can ask the app to do.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("copilot", {
  aircraft: (server) => ipcRenderer.invoke("acft", server),
  sttStatus: () => ipcRenderer.invoke("stt-status"),
  transcribe: (wav) => ipcRenderer.invoke("stt", wav),
  version: () => ipcRenderer.invoke("version"),
  setClickThrough: (on) => ipcRenderer.send("click-through", on),
  minimize: () => ipcRenderer.send("minimize"),
  quit: () => ipcRenderer.send("quit"),
  installUpdate: () => ipcRenderer.send("install-update"),
  on: (event, fn) => {
    if (["click-through", "toggle-listen", "update-ready"].includes(event)) ipcRenderer.on(event, (_e, v) => fn(v));
  },
});
