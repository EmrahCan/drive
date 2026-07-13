// Lexora Masaüstü Ajanı — Electron main process
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const chokidar = require("chokidar");
const Store = require("electron-store");
const { createClient } = require("@supabase/supabase-js");
const fetch = require("node-fetch");
const FormData = require("form-data");

// ---- CONFIG: bu değerler Lexora projesine sabittir ----
const SUPABASE_URL = "https://cfogzfiqmiaagvwctmoj.supabase.co";
const SUPABASE_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNmb2d6ZmlxbWlhYWd2d2N0bW9qIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM4Nzg4MjAsImV4cCI6MjA5OTQ1NDgyMH0.UR_cwXKu-xeDjHYzVKcZKsuPxuXgmFhHeaywBBHUbj8";
const APP_URL = "https://sherlock-lawyer.lovable.app";

const DEFAULT_INCLUDE_EXT = [".pdf", ".docx", ".doc", ".txt", ".rtf", ".odt"];
const DEFAULT_EXCLUDE_PATTERNS = ["node_modules", ".git", ".tmp", "~$"];
const MAX_SIZE = 20 * 1024 * 1024;

const store = new Store({
  defaults: {
    folders: [],
    synced: {},
    session: null,
    filters: {
      includeExts: DEFAULT_INCLUDE_EXT,
      excludePatterns: DEFAULT_EXCLUDE_PATTERNS,
    },
    rescanMinutes: 60,
    autoStart: true,
  },
});

function applyAutoStart(enabled) {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      openAsHidden: true,
      args: ["--hidden"],
    });
  } catch (e) {
    console.error("autostart failed", e);
  }
}


function getFilters() {
  const f = store.get("filters") || {};
  return {
    includeExts: (f.includeExts && f.includeExts.length ? f.includeExts : DEFAULT_INCLUDE_EXT)
      .map((e) => (e.startsWith(".") ? e.toLowerCase() : "." + e.toLowerCase())),
    excludePatterns: f.excludePatterns || [],
  };
}

function globToRegex(pattern) {
  // Simple glob → regex: * = any chars, ? = single char; case-insensitive
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(esc, "i");
}

function isExcluded(fullPath) {
  const { excludePatterns } = getFilters();
  const norm = fullPath.replace(/\\/g, "/");
  return excludePatterns.some((p) => {
    if (!p) return false;
    if (p.includes("*") || p.includes("?")) return globToRegex(p).test(norm);
    return norm.toLowerCase().includes(p.toLowerCase());
  });
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let win;
let tray;
let watchers = [];
let queue = [];
let processing = false;

function createWindow(showImmediately = true) {
  win = new BrowserWindow({
    width: 900,
    height: 640,
    show: showImmediately,
    title: "Lexora Agent",
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "renderer.html"));
  win.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function createTray() {
  let icon = nativeImage.createFromPath(path.join(__dirname, "build", "icon.png"));
  if (!icon.isEmpty()) icon = icon.resize({ width: 18, height: 18 });
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip("Lexora Agent");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Ajanı aç", click: () => win.show() },
      { label: "Şimdi tara", click: () => fullRescan("tepsi") },
      { type: "separator" },
      { label: "Çıkış", click: () => { app.isQuitting = true; app.quit(); } },
    ]),
  );
  tray.on("click", () => win.show());
}

async function login(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  store.set("session", data.session);
  return data.session;
}

async function getAccessToken() {
  const s = store.get("session");
  if (!s) throw new Error("Oturum yok");
  const now = Math.floor(Date.now() / 1000);
  if (s.expires_at && s.expires_at - 60 > now) return s.access_token;
  const { data, error } = await supabase.auth.refreshSession({ refresh_token: s.refresh_token });
  if (error) throw new Error("Oturum yenilenemedi: " + error.message);
  store.set("session", data.session);
  return data.session.access_token;
}

