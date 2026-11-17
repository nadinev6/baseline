"use strict";

const {
  SmartSpectraSDK,
  SmartSpectraErrorCode,
  SmartSpectraLogLevel,
  ProcessingStatus,
  ValidationCode,
  MetricType,
} = require("@smartspectra/node-sdk/renderer");
const { decodeMetrics } = require("@smartspectra/node-sdk/messages");
const {
  buildHeadDirectionAnalysis,
  buildRequestedMetrics,
  averagePositiveMetric,
  countBlinkEvents,
  createBlinkTransition,
  computeCardioBaseline,
  computeCardioResponse,
  extractBiometricReadings,
  hasPositiveMeasurement,
} = require("./telemetry-analysis");
const { headDirectionFromLandmarks, HEAD_DIRECTION_SOURCE } = require("./gaze-estimation");

const $ = (selector) => document.querySelector(selector);
const SENSOR_FEATURE_PREFERENCE_KEY = "baseline.sensorFeatures";
const DEFAULT_SENSOR_FEATURES = Object.freeze({ pulse: true, hrv: true, headDirection: false });

function readSensorFeaturePreferences() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(SENSOR_FEATURE_PREFERENCE_KEY) || "{}");
    return {
      pulse: typeof saved.pulse === "boolean" ? saved.pulse : DEFAULT_SENSOR_FEATURES.pulse,
      hrv: typeof saved.hrv === "boolean" ? saved.hrv : DEFAULT_SENSOR_FEATURES.hrv,
      headDirection: typeof saved.headDirection === "boolean" ? saved.headDirection : DEFAULT_SENSOR_FEATURES.headDirection,
    };
  } catch {
    return { ...DEFAULT_SENSOR_FEATURES };
  }
}

let sensorFeaturePreferences = readSensorFeaturePreferences();
let activeSessionFeatures = { ...sensorFeaturePreferences };

function getRequestedMetricInfo(features) {
  const codes = buildRequestedMetrics(features, MetricType);
  const names = codes.map((code) =>
    Object.entries(MetricType).find(([, value]) => value === code)?.[0] ?? `METRIC_${code}`,
  );
  return { codes, names };
}

const cameraVideo = $("#camera-video");
const cameraStage = $("#camera-stage");
const cameraPlaceholder = $("#camera-placeholder");
const cameraError = $("#camera-error");
const videoFileInput = $("#video-file-input");
const hudChips = {
  camera: { element: $("#camera-chip"), dot: $("#camera-dot"), state: $("#camera-status"), label: "Camera" },
  mic: { element: $("#mic-chip"), dot: $("#mic-dot"), state: $("#mic-status"), label: "Mic" },
  speech: { element: $("#speech-chip"), dot: $("#speech-dot"), state: $("#speech-status"), label: "Speech" },
  sensor: { element: $("#sensor-chip"), dot: $("#sensor-dot"), state: $("#sensor-status"), label: "SmartSpectra" },
};
const streamStatus = $("#stream-status");
const streamStatusDot = $("#stream-status-dot");
const transcriptStream = $("#transcript-stream");
const streamEmpty = $("#stream-empty");
const interimRow = $("#interim-row");
const interimText = $("#interim-text");
const sessionButton = $("#session-button");
const toastContainer = $("#toast-container");
const consentDialog = $("#session-consent-dialog");
const consentInput = $("#speech-consent");
const consentRow = $("#speech-consent-row");
const consentSupportNote = $("#speech-support-note");
const confirmSessionButton = $("#confirm-session-button");
const exportButton = $("#export-button");
const measurementReadiness = $("#measurement-readiness") ?? null;
const headDirectionValue = $("#headDirection-value");
const headDirectionCanvas = $("#head-direction-canvas");
const headDirectionDot = $("#head-direction-dot");
const microphoneDialog = $("#microphone-dialog");
const microphoneForm = $("#microphone-form");
const microphoneOptions = $("#microphone-options");
const microphoneNote = $("#microphone-note");
const micMeterFill = $("#mic-meter-fill");
const cameraDialogElement = $("#camera-dialog");
const cameraForm = $("#camera-form");
const cameraOptions = $("#camera-options");
const cameraNote = $("#camera-note");
const informationDialog = $("#information-dialog");
const infoTabButtons = [...document.querySelectorAll("#information-dialog .info-tab")];
const infoPanels = new Map(
  infoTabButtons.map((tab) => [tab.getAttribute("aria-controls"), document.getElementById(tab.getAttribute("aria-controls"))]),
);

function renderHeadDirectionOverlay(sample) {
  if (!headDirectionDot) return;
  if (!sample || !Number.isFinite(sample.x) || !Number.isFinite(sample.y)) {
    headDirectionDot.style.opacity = "0";
    headDirectionDot.classList.remove("is-calibrated");
    return;
  }
  const xPct = Math.max(0, Math.min(100, ((sample.x + 1) / 2) * 100));
  const yPct = Math.max(0, Math.min(100, ((sample.y + 1) / 2) * 100));
  headDirectionDot.style.left = `${xPct}%`;
  headDirectionDot.style.top = `${yPct}%`;
  headDirectionDot.style.opacity = "1";
  if (sample.calibrated) headDirectionDot.classList.add("is-calibrated");
  else headDirectionDot.classList.remove("is-calibrated");
}

function activateInfoTab(activeTab) {
  if (!activeTab) return;
  infoTabButtons.forEach((tab) => {
    const active = tab === activeTab;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.setAttribute("tabindex", active ? "0" : "-1");
    const panel = infoPanels.get(tab.getAttribute("aria-controls"));
    if (panel) panel.hidden = !active;
  });
  activeTab.focus();
}

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const isElectronApp = /electron\//i.test(navigator.userAgent);
const STT_FLUSH_MS = 4000;
const STT_TARGET_RATE = 16000;
const localStt = {
  active: false,
  modelReady: false,
  micStream: null,
  audioContext: null,
  processor: null,
  pcmBuffer: [],
  pcmCount: 0,
  flushTimer: null,
  lastFlushAtMs: null,
  downloadToastShown: false,
};
const MIC_PREFERENCE_KEY = "baseline.micDeviceId";
const CAMERA_PREFERENCE_KEY = "baseline.cameraDeviceId";
// Lower resolution reduces the renderer-to-main frame-copy cost while keeping
// enough detail for face metrics; request 50 fps to run the 50 fps camera at
// its native rate (above the SDK's 25 fps floor). Exact constraints keep the
// capture at a fixed 1280x720 so the app window never has to stretch.
const CAMERA_CAPTURE_CONSTRAINTS = {
  width: { exact: 1280 },
  height: { exact: 720 },
  aspectRatio: { exact: 16 / 9 },
  frameRate: { exact: 30 },
};
const cameraDialogPreview = { stream: null };
const micMeter = { stream: null, context: null, source: null, analyser: null, buffer: null, frame: 0 };
const utterances = [];
const headDirectionSamples = [];
const biometricSamples = [];
const faceSpeechEvents = [];
const blinkEvents = [];
const handednessHistory = [];

const GAP_THRESHOLD_MS = 2000;
const PACING_RUSHED_WPM = 160;

let handedness = "right";
let sessionActive = false;
let sessionOrigin = null;
let sessionStoppedAt = null;
let sessionStartedAt = null;
let sessionClockTimer = null;
let cameraStream = null;
let videoFile = null;
let videoFileSourceUrl = null;
let headDirectionTrackerDiagnostics = null;
let cameraPreviewWasConnected = false;
let smartSpectraClient = null;
let smartSpectraStartPromise = null;
let smartSpectraState = "not_connected";
let recognition = null;
let recognitionRestartTimer = null;
let recognitionStartupTimer = null;
let recognitionRetryCount = 0;
let speechMode = "not_started";
let utteranceCounter = 0;
let headDirectionCounter = 0;
let biometricCounter = 0;
let faceSpeechCounter = 0;
let blinkCounter = 0;
// Face-metric diagnostics remain in the export schema, but face metrics are
// intentionally limited to the requested blink metric and optional head-direction tracker.
let lastTalkingDetected = null;
let latestTalking = null;
let lastBlinkDetected = null;
// One-shot per-session terminal confirmations that the SDK is emitting data.
let firstMetricsLogged = false;
let firstPulseLogged = false;
let firstHrvLogged = false;
const faceMetricDiagnostics = {
  talking_packets: 0,
  talking_transitions: 0,
  landmark_packets: 0,
  first_landmark_point_count: null,
  first_landmark_stable: null,
  first_landmark_reset: null,
  last_packet_ms: null,
};
const metricPacketDiagnostics = {
  metrics_packets: 0,
  first_packet_ms: null,
  pulse_rate_packets: 0,
  pulse_rate_stable_packets: 0,
  pulse_confidence_packets: 0,
  hrv_packets: 0,
  hrv_stable_packets: 0,
  hrv_confidence_packets: 0,
  blink_packets: 0,
  blink_transitions: 0,
  talking_packets: 0,
  landmark_packets: 0,
  landmark_packets_with_points: 0,
  last_landmark_points_ms: null,
  last_packet_ms: null,
  last_payload_availability: null,
};
const validationStatusHistory = [];
const processingStatusHistory = [];
const cameraTrackSettingsHistory = [];
let latestValidationStatus = null;
// SDK error records for the export, kept like the other sample arrays:
// cumulative across "Resume" within one window. Consecutive identical
// code+message pairs collapse into the first record's count so a server-side
// 401 loop cannot flood the list.
const sessionSdkErrors = [];

function reverseEnumNames(enumObject) {
  if (typeof enumObject !== "object" || enumObject === null) return {};
  return Object.fromEntries(
    Object.entries(enumObject).map(([name, value]) => [Number(value), name]),
  );
}

const smartSpectraErrorCodeNames = reverseEnumNames(SmartSpectraErrorCode);
const smartSpectraProcessingStatusNames = reverseEnumNames(ProcessingStatus);
const smartSpectraValidationCodeNames = reverseEnumNames(ValidationCode);

// Per-session pipeline-health tracking (reset in startFreeSession): packet
// freshness, stall one-shots, and processing/validation cause logging. In the
// 19:53 session the engine failed with kProcessingFailed at 13 s and the app
// neither recovered nor notified — historical samples kept it reading green.
let lastSdkPacketElapsedMs = null;
let sdkRunningAtElapsedMs = null;
let stallActive = false;
let lastProcessingStatusName = null;
let lastValidationName = null;
let lastMetricReadinessWarning = null;
let smartSpectraWatchdogTimer = null;
let smartSpectraRecoveryInFlight = false;
// Cumulative reset+start recovery attempts across sessions; exported.
let smartSpectraRecoveryAttempts = 0;
const SMARTSPECTRA_STALL_MS = 10000;
const SMARTSPECTRA_WATCHDOG_INTERVAL_MS = 5000;
const SMARTSPECTRA_MAX_RECOVERY_ATTEMPTS = 2;
let lastRecognitionAtMs = 0;
let pendingSpeechStartMs = null;
let speechEverStarted = false;
let sttFlushCounter = 0;
let silentWindowCount = 0;
let noSpeechToastShown = false;
let sessionStopping = false;

function elapsedMs() {
  if (sessionOrigin === null) return 0;
  const end = sessionActive || sessionStoppedAt === null ? performance.now() : sessionStoppedAt;
  return Math.max(0, Math.round(end - sessionOrigin));
}

function updateSessionClock() {
  const seconds = Math.floor(elapsedMs() / 1000);
  const clockText = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  $("#session-clock").textContent = clockText;
  const stageCounter = $("#stage-counter-value");
  if (stageCounter) stageCounter.textContent = clockText;
}

function showToast(text, isError = false) {
  const toast = document.createElement("div");
  toast.className = isError ? "toast is-error" : "toast";
  toast.setAttribute("role", isError ? "alert" : "status");
  toast.textContent = text;
  let dismissalTimer = null;
  const dismiss = () => {
    if (dismissalTimer === null) return;
    window.clearTimeout(dismissalTimer);
    dismissalTimer = null;
    toast.classList.add("is-leaving");
    window.setTimeout(() => toast.remove(), 200);
  };
  toast.addEventListener("click", dismiss);
  dismissalTimer = window.setTimeout(dismiss, isError ? 6000 : 3500);
  toastContainer.append(toast);
}

function setStreamStatus(text, active = false) {
  streamStatus.textContent = text;
  streamStatusDot.classList.toggle("is-active", active);
}

function hudStateColor(text) {
  const value = text.toLowerCase();
  if (/(^|\W)(off|idle|not connected)($|\W)/.test(value)) return "gray";
  if (/(loading|starting|retrying|reconnecting|recovering|required|camera unavailable)/.test(value)) return "amber";
  if (/(listening|running|preview on|connected)/.test(value)) return "green";
  if (/(error|rejected|stalled|permission denied|mic unavailable|unavailable)/.test(value)) return "red";
  return "gray";
}

function applyHudState(source, text) {
  const chip = hudChips[source];
  chip.state.textContent = text;
  chip.element.title = `${chip.label}: ${text}`;
  chip.dot.classList.remove("is-gray", "is-amber", "is-green", "is-red");
  chip.dot.classList.add(`is-${hudStateColor(text)}`);
}

function setCameraStatus(text) {
  applyHudState("camera", text);
}

function setMicStatus(text) {
  applyHudState("mic", text);
}

function setSpeechStatus(text) {
  applyHudState("speech", text);
}

function setSensorStatus(text) {
  applyHudState("sensor", text);
}

function setMeasurementReadiness(text) {
  showToast(text);
}

function markHeadDirectionTrackerNoCamera() {
  headDirectionTrackerDiagnostics = {
    status: "no_camera",
    frames_processed: 0,
    faces_detected: 0,
    usable_eye_frames: 0,
    rejected_eye_frames: 0,
    estimates_emitted: 0,
    error: null,
  };
  headDirectionValue.textContent = "—";
  headDirectionValue.title = "No camera";
}

function setHeadDirectionTrackingDisabled() {
  headDirectionTrackerDiagnostics = {
    status: "disabled_by_user",
    frames_processed: 0,
    faces_detected: 0,
    usable_eye_frames: 0,
    rejected_eye_frames: 0,
    estimates_emitted: 0,
    error: null,
  };
  headDirectionValue.textContent = "OFF";
}

function updateSensorFeaturePreference(feature, enabled) {
  if (!Object.hasOwn(DEFAULT_SENSOR_FEATURES, feature) || typeof enabled !== "boolean") return;
  sensorFeaturePreferences = { ...sensorFeaturePreferences, [feature]: enabled };
  try {
    window.localStorage.setItem(SENSOR_FEATURE_PREFERENCE_KEY, JSON.stringify(sensorFeaturePreferences));
  } catch {
    showToast("Could not save sensor feature preferences. They will apply until the app closes.", true);
  }
  window.practiceBridge?.setSensorFeatureState?.(sensorFeaturePreferences);
  updateTelemetry();
  if (sessionActive || sessionOrigin !== null) {
    showToast("Preference saved. The current session keeps its sensor selection; restart Baseline to apply it to a new session.");
  }
}

function setHeadDirectionPreviewStatus() {
  if (activeSessionFeatures.headDirection) {
    headDirectionTrackerDiagnostics = {
      status: "awaiting_smart_spectra",
      frames_processed: 0,
      faces_detected: 0,
      usable_eye_frames: 0,
      rejected_eye_frames: 0,
      estimates_emitted: 0,
      error: null,
    };
    headDirectionValue.textContent = "—";
    headDirectionValue.title = "Awaiting SmartSpectra landmarks…";
  } else {
    setHeadDirectionTrackingDisabled();
  }
}

