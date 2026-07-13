const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agent", {
  getState: () => ipcRenderer.invoke("agent:getState"),
  login: (creds) => ipcRenderer.invoke("agent:login", creds),
  logout: () => ipcRenderer.invoke("agent:logout"),
  pickFolder: () => ipcRenderer.invoke("agent:pickFolder"),
  removeFolder: (dir) => ipcRenderer.invoke("agent:removeFolder", dir),
  resync: () => ipcRenderer.invoke("agent:resync"),
  setFilters: (filters) => ipcRenderer.invoke("agent:setFilters", filters),
  scanNow: () => ipcRenderer.invoke("agent:scanNow"),
  setRescan: (minutes) => ipcRenderer.invoke("agent:setRescan", minutes),
  setAutoStart: (enabled) => ipcRenderer.invoke("agent:setAutoStart", enabled),
  onLog: (cb) => ipcRenderer.on("agent:log", (_e, l) => cb(l)),
  onState: (cb) => ipcRenderer.on("agent:state", (_e, s) => cb(s)),
});