async function uploadFile(filePath) {
  if (isExcluded(filePath)) return;
  const ext = path.extname(filePath).toLowerCase();
  const { includeExts } = getFilters();
  if (!includeExts.includes(ext)) return;
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_SIZE) {
    log(`Atlandı (20MB üzeri): ${path.basename(filePath)}`);
    return;
  }

  const key = `${filePath}::${stat.mtimeMs}::${stat.size}`;
  const synced = store.get("synced") || {};
  if (synced[key]) return;

  const token = await getAccessToken();
  const form = new FormData();
  form.append("file", fs.createReadStream(filePath), {
    filename: path.basename(filePath),
    contentType: mimeFor(ext),
  });
  // Stable identifier so server can update existing row + re-embed when content changes
  form.append("client_path", filePath);

  log(`Yükleniyor: ${path.basename(filePath)}`);
  const res = await fetch(`${APP_URL}/api/documents/analyze`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    log(`HATA (${res.status}): ${path.basename(filePath)} — ${t.slice(0, 200)}`);
    return;
  }
  let status = "ok";
  try {
    const body = await res.json();
    status = body?.status || "ok";
  } catch { /* ignore */ }
  synced[key] = { at: Date.now(), name: path.basename(filePath), status };
  store.set("synced", synced);
  const label = status === "unchanged" ? "= Değişmemiş" : status === "updated" ? "↻ Güncellendi (yeni embedding)" : "✓ Yüklendi";
  log(`${label}: ${path.basename(filePath)}`);
  sendState();
}

function mimeFor(ext) {
  return {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".doc": "application/msword",
    ".txt": "text/plain",
    ".rtf": "application/rtf",
    ".odt": "application/vnd.oasis.opendocument.text",
  }[ext] || "application/octet-stream";
}

function enqueue(filePath) {
  queue.push(filePath);
  drain();
}

async function drain() {
  if (processing) return;
  processing = true;
  while (queue.length) {
    const p = queue.shift();
    try {
      await uploadFile(p);
    } catch (e) {
      log(`Hata: ${e.message}`);
    }
  }
  processing = false;
}

function startWatchers() {
  stopWatchers();
  const folders = store.get("folders") || [];
  const { excludePatterns } = getFilters();
  for (const dir of folders) {
    if (!fs.existsSync(dir)) continue;
    const w = chokidar.watch(dir, {
      ignored: (p) => /(^|[\/\\])\../.test(p) || isExcluded(p),
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 500 },
    });
    w.on("add", (p) => enqueue(p));
    w.on("change", (p) => enqueue(p));
    w.on("unlink", (p) => enqueueDelete(p));
    watchers.push(w);
  }
  log(`${folders.length} klasör izleniyor. Filtreler: ${getFilters().includeExts.join(",")} | hariç: ${excludePatterns.join(",") || "-"}`);
}

function stopWatchers() {
  for (const w of watchers) w.close();
  watchers = [];
}

function walkDir(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (isExcluded(full)) continue;
    if (e.isDirectory()) walkDir(full, out);
    else if (e.isFile()) out.push(full);
  }
  return out;
}

async function fullRescan(reason = "manuel") {
  const folders = store.get("folders") || [];
  if (!folders.length) return;
  log(`Tam tarama başladı (${reason})…`);
  let count = 0;
  for (const dir of folders) {
    const files = walkDir(dir);
    for (const f of files) { enqueue(f); count++; }
    // Silinen dosyalar: sunucudaki bu klasöre ait kayıtları mevcut listeyle karşılaştır.
    await sweepDeleted(dir, files).catch((e) => log(`Silme senkron hatası: ${e.message}`));
  }
  log(`Tam tarama: ${count} dosya kuyruğa alındı (değişmemişler atlanacak).`);
}

async function deleteRemote(filePath, reason = "agent-unlink") {
  try {
    const token = await getAccessToken();
    const res = await fetch(`${APP_URL}/api/documents/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ client_path: filePath, reason }),
    });
    if (!res.ok) {
      log(`Silme HATA (${res.status}): ${path.basename(filePath)}`);
      return;
    }
    const body = await res.json().catch(() => ({ deleted: 0 }));
    if (body.deleted > 0) {
      log(`🗑 Silindi (vektör dahil): ${path.basename(filePath)}`);
      // synced önbelleğinden bu dosyanın tüm anahtarlarını çıkar.
      const synced = store.get("synced") || {};
      for (const k of Object.keys(synced)) {
        if (k.startsWith(filePath + "::")) delete synced[k];
      }
      store.set("synced", synced);
      sendState();
    }
  } catch (e) {
    log(`Silme hatası: ${e.message}`);
  }
}

function enqueueDelete(filePath) {
  // chokidar unlink olayı: dosya artık diskte yok.
  deleteRemote(filePath);
}

async function sweepDeleted(rootDir, presentFiles, reason = "agent-sweep") {
  const token = await getAccessToken();
  const res = await fetch(`${APP_URL}/api/documents/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ root: rootDir, client_paths_present: presentFiles, reason }),
  });
  if (!res.ok) return;
  const body = await res.json().catch(() => ({ deleted: 0 }));
  if (body.deleted > 0) {
    log(`🗑 ${body.deleted} eksik dosya için vektör indeksi temizlendi (${rootDir}).`);
    const synced = store.get("synced") || {};
    for (const p of body.paths || []) {
      for (const k of Object.keys(synced)) {
        if (k.startsWith(p + "::")) delete synced[k];
      }
    }
    store.set("synced", synced);
    sendState();
  }
}