// Telemetry milestones print to the `npm start` terminal via the main
// process, so SDK health is visible live instead of only in a JSON export.
function logTelemetry(message) {
  console.info(message);
  try {
    window.practiceBridge?.logTelemetry?.(message);
  } catch {
    // Logging must never break telemetry itself.
  }
}

function setSmartSpectraStatus(text) {
  smartSpectraState = text.toLowerCase().replaceAll(" ", "_");
  setSensorStatus(text.toUpperCase());
}

function updateUtteranceCount() {
  const count = utterances.length;
  $("#utterance-count").textContent = `${count} ${count === 1 ? "utterance" : "utterances"}`;
  exportButton.disabled = count === 0 && biometricSamples.length === 0;
}

function showTranscriptEntry(text, source, timestampMs, startMs) {
  streamEmpty.hidden = true;
  const item = document.createElement("article");
  item.className = "transcript-entry";

  const header = document.createElement("div");
  header.className = "transcript-entry-header";
  const id = document.createElement("span");
  id.className = "transcript-entry-id";
  id.textContent = `UTTERANCE ${String(utteranceCounter).padStart(3, "0")}`;
  const time = document.createElement("time");
  time.className = "transcript-entry-time";
  time.textContent = `~${(timestampMs / 1000).toFixed(1)}s`;
  header.append(id, time);

  const body = document.createElement("p");
  body.className = "transcript-entry-text";
  body.textContent = text;
  const sourceLabel = document.createElement("span");
  sourceLabel.className = "transcript-entry-source";
  sourceLabel.textContent = source === "speech_recognition"
    ? "BROWSER TRANSCRIPTION"
    : source === "speech_recognition_partial"
      ? "BROWSER TRANSCRIPTION · PARTIAL"
      : source === "local_transcription"
        ? "LOCAL TRANSCRIPTION"
        : "MANUAL NOTE";

  item.append(header, body, sourceLabel);
  transcriptStream.append(item);
  transcriptStream.scrollTop = transcriptStream.scrollHeight;
}

function appendUtterance(text, source, observedAtMs, approximateSpeechStartMs = null) {
  const transcript = text.trim();
  if (!transcript) return;

  const utteranceId = `u-${String(utteranceCounter + 1).padStart(4, "0")}`;
  const windowStartMs = approximateSpeechStartMs ?? lastRecognitionAtMs;
  const linkedHeadDirection = headDirectionSamples
    .filter((sample) => !sample.linked_utterance_id && windowStartMs <= sample.timestamp_ms && sample.timestamp_ms <= observedAtMs)
    .map((sample) => {
      sample.linked_utterance_id = utteranceId;
      return sample.sample_id;
    });
  const linkedBiometrics = biometricSamples
    .filter((sample) => !sample.linked_utterance_id && windowStartMs <= sample.timestamp_ms && sample.timestamp_ms <= observedAtMs)
    .map((sample) => {
      sample.linked_utterance_id = utteranceId;
      return sample.sample_id;
    });
  const linkedFaceSpeech = faceSpeechEvents
    .filter((event) => !event.linked_utterance_id && windowStartMs <= event.timestamp_ms && event.timestamp_ms <= observedAtMs)
    .map((event) => {
      event.linked_utterance_id = utteranceId;
      return event.event_id;
    });
  const linkedBlinkEvents = blinkEvents
    .filter((event) => !event.linked_utterance_id && windowStartMs <= event.timestamp_ms && event.timestamp_ms <= observedAtMs)
    .map((event) => {
      event.linked_utterance_id = utteranceId;
      return event.event_id;
    });

  utteranceCounter += 1;

  utterances.push({
    utterance_id: utteranceId,
    transcript_text: transcript,
    source,
    timestamp_start_ms: windowStartMs,
    timestamp_end_ms: observedAtMs,
    timestamp_basis: "approximate_browser_recognition_result_window",
    handedness_preference: handedness,
    gaze_sample_ids: linkedHeadDirection,
    biometric_sample_ids: linkedBiometrics,
    face_speech_event_ids: linkedFaceSpeech,
    blink_event_ids: linkedBlinkEvents,
  });
  renderTranscriptStream();
}

function renderTranscriptStream() {
  transcriptStream.textContent = "";
  if (utterances.length === 0) {
    streamEmpty.hidden = false;
    return;
  }
  streamEmpty.hidden = true;

  const turns = groupUtterancesIntoTurns(utterances);
  for (const turn of turns) {
    const turnMetrics = computeTurnMetrics(turn, utterances, headDirectionSamples, biometricSamples, blinkEvents);
    const card = document.createElement("article");
    card.className = "turn-card";

    const header = document.createElement("header");
    header.className = "turn-header";
    const turnId = document.createElement("span");
    turnId.className = "turn-id";
    turnId.textContent = turn.turn_id;
    const turnTime = document.createElement("time");
    turnTime.className = "turn-time";
    turnTime.textContent = `${formatSessionTimestamp(turn.start_ms)} – ${formatSessionTimestamp(turn.end_ms)}`;
    const turnType = document.createElement("span");
    turnType.className = "turn-type";
    turnType.textContent = turn.turn_type;
    header.append(turnId, turnTime, turnType);

    const utterancesEl = document.createElement("div");
    utterancesEl.className = "turn-utterances";
    for (const uid of turn.utterance_ids) {
      const u = utterances.find((ut) => ut.utterance_id === uid);
      if (!u) continue;
      const entry = document.createElement("article");
      entry.className = "transcript-entry";
      const id = document.createElement("span");
      id.className = "transcript-entry-id";
      id.textContent = `UTTERANCE ${String(u.utterance_id).padStart(3, "0")}`;
      const time = document.createElement("time");
      time.className = "transcript-entry-time";
      time.textContent = `~${(u.timestamp_start_ms / 1000).toFixed(1)}s`;
      const body = document.createElement("p");
      body.className = "transcript-entry-text";
      body.textContent = u.transcript_text;
      const sourceLabel = document.createElement("span");
      sourceLabel.className = "transcript-entry-source";
      sourceLabel.textContent = u.source === "speech_recognition"
        ? "BROWSER TRANSCRIPTION"
        : u.source === "speech_recognition_partial"
          ? "BROWSER TRANSCRIPTION · PARTIAL"
          : u.source === "local_transcription"
            ? "LOCAL TRANSCRIPTION"
            : "MANUAL NOTE";
      entry.append(id, time, body, sourceLabel);
      utterancesEl.append(entry);
    }
    card.append(header, utterancesEl);
    transcriptStream.append(card);
  }
}

function sentenceChunks(text) {
  const matches = text.match(/[^.!?。！？]+[.!?。！？]+|[^.!?。！？]+$/gu);
  return matches ? matches.map((part) => part.trim()).filter(Boolean) : [];
}

function updateInterim(text) {
  const value = text.trim();
  interimText.textContent = value;
  interimRow.hidden = !value;
}

function clearRecognitionRestart() {
  if (recognitionRestartTimer !== null) {
    window.clearTimeout(recognitionRestartTimer);
    recognitionRestartTimer = null;
  }
}

function clearRecognitionStartupTimer() {
  if (recognitionStartupTimer !== null) {
    window.clearTimeout(recognitionStartupTimer);
    recognitionStartupTimer = null;
  }
}

function markSpeechUnavailable() {
  recognition = null;
  speechMode = "unavailable";
  clearRecognitionRestart();
  clearRecognitionStartupTimer();
  setSpeechStatus("UNAVAILABLE");
  setMicStatus("UNAVAILABLE");
  setStreamStatus("UNAVAILABLE");
  showToast("Speech transcription is unavailable in this desktop build. The session continues with the camera preview and sensor telemetry.");
}

function startRecognition() {
  if (!sessionActive || !SpeechRecognition || recognition) return;

  const instance = new SpeechRecognition();
  recognition = instance;
  instance.continuous = true;
  instance.interimResults = true;
  instance.lang = navigator.language || "en-US";

  recognitionStartupTimer = window.setTimeout(() => {
    if (recognition !== instance || speechEverStarted) return;
    markSpeechUnavailable();
  }, 5000);

  instance.onstart = () => {
    speechEverStarted = true;
    clearRecognitionStartupTimer();
    setSpeechStatus("LISTENING");
    setMicStatus("LISTENING");
    setStreamStatus("LISTENING", true);
    showToast("Free session active. Transcript timing reflects when the browser returned each speech result.");
  };

  instance.onresult = (event) => {
    recognitionRetryCount = 0;
    const now = elapsedMs();
    let interim = "";

    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const text = result[0]?.transcript || "";
      if (result.isFinal) {
        updateInterim("");
        const speechStartMs = pendingSpeechStartMs ?? now;
        for (const chunk of sentenceChunks(text)) {
          appendUtterance(chunk, "speech_recognition", now, speechStartMs);
        }
        pendingSpeechStartMs = null;
      } else {
        interim += text;
        if (text.trim() && pendingSpeechStartMs === null) {
          pendingSpeechStartMs = now;
        }
      }
    }

    updateInterim(interim);
  };

instance.onerror = (event) => {
    const error = event.error;
    const isPermissionError = error === "not-allowed";
    if (!speechEverStarted &&
        ["network", "service-not-allowed", "audio-capture", "language-not-supported"].includes(error)) {
      markSpeechUnavailable();
      return;
    }
    const isFatal = error === "service-not-allowed" || error === "audio-capture" || error === "language-not-supported";
    const status = isPermissionError
      ? "PERMISSION DENIED"
      : error === "audio-capture"
        ? "MIC UNAVAILABLE"
        : isFatal
          ? "UNAVAILABLE"
          : "RETRYING";
    setSpeechStatus(status);
    setMicStatus(status);
    showToast(
      isPermissionError
        ? "Speech recognition could not access the microphone. Check the microphone permission before starting another session."
        : error === "audio-capture"
          ? "The speech service could not capture microphone audio. Check that the microphone is connected and not in use by another app."
          : `Speech recognition reported "${error}".`,
      isFatal || isPermissionError,
    );
    if (isPermissionError || isFatal) {
      recognition = null;
      clearRecognitionRestart();
      setStreamStatus("UNAVAILABLE");
    }
  };

  instance.onend = () => {
    if (recognition !== instance) return;
    recognition = null;
    clearRecognitionStartupTimer();
    if (!sessionActive) return;
    if (!speechEverStarted) {
      markSpeechUnavailable();
      return;
    }
    if (recognitionRetryCount >= 3) {
      setSpeechStatus("UNAVAILABLE");
      setMicStatus("UNAVAILABLE");
      setStreamStatus("UNAVAILABLE");
      showToast(
        "Speech recognition stopped after repeated connection failures. Transcription is unavailable in this desktop build; the session continues with the camera preview and sensor telemetry.",
      );
      return;
    }
    recognitionRetryCount += 1;
    setSpeechStatus("RECONNECTING");
    setMicStatus("RECONNECTING");
    clearRecognitionRestart();
    recognitionRestartTimer = window.setTimeout(startRecognition, 750 * 2 ** (recognitionRetryCount - 1));
  };

  try {
    instance.start();
  } catch {
    markSpeechUnavailable();
  }
}

function addSmartSpectraMetrics(buffer, timestampUs) {
  const metrics = decodeMetrics(buffer);
  if (!metrics || (typeof Buffer !== "undefined" && Buffer.isBuffer(metrics))) {
    throw new TypeError("SmartSpectra returned an unreadable metrics payload.");
  }

  const landmarks = metrics.face?.landmarks?.at(-1);
  const readings = extractBiometricReadings(metrics);
  const sample = { timestamp_ms: elapsedMs(), ...readings.fields };
  lastSdkPacketElapsedMs = sample.timestamp_ms;
  if (stallActive) {
    // Any fresh packet clears the stall, even one without usable metric
    // fields; the engine is demonstrably producing again.
    stallActive = false;
    logTelemetry("SmartSpectra packets resumed after the stall gap");
  }
  const sourceTimestampUs = Number(timestampUs);
  if (Number.isFinite(sourceTimestampUs) && sourceTimestampUs >= 0) {
    sample.source_timestamp_us = sourceTimestampUs;
  }
  const {
    pulse_rate: hasPulse,
    hrv: hasHrv,
    blinking: hasBlink,
    pulse_stable: hasStablePulse,
    hrv_stable: hasStableHrv,
  } = readings.availability;
  const hasLandmarks = Array.isArray(landmarks?.value);
  metricPacketDiagnostics.metrics_packets += 1;
  if (metricPacketDiagnostics.first_packet_ms === null) {
    metricPacketDiagnostics.first_packet_ms = sample.timestamp_ms;
  }
  metricPacketDiagnostics.last_packet_ms = sample.timestamp_ms;
  if (hasPulse) metricPacketDiagnostics.pulse_rate_packets += 1;
  if (hasHrv) metricPacketDiagnostics.hrv_packets += 1;
  if (hasBlink) metricPacketDiagnostics.blink_packets += 1;
  if (hasStablePulse) metricPacketDiagnostics.pulse_rate_stable_packets += 1;
  if (hasStableHrv) metricPacketDiagnostics.hrv_stable_packets += 1;
  if (readings.availability.pulse_confidence) metricPacketDiagnostics.pulse_confidence_packets += 1;
  if (readings.availability.hrv_confidence) metricPacketDiagnostics.hrv_confidence_packets += 1;
  if (hasLandmarks) {
    metricPacketDiagnostics.landmark_packets += 1;
    if (landmarks.value.length > 0) {
      metricPacketDiagnostics.landmark_packets_with_points += 1;
      metricPacketDiagnostics.last_landmark_points_ms = sample.timestamp_ms;
    }
  }
  metricPacketDiagnostics.last_payload_availability = {
    pulse_rate: hasPulse,
    pulse_rate_stable: hasStablePulse,
    pulse_confidence: readings.availability.pulse_confidence,
    hrv: hasHrv,
    hrv_stable: hasStableHrv,
    hrv_confidence: readings.availability.hrv_confidence,
    blinking: hasBlink,
    talking: readings.availability.talking,
    landmarks: hasLandmarks,
    landmark_point_count: hasLandmarks ? landmarks.value.length : null,
  };
  const hasCardioMetric = hasPulse || hasHrv;
  const hasMetric = hasCardioMetric || hasBlink;
  if (hasMetric) {
    const storedSample = addBiometricSample(sample);
    if (hasCardioMetric && !firstMetricsLogged) {
      firstMetricsLogged = true;
      logTelemetry(`usable cardio metric fields received: first packet at ${sample.timestamp_ms} ms`);
    }
    if (hasBlink) {
      trackBlinkTransition(storedSample);
      updateTelemetry();
    }
    if (sample.pulse_bpm > 0 && sample.pulse_stable === true && !firstPulseLogged) {
      firstPulseLogged = true;
      logTelemetry(`pulse rate available: ${sample.pulse_bpm.toFixed(1)} BPM (pulse needs about 12 s of measurement)`);
    }
    if (sample.hrv_ms > 0 && sample.hrv_stable === true && !firstHrvLogged) {
      firstHrvLogged = true;
      logTelemetry(`HRV available: ${sample.hrv_ms.toFixed(1)} ms RMSSD (HRV needs about 60 s of measurement)`);
    }
  }
  trackLandmarkDiagnostics(landmarks, sample.timestamp_ms);

  if (hasLandmarks && activeSessionFeatures.headDirection && sessionActive) {
    const headDirection = headDirectionFromLandmarks(landmarks.value);
    if (headDirection) {
      recordHeadDirectionSample(
        { ...headDirection, timestamp_ms: sample.timestamp_ms, calibrated: true },
        { source: "smartspectra_landmarks", calibrated: true },
      );
      if (headDirectionValue.textContent !== headDirection) headDirectionValue.textContent = headDirection;
    }
  }
}

