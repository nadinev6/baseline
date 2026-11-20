"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("practiceBridge", Object.freeze({
  getPresageApiKey: () => ipcRenderer.invoke("practice:get-presage-api-key"),
  logTelemetry: (message) => ipcRenderer.send("practice:app-log", String(message)),
  onShowInformation: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("practice:show-information", listener);
    return () => ipcRenderer.removeListener("practice:show-information", listener);
  },
  onShowHandedness: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("practice:show-handedness", listener);
    return () => ipcRenderer.removeListener("practice:show-handedness", listener);
  },
  onShowMicrophoneSettings: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("practice:show-microphone-settings", listener);
    return () => ipcRenderer.removeListener("practice:show-microphone-settings", listener);
  },
  onShowCameraSettings: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("practice:show-camera-settings", listener);
    return () => ipcRenderer.removeListener("practice:show-camera-settings", listener);
  },
  onShowVideoSettings: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("practice:show-video-settings", listener);
    return () => ipcRenderer.removeListener("practice:show-video-settings", listener);
  },
  setSensorFeatureState: (features) => {
    if (!features || typeof features !== "object") return;
    ipcRenderer.send("practice:sensor-feature-state", {
      pulse: features.pulse === true,
      hrv: features.hrv === true,
      talking: features.talking === true,
      headDirection: features.headDirection === true,
    });
  },
  onSensorFeatureToggle: (callback) => {
    const listener = (_event, setting) => callback(setting);
    ipcRenderer.on("practice:sensor-feature-toggle", listener);
    return () => ipcRenderer.removeListener("practice:sensor-feature-toggle", listener);
  },
  startLocalStt: () => ipcRenderer.invoke("practice:stt-start"),
  sendLocalSttAudio: (samples, timeAbsMs) => ipcRenderer.invoke("practice:stt-audio", samples, timeAbsMs),
  flushLocalStt: (timeAbsMs, requestId) => ipcRenderer.invoke("practice:stt-flush", timeAbsMs, requestId),
  stopLocalStt: () => ipcRenderer.invoke("practice:stt-stop"),
  onLocalSttResult: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on("practice:stt-result", listener);
    return () => ipcRenderer.removeListener("practice:stt-result", listener);
  },
}));
