"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");
const { app, BrowserWindow, ipcMain, Menu, session } = require("electron");
const { bindSmartSpectraIpc } = require("@smartspectra/node-sdk/main");

let mainWindow;
let sttWorker = null;
let sensorFeatureMenuItems = new Map();

// One app instance owns the session. Dual windows launched from terminals
// with different environment snapshots (with/without the API key) otherwise
// coexist and accept sessions with silently different telemetry coverage.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function stopSttWorker() {
  if (!sttWorker) return;
  const worker = sttWorker;
  sttWorker = null;
  try {
    worker.stdin.end();
  } catch {
    // worker already gone
  }
  worker.kill();
}

function createApplicationMenu() {
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "Information…",
          accelerator: "CmdOrCtrl+I",
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send("practice:show-information");
            }
          },
        },
        {
          label: "Microphone…",
          accelerator: "CmdOrCtrl+M",
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send("practice:show-microphone-settings");
            }
          },
        },
        {
          label: "Camera…",
          accelerator: "CmdOrCtrl+Shift+C",
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send("practice:show-camera-settings");
            }
          },
        },
        {
          label: "Video File…",
          accelerator: "CmdOrCtrl+Shift+V",
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send("practice:show-video-settings");
            }
          },
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Features",
      submenu: [
        {
          id: "feature-handedness",
          label: "Handedness…",
          accelerator: "CmdOrCtrl+H",
          type: "normal",
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send("practice:show-handedness");
            }
          },
        },
        {
          id: "feature-pulse",
          label: "Pulse rate (optional)",
          type: "checkbox",
          checked: false,
          click: (item) => sendToRenderer("practice:sensor-feature-toggle", {
            feature: "pulse",
            enabled: item.checked,
          }),
        },
        {
          id: "feature-hrv",
          label: "HRV (optional)",
          type: "checkbox",
          checked: false,
          click: (item) => sendToRenderer("practice:sensor-feature-toggle", {
            feature: "hrv",
            enabled: item.checked,
          }),
        },
        {
          id: "feature-head-direction",
          label: "Experimental head direction tracking",
          type: "checkbox",
          checked: false,
          click: (item) => sendToRenderer("practice:sensor-feature-toggle", {
            feature: "headDirection",
            enabled: item.checked,
          }),
        },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  const menu = Menu.buildFromTemplate(template);
  sensorFeatureMenuItems = new Map(
    ["pulse", "hrv", "headDirection"].map((feature) => [
      feature,
      menu.getMenuItemById(`feature-${feature}`),
    ]),
  );
  Menu.setApplicationMenu(menu);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    minWidth: 1280,
    minHeight: 720,
    maxWidth: 1280,
    maxHeight: 720,
    icon: path.join(__dirname, "icon.png"),
    backgroundColor: "#e4e9ee",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  bindSmartSpectraIpc(mainWindow);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.on("closed", () => {
    stopSttWorker();
    ipcMain.removeHandler("practice:get-presage-api-key");
    ipcMain.removeHandler("practice:stt-start");
    ipcMain.removeHandler("practice:stt-audio");
    ipcMain.removeHandler("practice:stt-flush");
    ipcMain.removeHandler("practice:stt-stop");
    ipcMain.removeAllListeners("practice:app-log");
    ipcMain.removeAllListeners("practice:sensor-feature-state");
    mainWindow = null;
  });

  ipcMain.handle("practice:get-presage-api-key", (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents ||
        event.senderFrame !== mainWindow.webContents.mainFrame) {
      throw new Error("Presage credentials are available only to the app window.");
    }
    const apiKey = process.env.PRESAGE_API_KEY || null;
    if (apiKey) {
      console.log(
        `[SmartSpectra/main] Presage API key served to renderer: ` +
          `${apiKey.length} chars (${apiKey.slice(0, 2)}…${apiKey.slice(-2)})`,
      );
    } else {
      console.log("[SmartSpectra/main] Presage API key not set; renderer will report api_key_required");
    }
    return apiKey;
  });

  const isAppWindowSender = (event) =>
    mainWindow && event.sender === mainWindow.webContents &&
    event.senderFrame === mainWindow.webContents.mainFrame;

  ipcMain.on("practice:sensor-feature-state", (event, features) => {
    if (!isAppWindowSender(event) || !features || typeof features !== "object") return;
    for (const [feature, item] of sensorFeatureMenuItems) {
      if (item && typeof features[feature] === "boolean") item.checked = features[feature];
    }
  });

  // Renderer telemetry milestones are invisible in `npm start` terminals
  // otherwise: the renderer DevTools console is not the launch terminal.
  ipcMain.on("practice:app-log", (event, message) => {
    if (!isAppWindowSender(event) || typeof message !== "string" || !message.trim()) return;
    console.log(`[SmartSpectra] ${message}`);
  });

  ipcMain.handle("practice:stt-start", (event) => {
    if (!isAppWindowSender(event)) return { ok: false, error: "Rejected." };
    if (sttWorker) return { ok: true };

    const cacheDir = path.join(app.getPath("userData"), "stt-models");
    let worker;
    try {
      worker = spawn("node", [path.join(__dirname, "stt-worker.cjs"), cacheDir], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : String(error) };
    }
    sttWorker = worker;

    worker.on("error", (error) => {
      sttWorker = null;
      sendToRenderer("practice:stt-result", {
        type: "error",
        message: error && error.message ? error.message : String(error),
      });
    });
    worker.on("exit", () => {
      sttWorker = null;
    });

    let stdoutBuffer = "";
    worker.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      let newlineIndex;
      while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        sendToRenderer("practice:stt-result", message);
      }
    });
    worker.stderr.on("data", (chunk) => {
      process.stderr.write(`[stt-worker] ${chunk.toString()}`);
    });
    worker.stdin.on("error", () => {
      // Worker may have exited; downstream writes are guarded by writable check.
    });

    worker.stdin.write(`${JSON.stringify({ type: "start" })}\n`);
    return { ok: true };
  });

  ipcMain.handle("practice:stt-audio", (event, samples, timeAbsMs) => {
    if (!isAppWindowSender(event) || !sttWorker || !sttWorker.stdin.writable) return false;
    sttWorker.stdin.write(`${JSON.stringify({ type: "audio", samples })}\n`);
    return true;
  });

  ipcMain.handle("practice:stt-flush", (event, timeAbsMs, requestId) => {
    if (!isAppWindowSender(event) || !sttWorker || !sttWorker.stdin.writable) return false;
    sttWorker.stdin.write(`${JSON.stringify({ type: "flush", timeAbsMs, requestId })}\n`);
    return true;
  });

  ipcMain.handle("practice:stt-stop", (event) => {
    if (!isAppWindowSender(event)) return false;
    stopSttWorker();
    return true;
  });

  mainWindow.loadFile(path.join(__dirname, "frontend", "index.html"));
}

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;
  if (process.platform === "win32") {
    app.setAppUserModelId("com.baseline.practice");
  }

  session.defaultSession.registerPreloadScript({
    id: "smartspectra-bridge",
    type: "frame",
    filePath: require.resolve("@smartspectra/node-sdk/preload"),
  });

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const url = details?.requestingUrl || webContents.getURL();
    const mediaTypes = details?.mediaTypes || [];
    const permittedMediaTypes = mediaTypes.length > 0 &&
      mediaTypes.every((type) => type === "audio" || type === "video");
    callback(permission === "media" && url.startsWith("file://") && permittedMediaTypes);
  });

  createApplicationMenu();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