// Records the SDK's per-packet talking state and logs only state transitions
// (plus the first observation) so the console does not fill with repeats.
function trackTalkingTransition(sample) {
  faceMetricDiagnostics.talking_packets += 1;
  faceMetricDiagnostics.last_packet_ms = sample.timestamp_ms;
  const detected = sample.talking_detected;
  if (detected === lastTalkingDetected) return;
  const isTransition = lastTalkingDetected !== null;
  faceSpeechCounter += 1;
  const event = {
    event_id: `sd-${String(faceSpeechCounter).padStart(5, "0")}`,
    timestamp_ms: sample.timestamp_ms,
    detected,
    stable: sample.talking_stable,
    previous_state: lastTalkingDetected,
    biometric_sample_id: sample.sample_id,
  };
  if (sample.source_timestamp_us !== undefined) event.source_timestamp_us = sample.source_timestamp_us;
  faceSpeechEvents.push(event);
  faceMetricDiagnostics.talking_transitions += 1;
  faceMetricDiagnostics.last_talking_detected = detected;
  latestTalking = { detected, stable: sample.talking_stable };
  logTelemetry(
    `talking ${isTransition ? "transition" : "first observation"}: ` +
      `detected=${detected} stable=${sample.talking_stable} at ${sample.timestamp_ms} ms ` +
      `(event sd-${String(faceSpeechCounter).padStart(5, "0")}, ${faceSpeechEvents.length} recorded)`,
  );
  lastTalkingDetected = detected;
}

function trackBlinkTransition(sample) {
  const transition = createBlinkTransition(
    sample,
    lastBlinkDetected,
    `bl-${String(blinkCounter + 1).padStart(5, "0")}`,
  );
  lastBlinkDetected = transition.nextDetected;
  if (!transition.event) return;
  blinkCounter += 1;
  blinkEvents.push(transition.event);
  faceMetricDiagnostics.blink_transitions += 1;
  if (transition.event.counted_as_blink) {
    logTelemetry(
      `blink event: stable transition at ${sample.timestamp_ms} ms ` +
        `(${transition.event.event_id ?? `bl-${String(blinkCounter).padStart(5, "0")}`})`,
    );
  }
}

// Counts landmark packets and records non-identifying shape metadata only.
function trackLandmarkDiagnostics(landmarks, timestampMs) {
  if (!landmarks || !Array.isArray(landmarks.value)) return;
  faceMetricDiagnostics.landmark_packets += 1;
  faceMetricDiagnostics.last_packet_ms = timestampMs;
  if (faceMetricDiagnostics.first_landmark_point_count !== null) return;
  faceMetricDiagnostics.first_landmark_point_count = landmarks.value.length;
  faceMetricDiagnostics.first_landmark_stable = Boolean(landmarks.stable);
  faceMetricDiagnostics.first_landmark_reset = Boolean(landmarks.reset);
  logTelemetry(
    `face landmarks available: ${landmarks.value.length} points, ` +
    `stable=${Boolean(landmarks.stable)}, reset=${Boolean(landmarks.reset)} — SDK landmarks are used for head-direction estimation; raw facial coordinates are not exported`,
  );
}

function recordCameraTrackSettings(stream) {
  const track = stream?.getVideoTracks?.()[0];
  if (!track) return;
  const settings = track.getSettings();
  const recordedSettings = {
    timestamp_ms: elapsedMs(),
    width: Number.isFinite(settings.width) ? settings.width : null,
    height: Number.isFinite(settings.height) ? settings.height : null,
    frame_rate: Number.isFinite(settings.frameRate) ? settings.frameRate : null,
    facing_mode: settings.facingMode ?? null,
    aspect_ratio: Number.isFinite(settings.aspectRatio) ? settings.aspectRatio : null,
    resize_mode: settings.resizeMode ?? null,
    enabled: track.enabled,
    ready_state: track.readyState,
  };
  cameraTrackSettingsHistory.push(recordedSettings);
  logTelemetry(
    `camera track settings: ${recordedSettings.width ?? "unknown"}x${recordedSettings.height ?? "unknown"} ` +
      `at ${recordedSettings.frame_rate ?? "unknown"} fps`,
  );
}

// Auth failures get a distinct state so exports can say "the server rejected
// the key" instead of a generic SDK error. Matches the SDK's
// kAuthenticationFailed enum value and the Presage 401 response wording.
function isSmartSpectraAuthFailure(code, message) {
  if (SmartSpectraErrorCode !== undefined && code === SmartSpectraErrorCode.kAuthenticationFailed) return true;
  return /authentication|api key|401/i.test(String(message ?? ""));
}

function extractErrorParts(error) {
  if (error === null || error === undefined) return { code: null, message: "", retryable: null };
  return {
    code: typeof error.code === "number" ? error.code : null,
    message: error instanceof Error && error.message ? error.message : String(error),
    retryable: typeof error.retryable === "boolean" ? error.retryable : null,
  };
}

// Records one SDK error observation. Consecutive identical code+message pairs
// extend the running count of the last record; anything else starts a new
// record. Returns true only for a first occurrence, which callers log/show.
function recordSmartSpectraError(code, message, retryable, stage) {
  const previous = sessionSdkErrors.at(-1);
  if (previous && previous.stage === stage && previous.code === code &&
      previous.message === message && previous.retryable === retryable) {
    previous.count += 1;
    return false;
  }
  const record = {
    timestamp_ms: elapsedMs(),
    ...(stage === undefined ? {} : { stage }),
    code,
    code_name: typeof code === "number" ? smartSpectraErrorCodeNames[code] ?? null : null,
    message: message || "no_error_message",
    retryable,
    count: 1,
  };
  sessionSdkErrors.push(record);
  logTelemetry(
    `error recorded (first occurrence): ` +
      `${record.code_name ?? `code ${record.code ?? "unknown"}`}: ${record.message}` +
      `${stage === undefined ? "" : ` [${stage}]`}`,
  );
  return true;
}

// One glanceable snake_case line over the recorded errors, following the
// analysis_status convention; no token counts or cognitive inference.
function smartSpectraErrorSummary() {
  if (sessionSdkErrors.length === 0) return "no_sdk_errors_recorded";
  return sessionSdkErrors
    .map((record) => {
      const codeText = record.code_name
        ? record.code_name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()
        : record.code !== null
          ? `code_${record.code}`
          : "no_code";
      const detail = record.message
        .toLowerCase()
        .replaceAll(/[^\w]+/g, "_")
        .replace(/^_+/, "")
        .slice(0, 80)
        .replace(/_+$/, "") || "no_message";
      return `${codeText}_${detail}${record.count > 1 ? `_repeated_${record.count}_times` : ""}`;
    })
    .join("_then_");
}

// A pipeline is stalled when no metrics packet has arrived for 10 s — either
// none since the last (re)start resolved, or none since the last packet.
// Staleness is measured on the session clock, so it stays truthful in exports
// taken after the session ends.
function smartSpectraPacketsStalled() {
  const referenceMs = lastSdkPacketElapsedMs ?? sdkRunningAtElapsedMs;
  if (referenceMs === null) return false;
  return elapsedMs() - referenceMs > SMARTSPECTRA_STALL_MS;
}

const SMARTSPECTRA_LIVE_STATES = ["connected", "running", "recovering"];

function checkSmartSpectraStall() {
  if (!sessionActive || sessionStopping || !smartSpectraClient || smartSpectraStartPromise) return;
  // Terminal diagnoses (auth_rejected, sdk_error, pipeline_stalled,
  // api_key_required, camera unavailable) must not be overwritten by the
  // watchdog; only a live pipeline can be called stalled.
  if (!SMARTSPECTRA_LIVE_STATES.includes(smartSpectraState)) return;
  updateMetricReadinessWarning();
  if (smartSpectraRecoveryInFlight || !smartSpectraPacketsStalled()) return;
  if (!stallActive) {
    stallActive = true;
    setSmartSpectraStatus("pipeline stalled");
    const gapSeconds = Math.round((elapsedMs() - (lastSdkPacketElapsedMs ?? sdkRunningAtElapsedMs)) / 1000);
    logTelemetry(
      `no SmartSpectra packets for ${gapSeconds} s — the processing pipeline looks stalled; ` +
        "see face_metric_diagnostics in the export",
    );
    showToast("SmartSpectra stopped sending packets. The pipeline looks stalled; the session keeps recording.", true);
  }
}

function updateMetricReadinessWarning() {
  if (!metricPacketDiagnostics.metrics_packets || metricPacketDiagnostics.first_packet_ms === null) return;
  const now = elapsedMs();
  const missing = [];
  if (
    activeSessionFeatures.pulse &&
    metricPacketDiagnostics.pulse_rate_stable_packets === 0 &&
    now - metricPacketDiagnostics.first_packet_ms >= 12_000
  ) missing.push("pulse");
  if (
    activeSessionFeatures.hrv &&
    metricPacketDiagnostics.hrv_stable_packets === 0 &&
    now - metricPacketDiagnostics.first_packet_ms >= 60_000
  ) missing.push("HRV");
  if (missing.length) {
    const warning = `SDK packets are arriving, but no stable ${missing.join(" or ")} measurement has been emitted. ` +
      "Check the camera view and the recorded SDK validation status.";
    if (warning !== lastMetricReadinessWarning) {
      lastMetricReadinessWarning = warning;
      logTelemetry(warning);
    }
  } else if (latestValidationStatus?.status === "kOk") {
    lastMetricReadinessWarning = null;
    setMeasurementReadiness(cameraValidatedReadinessMessage());
  } else {
    lastMetricReadinessWarning = null;
  }
}

function cameraValidatedReadinessMessage() {
  const readinessNotes = [];
  if (activeSessionFeatures.pulse) readinessNotes.push("pulse usually needs about 12 s");
  if (activeSessionFeatures.hrv) readinessNotes.push("HRV usually needs about 60 s");
  return `Camera validated. Blink detection is enabled${
    readinessNotes.length ? `; ${readinessNotes.join(" and ")} of continuous measurement.` : "."
  }`;
}

