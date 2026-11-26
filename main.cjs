// ATC 24 Copilot: a small always-on-top overlay that hears ATC calls,
// tells you what to do and what to read back.
const { app, BrowserWindow, ipcMain, globalShortcut, screen, session, desktopCapturer, shell } = require("electron");
const path = require("path");
const fs = require("fs");

const RADAR = "https://atc24-radar-mauve.vercel.app";
const VERSION = app.getVersion();
let win = null;
let clickThrough = false;

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
        setTimeout(() => win.webContents.executeJavaScript(`localStorage.setItem("callsign","Speedbird-208"); window.__clip(Uint8Array.from(atob("${b64}"), c => c.charCodeAt(0)).buffer)`).catch((e) => console.log("[smoke] feed failed", e.message)), 1500);
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
  try {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoDownload = true;
    autoUpdater.on("update-downloaded", (info) => win?.webContents.send("update-ready", info.version));
    const check = () => autoUpdater.checkForUpdates().catch(() => {});
    if (app.isPackaged) { check(); setInterval(check, 30 * 60 * 1000); }
    ipcMain.on("install-update", () => autoUpdater.quitAndInstall());
  } catch {}
});

app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => globalShortcut.unregisterAll());
if (!app.requestSingleInstanceLock()) app.quit();
else app.on("second-instance", () => { if (win) { win.show(); win.focus(); } });

// ---- network (done here, not in the page, so there are no CORS limits) -----
const UA = `ATC24-Copilot/${VERSION}`;
ipcMain.handle("acft", async (_e, server) => {
  try {
    const r = await fetch(`${RADAR}/api/acft${server === "event" ? "?server=event" : ""}`, { headers: { "User-Agent": UA } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
});
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
