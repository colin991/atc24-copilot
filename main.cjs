// ATC 24 Copilot: a small always-on-top overlay that hears ATC calls,
// tells you what to do and what to read back.
const { app, BrowserWindow, ipcMain, globalShortcut, screen, session, desktopCapturer, shell } = require("electron");
const path = require("path");
const fs = require("fs");

const RADAR = "https://atc24-radar-mauve.vercel.app";
const VERSION = app.getVersion();
let win = null;
let clickThrough = false;

// Lets the built-in speech model use several CPU cores (much faster on PCs
// without a usable graphics card).
app.commandLine.appendSwitch("enable-features", "SharedArrayBuffer");
// COPILOT_NO_GPU=1: test as if this PC had no usable graphics card.
if (process.env.COPILOT_NO_GPU) app.commandLine.appendSwitch("disable-gpu");
// Test runs from the source folder get their own profile, so they never
// clash with an installed copy that is already open.
if (!app.isPackaged) app.setPath("userData", path.join(app.getPath("appData"), "atc24-copilot-dev"));

// ---- window position is remembered between runs ---------------------------
const stateFile = () => path.join(app.getPath("userData"), "window.json");
function loadBounds() {
  try { return JSON.parse(fs.readFileSync(stateFile(), "utf8")); } catch { return null; }
}
function saveBounds() {
  if (!win || win.isDestroyed()) return;
  try { fs.writeFileSync(stateFile(), JSON.stringify(win.getBounds())); } catch {}
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  const saved = loadBounds();
  const w = 380, h = 600;
  win = new BrowserWindow({
    width: saved?.width || w,
    height: saved?.height || h,
    x: saved?.x ?? area.x + area.width - w - 16,
    y: saved?.y ?? area.y + 16,
    minWidth: 300,
    minHeight: 200,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    hasShadow: false,
    backgroundColor: "#00000000",
    title: "ATC 24 Copilot",
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep listening when the game has focus
    },
  });
  // Above borderless-fullscreen games too.
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  // COPILOT_SMOKE=1: print the page's console and quit after a few seconds (for checks).
  if (process.env.COPILOT_SMOKE) {
    win.webContents.on("console-message", (_e, level, message, line, source) => console.log(`[page ${level}] ${message} (${path.basename(source || "")}:${line})`));
    win.webContents.on("did-finish-load", () => {
      console.log("[smoke] page loaded");
      // COPILOT_TEST_WAV=<file>: feed a recorded call in as if it was heard.
      if (process.env.COPILOT_TEST_WAV) {
        const b64 = fs.readFileSync(process.env.COPILOT_TEST_WAV).toString("base64");
        // Feeds it 3 times and logs how long each took (the first includes loading the model).
        setTimeout(() => win.webContents.executeJavaScript(`(async () => { localStorage.setItem("callsign","Speedbird-208"); const buf = Uint8Array.from(atob("${b64}"), c => c.charCodeAt(0)).buffer; for (let i = 0; i < 3; i++) { const t = performance.now(); await window.__clip(buf.slice(0)); console.log("[timing] call " + (i + 1) + ": " + Math.round(performance.now() - t) + " ms, " + document.getElementById("sttMode").textContent + ", say: " + document.getElementById("say").textContent); } })()`).catch((e) => console.log("[smoke] feed failed", e.message)), 1500);
      }
    });
    setTimeout(async () => {
      try { console.log("[smoke] state:", await win.webContents.executeJavaScript("JSON.stringify({dot: document.getElementById('dot').title, stt: document.getElementById('sttMode').textContent, flight: document.getElementById('flight').textContent, heard: document.getElementById('heard').textContent, do: document.getElementById('doList').innerText, say: document.getElementById('say').textContent})")); } catch (e) { console.log("[smoke] eval failed", e.message); }
      app.quit();
    }, +process.env.COPILOT_SMOKE > 1 ? +process.env.COPILOT_SMOKE : 7000);
  }
  win.on("moved", saveBounds);
  win.on("resized", saveBounds);
  win.on("closed", () => { win = null; });
  // Links open in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: "deny" }; });
}

function setClickThrough(on) {
  clickThrough = on;
  if (!win) return;
  win.setIgnoreMouseEvents(on, { forward: true });
  win.webContents.send("click-through", on);
}