async function startSmartSpectraTelemetry(stream) {
  if (!sessionActive) return;
  recordCameraTrackSettings(stream);
  if (!window.practiceBridge?.getPresageApiKey) {
    setSmartSpectraStatus("Electron required");
    setMeasurementReadiness("SmartSpectra readiness unavailable outside the Electron app.");
    showToast("SmartSpectra runs through the Electron desktop app. The camera preview and transcription can continue without biometrics.");
    return;
  }

  let apiKey;
  try {
    apiKey = await window.practiceBridge.getPresageApiKey();
  } catch (error) {
    if (!sessionActive) return;
    const parts = extractErrorParts(error);
    recordSmartSpectraError(parts.code, parts.message, parts.retryable, "start");
    setSmartSpectraStatus("Bridge error");
    showToast(
      `Could not read the Presage API key from the desktop app: ${parts.message}`,
      true,
    );
    return;
  }

  if (!sessionActive) return;
  if (!apiKey) {
    setSmartSpectraStatus("API key required");
    setMeasurementReadiness("SmartSpectra readiness unavailable: API key is not configured.");
    logTelemetry("Presage API key missing: set PRESAGE_API_KEY in the environment or .env and restart; SmartSpectra will show api_key_required");
    showToast("Camera and transcription are active. Set PRESAGE_API_KEY in the environment, then restart the app to enable SmartSpectra.");
    return;
  }

  const { codes: requestedMetrics, names: requestedMetricNames } = getRequestedMetricInfo(activeSessionFeatures);
  logTelemetry(
    `Presage API key loaded: ${apiKey.length} chars (${apiKey.slice(0, 2)}…${apiKey.slice(-2)}) ` +
      `— constructing SmartSpectra SDK (requested: ${requestedMetricNames.join(", ")})`,
  );
  setMeasurementReadiness("Waiting for SmartSpectra camera validation. Keep your face centered, well lit, and unobstructed.");

  let client;
  try {
    client = new SmartSpectraSDK({
      apiKey,
      requestedMetrics,
      enableTelemetry: true,
      logLevel: SmartSpectraLogLevel.kInfo,
    });
  } catch (error) {
    const parts = extractErrorParts(error);
    recordSmartSpectraError(parts.code, parts.message, parts.retryable, "start");
    setSmartSpectraStatus("SDK error");
    showToast(
      `Could not initialize SmartSpectra: ${parts.message}`,
      true,
    );
    return;
  }
  smartSpectraClient = client;
  // Bounded self-recovery for retryable engine failures: a retryable error
  // used to only relabel the chip while the pipeline stayed dead for the rest
  // of the session (kProcessingFailed killed the 19:53 session 7 s after its
  // first packet, with no attempt to rebuild). Auth rejections never recover —
  // a refused key needs a new key, not a pipeline rebuild.
  let recoveryAttempts = 0;
  let recoveryBudgetExhaustedLogged = false;

  const attemptRecovery = async (originalMessage) => {
    if (smartSpectraRecoveryInFlight || !sessionActive || sessionStopping) return;
    if (smartSpectraClient !== client) return;
    if (smartSpectraState === "auth_rejected") return;
    if (recoveryAttempts >= SMARTSPECTRA_MAX_RECOVERY_ATTEMPTS) {
      if (!recoveryBudgetExhaustedLogged) {
        recoveryBudgetExhaustedLogged = true;
        setSmartSpectraStatus("SDK error");
        logTelemetry("SmartSpectra recovery budget exhausted (2 attempts); SDK stays down for this session");
        showToast("SmartSpectra recovery failed twice; telemetry is down for this session.", true);
      }
      return;
    }
    smartSpectraRecoveryInFlight = true;
    recoveryAttempts += 1;
    smartSpectraRecoveryAttempts += 1;
    const attempt = recoveryAttempts;
    setSmartSpectraStatus("recovering");
    logTelemetry(
      `SmartSpectra recovery ${attempt}/${SMARTSPECTRA_MAX_RECOVERY_ATTEMPTS}: rebuilding pipeline (reset + start) after: ${originalMessage}`,
    );
    let resetError = null;
    try {
      await client.reset();
    } catch (error) {
      resetError = error;
    }
    if (!sessionActive || sessionStopping || smartSpectraClient !== client) {
      smartSpectraRecoveryInFlight = false;
      return;
    }
    if (resetError) {
      smartSpectraRecoveryInFlight = false;
      const parts = extractErrorParts(resetError);
      recordSmartSpectraError(parts.code, parts.message, parts.retryable, "recovery");
      setSmartSpectraStatus("SDK error");
      showToast(`SmartSpectra recovery could not reset the pipeline: ${parts.message}`, true);
      return;
    }
    let startPromise = null;
    try {
      startPromise = client.start();
      smartSpectraStartPromise = startPromise;
      await startPromise;
      if (smartSpectraStartPromise === startPromise) smartSpectraStartPromise = null;
      sdkRunningAtElapsedMs = elapsedMs();
      lastSdkPacketElapsedMs = null;
      smartSpectraRecoveryInFlight = false;
      if (!sessionActive || sessionStopping) return;
      logTelemetry(
        `SmartSpectra recovery ${attempt}/${SMARTSPECTRA_MAX_RECOVERY_ATTEMPTS} succeeded: pipeline restarted, waiting for first metrics packet…`,
      );
      if (smartSpectraClient === client &&
          (smartSpectraState === "recovering" || smartSpectraState === "retrying")) {
        setSmartSpectraStatus("running");
      }
    } catch (error) {
      if (smartSpectraStartPromise === startPromise) smartSpectraStartPromise = null;
      smartSpectraRecoveryInFlight = false;
      const parts = extractErrorParts(error);
      recordSmartSpectraError(parts.code, parts.message, parts.retryable, "recovery");
      if (!sessionActive || sessionStopping || smartSpectraClient !== client) return;
      setSmartSpectraStatus(parts.retryable ? "retrying" : "SDK error");
      logTelemetry(`SmartSpectra recovery ${attempt}/${SMARTSPECTRA_MAX_RECOVERY_ATTEMPTS} failed: ${parts.message}`);
      showToast(`SmartSpectra recovery ${attempt} failed: ${parts.message}`, true);
    }
  };

  client.on("metrics", (buffer, timestampUs) => {
    if (!sessionActive || smartSpectraClient !== client) return;
    try {
      addSmartSpectraMetrics(buffer, timestampUs);
    } catch (error) {
      setSmartSpectraStatus("metrics error");
      showToast(
        `Could not process SmartSpectra metrics: ${error instanceof Error ? error.message : "unknown error"}`,
        true,
      );
    }
  });
  client.on("processingStatus", (statusValue) => {
    if (!sessionActive || smartSpectraClient !== client) return;
    const name = smartSpectraProcessingStatusNames[statusValue] ?? `status_${statusValue}`;
    if (name === lastProcessingStatusName) return;
    lastProcessingStatusName = name;
    processingStatusHistory.push({
      timestamp_ms: elapsedMs(),
      status_code: statusValue,
      status: name,
    });
    logTelemetry(`processing status: ${name}`);
    if (statusValue === ProcessingStatus.kError && smartSpectraState !== "auth_rejected" &&
        smartSpectraState !== "retrying" && smartSpectraState !== "sdk_error") {
      setSmartSpectraStatus("SDK error");
    }
  });
  client.on("validationStatus", (codeValue, timestampUs, hint) => {
    if (!sessionActive || smartSpectraClient !== client) return;
    const name = smartSpectraValidationCodeNames[codeValue] ?? `validation_${codeValue}`;
    const detail = typeof hint === "string" ? hint : "";
    const signature = `${name}:${detail}`;
    if (signature === lastValidationName) return;
    lastValidationName = signature;
    const record = {
      timestamp_ms: elapsedMs(),
      status_code: codeValue,
      status: name,
      hint: detail || null,
    };
    const sourceTimestamp = Number(timestampUs);
    if (Number.isFinite(sourceTimestamp) && sourceTimestamp >= 0) {
      record.source_timestamp_us = sourceTimestamp;
    }
    validationStatusHistory.push(record);
    latestValidationStatus = record;
    const readinessLabel = name === "kOk"
      ? "Camera ready"
      : name.replace(/^k/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
    setMeasurementReadiness(name === "kOk"
      ? cameraValidatedReadinessMessage()
      : `Camera readiness: ${readinessLabel}${detail ? ` — ${detail}` : ""}`);
    logTelemetry(`measurement readiness: ${name}${detail ? ` — ${detail}` : ""}`);
  });
  client.on("error", (code, message, retryable) => {
    const authFailure = isSmartSpectraAuthFailure(code, message);
    const firstOccurrence = recordSmartSpectraError(code, message, retryable);
    if (authFailure) {
      setSmartSpectraStatus("auth rejected");
      if (firstOccurrence) {
        logTelemetry(
          "AUTH REJECTED: the Presage server refused this key — compare the fingerprint printed at launch " +
            "with the portal's current key, update .env or the environment, then restart",
        );
        showToast(
          "The Presage server rejected the SmartSpectra key. Compare the key fingerprint printed at launch with the portal's current key, then update .env and restart.",
          true,
        );
      }
      return;
    }
    setSmartSpectraStatus(retryable ? "retrying" : "SDK error");
    if (retryable) void attemptRecovery(message);
    // Consecutive repeats collapse into the last record's count; surface the
    // toast only once per new code+message pair so a 401 loop cannot flood.
    if (firstOccurrence) {
      showToast(`SmartSpectra reported an error: ${message}`, true);
    }
  });

  try {
    client.useMediaStream(stream);
    const startPromise = client.start();
    smartSpectraStartPromise = startPromise;
    await startPromise;
    if (smartSpectraStartPromise === startPromise) smartSpectraStartPromise = null;
    sdkRunningAtElapsedMs = elapsedMs();
    logTelemetry("SmartSpectra SDK started: waiting for first metrics packet…");
    if (smartSpectraClient === client && smartSpectraState === "starting") {
      setSmartSpectraStatus("running");
    }
  } catch (error) {
    smartSpectraStartPromise = null;
    const parts = extractErrorParts(error);
    const authFailure = isSmartSpectraAuthFailure(parts.code, parts.message);
    recordSmartSpectraError(parts.code, parts.message, parts.retryable, "start");
    if (smartSpectraClient === client) {
      smartSpectraClient = null;
      try {
        await client.destroy();
      } catch (destroyError) {
        console.error("Could not clean up SmartSpectra after startup failure:", destroyError);
      }
      setSmartSpectraStatus(authFailure ? "auth rejected" : "SDK error");
      if (authFailure) {
        logTelemetry(
          "AUTH REJECTED: the Presage server refused this key — compare the fingerprint printed at launch " +
            `with the portal's current key, update .env or the environment, then restart (${parts.message})`,
        );
      } else {
        logTelemetry(`SmartSpectra start failed: ${parts.message}`);
      }
      showToast(
        authFailure
          ? `The Presage server rejected the SmartSpectra credentials: ${parts.message}`
          : `SmartSpectra could not start: ${parts.message}`,
        true,
      );
    }
  }
}

async function stopSmartSpectraTelemetry() {
  const client = smartSpectraClient;
  smartSpectraClient = null;
  if (!client) return true;

  let stopError = null;
  if (smartSpectraStartPromise) {
    try {
      await smartSpectraStartPromise;
    } catch (error) {
      stopError = error;
      const parts = extractErrorParts(error);
      recordSmartSpectraError(parts.code, parts.message, parts.retryable, "start");
    } finally {
      smartSpectraStartPromise = null;
    }
  }
  try {
    await client.stop();
  } catch (error) {
    stopError = error;
  }
  try {
    await client.destroy();
  } catch (error) {
    stopError = stopError
      ? new AggregateError([stopError, error], "SmartSpectra shutdown failed.")
      : error;
  }

  if (stopError) {
    logTelemetry(
      `SmartSpectra cleanup failed: ${stopError instanceof Error ? stopError.message : "unknown error"}`,
    );
    showToast(
      `SmartSpectra cleanup failed: ${stopError instanceof Error ? stopError.message : "unknown error"}`,
      true,
    );
  }
  if (smartSpectraState === "auth_rejected") {
    setSmartSpectraStatus("auth rejected");
  } else if (stopError) {
    setSmartSpectraStatus("shutdown error");
  } else {
    setSmartSpectraStatus("not connected");
    logTelemetry(`SmartSpectra telemetry stopped cleanly (${biometricSamples.length} biometric samples recorded)`);
  }
  return stopError === null;
}

async function startFreeSession() {
  if (sessionActive) {
    await stopFreeSession(true);
    return;
  }
  sessionActive = true;
  sessionStopping = false;
  sessionStoppedAt = null;
  // Update data pane status when session starts
  if (dataPaneStatus) dataPaneStatus.textContent = "ACTIVE";
  if (sessionOrigin === null) {
    sessionOrigin = performance.now();
    sessionStartedAt = new Date().toISOString();
    activeSessionFeatures = { ...sensorFeaturePreferences };
    lastRecognitionAtMs = 0;
    pendingSpeechStartMs = null;
    handednessHistory.push({ timestamp_ms: 0, preference: handedness });
    updateTelemetry();
  }
  // The SmartSpectra client restarts with each session, so its first packet
  // must register as a new observation rather than a stale transition.
  lastTalkingDetected = null;
  lastBlinkDetected = null;
  firstMetricsLogged = false;
  firstPulseLogged = false;
  firstHrvLogged = false;
  lastSdkPacketElapsedMs = null;
  sdkRunningAtElapsedMs = null;
  stallActive = false;
  smartSpectraRecoveryInFlight = false;
  lastProcessingStatusName = null;
  lastValidationName = null;
  lastMetricReadinessWarning = null;
  latestValidationStatus = null;
  speechEverStarted = false;
  recognitionRetryCount = 0;
  silentWindowCount = 0;
  noSpeechToastShown = false;
  sessionButton.textContent = "Stop Free Session";
  sessionButton.classList.add("is-recording");
  updateUtteranceCount();
  const speechAvailable = Boolean(SpeechRecognition) || isElectronApp;
  setStreamStatus("STARTING", true);
  setSpeechStatus(speechAvailable ? "STARTING" : "UNAVAILABLE");
  setSmartSpectraStatus("starting");
  setMeasurementReadiness("Transcript and blink observations are the default. Optional sensor settings apply to new sessions.");
  setMicStatus(speechAvailable ? "STARTING" : "UNAVAILABLE");
  sessionClockTimer = window.setInterval(updateSessionClock, 1000);
  smartSpectraWatchdogTimer = window.setInterval(checkSmartSpectraStall, SMARTSPECTRA_WATCHDOG_INTERVAL_MS);
  updateSessionClock();

  const cameraPermissionRequest = startCameraPreview();

  if (isElectronApp) {
    speechMode = "local_speech_recognition";
    startLocalStt();
  } else if (SpeechRecognition) {
    speechMode = "browser_speech_recognition";
    startRecognition();
  } else {
    speechMode = "unavailable";
    setStreamStatus("UNAVAILABLE", true);
    setSpeechStatus("UNAVAILABLE");
    showToast("Continuous speech recognition is not supported in this browser. Transcript capture is unavailable.");
  }
  const cameraConnected = await cameraPermissionRequest;
  if (!sessionActive) return;
  if (cameraConnected && sessionActive) {
    await startSmartSpectraTelemetry(cameraStream);
  } else {
    setSmartSpectraStatus("camera unavailable");
    setMeasurementReadiness("Camera unavailable; SmartSpectra cannot measure this session.");
  }
}

function openSessionConsent() {
  if (!consentDialog.open) {
    consentInput.checked = false;
    if (SpeechRecognition || isElectronApp) {
      consentRow.hidden = false;
      confirmSessionButton.disabled = true;
      consentSupportNote.textContent = isElectronApp
        ? "Speech transcription runs locally on this device with a downloaded model; microphone audio is not sent to a cloud service. The first run downloads the model (about 40 MB)."
        : "Speech recognition is available here but may be unavailable in the desktop app. Microphone access is managed by the browser speech service; if transcription never starts, the session continues with the camera preview and sensor telemetry.";
    } else {
      consentRow.hidden = true;
      confirmSessionButton.disabled = false;
      consentSupportNote.textContent =
        "This browser does not support the Web Speech Recognition API, so transcription is unavailable in the desktop app. A camera preview can start and the session continues with sensor telemetry.";
    }
    consentDialog.showModal();
  }
}

function stopRecognition() {
  clearRecognitionRestart();
  clearRecognitionStartupTimer();
  if (!recognition) return;
  const instance = recognition;
  recognition = null;
  instance.onend = null;
  instance.onerror = null;
  instance.onresult = null;
  try {
    instance.stop();
  } catch {
    // Recognition may have stopped already.
  }
}

function getPreferredMicDeviceId() {
  try {
    return window.localStorage.getItem(MIC_PREFERENCE_KEY) || "";
  } catch {
    return "";
  }
}

function setPreferredMicDeviceId(id) {
  try {
    if (id) window.localStorage.setItem(MIC_PREFERENCE_KEY, id);
    else window.localStorage.removeItem(MIC_PREFERENCE_KEY);
  } catch {
    // Storage unavailable; the picker still works for this run.
  }
}

function getPreferredCameraDeviceId() {
  try {
    return window.localStorage.getItem(CAMERA_PREFERENCE_KEY) || "";
  } catch {
    return "";
  }
}

function setPreferredCameraDeviceId(id) {
  try {
    if (id) window.localStorage.setItem(CAMERA_PREFERENCE_KEY, id);
    else window.localStorage.removeItem(CAMERA_PREFERENCE_KEY);
  } catch {
    // Storage unavailable; the picker still works for this run.
  }
}

async function startCameraPreview(deviceId) {
  cameraError.textContent = "";
  if (videoFileSourceUrl && videoFile) {
    const started = await startVideoFilePreview(videoFile);
    return started ? cameraStream : false;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    markHeadDirectionTrackerNoCamera();
    cameraError.textContent = "Camera preview requires a supported browser and a secure context (HTTPS or localhost).";
    setCameraStatus("UNAVAILABLE");
    return false;
  }

  const constraints = {
    audio: false,
    video: deviceId
      ? { deviceId: { exact: deviceId }, ...CAMERA_CAPTURE_CONSTRAINTS }
      : { facingMode: "user", ...CAMERA_CAPTURE_CONSTRAINTS },
  };

  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    cameraStream = stream;
    cameraVideo.srcObject = cameraStream;
    cameraPreviewWasConnected = true;
    cameraStage.classList.add("is-live");
    cameraPlaceholder.hidden = true;
    setCameraStatus("PREVIEW ON");
    setHeadDirectionPreviewStatus();
    return true;
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    cameraStream = null;
    markHeadDirectionTrackerNoCamera();
    setCameraStatus("OFF");
    const messages = {
      NotAllowedError: "Camera permission was denied. Speech recognition may still start if supported and permitted by your browser.",
      NotFoundError: "No camera was found. Speech recognition may still work if supported by your browser.",
      NotReadableError: "The camera is unavailable or already in use.",
      OverconstrainedError: "The selected camera cannot provide the requested 30 fps mode. Choose a camera mode that supports 30 fps or select another camera.",
    };
    cameraError.textContent =
      messages[error?.name] || `Could not start camera preview: ${error instanceof Error ? error.message : "unknown error"}`;
    return false;
  }
}

async function startVideoFilePreview(file) {
  if (videoFileSourceUrl) {
    URL.revokeObjectURL(videoFileSourceUrl);
    videoFileSourceUrl = null;
  }
  videoFile = file;
  videoFileSourceUrl = URL.createObjectURL(file);
  cameraVideo.pause();
  cameraVideo.srcObject = null;
  cameraVideo.src = videoFileSourceUrl;
  cameraVideo.loop = true;
  cameraVideo.removeAttribute("muted");
  cameraVideo.muted = false;
  cameraVideo.volume = 1;
  cameraVideo.playsInline = true;
  cameraVideo.load();
  try {
    await cameraVideo.play();
    if (cameraVideo.readyState < 2) {
      await new Promise((resolve) => {
        cameraVideo.addEventListener('loadeddata', resolve, { once: true });
      });
    }
  } catch (error) {
    cameraError.textContent = `Could not play video: ${error instanceof Error ? error.message : "unknown error"}`;
    return false;
  }
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
  }