let rescanTimer = null;
function scheduleRescan() {
  if (rescanTimer) { clearInterval(rescanTimer); rescanTimer = null; }
  const mins = Number(store.get("rescanMinutes")) || 0;
  if (mins > 0) {
    rescanTimer = setInterval(() => fullRescan("periyodik"), mins * 60 * 1000);
    log(`Periyodik tarama: her ${mins} dk.`);
  } else {
    log("Periyodik tarama kapalı.");
  }
}


function log(msg) {
  const line = `[${new Date().toLocaleTimeString("tr-TR")}] ${msg}`;
  console.log(line);
  win?.webContents.send("agent:log", line);
}

function buildState() {
  return {
    folders: store.get("folders") || [],
    syncedCount: Object.keys(store.get("synced") || {}).length,
    signedIn: !!store.get("session"),
    email: store.get("session")?.user?.email || null,
    filters: getFilters(),
    rescanMinutes: Number(store.get("rescanMinutes")) || 0,
    autoStart: store.get("autoStart") !== false,
  };
}

function sendState() {
  win?.webContents.send("agent:state", buildState());
}

// ---- IPC ----
ipcMain.handle("agent:getState", () => buildState());

ipcMain.handle("agent:setAutoStart", (_e, enabled) => {
  store.set("autoStart", !!enabled);
  applyAutoStart(!!enabled);
  sendState();
  return !!enabled;
});

ipcMain.handle("agent:scanNow", () => fullRescan("manuel"));
ipcMain.handle("agent:setRescan", (_e, minutes) => {
  const m = Math.max(0, Math.floor(Number(minutes) || 0));
  store.set("rescanMinutes", m);
  scheduleRescan();
  sendState();
  return m;
});


ipcMain.handle("agent:setFilters", (_e, filters) => {
  const clean = {
    includeExts: (filters?.includeExts || [])
      .map((s) => String(s).trim().toLowerCase())
      .filter(Boolean)
      .map((e) => (e.startsWith(".") ? e : "." + e)),
    excludePatterns: (filters?.excludePatterns || [])
      .map((s) => String(s).trim())
      .filter(Boolean),
  };
  if (!clean.includeExts.length) clean.includeExts = DEFAULT_INCLUDE_EXT;
  store.set("filters", clean);
  startWatchers();
  sendState();
  return clean;
});

ipcMain.handle("agent:login", async (_e, { email, password }) => {
  const s = await login(email, password);
  startWatchers();
  scheduleRescan();
  fullRescan("giriş sonrası");
  sendState();
  return { email: s.user.email };
});


ipcMain.handle("agent:logout", () => {
  store.set("session", null);
  stopWatchers();
  sendState();
});

ipcMain.handle("agent:pickFolder", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "multiSelections"] });
  if (r.canceled) return [];
  const folders = new Set(store.get("folders") || []);
  r.filePaths.forEach((p) => folders.add(p));
  store.set("folders", [...folders]);
  startWatchers();
  sendState();
  return [...folders];
});

ipcMain.handle("agent:removeFolder", async (_e, dir) => {
  const folders = (store.get("folders") || []).filter((f) => f !== dir);
  store.set("folders", folders);
  startWatchers();
  // Klasör artık izlenmiyor → içindeki tüm belgelerin vektörünü temizle.
  try {
    await sweepDeleted(dir, [], "folder-removed");
  } catch (e) {
    log(`Klasör temizleme hatası: ${e.message}`);
  }
  sendState();
  return folders;
});

ipcMain.handle("agent:resync", () => {
  store.set("synced", {});
  startWatchers();
  log("Senkron geçmişi temizlendi — tüm dosyalar yeniden yüklenecek.");
});

app.whenReady().then(() => {
  const startedHidden = process.argv.includes("--hidden");
  createWindow(!startedHidden);
  createTray();
  applyAutoStart(store.get("autoStart") !== false);
  if (store.get("session")) {
    startWatchers();
    scheduleRescan();
    fullRescan("başlangıç");
  }
});

app.on("window-all-closed", (e) => e.preventDefault());
