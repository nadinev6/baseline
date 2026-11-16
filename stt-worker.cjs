"use strict";

// Local speech-to-text worker for the Baseline desktop app.
// Runs under the system Node.js runtime (not Electron) so the ONNX runtime's
// native bindings match the host Node ABI. Communicates over stdin/stdout:
//   in:  {"type":"start"} | {"type":"audio","samples":number[]} |
//        {"type":"flush","timeAbsMs":number} | {"type":"stop"}
//   out: {"type":"ready"} | {"type":"status","message"} |
//        {"type":"final","text","startAbsMs","endAbsMs"} |
//        {"type":"interim","text"} | {"type":"error","message"}
// stdout carries protocol messages only; all diagnostics go to stderr.

const readline = require("node:readline");
const { pipeline, env } = require("@xenova/transformers");

const MODEL_NAME = "Xenova/whisper-tiny.en";
const SAMPLE_RATE = 16000;
const RMS_SILENCE_THRESHOLD = 0.003;
const MIN_WINDOW_SAMPLES = SAMPLE_RATE * 0.6;

const cacheDirArg = process.argv[2];
if (cacheDirArg) {
  env.cacheDir = cacheDirArg;
}

const originalLog = console.log;
console.log = (...args) => {
  process.stderr.write(`[stt-worker] ${args.join(" ")}\n`);
};

function out(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let modelPromise = null;
let lastReportedPercent = -1;
let modelReadyReported = false;

function loadModel() {
  if (!modelPromise) {
    modelPromise = pipeline("automatic-speech-recognition", MODEL_NAME, {
      progress_callback: (progress) => {
        if (progress.status === "progress" && progress.loaded != null && progress.total) {
          const percent = Math.min(100, Math.round((progress.loaded / progress.total) * 100));
          const bucket = Math.floor(percent / 5) * 5;
          if (bucket !== lastReportedPercent) {
            lastReportedPercent = bucket;
            out({ type: "status", message: `Downloading local speech model… ${percent}%` });
          }
        } else if (progress.status === "done") {
          if (!modelReadyReported) {
            modelReadyReported = true;
            out({ type: "status", message: "Local speech model ready" });
          }
        }
      },
    })
      .then((model) => {
        out({ type: "ready", model: MODEL_NAME });
        return model;
      })
      .catch((error) => {
        out({ type: "error", message: error && error.message ? error.message : String(error) });
        throw error;
      });
  }
  return modelPromise;
}

let sampleBuffer = [];
let sampleCount = 0;
let lastFlushAbsMs = null;
let processing = Promise.resolve();

function accumulate(samples) {
  sampleBuffer.push(new Float32Array(samples));
  sampleCount += samples.length;
}

function takeBufferedSamples() {
  const buffer = new Float32Array(sampleCount);
  let offset = 0;
  for (const chunk of sampleBuffer) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  sampleBuffer = [];
  sampleCount = 0;
  return buffer;
}

function computeRms(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    sum += buffer[i] * buffer[i];
  }
  return Math.sqrt(sum / buffer.length);
}

function handleFlush(timeAbsMs, requestId) {
  processing = processing.then(async () => {
    if (lastFlushAbsMs === null) {
      lastFlushAbsMs = timeAbsMs;
      console.log(`flush anchor at ${timeAbsMs}ms${requestId ? ` (${requestId})` : ""}`);
      out({ type: "flush_done", requestId });
      return;
    }
    const startAbsMs = lastFlushAbsMs;
    lastFlushAbsMs = timeAbsMs;
    const buffer = takeBufferedSamples();
    const rms = computeRms(buffer);
    console.log(
      `flush window ${(buffer.length / SAMPLE_RATE).toFixed(2)}s rms=${rms.toFixed(4)} ` +
      `gate=${RMS_SILENCE_THRESHOLD} samples>=${MIN_WINDOW_SAMPLES}${requestId ? ` (${requestId})` : ""}`,
    );
    if (buffer.length < MIN_WINDOW_SAMPLES || rms < RMS_SILENCE_THRESHOLD) {
      out({ type: "interim", text: "" });
      out({ type: "flush_done", requestId });
      return;
    }
    try {
      const model = await loadModel();
      // NOTE: do not pass language/task options here. For English-only
      // whisper-tiny.en, transformers.js injects forced_decoder_ids that make
      // the decoder emit empty output (verified: every option combo with
      // language or task returns { text: "" }, while no options transcribes).
      const result = await model(buffer);
      const text = (result && result.text ? result.text : "").trim();
      if (text) {
        out({ type: "final", text, startAbsMs, endAbsMs: timeAbsMs });
      } else {
        out({ type: "interim", text: "" });
      }
    } catch (error) {
      out({ type: "error", message: error && error.message ? error.message : String(error) });
    }
    out({ type: "flush_done", requestId });
  });
}

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.type === "start") {
    out({ type: "started" });
  } else if (message.type === "audio") {
    if (Array.isArray(message.samples)) accumulate(message.samples);
  } else if (message.type === "flush") {
    if (typeof message.timeAbsMs === "number") handleFlush(message.timeAbsMs, message.requestId);
  } else if (message.type === "stop") {
    rl.close();
  }
});

rl.on("close", () => {
  process.exit(0);
});