cameraStream = cameraVideo.captureStream(30);
  cameraPreviewWasConnected = true;
  cameraStage.classList.add("is-live");
    cameraPlaceholder.hidden = true;
    setCameraStatus("VIDEO FILE");
    setHeadDirectionPreviewStatus();
    return true;
}

async function populateCameraOptions(savedId) {
  // Opening the default stream also grants the permission that unlocks device
  // labels in enumerateDevices, and reveals which physical device "default" currently maps to.
  let defaultLabel = "";
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } });
    defaultLabel = (probe.getVideoTracks()[0]?.label || "").replace(/^Camera /, "") || "";
    probe.getTracks().forEach((track) => track.stop());
  } catch {
    // enumerateDevices still works; labels may just be blank.
  }

  const devices = [...(await navigator.mediaDevices.enumerateDevices())]
    .filter((device) => device.kind === "videoinput" &&
      device.deviceId !== "default" && device.deviceId !== "communications");

  cameraOptions.textContent = "";
  const options = [{ value: "", label: `System default${defaultLabel ? ` — ${defaultLabel}` : ""}` }];

  for (const device of devices) {
    const label = device.label || "Camera";
    options.push({ value: device.deviceId, label: `${label}${label === defaultLabel ? " (system default)" : ""}` });
  }

  for (const option of options) {
    const row = document.createElement("label");
    row.className = "modal-consent-row";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "camera-device";
    input.value = option.value;
    input.checked = option.value === savedId;
    const text = document.createElement("span");
    text.className = "mic-option-label";
    text.textContent = option.label;
    input.addEventListener("change", () => {
      if (!input.checked) return;
      startCameraPreview(option.value).catch(() => {
        cameraNote.textContent =
          "That camera could not be opened. It may be busy, missing, or blocked by Windows privacy settings.";
      });
    });
    row.append(input, text);
    cameraOptions.append(row);
  }
}

async function openCameraSettings() {
  cameraNote.textContent = "";
  const savedId = getPreferredCameraDeviceId();
  let populated = false;
  try {
    await populateCameraOptions(savedId);
    populated = true;
  } catch {
    cameraNote.textContent =
      "Could not enumerate camera devices. Check Windows privacy settings for camera access.";
  }
  try {
    await startCameraPreview(savedId);
  } catch {
    cameraNote.textContent = populated
      ? "The selected camera could not be opened for the preview. It may be busy, missing, or blocked."
      : "Could not enumerate camera devices. Check Windows privacy settings for camera access.";
  }
  if (!cameraDialogElement.open) cameraDialogElement.showModal();
}

function stopMicPreview() {
  if (micMeter.frame) {
    window.cancelAnimationFrame(micMeter.frame);
    micMeter.frame = 0;
  }
  if (micMeter.source) {
    try {
      micMeter.source.disconnect();
    } catch {
      // already disconnected
    }
    micMeter.source = null;
  }
  micMeter.analyser = null;
  if (micMeter.context) {
    try {
      void micMeter.context.close();
    } catch {
      // already closed
    }
    micMeter.context = null;
  }
  if (micMeter.stream) {
    micMeter.stream.getTracks().forEach((track) => track.stop());
    micMeter.stream = null;
  }
}

function updateMicMeter() {
  if (!micMeter.analyser) {
    micMeter.frame = 0;
    return;
  }
  micMeter.analyser.getFloatTimeDomainData(micMeter.buffer);
  let sum = 0;
  for (let i = 0; i < micMeter.buffer.length; i += 1) sum += micMeter.buffer[i] ** 2;
  const rms = Math.sqrt(sum / micMeter.buffer.length);
  const percent = Math.min(100, Math.round(rms * 260));
  micMeterFill.style.width = `${percent}%`;
  micMeterFill.classList.toggle("is-low", percent < 6);
  micMeter.frame = window.requestAnimationFrame(updateMicMeter);
}

async function startMicPreview(deviceId) {
  stopMicPreview();
  micMeter.stream = await navigator.mediaDevices.getUserMedia(
    deviceId ? { audio: { deviceId: { exact: deviceId } } } : { audio: true },
  );
  micMeter.context = new AudioContext();
  const source = micMeter.context.createMediaStreamSource(micMeter.stream);
  const analyser = micMeter.context.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  micMeter.source = source;
  micMeter.analyser = analyser;
  micMeter.buffer = new Float32Array(analyser.fftSize);
  micMeter.frame = window.requestAnimationFrame(updateMicMeter);
}

function physicalMicLabel(trackLabel) {
  return trackLabel.replace(/^Default - /, "").replace(/^Communications - /, "");
}

async function populateMicrophoneOptions(savedId) {
  // Opening the default stream also grants the permission that unlocks device
  // labels in enumerateDevices, and reveals which physical device "default"
  // currently maps to.
  let defaultLabel = "";
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    defaultLabel = physicalMicLabel(probe.getAudioTracks()[0]?.label || "");
    probe.getTracks().forEach((track) => track.stop());
  } catch {
    // enumerateDevices still works; labels may just be blank.
  }

  const devices = [...(await navigator.mediaDevices.enumerateDevices())]
    .filter((device) => device.kind === "audioinput" &&
      device.deviceId !== "default" && device.deviceId !== "communications");

  microphoneOptions.textContent = "";
  const options = [{ value: "", label: `System default${defaultLabel ? ` — ${defaultLabel}` : ""}` }];
  for (const device of devices) {
    const label = device.label || "Microphone";
    options.push({ value: device.deviceId, label: `${label}${label === defaultLabel ? " (system default)" : ""}` });
  }

  for (const option of options) {
    const row = document.createElement("label");
    row.className = "modal-consent-row";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "microphone-device";
    input.value = option.value;
    input.checked = option.value === savedId;
    const text = document.createElement("span");
    text.className = "mic-option-label";
    text.textContent = option.label;
    input.addEventListener("change", () => {
      if (!input.checked) return;
      startMicPreview(option.value).catch(() => {
        microphoneNote.textContent =
          "That device could not be opened. It may be busy, missing, or blocked by Windows privacy settings.";
      });
    });
    row.append(input, text);
    microphoneOptions.append(row);
  }
}

async function openMicrophoneSettings() {
  microphoneNote.textContent = "";
  const savedId = getPreferredMicDeviceId();
  let populated = false;
  try {
    await populateMicrophoneOptions(savedId);
    populated = true;
  } catch {
    microphoneNote.textContent =
      "Could not enumerate microphone devices. Check Windows privacy settings for microphone access.";
  }
  try {
    await startMicPreview(savedId);
  } catch {
    microphoneNote.textContent = populated
      ? "The selected device could not be opened for the level meter. It may be busy, missing, or blocked."
      : "Could not enumerate microphone devices. Check Windows privacy settings for microphone access.";
  }
  if (!microphoneDialog.open) microphoneDialog.showModal();
}

function markSpeechHeard() {
  silentWindowCount = 0;
  if (hudChips.speech.state.textContent === "NO SPEECH DETECTED") {
    setSpeechStatus("LISTENING");
    setMicStatus("LISTENING");
  }
}

function flushLocalSttChunk(requestId = null) {
  if (!localStt.active) return;
  const now = elapsedMs();
  if (localStt.lastFlushAtMs === null) {
    localStt.lastFlushAtMs = now;
    window.practiceBridge?.flushLocalStt(now, requestId);
    return;
  }
  const raw = new Float32Array(localStt.pcmCount);
  let offset = 0;
  for (const chunk of localStt.pcmBuffer) {
    raw.set(chunk, offset);
    offset += chunk.length;
  }
  localStt.pcmBuffer = [];
  localStt.pcmCount = 0;
  const rate = localStt.audioContext?.sampleRate || STT_TARGET_RATE;
  const samples = resampleTo16k(raw, rate);
  if (samples.length === 0) {
    window.practiceBridge?.flushLocalStt(now, requestId);
    return;
  }
  window.practiceBridge?.sendLocalSttAudio(Array.from(samples), now);
  window.practiceBridge?.flushLocalStt(now, requestId);
}

// Sends any unflushed mic audio so the final seconds of a session are
// transcribed, and returns the request id used to await its completion.
// Anchors a window first when the session is too short to have one, so short
// sessions are not dropped entirely.
function sendLocalSttTail() {
  if (!localStt.active || !window.practiceBridge?.flushLocalStt) return null;
  const now = elapsedMs();
  if (localStt.lastFlushAtMs === null) {
    localStt.lastFlushAtMs = 0;
    window.practiceBridge.flushLocalStt(0);
  }
  sttFlushCounter += 1;
  const requestId = `tail-${sttFlushCounter}`;
  flushLocalSttChunk(requestId);
  return requestId;
}

function waitForLocalSttFlushDone(requestId, timeoutMs) {
  return new Promise((resolve) => {
    if (!window.practiceBridge?.onLocalSttResult) {
      resolve();
      return;
    }
    let settled = false;
    let timeoutId = null;
    const off = window.practiceBridge.onLocalSttResult((message) => {
      if (settled || message.type !== "flush_done" || message.requestId !== requestId) return;
      settled = true;
      window.clearTimeout(timeoutId);
      off();
      resolve();
    });
    timeoutId = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      off();
      resolve();
    }, timeoutMs);
  });
}

function markLocalSttUnavailable(message) {
  localStt.active = false;
  speechMode = "unavailable";
  setSpeechStatus("UNAVAILABLE");
  setMicStatus("UNAVAILABLE");
  setStreamStatus("UNAVAILABLE");
  showToast(message || "Local speech transcription is unavailable. The session continues with the camera preview and sensor telemetry.", true);
  stopLocalStt();
}

function stopLocalStt() {
  localStt.active = false;
  localStt.modelReady = false;
  if (localStt.flushTimer !== null) {
    window.clearInterval(localStt.flushTimer);
    localStt.flushTimer = null;
  }
  if (localStt.processor) {
    try {
      localStt.processor.disconnect();
    } catch {
      // already disconnected
    }
    localStt.processor = null;
  }
  if (localStt.audioContext) {
    try {
      localStt.audioContext.close();
    } catch {
      // already closed
    }
    localStt.audioContext = null;
  }
  if (localStt.micStream) {
    localStt.micStream.getTracks().forEach((track) => track.stop());
    localStt.micStream = null;
  }
  localStt.pcmBuffer = [];
  localStt.pcmCount = 0;
  localStt.lastFlushAtMs = null;
  window.practiceBridge?.stopLocalStt();
}

function resampleTo16k(source, fromRate) {
  if (fromRate === STT_TARGET_RATE) return source;
  const ratio = fromRate / STT_TARGET_RATE;
  const output = new Float32Array(Math.floor(source.length / ratio));
  for (let i = 0; i < output.length; i += 1) {
    output[i] = source[Math.floor(i * ratio)];
  }
  return output;
}

function setupLocalSttAudioPipeline(stream) {
  const audioContext = new AudioContext();
  localStt.audioContext = audioContext;
  if (audioContext.state === "suspended") {
    void audioContext.resume();
  }
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  localStt.processor = processor;
  processor.onaudioprocess = (event) => {
    if (!localStt.active) return;
    const channel = event.inputBuffer.getChannelData(0);
    localStt.pcmBuffer.push(new Float32Array(channel));
    localStt.pcmCount += channel.length;
  };
  source.connect(processor);
  processor.connect(audioContext.destination);
  localStt.flushTimer = window.setInterval(flushLocalSttChunk, STT_FLUSH_MS);
}

async function openLocalSttMicStream() {
  const preferred = getPreferredMicDeviceId();
  if (preferred) {
    try {
      return {
        stream: await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: preferred } } }),
        fellBack: false,
      };
    } catch {
      setPreferredMicDeviceId("");
    }
  }
  return { stream: await navigator.mediaDevices.getUserMedia({ audio: true }), fellBack: Boolean(preferred) };
}

async function startLocalStt() {
  try {
    localStt.active = true;
    setMicStatus("STARTING");
    setSpeechStatus("STARTING");
    setStreamStatus("STARTING", true);

    const startResult = await window.practiceBridge?.startLocalStt();
    if (!startResult?.ok) {
      markLocalSttUnavailable(startResult?.error || "Local speech transcription could not start.");
      return;
    }

    const { stream, fellBack } = await openLocalSttMicStream();
    if (!localStt.active) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    localStt.micStream = stream;
    setupLocalSttAudioPipeline(stream);
    if (fellBack) {
      showToast("The saved microphone was unavailable, so the system default is in use. Pick another input under File › Microphone.", true);
    }
    setMicStatus("LISTENING");
    setSpeechStatus(localStt.modelReady ? "LISTENING" : "LOADING MODEL");
  } catch {
    markLocalSttUnavailable("The microphone could not be opened. Check the microphone permission and that no other app is using it.");
  }
}

function handleLocalSttResult(message) {
  if (!localStt.active && message.type !== "status") return;
  if (message.type === "ready") {
    localStt.modelReady = true;
    if (localStt.active) setSpeechStatus("LISTENING");
  } else if (message.type === "status") {
    if (localStt.active) setSpeechStatus(localStt.modelReady ? "LISTENING" : "LOADING MODEL");
    if (message.message.startsWith("Downloading local speech model") && !localStt.downloadToastShown) {
      localStt.downloadToastShown = true;
      showToast("First run: downloading the local speech model (about 40 MB). It is stored on this device.");
    }
  } else if (message.type === "final") {
    if (!sessionActive || !localStt.active) return;
    markSpeechHeard();
    appendUtterance(message.text, "local_transcription", message.endAbsMs, message.startAbsMs);
  } else if (message.type === "interim") {
    if (sessionActive) updateInterim(message.text);
    if (localStt.active && !message.text) {
      silentWindowCount += 1;
      if (silentWindowCount >= 3 && !noSpeechToastShown) {
        noSpeechToastShown = true;
        setSpeechStatus("NO SPEECH DETECTED");
        setMicStatus("NO SPEECH DETECTED");
        showToast("No speech detected yet. Check File › Microphone to pick the correct input and watch its level meter.", true);
      }
    }
  } else if (message.type === "error") {
    markLocalSttUnavailable(message.message);
  }
}

function stopCameraPreview() {
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
  }
  cameraVideo.srcObject = null;
  if (videoFileSourceUrl) {
    cameraVideo.pause();
    cameraVideo.currentTime = 0;
    cameraVideo.src = "";
    URL.revokeObjectURL(videoFileSourceUrl);
    videoFileSourceUrl = null;
  }
  cameraStage.classList.remove("is-live");
  cameraPlaceholder.hidden = false;
  setCameraStatus("OFF");
  setMicStatus("OFF");
  headDirectionValue.textContent = activeSessionFeatures.headDirection ? "CAMERA OFF" : "OFF";
}

