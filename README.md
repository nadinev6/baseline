# Baseline CogniSync

A lightweight Python package and Electron practice app for organizing transcript
windows, blink events, and optional gaze or Presage SmartSpectra observations.
The project stores telemetry for review; it does not infer a person's intent,
truthfulness, or cognitive state.

## Requirements and dependencies

### Python package

- Python 3.10 or newer
- No third-party Python runtime dependencies

Install the package in editable mode and run the unit tests from the project
root:

```powershell
python -m pip install -e .
python -m unittest discover -s tests -v
```

### Electron app and SmartSpectra SDK

- Node.js 20 or newer (Node 24 LTS recommended)
- npm
- Windows x64, macOS Apple Silicon, or supported Linux x64/ARM64 for the
  SmartSpectra Node SDK
- A Presage SmartSpectra API key from the
  [Presage developer portal](https://physiology.presagetech.com/auth/register)

The root `package.json` pins:

- `@smartspectra/node-sdk` **3.4.0**
- `@mediapipe/tasks-vision` **1.2.3**
- Electron **43.8.7**
- esbuild **0.25.0**

Install the JavaScript dependencies and launch the app:

```powershell
npm install
npm start
```

The first install downloads SmartSpectra's native runtime packages for all
supported platforms and can use several hundred megabytes. The app builds
`frontend\app.js` into the ignored `frontend\dist\app.bundle.js` before
launching Electron. The launcher clears VS Code's `ELECTRON_RUN_AS_NODE`
environment flag for Electron so the desktop window starts normally.

Only one app instance runs at a time. A second `npm start` exits and focuses
the existing window instead of opening a fresh instance with a different
environment snapshot, which could otherwise accept sessions while missing the
API key.

The launcher also reads a project-root `.env` file when it exists and loads
its `NAME=value` lines into the child process environment; values already set
in the real process environment win. Blank lines and `#` comments are skipped.
The launch console prints how many variables were loaded plus a masked
fingerprint of the effective `PRESAGE_API_KEY` (length with only the first and
last two characters, never the value itself) so a stale or wrong `.env` copy
can be compared against the Presage portal's active key. If the key is absent
or empty in both sources, an explicit warning is printed instead — assigning
an empty string to an environment variable in Windows PowerShell 5.1 deletes
it, so that situation is surfaced rather than left silent.

SmartSpectra health is confirmed live in the same terminal during a session
via the `practice:app-log` bridge: the main process reports when it serves the
API key, and the app reports key loaded, SDK started, blink events, any enabled
pulse/HRV observations, camera track settings, validation-status changes,
recorded errors, and a clean stop summary. Detailed camera and metric
availability diagnostics are included in the session export.

Set the API key in the process environment or in a project-root `.env` file before launching. In PowerShell:

```powershell
$env:PRESAGE_API_KEY = "<your Presage API key>"
npm start
```

The key is not stored in the repository or renderer bundle. The local Electron
main process provides it to the app renderer over a restricted IPC handler.
Without the key, the camera preview and any browser-supported transcription
can still run, but SmartSpectra telemetry remains unavailable. Do not paste the
key into source files, `package.json`, or a committed `.env` file.

## SmartSpectra integration

Electron is required because Presage currently publishes a Node.js/Electron
SDK with native runtime components; there is no browser-only SDK package. The
SDK is installed as an npm dependency and receives the same camera stream the
app previews. Blink detection is requested by default. Pulse rate and HRV
RMSSD are optional checkboxes under the Electron **Features** menu; only the
selected metrics are requested. Feature changes apply to a new app session, so
restart Baseline CogniSync after ending the current session. Their available values and
confidence are recorded as timestamped observations, while missing values remain null/omitted.
The session export includes enabled features, requested metric codes,
per-packet metric availability, SDK processing states, and validation statuses
to help diagnose absent measurements. The SDK log level is INFO.

Stable rising blink-detection transitions are exported as events. Per-utterance
blink counts/rates use approximate transcription windows and should be treated
as descriptive observations, not cognitive-state measures. The app captures
transcript text and a coarse word-per-minute pacing label based on approximate
utterance timing. It does not currently calculate semantic text scores or
acoustic prosody.

The optional experimental head-direction estimate is derived from SmartSpectra
face landmarks (478-point FaceMesh landmarks returned by the SDK). It emits
preview-relative screen-direction vectors once landmark packets are received.
Enabling gaze in Features starts the estimate; it remains experimental and
unvalidated. Direction vectors (`UP_LEFT`, `UP_RIGHT`, `DOWN_LEFT`,
`DOWN_RIGHT`, `LATERAL_LEFT`, `LATERAL_RIGHT`) are mapped to NLP cue codes
(`nlp_code`) and cognitive state types (`cognitive_type`) per the NLP reference
guide using the subject handedness setting; results are flagged as an
experimental preview-relative estimate, not a validated measurement.

Per-utterance classification uses the **peak-deviation outlier** across the
500 ms lead-up before speech onset plus the utterance window, not a single
pre-speech snapshot. The sample with the largest Euclidean magnitude
`√(x² + y²)` is the primary classification source; the export also reports
`during_utterance_direction`, `pre_speech_direction`, `peak_deviation`,
`peak_sample_id`, `peak_vector`, and `variance_x`/`variance_y` for transparency.
Coordinates supplied through the optional adapter remain marked as unvalidated
and are not classified.

If pulse and HRV are enabled and both channels have enough data, each uses the
median of its first 30 seconds of stable readings as a within-session reference
(at least three samples spanning at least 15 seconds). Later stable pulse and
HRV changes feed a provisional paired cardio-response heuristic: pulse up by
at least 4 BPM and HRV down by at least 15 ms. This heuristic is not a validated
stress measure, medical assessment, or cognitive-state label; stress/cognitive
flags remain null unless the required cardio data and baselines exist.

SDK errors are recorded rather than discarded: each distinct code+message pair
keeps its numeric code, SDK enum name, message, retryable flag, first
timestamp, and a running count of consecutive repeats, exported under
`face_metric_diagnostics.errors` with a snake_case `error_summary` line.
Authentication failures (the SDK's `kAuthenticationFailed` family and Presage
401 responses) turn the sensor chip to `AUTH REJECTED` and the export
`source_status.presage_smartspectra` to `auth_rejected`, distinguishing "the
server rejected this key" (compare the launch-console fingerprint with the
portal's active key) from "no key was configured" (`api_key_required`).

Retryable engine failures (such as `kProcessingFailed`) additionally trigger
an automatic recovery: `reset()` + `start()` rebuild the pipeline, at most
twice per session, with every attempt logged to the launch terminal and
counted in `face_metric_diagnostics.recovery_attempts`. Processing-status and
measurement-readiness transitions (face framing, lighting, motion) print to
the terminal so the cause of a failure is visible live. The sensor chip reads
`CONNECTED` only while packets flow within the last 10 s; when packets stop,
it turns to red `STALLED` with a terminal warning, and the export marks
`face_metric_diagnostics.pipeline_stalled: true` plus
`source_status.presage_smartspectra: "timestamped_samples_received_then_pipeline_stalled"`
instead of implying healthy reception from historical samples.

The camera stream is passed to the SDK for on-device measurement and is not
recorded to disk by this app. A Presage API key is required for SDK
authentication. Consult the vendor documentation for the SDK's processing,
metric limitations, and data handling:

- [SmartSpectra SDK overview](https://presagetech.com/docs/smartspectra-sdk)
- [Node.js and Electron guide](https://presagetech.com/docs/smartspectra-sdk/nodejs)
- [Node.js metrics guide](https://presagetech.com/docs/smartspectra-sdk/nodejs/metrics)
- [Metrics data types](https://presagetech.com/docs/smartspectra-sdk/data-types)
- [Model cards and limitations](https://presagetech.com/docs/smartspectra-sdk/model-cards-and-limitations)

The SmartSpectra SDK is for general wellness use; its metrics are not a
diagnostic or a validated measure of cognitive state.

## Frontend capture and adapter

The desktop UI is in `frontend\index.html`. Starting a free session opens the
consent dialog, requests a video-only camera stream, and starts speech
transcription:

- **Electron:** audio is transcribed locally by `stt-worker.cjs`, a Node worker
  running `@xenova/transformers` with the `Xenova/whisper-tiny.en` model. Audio
  is captured continuously with a `ScriptProcessorNode` and flushed to the
  worker in 4 s windows. ([BLANK_AUDIO] transcription was previously caused by
  `AnalyserNode` polling that dropped audio between reads; the continuous
  capture fixes it.)
- **Browser fallback:** browser `SpeechRecognition` / `webkitSpeechRecognition`
  when available. Support and audio processing depend on the Chromium build and
  browser service; some implementations may process audio outside the device.

Transcript timestamps are approximate recognition-result windows, not word-level
audio timestamps or a measured pre-speech window.

The default session requests blink detection. Optional pulse, HRV, and
experimental gaze tracking can be selected in the Electron **Features** menu;
changes apply after restarting Baseline CogniSync for a new app session. Gaze tracking runs locally but does not emit
estimates until calibrated, and this UI currently has no calibration controls.
Only transcript text and coarse timing-based pacing are currently computed;
semantic scores and acoustic prosody are not implemented.

The app also exposes `window.practiceSessionAdapter` for alternate timestamped
sources while a session is active:

```javascript
window.practiceSessionAdapter.onGazeSample({
  timestamp_ms: 1250,
  x: 0.2,
  y: -0.1,
  z: 0.8,
});
window.practiceSessionAdapter.onBiometricSample({
  timestamp_ms: 1260,
  pulse_bpm: 72,
  pulse_confidence: 92,
  hrv_ms: 48,
  hrv_metric: "RMSSD",
  hrv_confidence: 86,
  blink_detected: false,
  blink_stable: true,
});
```

Adapter timestamps are milliseconds from session start. SmartSpectra callback
timestamps are preserved separately as `source_timestamp_us`; app-side sample
timestamps use the local session clock for transcript binding.

## Session JSON

The export follows the organization in `nlp_reference_guide.md`:

- `session_metadata`: session identity, timing, handedness preference, and
  enabled feature selections and local gaze-estimator status.
- `utterance_telemetry_stream`: utterance text and approximate times, linked
  blink events, gaze samples, per-utterance `gaze_analysis` (peak-deviation
  primary direction, during-utterance and pre-speech views, peak/outlier
  metrics, variance), and any enabled pulse/HRV observations.
- `sensor_samples`: timestamped blink events, gaze-adapter/tracker samples, and
  optional cardio samples. SDK errors and pipeline state remain in diagnostics.
- `smartspectra_diagnostics`: camera track settings, requested metric codes,
  metric availability counts, cardio-baseline status, SDK processing states,
  and validation statuses and hints.
- `sample_provenance` and `source_status`: source and analysis availability.

Screen-relative gaze directions are experimental estimates, not validated
eye-accessing cues. Missing gaze, semantic scores, and acoustic prosody remain
`null`; absent pulse/HRV measurements and their turn averages also remain
`null`, never zero. A raw sample is not interpreted as evidence of a cognitive
state. The NLP cue codes and cognitive types are experimental hypotheses per
`nlp_reference_guide.md`, not validated measurements.

## Python API

```python
from sensor_alignment import (
    BiometricSample,
    GazeSample,
    Utterance,
    align_utterance,
)

utterance = Utterance("u-1", "Sample sentence.", 12_000, 15_500)
aligned = align_utterance(
    utterance,
    gaze_samples=[GazeSample(12_100, 0.2, -0.1)],
    biometric_samples=[
        BiometricSample(12_200, blink_rate_hz=0.25, hrv_ms=48, pulse_bpm=72)
    ],
)
print(aligned.to_json())
```

`align_utterance` uses an inclusive `[timestamp_start_ms, timestamp_end_ms]`
window and sorts matched samples chronologically. It preserves supplied values
without assigning cognitive labels.