app.whenReady().then(() => {
  // "System audio": capture what you hear (game + Discord) without a screen
  // picker. Windows supports loopback audio capture directly.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ["screen"] }).then((sources) => {
      callback({ video: sources[0], audio: "loopback" });
    }).catch(() => callback({}));
  });
  // Only the microphone/screen-audio permissions this app needs.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(["media", "display-capture"].includes(permission)));

  createWindow();

  // Ctrl+Shift+X: clicks go through the overlay to the game (and back).
  globalShortcut.register("CommandOrControl+Shift+X", () => setClickThrough(!clickThrough));
  // Ctrl+Shift+H: hide / show.
  globalShortcut.register("CommandOrControl+Shift+H", () => { if (!win) return; win.isVisible() ? win.hide() : win.showInactive(); });
  // Ctrl+Shift+P: pause / resume listening.
  globalShortcut.register("CommandOrControl+Shift+P", () => win?.webContents.send("toggle-listen"));

  // Updates from GitHub Releases (installed copies update themselves).
  // The page is told every step so the settings panel can show it.
  let status = { state: app.isPackaged ? "idle" : "dev", version: VERSION };
  const tell = (s) => { status = { ...status, ...s }; win?.webContents.send("update-status", status); };
  ipcMain.handle("update-status", () => status);
  try {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("checking-for-update", () => tell({ state: "checking" }));
    autoUpdater.on("update-not-available", () => tell({ state: "latest", checkedAt: Date.now() }));
    autoUpdater.on("update-available", (info) => tell({ state: "downloading", next: info.version, percent: 0 }));
    autoUpdater.on("download-progress", (p) => tell({ state: "downloading", percent: Math.round(p.percent || 0) }));
    autoUpdater.on("update-downloaded", (info) => { tell({ state: "ready", next: info.version }); win?.webContents.send("update-ready", info.version); });
    autoUpdater.on("error", (e) => tell({ state: "error", error: String(e?.message || e).slice(0, 120) }));
    const check = () => { if (status.state === "downloading" || status.state === "ready") return; autoUpdater.checkForUpdates().catch(() => {}); };
    if (app.isPackaged) { check(); setInterval(check, 30 * 60 * 1000); }
    ipcMain.handle("check-update", () => { if (!app.isPackaged) return status; check(); return status; });
    ipcMain.on("install-update", () => autoUpdater.quitAndInstall(true, true)); // silent, then reopen
  } catch {
    ipcMain.handle("check-update", () => status);
  }
});

app.on("window-all-closed", () => app.quit());
// Hotkeys only exist once the app is ready (a second copy quits before that).
app.on("will-quit", () => { if (app.isReady()) globalShortcut.unregisterAll(); });
// Only one copy: opening it again just brings the first one forward.
if (!app.requestSingleInstanceLock()) { app.exit(0); }
else app.on("second-instance", () => { if (win) { win.show(); win.focus(); } });

// ---- network (done here, not in the page, so there are no CORS limits) -----
const UA = `ATC24-Copilot/${VERSION}`;
ipcMain.handle("acft", async (_e, server) => {
  try {
    const r = await fetch(`${RADAR}/api/acft${server === "event" ? "?server=event" : ""}`, { headers: { "User-Agent": UA } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
});
// For "My calls": ATIS letters/runways, airport positions, and your flight
// plan (from the radar's live server, which is the only place plans are kept).
const LIVE = "https://atc24-radar-live.onrender.com";
const getJson = async (url) => {
  try { const r = await fetch(url, { headers: { "User-Agent": UA } }); return r.ok ? await r.json() : null; } catch { return null; }
};
ipcMain.handle("atis", () => getJson(`${RADAR}/api/atis`));
ipcMain.handle("airports", () => getJson(`${RADAR}/airports.json`));
ipcMain.handle("plan", (_e, q) => getJson(`${LIVE}/api/plan?q=${encodeURIComponent(String(q || "").slice(0, 60))}`));
ipcMain.handle("stt-status", async () => {
  try { const r = await fetch(`${RADAR}/api/stt`, { headers: { "User-Agent": UA } }); return r.ok ? await r.json() : { fast: false }; }
  catch { return { fast: false }; }
});
ipcMain.handle("stt", async (_e, wav) => {
  try {
    const r = await fetch(`${RADAR}/api/stt`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav", "X-ATC-Copilot": VERSION, "User-Agent": UA },
      body: Buffer.from(wav),
    });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { text: j.text, ms: j.ms } : { error: j.error || `HTTP ${r.status}`, status: r.status };
  } catch { return { error: "offline" }; }
});
ipcMain.on("click-through", (_e, on) => setClickThrough(!!on));
ipcMain.on("quit", () => app.quit());
ipcMain.on("minimize", () => win?.minimize());
ipcMain.handle("version", () => VERSION);