async function stopFreeSession(showMessage) {
  if (sessionStopping) return;
  sessionStopping = true;
  sessionActive = false;
  sessionStoppedAt = performance.now();
  let cleanupSucceeded = true;
  try {
    const partial = interimText.textContent.trim();
    if (partial) {
      appendUtterance(
        partial,
        "speech_recognition_partial",
        elapsedMs(),
        pendingSpeechStartMs ?? lastRecognitionAtMs,
      );
    }
    // Transcribe the final seconds of mic audio before tearing the capture
    // down; without this the tail of every session was discarded.
    if (localStt.active) {
      const tailId = sendLocalSttTail();
      if (tailId !== null) await waitForLocalSttFlushDone(tailId, 15000);
    }
    pendingSpeechStartMs = null;
    stopRecognition();
    stopLocalStt();
    cleanupSucceeded = await stopSmartSpectraTelemetry();
  } catch {
    cleanupSucceeded = false;
  } finally {
    // Always tear down timers, camera, and UI — a failure in the async
    // cleanup path must not leave the clock ticking or the camera running.
    stopCameraPreview();
    if (sessionClockTimer !== null) {
      window.clearInterval(sessionClockTimer);
      sessionClockTimer = null;
    }
    if (smartSpectraWatchdogTimer !== null) {
      window.clearInterval(smartSpectraWatchdogTimer);
      smartSpectraWatchdogTimer = null;
    }
    smartSpectraRecoveryInFlight = false;
    sessionButton.textContent = "Start Free Session";
    sessionButton.classList.remove("is-recording");
    consentInput.disabled = false;
    setSpeechStatus("IDLE");
    setMicStatus("OFF");
    setStreamStatus("SESSION ENDED");
    updateInterim("");
    updateUtteranceCount();
    sessionStopping = false;
    if (showMessage) {
      showToast(
        cleanupSucceeded
          ? "Session ended. Export the transcript and any connected raw sensor samples."
          : "Session ended with errors. Export the transcript and any connected raw sensor samples.",
        !cleanupSucceeded,
      );
    }
  }
}

function updateTelemetry() {
  const hasBiometrics = biometricSamples.length > 0;
  const displayedFeatures = sessionOrigin === null ? sensorFeaturePreferences : activeSessionFeatures;
  // "Connected" must reflect live packet flow, not historical samples: the
  // 19:53 session read as connected for 69 s after the pipeline had failed.
  if (hasBiometrics) {
    if (smartSpectraPacketsStalled()) {
      setSensorStatus("STALLED");
    } else {
      setSensorStatus("CONNECTED");
      if (hasBiometrics && smartSpectraState !== "auth_rejected") {
        setSmartSpectraStatus("connected");
      }
    }
  } else {
    setSensorStatus(smartSpectraState.replaceAll("_", " ").toUpperCase());
  }

  const latestPulse = [...biometricSamples].reverse().find((sample) =>
    sample.pulse_stable === true && hasPositiveMeasurement(sample.pulse_bpm));
  const latestHrv = [...biometricSamples].reverse().find((sample) =>
    sample.hrv_stable === true && hasPositiveMeasurement(sample.hrv_ms));
  $("#blink-value").textContent = String(
    blinkEvents.filter((event) => event.counted_as_blink === true).length,
  );
  const talkingEl = $("#talking-value");
  if (displayedFeatures?.talking) {
    if (latestTalking && latestTalking.stable) {
      talkingEl.innerHTML = `<span class="talking-badge is-stable">TALKING ACTIVE STABLE</span>`;
    } else if (latestTalking) {
      talkingEl.innerHTML = `<span class="talking-badge is-active">TALKING ACTIVE</span>`;
    } else {
      talkingEl.innerHTML = `<span class="talking-badge is-off">LISTENING OFF</span>`;
    }
  } else {
    talkingEl.innerHTML = `<span class="talking-badge is-off">OFF</span>`;
  }
  $("#pulse-value").innerHTML = !displayedFeatures.pulse
    ? "OFF"
    : latestPulse
      ? `${latestPulse.pulse_bpm.toFixed(1)} <small>BPM</small>`
      : "— <small>BPM</small>";
  $("#hrv-value").innerHTML = !displayedFeatures.hrv
    ? "OFF"
    : latestHrv
      ? `${latestHrv.hrv_ms.toFixed(1)} <small>MS</small>`
      : "— <small>MS</small>";
  updateUtteranceCount();
}

// Classifies a raw head-direction vector (normalized -1..1 landmark-derived coordinate)
// into an observer-view direction, NLP cue code, NLP classification, and
// cognitive type per the directional gaze matrix in nlp_reference_guide.md.
// The vector is read from the observer's (camera) frame of the subject; a LEFT
// handedness preference inverts the horizontal component before classifying.
// Computes cardio changes only after both session reference baselines are established.
function computeDerivedBiometrics(utterance, biometricSamplesById, cardioBaseline) {
  const sampleIds = utterance.biometric_sample_ids;
  if (!sampleIds || sampleIds.length === 0) {
    return {
      pulse_bpm: null,
      pulse_baseline_bpm: cardioBaseline.pulse_bpm.value,
      pulse_spike_bpm: null,
      pulse_confidence: null,
      hrv_ms: null,
      hrv_baseline_ms: cardioBaseline.hrv_ms.value,
      hrv_metric: null,
      hrv_confidence: null,
      hrv_delta_ms: null,
      blink_suppression_s: null,
      blink_rate_pm: null,
      blink_detected: null,
      blink_stable: null,
      talking_detected: null,
      talking_stable: null,
      pulse_baseline_status: cardioBaseline.pulse_bpm.status,
      hrv_baseline_status: cardioBaseline.hrv_ms.status,
      analysis_status: activeSessionFeatures.pulse || activeSessionFeatures.hrv
        ? "no_biometric_samples"
        : "cardio_metrics_disabled",
    };
  }

  const samples = sampleIds
    .map(id => biometricSamplesById.get(id))
    .filter(Boolean)
    .sort((a, b) => a.timestamp_ms - b.timestamp_ms);

  if (samples.length === 0) {
    return {
      pulse_bpm: null,
      pulse_baseline_bpm: cardioBaseline.pulse_bpm.value,
      pulse_spike_bpm: null,
      pulse_confidence: null,
      hrv_ms: null,
      hrv_baseline_ms: cardioBaseline.hrv_ms.value,
      hrv_metric: null,
      hrv_confidence: null,
      hrv_delta_ms: null,
      blink_suppression_s: null,
      blink_rate_pm: null,
      blink_detected: null,
      blink_stable: null,
      talking_detected: null,
      talking_stable: null,
      pulse_baseline_status: cardioBaseline.pulse_bpm.status,
      hrv_baseline_status: cardioBaseline.hrv_ms.status,
      analysis_status: activeSessionFeatures.pulse || activeSessionFeatures.hrv
        ? "no_biometric_samples"
        : "cardio_metrics_disabled",
    };
  }

  const latestPulse = [...samples].reverse().find((sample) => hasPositiveMeasurement(sample.pulse_bpm));
  const latestHrv = [...samples].reverse().find((sample) => hasPositiveMeasurement(sample.hrv_ms));
  const pulseBpm = latestPulse?.pulse_bpm ?? null;
  const pulseConfidence = latestPulse?.pulse_confidence ?? null;
  const hrvMs = latestHrv?.hrv_ms ?? null;
  const hrvMetric = latestHrv?.hrv_metric ?? null;
  const hrvConfidence = latestHrv?.hrv_confidence ?? null;
  const latestBlink = [...samples].reverse().find((sample) => typeof sample.blink_detected === "boolean");
  const pulseAfterBaseline = cardioBaseline.pulse_bpm.status === "established"
    ? [...samples].reverse().find((sample) =>
      sample.timestamp_ms > cardioBaseline.pulse_bpm.end_ms &&
      sample.pulse_stable === true &&
      hasPositiveMeasurement(sample.pulse_bpm))
    : null;
  const hrvAfterBaseline = cardioBaseline.hrv_ms.status === "established"
    ? [...samples].reverse().find((sample) =>
      sample.timestamp_ms > cardioBaseline.hrv_ms.end_ms &&
      sample.hrv_stable === true &&
      hasPositiveMeasurement(sample.hrv_ms))
    : null;
  const pulseSpikeBpm = pulseAfterBaseline
    ? pulseAfterBaseline.pulse_bpm - cardioBaseline.pulse_bpm.value
    : null;
  const hrvDeltaMs = hrvAfterBaseline
    ? hrvAfterBaseline.hrv_ms - cardioBaseline.hrv_ms.value
    : null;
  const baselineReady = cardioBaseline.pulse_bpm.status === "established" &&
    cardioBaseline.hrv_ms.status === "established";

  return {
    pulse_bpm: pulseBpm,
    pulse_baseline_bpm: cardioBaseline.pulse_bpm.value,
    pulse_spike_bpm: pulseSpikeBpm,
    pulse_confidence: pulseConfidence,
    hrv_ms: hrvMs,
    hrv_baseline_ms: cardioBaseline.hrv_ms.value,
    hrv_metric: hrvMetric,
    hrv_confidence: hrvConfidence,
    hrv_delta_ms: hrvDeltaMs,
    blink_suppression_s: null,
    blink_rate_pm: null,
    blink_detected: latestBlink?.blink_detected ?? null,
    blink_stable: latestBlink?.blink_stable ?? null,
    talking_detected: null,
    talking_stable: null,
    pulse_baseline_status: cardioBaseline.pulse_bpm.status,
    hrv_baseline_status: cardioBaseline.hrv_ms.status,
    analysis_status: !activeSessionFeatures.pulse && !activeSessionFeatures.hrv
      ? "cardio_metrics_disabled"
      : baselineReady && pulseAfterBaseline && hrvAfterBaseline
      ? "baseline_relative_metrics_computed"
      : baselineReady
        ? "awaiting_post_baseline_cardio_readings"
        : "cardio_baseline_not_ready",
  };
}

// This paired threshold is a provisional cardio-response heuristic, not a stress diagnosis.
function computeTelemetryFlags(derivedBiometrics) {
  const { pulse_spike_bpm, hrv_delta_ms } = derivedBiometrics;
  const cardioResponse = computeCardioResponse(pulse_spike_bpm, hrv_delta_ms);

  return {
    elevated_cognitive_load: null,
    autonomic_shift_detected: cardioResponse.candidate,
    cardio_response_candidate: cardioResponse.candidate,
    biometric_congruence: null,
    analysis_status: cardioResponse.analysis_status,
  };
}

function formatSessionTimestamp(timestampMs) {
  const totalMs = Math.max(0, Math.round(timestampMs));
  const minutes = Math.floor(totalMs / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const milliseconds = totalMs % 1000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

function recordHeadDirectionSample(sample, metadata = {}) {
  if (!sessionActive) throw new Error("Start a practice session before sending head-direction samples.");
  if (!Number.isFinite(sample.x) || !Number.isFinite(sample.y) ||
      (sample.z !== undefined && !Number.isFinite(sample.z))) {
    throw new TypeError("Head-direction coordinates must be finite numbers.");
  }
  const timestamp = sample.timestamp_ms ?? elapsedMs();
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new TypeError("Head-direction timestamp_ms must be non-negative.");
  }
  headDirectionCounter += 1;
  headDirectionSamples.push({
    sample_id: `g-${String(headDirectionCounter).padStart(5, "0")}`,
    timestamp_ms: Math.round(timestamp),
    x: sample.x,
    y: sample.y,
    ...metadata,
    ...(sample.z === undefined ? {} : { z: sample.z }),
  });
  updateTelemetry();
}

function addHeadDirectionSample(sample) {
  return recordHeadDirectionSample(sample, { source: HEAD_DIRECTION_SOURCE, calibrated: true });
}

function addBiometricSample(sample) {
  if (!sessionActive) throw new Error("Start a practice session before sending biometric samples.");
  const metricNames = [
    "blink_rate_hz",
    "hrv_ms",
    "pulse_bpm",
    "pulse_confidence",
    "hrv_confidence",
    "source_timestamp_us",
  ];
  for (const name of metricNames) {
    if (sample[name] !== undefined && (!Number.isFinite(sample[name]) || sample[name] < 0)) {
      throw new TypeError(`${name} must be a finite non-negative number.`);
    }
  }
  for (const name of ["pulse_confidence", "hrv_confidence"]) {
    if (sample[name] !== undefined && sample[name] > 100) {
      throw new RangeError(`${name} must not exceed 100.`);
    }
  }
  for (const name of [
    "pulse_stable", "hrv_stable", "blink_detected", "blink_stable", "talking_detected", "talking_stable",
  ]) {
    if (sample[name] !== undefined && typeof sample[name] !== "boolean") {
      throw new TypeError(`${name} must be a boolean.`);
    }
  }
  if (sample.hrv_metric !== undefined && sample.hrv_metric !== "RMSSD") {
    throw new TypeError("hrv_metric must be RMSSD when provided.");
  }
  const timestamp = sample.timestamp_ms ?? elapsedMs();
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new TypeError("Biometric timestamp_ms must be non-negative.");
  }
  biometricCounter += 1;
  const storedSample = {
    sample_id: `b-${String(biometricCounter).padStart(5, "0")}`,
    timestamp_ms: Math.round(timestamp),
    ...(sample.blink_rate_hz === undefined ? {} : { blink_rate_hz: sample.blink_rate_hz }),
    ...(sample.hrv_ms === undefined ? {} : { hrv_ms: sample.hrv_ms }),
    ...(sample.pulse_bpm === undefined ? {} : { pulse_bpm: sample.pulse_bpm }),
    ...(sample.source_timestamp_us === undefined ? {} : { source_timestamp_us: sample.source_timestamp_us }),
    ...(sample.pulse_confidence === undefined ? {} : { pulse_confidence: sample.pulse_confidence }),
    ...(sample.hrv_confidence === undefined ? {} : { hrv_confidence: sample.hrv_confidence }),
    ...(sample.hrv_metric === undefined ? {} : { hrv_metric: sample.hrv_metric }),
    ...(sample.pulse_stable === undefined ? {} : { pulse_stable: sample.pulse_stable }),
    ...(sample.hrv_stable === undefined ? {} : { hrv_stable: sample.hrv_stable }),
    ...(sample.blink_detected === undefined ? {} : { blink_detected: sample.blink_detected }),
    ...(sample.blink_stable === undefined ? {} : { blink_stable: sample.blink_stable }),
    ...(sample.talking_detected === undefined ? {} : { talking_detected: sample.talking_detected }),
    ...(sample.talking_stable === undefined ? {} : { talking_stable: sample.talking_stable }),
  };
  biometricSamples.push(storedSample);
  updateTelemetry();
  return storedSample;
}

function buildSessionData() {
  const biometricSamplesById = new Map(biometricSamples.map((sample) => [sample.sample_id, sample]));
  const cardioBaseline = computeCardioBaseline(biometricSamples);
  const { codes: requestedMetricCodes, names: requestedMetricNames } = getRequestedMetricInfo(activeSessionFeatures);
  const trackerHeadDirectionSamples = headDirectionSamples.filter((sample) => sample.source === HEAD_DIRECTION_SOURCE && sample.calibrated === true);
  const adapterHeadDirectionSamples = headDirectionSamples.filter((sample) => sample.source !== HEAD_DIRECTION_SOURCE || sample.calibrated !== true);
  const landmarkSamplesReceived = headDirectionSamples.length > 0;
  const headDirectionEstimatorStatus = landmarkSamplesReceived
    ? "experimental_head_pose_landmarks_estimates_recorded_nlp_mapping_disabled"
    : activeSessionFeatures.headDirection
      ? "awaiting_smart_spectra_landmarks"
      : "disabled_by_user";
  const headDirectionCalibrationStatus = landmarkSamplesReceived
    ? "sdk_stable_flag_provided"
    : activeSessionFeatures.headDirection
      ? "awaiting_smart_spectra_landmarks"
      : "not_requested";

  return {
    session_metadata: {
      session_id: sessionStartedAt,
      app_name: "Baseline",
      timestamp_iso: sessionStartedAt,
      session_ended_at: sessionStoppedAt === null ? null : new Date(Date.parse(sessionStartedAt) + elapsedMs()).toISOString(),
      session_elapsed_ms: elapsedMs(),
      handedness_setting: handedness.toUpperCase(),
      handedness_changes: handednessHistory,
      enabled_features: {
        blink: true,
        pulse: activeSessionFeatures.pulse,
        hrv: activeSessionFeatures.hrv,
        gaze: activeSessionFeatures.headDirection,
      },
      gaze_inversion_active: false,
      gaze_inversion_status: "not_applied_experimental_preview_relative_estimate",
      gaze_estimator: {
        name: "SmartSpectra SDK FACE_LANDMARKS",
        runtime: "smartspectra_sdk",
        tracking_status: headDirectionEstimatorStatus,
        calibration_status: headDirectionCalibrationStatus,
        cognitive_classification: "disabled_not_validated",
        diagnostics: null,
      },
    },
    utterance_telemetry_stream: utterances.map((utterance) => {
      const gazeAnalysis = buildHeadDirectionAnalysis(utterance, headDirectionSamples, handedness);
      if (!activeSessionFeatures.headDirection && !adapterHeadDirectionSamples.length) {
        gazeAnalysis.analysis_status = "head_direction_tracking_disabled_by_user";
      } else if (activeSessionFeatures.headDirection && !trackerHeadDirectionSamples.length) {
        gazeAnalysis.analysis_status = "no_calibrated_gaze_samples_in_utterance_window";
      }

      const derivedBiometrics = computeDerivedBiometrics(utterance, biometricSamplesById, cardioBaseline);
      const utteranceBlinkEvents = blinkEvents.filter((event) =>
        (utterance.blink_event_ids ?? []).includes(event.event_id),
      );
      const blinkCount = countBlinkEvents(
        utteranceBlinkEvents,
        utterance.timestamp_start_ms,
        utterance.timestamp_end_ms,
      );
      const blinkSampleCount = biometricSamples.filter((sample) =>
        typeof sample.blink_detected === "boolean" &&
        sample.timestamp_ms >= utterance.timestamp_start_ms &&
        sample.timestamp_ms <= utterance.timestamp_end_ms,
      ).length;
      const utteranceDurationMs = utterance.timestamp_end_ms - utterance.timestamp_start_ms;

      return {
        utterance_id: utterance.utterance_id,
        timestamp_start: formatSessionTimestamp(utterance.timestamp_start_ms),
        timestamp_end: formatSessionTimestamp(utterance.timestamp_end_ms),
        timestamp_start_ms: utterance.timestamp_start_ms,
        timestamp_end_ms: utterance.timestamp_end_ms,
        timestamp_basis: utterance.timestamp_basis,
        handedness_setting: utterance.handedness_preference.toUpperCase(),
        spoken_text: utterance.transcript_text,
        gaze_analysis: gazeAnalysis,
        presage_biometrics: {
          pulse_bpm: derivedBiometrics.pulse_bpm,
          pulse_baseline_bpm: derivedBiometrics.pulse_baseline_bpm,
          pulse_spike_bpm: derivedBiometrics.pulse_spike_bpm,
          pulse_confidence: derivedBiometrics.pulse_confidence,
          hrv_ms: derivedBiometrics.hrv_ms,
          hrv_baseline_ms: derivedBiometrics.hrv_baseline_ms,
          hrv_metric: derivedBiometrics.hrv_metric,
          hrv_confidence: derivedBiometrics.hrv_confidence,
          hrv_delta_ms: derivedBiometrics.hrv_delta_ms,
          blink_suppression_s: derivedBiometrics.blink_suppression_s,
          blink_rate_pm: derivedBiometrics.blink_rate_pm,
          blink_detected: derivedBiometrics.blink_detected,
          blink_stable: derivedBiometrics.blink_stable,
          talking_detected: derivedBiometrics.talking_detected,
          talking_stable: derivedBiometrics.talking_stable,
          pulse_baseline_status: derivedBiometrics.pulse_baseline_status,
          hrv_baseline_status: derivedBiometrics.hrv_baseline_status,
          analysis_status: derivedBiometrics.analysis_status ?? "raw_observations_only_no_baseline_or_derived_metrics",
        },
        blink_analysis: {
          event_ids: utterance.blink_event_ids ?? [],
          sample_count: blinkSampleCount,
          blink_event_count: blinkCount,
          blink_rate_per_minute: blinkSampleCount > 0 && utteranceDurationMs > 0
            ? Number((blinkCount / (utteranceDurationMs / 60_000)).toFixed(2))
            : null,
          analysis_status: blinkSampleCount === 0
            ? "no_blink_samples_in_approximate_transcription_window"
            : blinkCount > 0
            ? "stable_blink_transitions_in_approximate_transcription_window"
            : utteranceBlinkEvents.length
              ? "unstable_blink_candidates_only"
              : "blink_samples_received_no_stable_blinks",
        },
        speech_detection: {
          linked_event_ids: utterance.face_speech_event_ids ?? [],
          analysis_status: faceSpeechEvents.length
            ? "raw_smartspectra_talking_transitions_window_correlated_not_a_measured_speech_onset"
            : "unavailable_no_face_talking_packets",
        },
        telemetry_flags: computeTelemetryFlags(derivedBiometrics),
      };
    }),
    timestamp_note: "Transcript timestamps are approximate recognition or local transcription windows, not word-level audio timestamps or a measured pre-speech window.",
    sensor_samples: {
      gaze: headDirectionSamples,
      presage_biometrics: biometricSamples,
      face_speech_events: faceSpeechEvents,
      blink_events: blinkEvents,
    },
sample_provenance: {
      gaze: trackerHeadDirectionSamples.length
        ? "Experimental head-pose landmark estimates recorded; NLP/cognitive classification remains disabled."
        : adapterHeadDirectionSamples.length
          ? "Unvalidated adapter coordinates only; head-direction vectors and cognitive classification are not computed."
          : activeSessionFeatures.headDirection
            ? "No head-direction estimates received; awaiting SmartSpectra landmark packets."
            : "Head-direction tracking not requested; no gaze samples recorded.",
      presage_biometrics: biometricSamples.length
        ? "Raw blink-state observations and any enabled pulse/HRV observations. Pulse/HRV baselines use stable readings only; the paired cardio-response flag is a heuristic, not a stress diagnosis."
        : "No SmartSpectra metric samples received.",
      blink_events: blinkEvents.length
        ? "Stable rising transitions in SmartSpectra blink detection; rates are calculated only over approximate transcript windows and are not cognitive-state measures."
        : "No stable blink-on transitions received.",
      face_speech_events: faceSpeechEvents.length
        ? "SmartSpectra talking-detection transitions only; event timing is packet-quantized, not a measured audio speech onset."
        : "No SmartSpectra talking packets received.",
    },
    face_metric_diagnostics: {
      talking_packets: faceMetricDiagnostics.talking_packets,
      talking_transitions: faceMetricDiagnostics.talking_transitions,
      last_talking_detected: faceMetricDiagnostics.last_talking_detected ?? null,
      landmark_packets: faceMetricDiagnostics.landmark_packets,
      first_landmark_point_count: faceMetricDiagnostics.first_landmark_point_count,
      first_landmark_stable: faceMetricDiagnostics.first_landmark_stable,
      first_landmark_reset: faceMetricDiagnostics.first_landmark_reset,
      blink_transitions: faceMetricDiagnostics.blink_transitions,
      last_packet_ms: metricPacketDiagnostics.last_packet_ms,
      note: "Blinking is requested by default. Pulse and HRV are optional. Head-direction estimates are derived from SmartSpectra face landmarks only when enabled; NLP/cognitive classification remains disabled.",
      errors: sessionSdkErrors,
      error_summary: smartSpectraErrorSummary(),
      pipeline_stalled: smartSpectraPacketsStalled(),
      recovery_attempts: smartSpectraRecoveryAttempts,
    },
    smartspectra_diagnostics: {
      requested_metric_codes: requestedMetricCodes,
      requested_metric_names: requestedMetricNames,
      cardio_baseline: cardioBaseline,
      camera_track_settings: cameraTrackSettingsHistory,
      metric_packet_availability: metricPacketDiagnostics,
      validation_status_history: validationStatusHistory,
      latest_validation_status: latestValidationStatus,
      processing_status_history: processingStatusHistory,
      sdk_log_level: "INFO",
    },
    source_status: {
      camera_preview: cameraPreviewWasConnected ? "connected_during_session_preview_only" : "not_connected",
      speech_recognition: speechMode,
      gaze_tracking: headDirectionEstimatorStatus,
      presage_smartspectra: biometricSamples.length
        ? (smartSpectraPacketsStalled()
          ? "timestamped_samples_received_then_pipeline_stalled"
          : "timestamped_samples_received")
        : smartSpectraState,
      smartspectra_talking: faceMetricDiagnostics.talking_packets
        ? "talking_packets_received_transitions_recorded"
        : "not_requested",
      smartspectra_face_landmarks: faceMetricDiagnostics.landmark_packets
        ? "landmark_packets_received_gaze_not_computed"
        : "not_requested",
      smartspectra_blinking: metricPacketDiagnostics.blink_packets
        ? "blink_packets_received"
        : "requested_no_blink_packets_received",
    },
    turn_groups: buildTurnGroups(),
  };
}

// Group consecutive utterances into a turn when the gap between the end of the
// prior utterance and the start of the next is within GAP_THRESHOLD_MS (time-based
// grouping). Returns an array of turns with shared metadata.
function groupUtterancesIntoTurns(utterances) {
  const ordered = [...utterances].sort((a, b) => a.timestamp_start_ms - b.timestamp_start_ms);
  const turns = [];
  let current = null;
  for (const u of ordered) {
    if (!current || u.timestamp_start_ms - (current?.end_ms ?? 0) > GAP_THRESHOLD_MS) {
      current = { turn_id: `TURN-${String(turns.length + 1).padStart(3, "0")}`, utterance_ids: [], start_ms: u.timestamp_start_ms, end_ms: u.timestamp_end_ms, spoken_texts: [] };
      turns.push(current);
    }
    current.utterance_ids.push(u.utterance_id);
    current.end_ms = u.timestamp_end_ms;
    current.spoken_texts.push(u.transcript_text);
  }
  // Heuristic turn labels: first turn is INTRO, subsequent are EXPERIENCE.
  turns.forEach((t, i) => { t.turn_type = i === 0 ? "INTRO" : "EXPERIENCE"; });
  return turns;
}

// Compute delivery metrics per turn:
//   Eye Contact Stability: stable (|dx|,|dy| variance low) across head-direction samples in the turn,
//   Unstable otherwise; null-safe when no head-direction data exists.
//   Pacing: Optimal / Rushed based on total utterance duration vs word count.
function computeTurnMetrics(turn, utterances, headDirectionSamples, biometricSamples, blinkEvents) {
  const byId = new Map(utterances.map((u) => [u.utterance_id, u]));
  const turnUtterances = turn.utterance_ids.map(id => byId.get(id)).filter(Boolean);
  const totalDurationMs = turn.end_ms - turn.start_ms;
  const totalWords = turnUtterances.reduce(
    (sum, u) => sum + (u.transcript_text.split(/\s+/).filter(Boolean).length),
    0
  );
  let pacing = null;
  if (totalDurationMs > 0 && totalWords > 0) {
    const wpm = totalWords / (totalDurationMs / 60000);
    pacing = wpm > PACING_RUSHED_WPM ? "Rushed" : "Optimal";
  }

  const headDirectionInTurn = headDirectionSamples.filter((sample) =>
    sample.timestamp_ms >= turn.start_ms && sample.timestamp_ms <= turn.end_ms
  );

  const bioInTurn = biometricSamples.filter((sample) =>
    sample.timestamp_ms >= turn.start_ms && sample.timestamp_ms <= turn.end_ms
  );
  const avgPulse = averagePositiveMetric(
    bioInTurn.filter((sample) => sample.pulse_stable === true),
    "pulse_bpm",
  );
  const avgHrv = averagePositiveMetric(
    bioInTurn.filter((sample) => sample.hrv_stable === true),
    "hrv_ms",
  );
  const blinkCount = countBlinkEvents(blinkEvents, turn.start_ms, turn.end_ms);

  return {
    eyeContactStability: null,
    pacing,
    avgPulse: avgPulse ?? null,
    avgHrv: avgHrv ?? null,
    blinkCount,
    sampleCount: headDirectionInTurn.length,
  };
}

// Build turn groups for the export: grouping utterances into turns, computing metrics,
// and capturing the dominant cognitive type for each turn.
function buildTurnGroups() {
  const turns = groupUtterancesIntoTurns(utterances);
  return turns.map((turn) => {
    const metrics = computeTurnMetrics(turn, utterances, headDirectionSamples, biometricSamples, blinkEvents);
    return {
      turn_id: turn.turn_id,
      utterance_ids: turn.utterance_ids,
      start_ms: turn.start_ms,
      end_ms: turn.end_ms,
      turn_type: turn.turn_type,
      spoken_text: turn.spoken_texts.join(" "),
      delivery_metrics: {
        eye_contact_stability: metrics.eyeContactStability,
        pacing: metrics.pacing,
        avg_pulse_bpm: metrics.avgPulse,
        avg_hrv_ms: metrics.avgHrv,
        blink_event_count: metrics.blinkCount,
      },
      cognitive_tags: {
        cognitive_type: null,
        nlp_code: null,
        nlp_classification: null,
        analysis_status: !activeSessionFeatures.headDirection
          ? "head_direction_tracking_disabled_by_user"
          : headDirectionSamples.some((sample) => sample.source === HEAD_DIRECTION_SOURCE && sample.calibrated === true)
            ? "disabled_experimental_gaze_not_validated"
            : "head_direction_tracker_requires_calibration_no_estimates",
      },
      sample_count: metrics.sampleCount,
    };
  });
}

function exportSession() {
  const content = JSON.stringify(buildSessionData(), null, 2);
  const file = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = "free-practice-session.json";
  link.click();
  URL.revokeObjectURL(url);
  showToast("Session JSON exported as free-practice-session.json.");
}

// Old handedness sidebar handler removed - replaced by handedness dialog

sessionButton.addEventListener("click", async () => {
  if (sessionActive) {
    await stopFreeSession(true);
    return;
  }
  openSessionConsent();
});
consentInput.addEventListener("change", () => {
  confirmSessionButton.disabled = (SpeechRecognition || isElectronApp) && !consentInput.checked;
});
$("#consent-form").addEventListener("submit", (event) => {
  if (event.submitter?.value !== "start") return;
  event.preventDefault();
  if ((SpeechRecognition || isElectronApp) && !consentInput.checked) return;
  consentDialog.close();
  startFreeSession();
});
exportButton.addEventListener("click", exportSession);

microphoneForm.addEventListener("submit", (event) => {
  if (event.submitter?.value !== "save") return;
  const selected = microphoneOptions.querySelector("input[name='microphone-device']:checked");
  const value = selected ? selected.value : "";
  const deviceLabel = selected?.closest(".modal-consent-row")?.querySelector(".mic-option-label")?.textContent
    || "the system default";
  const changed = value !== getPreferredMicDeviceId();
  setPreferredMicDeviceId(value);
  microphoneDialog.close();
  if (localStt.active) {
    stopLocalStt();
    startLocalStt();
    showToast(`Microphone switched to ${deviceLabel}. This session continues on the new input.`);
  } else if (changed) {
    showToast(`Microphone saved: ${deviceLabel}. It applies to the next session.`);
  }
});

microphoneDialog.addEventListener("close", () => stopMicPreview());

cameraForm.addEventListener("submit", (event) => {
  if (event.submitter?.value !== "save") return;
  const selected = cameraOptions.querySelector("input[name='camera-device']:checked");
  const value = selected ? selected.value : "";
  const deviceLabel = selected?.closest(".modal-consent-row")?.querySelector(".mic-option-label")?.textContent
    || "the system default";
  const changed = value !== getPreferredCameraDeviceId();
  setPreferredCameraDeviceId(value);
  cameraDialogElement.close();
  if (smartSpectraClient && sessionActive && changed) {
    stopCameraPreview();
    startCameraPreview(value).then((connected) => {
      if (connected) {
        startSmartSpectraTelemetry(cameraStream);
      }
    });
    showToast(`Camera switched to ${deviceLabel}. SmartSpectra restarted on the new input.`);
  } else if (changed) {
    showToast(`Camera saved: ${deviceLabel}. It applies to the next session.`);
  }
});

cameraDialogElement.addEventListener("close", () => {
  if (!sessionActive) stopCameraPreview();
});

infoTabButtons.forEach((tab, index) => {
  tab.addEventListener("click", () => activateInfoTab(tab));
  tab.addEventListener("keydown", (event) => {
    let target = null;
    if (event.key === "ArrowRight") target = infoTabButtons[(index + 1) % infoTabButtons.length];
    else if (event.key === "ArrowLeft") target = infoTabButtons[(index + infoTabButtons.length - 1) % infoTabButtons.length];
    else if (event.key === "Home") target = infoTabButtons[0];
    else if (event.key === "End") target = infoTabButtons[infoTabButtons.length - 1];
    if (!target) return;
    event.preventDefault();
    activateInfoTab(target);
  });
});

if (window.practiceBridge?.onShowInformation) {
  window.practiceBridge.onShowInformation(() => {
    activateInfoTab(infoTabButtons[0]);
    if (!informationDialog.open) informationDialog.showModal();
  });
}

if (window.practiceBridge?.onShowHandedness) {
  window.practiceBridge.onShowHandedness(() => {
    const dlg = $("#handedness-dialog");
    if (dlg && !dlg.open) dlg.showModal();
  });
}

if (window.practiceBridge?.onShowMicrophoneSettings) {
  window.practiceBridge.onShowMicrophoneSettings(() => {
    void openMicrophoneSettings();
  });
}

if (window.practiceBridge?.onShowCameraSettings) {
  window.practiceBridge.onShowCameraSettings(() => {
    openCameraSettings();
  });
}

if (window.practiceBridge?.onShowVideoSettings) {
  window.practiceBridge.onShowVideoSettings(() => {
    videoFileInput.click();
  });
}

videoFileInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    await startVideoFilePreview(file);
    if (sessionActive) {
      startSmartSpectraTelemetry(cameraStream);
      showToast("Video file loaded. SmartSpectra restarted on the new source.");
    } else {
      showToast("Video file loaded. Start a session to run SmartSpectra on it.");
    }
  } catch (error) {
    cameraError.textContent = `Could not load video file: ${error instanceof Error ? error.message : "unknown error"}`;
  }
  event.target.value = "";
});

// Wash toggle
const washToggleBtn = $("#washToggleBtn");
if (washToggleBtn) {
  const washLabels = { subtle: "Toggle holographic wash", vivid: "Holographic wash: vivid", off: "Holographic wash: off" };
  washToggleBtn.addEventListener("click", () => {
    const appShell = $("#appShell");
    if (!appShell) return;
    const current = appShell.className;
    if (current.includes("wash-off")) {
      appShell.classList.remove("wash-off");
      appShell.classList.add("wash-vivid");
      washToggleBtn.setAttribute("aria-label", washLabels.vivid);
    } else if (current.includes("wash-vivid")) {
      appShell.classList.remove("wash-vivid");
      appShell.classList.add("wash-off");
      washToggleBtn.setAttribute("aria-label", washLabels.off);
    } else {
      appShell.classList.remove("wash-off", "wash-vivid");
      washToggleBtn.setAttribute("aria-label", washLabels.subtle);
    }
  });
}

// Handedness menu button
const handednessMenuBtn = $("#handedness-menu-btn");
const handednessDialog = $("#handedness-dialog");
if (handednessMenuBtn && handednessDialog) {
  handednessMenuBtn.addEventListener("click", () => {
    if (!handednessDialog.open) handednessDialog.showModal();
  });
}

// Audio / Camera / About topbar buttons mirror the Electron menu shortcuts
$("#audio-menu-btn")?.addEventListener("click", () => {
  void openMicrophoneSettings();
});
$("#camera-menu-btn")?.addEventListener("click", () => {
  openCameraSettings();
});
$("#about-menu-btn")?.addEventListener("click", () => {
  activateInfoTab(infoTabButtons[0]);
  if (!informationDialog.open) informationDialog.showModal();
});

// Handedness dialog button handlers
const handednessDialogButtons = handednessDialog?.querySelectorAll(".toggle-btn") ?? [];
handednessDialogButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const handednessValue = button.dataset.handedness;
    handedness = handednessValue;
    handednessDialogButtons.forEach((item) => {
      const selected = item === button;
      item.classList.toggle("active", selected);
      item.setAttribute("aria-pressed", String(selected));
    });
    if (sessionActive) {
      handednessHistory.push({ timestamp_ms: elapsedMs(), preference: handedness });
    }
    handednessDialog.close();
  });
});

window.practiceBridge?.setSensorFeatureState?.(sensorFeaturePreferences);
if (window.practiceBridge?.onSensorFeatureToggle) {
  window.practiceBridge.onSensorFeatureToggle(({ feature, enabled }) => {
    updateSensorFeaturePreference(feature, enabled);
  });
}
updateTelemetry();

// Data pane view switching (Preview / Signals / JSON)
const dataPaneViewBtns = document.querySelectorAll(".data-pane-tab");
const dataPaneRichText = document.getElementById("data-pane-rich-text");
const dataPaneJson = document.getElementById("data-pane-json");
const dataPaneJsonCode = dataPaneJson?.querySelector(".data-pane-code");
const dataPaneStatus = document.getElementById("data-pane-status");

const cameraStageView = document.getElementById("camera-stage");
const dataPaneSearchBar = document.querySelector(".data-pane-search");
const telemetryGridEl = document.querySelector(".telemetry-grid");

function switchDataPaneView(view) {
  dataPaneViewBtns.forEach((b) => {
    const selected = b.dataset.view === view;
    b.classList.toggle("is-active", selected);
    b.setAttribute("aria-selected", String(selected));
  });
  if (cameraStageView) cameraStageView.hidden = view !== "preview";
  if (dataPaneRichText) dataPaneRichText.hidden = view !== "rich-text";
  if (dataPaneJson) dataPaneJson.hidden = view !== "json";
  // Search only applies to the data views, not the camera preview.
  if (dataPaneSearchBar) dataPaneSearchBar.hidden = view === "preview";
  // Live telemetry signals are shown only on the camera preview tab.
  if (telemetryGridEl) telemetryGridEl.hidden = view !== "preview";
  if (view === "rich-text") {
    renderRichText();
  } else if (view === "json") {
    if (sessionActive) {
      exportSession();
    } else if (dataPaneJsonCode) {
      dataPaneJsonCode.textContent = "No session data";
    }
  }
}

// Initialize the default view (Signals) on load.
switchDataPaneView("rich-text");

dataPaneViewBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    switchDataPaneView(btn.dataset.view || "rich-text");
  });
});

const dataPaneSearch = document.getElementById("data-pane-search");
const dataPaneSearchClear = document.getElementById("data-pane-search-clear");
const dataPaneSearchCount = document.getElementById("data-pane-search-count");

function renderDataPaneSearchResults() {
  if (!dataPaneRichText) return;
  const entries = dataPaneRichText.querySelectorAll(".rich-text-entry");
  const query = (dataPaneSearch?.value || "").trim().toLowerCase();
  let visibleCount = 0;
  entries.forEach((entry) => {
    const transcript = (entry.querySelector(".rich-text-transcript")?.textContent || "").toLowerCase();
    const signals = Array.from(entry.querySelectorAll(".rich-text-badge")).map((b) => (b.textContent || "").toLowerCase()).join(" ");
    const match = query === "" || transcript.includes(query) || signals.includes(query);
    entry.style.display = match ? "grid" : "none";
    if (match) visibleCount += 1;
  });
  if (dataPaneSearchCount) {
    dataPaneSearchCount.textContent = String(visibleCount);
    dataPaneSearchCount.hidden = visibleCount === 0;
  }
}

if (dataPaneSearch) {
  dataPaneSearch.addEventListener("input", renderDataPaneSearchResults);
  dataPaneSearch.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      dataPaneSearch.value = "";
      renderDataPaneSearchResults();
      dataPaneSearch.focus();
    }
  });
}

if (dataPaneSearchClear) {
  dataPaneSearchClear.addEventListener("click", () => {
    dataPaneSearch.value = "";
    renderDataPaneSearchResults();
    dataPaneSearch.focus();
  });
}

const dataPaneExportBtn = document.querySelector(".data-pane-export");
if (dataPaneExportBtn && !dataPaneExportBtn.hasAttribute("data-bound")) {
  dataPaneExportBtn.setAttribute("data-bound", "true");
  dataPaneExportBtn.addEventListener("click", () => {
    if (sessionActive) {
      exportSession();
    } else {
      showToast("Start a session to export JSON data.");
    }
  });
}

function renderRichText() {
  if (!dataPaneRichText) return;
  dataPaneRichText.innerHTML = "";
  const entries = [];
  if (blinkEvents.length > 0) {
    const latest = blinkEvents[blinkEvents.length - 1];
    entries.push({
      time: new Date(latest.timestamp_ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      type: "blink",
      stable: latest.counted_as_blink === true,
      transcript: `Blink event ${latest.event_id ?? ""}: ${latest.counted_as_blink ? "stable" : "unstable"} blink`,
      details: `counted_as_blink: ${latest.counted_as_blink === true}`,
      badge: `<span class="rich-text-badge rich-text-badge--blink">${latest.counted_as_blink ? "BLINK (STABLE)" : "BLINK (UNSTABLE)"}</span>`,
    });
  }
  if (biometricSamples.length > 0) {
    const latestPulse = [...biometricSamples].reverse().find((s) => s.pulse_stable === true && s.pulse_bpm);
    if (latestPulse) {
      entries.push({
        time: new Date(latestPulse.timestamp_ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
        type: "pulse",
        stable: true,
        transcript: `Pulse rate ${latestPulse.pulse_bpm.toFixed(1)} BPM`,
        details: `event ${latestPulse.event_id ?? "N/A"}: ${latestPulse.pulse_bpm.toFixed(1)} BPM`,
        badge: `<span class="rich-text-badge rich-text-badge--pulse">${latestPulse.pulse_stable ? "PULSE (STABLE)" : "PULSE (UNSTABLE)"}</span>`,
      });
    }
    const latestHrv = [...biometricSamples].reverse().find((s) => s.hrv_stable === true && s.hrv_ms);
    if (latestHrv) {
      entries.push({
        time: new Date(latestHrv.timestamp_ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
        type: "hrv",
        stable: true,
        transcript: `HRV ${latestHrv.hrv_ms.toFixed(1)} MS`,
        details: `event ${latestHrv.event_id ?? "N/A"}: ${latestHrv.hrv_ms.toFixed(1)} MS`,
        badge: `<span class="rich-text-badge rich-text-badge--hrv">${latestHrv.hrv_stable ? "HRV (STABLE)" : "HRV (UNSTABLE)"}</span>`,
      });
    }
  }
  if (handednessHistory.length > 0) {
    const latest = handednessHistory[handednessHistory.length - 1];
    entries.push({
      time: new Date(latest.timestamp_ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      type: "head-direction",
      stable: true,
      transcript: `Head direction: ${latest.preference}`,
      details: `preference: ${latest.preference}`,
      badge: `<span class="rich-text-badge rich-text-badge--direction">${latest.preference}</span>`,
    });
  }
  if (faceSpeechEvents.length > 0) {
    const latest = faceSpeechEvents[faceSpeechEvents.length - 1];
    const talkingText = latest.detected ? (latest.stable ? "TALKING STABLE" : "TALKING") : "LISTENING";
    const talkingClass = latest.detected ? (latest.stable ? "rich-text-badge--talking-stable" : "rich-text-badge--talking-active") : "rich-text-badge--talking-off";
    entries.push({
      time: new Date(latest.timestamp_ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      type: "talking",
      stable: latest.stable,
      transcript: talkingText,
      details: `${latest.event_id ?? "N/A"}: detected=${latest.detected}, stable=${latest.stable}`,
      badge: `<span class="rich-text-badge ${talkingClass}">${talkingText}</span>`,
    });
  }
  if (entries.length === 0) {
    dataPaneRichText.innerHTML = `
      <div class="rich-text-empty">
        <div class="rich-text-empty-icon" aria-hidden="true">◎</div>
        <p>No session data</p>
        <span>Start a free session to stream live JSON and rich-text analysis.</span>
      </div>
    `;
    return;
  }
  entries.forEach((entry) => {
    const el = document.createElement("div");
    el.className = "rich-text-entry";
    el.innerHTML = `
      <div class="rich-text-time">${entry.time}</div>
      <div class="rich-text-content">
        <div class="rich-text-transcript">${entry.transcript}</div>
        <div class="rich-text-signals">
          ${entry.badge || `<span class="rich-text-badge rich-text-badge--${entry.type}">${entry.type.toUpperCase()}</span>`}
          <span class="rich-text-badge rich-text-badge--info">${entry.details}</span>
        </div>
      </div>
    `;
    dataPaneRichText.appendChild(el);
  });
}

if (dataPaneStatus) {
  const updateDataPaneStatus = () => {
    if (dataPaneStatus) dataPaneStatus.textContent = sessionActive ? "ACTIVE" : "IDLE";
  };
  updateDataPaneStatus();
  // Re-sync status after session start/stop through the existing lifecycle hooks
  const originalStopSession = stopSession;
  stopSession = ((...args) => {
    const result = originalStopSession(...args);
    updateDataPaneStatus();
    return result;
  });
}

if (window.practiceBridge?.onLocalSttResult) {
  window.practiceBridge.onLocalSttResult(handleLocalSttResult);
}

window.practiceSessionAdapter = Object.freeze({
  onGazeSample: addHeadDirectionSample,
  onBiometricSample: addBiometricSample,
  getSessionData: buildSessionData,
});

window.addEventListener("beforeunload", () => {
  stopRecognition();
  stopLocalStt();
  stopCameraPreview();
  if (sessionClockTimer !== null) window.clearInterval(sessionClockTimer);
});
