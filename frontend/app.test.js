"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("path");

const {
  buildHeadDirectionAnalysis,
  buildRequestedMetrics,
  countBlinkEvents,
  averagePositiveMetric,
  createBlinkTransition,
  computeCardioBaseline,
  computeCardioResponse,
  extractBiometricReadings,
  hasPositiveMeasurement,
} = require("./telemetry-analysis");
const {
  CALIBRATION_TARGETS,
  classifyPreviewDirection,
  estimateGaze,
  extractEyeFeatures,
  fitGazeCalibration,
  mapDirection,
} = require("./gaze-estimation");
const {
  HeadDirectionTracker,
  HEAD_DIRECTION_SOURCE,
} = require("./eye-gaze-tracker");

const utterance = { timestamp_start_ms: 1000, timestamp_end_ms: 3000 };

test("reports head-direction as unavailable when no estimator is configured", () => {
  const result = buildHeadDirectionAnalysis(utterance, []);
  assert.equal(result.analysis_status, "head_direction_estimator_not_configured");
  assert.equal(result.head_direction_estimation_method, "not_configured");
  assert.equal(result.cognitive_type, null);
});

test("does not classify unvalidated adapter coordinates as head direction or cognition", () => {
  const result = buildHeadDirectionAnalysis(utterance, [
    { sample_id: "h-00001", timestamp_ms: 500, x: 0.8, y: 0.7, source: "adapter_unvalidated" },
  ]);
  assert.equal(result.analysis_status, "unvalidated_head_direction_samples_not_classified");
  assert.equal(result.pre_speech_vector, null);
  assert.equal(result.nlp_code, null);
  assert.equal(result.cognitive_type, null);
  assert.deepEqual(result.associated_sample_ids, ["h-00001"]);
});

test("reports calibrated head-direction sample with NLP mapping applied", () => {
  const result = buildHeadDirectionAnalysis(utterance, [
    {
      sample_id: "h-00002",
      timestamp_ms: 900,
      x: -0.5,
      y: -0.4,
      source: "head_direction",
      calibrated: true,
    },
  ]);
  assert.equal(result.pre_speech_direction, "UP_LEFT");
  assert.equal(result.head_direction_estimation_method, "experimental_preview_relative_head_direction");
  assert.equal(result.analysis_status, "experimental_preview_head_direction_available_nlp_mapping_disabled");
  assert.equal(result.pre_speech_vector, null);
  assert.equal(result.nlp_code, "Vc");
  assert.equal(result.nlp_classification, "Visual Constructed");
  assert.equal(result.cognitive_type, "CONSTRUCTED");
});

test("reports calibrated head-direction sample in utterance window when not in pre-speech window", () => {
  const result = buildHeadDirectionAnalysis(utterance, [
    { sample_id: "h-00004", timestamp_ms: 1500, x: 0.3, y: -0.3, source: "head_direction", calibrated: true },
  ]);
  assert.equal(result.pre_speech_direction, "UP_RIGHT");
  assert.equal(result.nlp_code, "Vr");
  assert.equal(result.cognitive_type, "REMEMBERED");
  assert.equal(result.head_direction_sample_count, 1);
  assert.equal(result.associated_sample_ids.length, 1);
});

test("does not classify pre-speech uncalibrated samples but counts them", () => {
  const result = buildHeadDirectionAnalysis(utterance, [
    { sample_id: "h-00005", timestamp_ms: 900, x: -0.5, y: -0.4, source: "head_direction", calibrated: false },
  ]);
  assert.equal(result.pre_speech_direction, null);
  assert.equal(result.nlp_code, null);
  assert.equal(result.cognitive_type, null);
  assert.equal(result.head_direction_sample_count, 1);
  assert.equal(result.associated_sample_ids.length, 1);
});

test("uses right-handedness direction mapping by default", () => {
  assert.equal(classifyPreviewDirection(-0.5, -0.5).direction, "UP_LEFT");
  assert.equal(classifyPreviewDirection(-0.5, -0.5).nlpCode, "Vc");
  assert.equal(classifyPreviewDirection(-0.5, -0.5).cognitiveType, "CONSTRUCTED");
});

test("handedness inversion flips horizontal direction", () => {
  const result = buildHeadDirectionAnalysis(utterance, [
    { sample_id: "h-00006", timestamp_ms: 1000, x: -0.3, y: 0.2, source: "head_direction", calibrated: true },
  ], "left");
  assert.equal(result.pre_speech_direction, "LATERAL_RIGHT"); // inverted
  assert.equal(result.nlp_code, "Ar");
  assert.equal(result.cognitive_type, "REMEMBERED");
});

test("mapDirection handles all observer-view vectors and lateral states", () => {
  assert.equal(mapDirection(-0.5, -0.5).direction, "UP_LEFT");
  assert.equal(mapDirection(0.5, -0.5).direction, "UP_RIGHT");
  assert.equal(mapDirection(-0.3, 0.3).direction, "DOWN_LEFT");
  assert.equal(mapDirection(0.3, 0.3).direction, "DOWN_RIGHT");
  assert.equal(mapDirection(-0.5, 0).direction, "LATERAL_LEFT");
  assert.equal(mapDirection(0.5, 0).direction, "LATERAL_RIGHT");
  assert.equal(mapDirection(0.0, 0.0).direction, "CENTER");
  assert.equal(mapDirection(0.0, 0.1).direction, "CENTER");
});

test("extracts normalized eye and head-pose features from iris landmarks", () => {
  const features = extractEyeFeatures(makeLandmarks());
  assert.equal(features.length, 4);
  assert.ok(features.every(Number.isFinite));
  assert.ok(Math.abs(features[0]) < 0.001);
  assert.ok(Math.abs(features[1]) < 0.001);
  assert.equal(extractEyeFeatures(makeLandmarks(0.5, 0.5))[0] > features[0], true);
  assert.equal(extractEyeFeatures(makeLandmarks(0.5, 0.5))[1] > features[1], true);
});

function makeLandmarks(horizontal = 0, vertical = 0) {
  const landmarks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  const irisX = 0.43 + horizontal * 0.015;
  const irisY = 0.5 + vertical * 0.01;
  landmarks[33] = { x: 0.4, y: 0.5 };
  landmarks[133] = { x: 0.46, y: 0.5 };
  landmarks[159] = { x: 0.43, y: 0.48 };
  landmarks[145] = { x: 0.43, y: 0.52 };
  landmarks[468] = { x: irisX, y: irisY };
  landmarks[362] = { x: 0.54, y: 0.5 };
  landmarks[263] = { x: 0.6, y: 0.5 };
  landmarks[386] = { x: 0.57, y: 0.48 };
  landmarks[374] = { x: 0.57, y: 0.52 };
  landmarks[473] = { x: 0.57 + horizontal * 0.015, y: irisY };
  landmarks[234] = { x: 0.2, y: 0.5 };
  landmarks[454] = { x: 0.8, y: 0.5 };
  landmarks[1] = { x: 0.5, y: 0.52 };
  landmarks[10] = { x: 0.5, y: 0.1 };
  landmarks[152] = { x: 0.5, y: 0.9 };
  return landmarks;
}

test("rejects incomplete or blink-occluded eye landmarks", () => {
  assert.equal(extractEyeFeatures([]), null);
  const blink = makeLandmarks();
  blink[145] = { x: 0.43, y: 0.481 };
  assert.equal(extractEyeFeatures(blink), null);
});

test("fits calibration and returns bounded preview-relative estimates", () => {
  const samples = CALIBRATION_TARGETS.map((target) => ({
    features: [target.x / 0.7, target.y / 0.7, 0, 0],
    x: target.x,
    y: target.y,
  }));
  const fitted = fitGazeCalibration(samples);
  assert.equal(fitted.ok, true);
  const estimate = estimateGaze([0.5, -0.5, 0, 0], fitted.calibration);
  assert.ok(Math.abs(estimate.x - 0.35) < 0.01);
  assert.ok(Math.abs(estimate.y + 0.35) < 0.01);
  assert.equal(estimate.direction.direction, "UP_RIGHT");
  assert.equal(estimate.clipped, false);
  const clipped = estimateGaze([3, 0, 0, 0], fitted.calibration);
  assert.equal(clipped.x, 1);
  assert.equal(clipped.clipped, true);
  assert.equal(classifyPreviewDirection(-0.9, 0.1).direction, "LATERAL_LEFT");
});

test("rejects calibration without enough eye movement variation", () => {
  const samples = CALIBRATION_TARGETS.map((target) => ({
    features: [0, 0, 0, 0],
    x: target.x,
    y: target.y,
  }));
  const fitted = fitGazeCalibration(samples);
  assert.equal(fitted.ok, false);
  assert.match(fitted.error, /varied too little/);
});

test("keeps failed calibration captures until the user explicitly retries", () => {
  const pendingCalibration = CALIBRATION_TARGETS.map((target) => ({
    features: [target.x / 0.7, target.y / 0.7, 0, 0],
    x: target.x,
    y: target.y,
  }));
  pendingCalibration[0].x = 0.7;
  const tracker = Object.create(HeadDirectionTracker.prototype);
  Object.assign(tracker, {
    landmarker: {},
    stopped: false,
    calibration: null,
    calibrationState: "collecting",
    pendingCalibration,
    lastStatus: "calibrating",
    diagnostics: { calibration_targets_captured: CALIBRATION_TARGETS.length, calibration_failure: null },
    onStatus(status) {
      this.reportedStatus = status;
    },
  });

  const result = tracker.completeCalibration();
  assert.equal(result.ok, false);
  assert.equal(tracker.pendingCalibration.length, CALIBRATION_TARGETS.length);
  assert.equal(tracker.calibrationState, "failed");
  assert.equal(tracker.diagnostics.calibration_targets_captured, CALIBRATION_TARGETS.length);
  assert.equal(tracker.diagnostics.calibration_failure, "Capture all nine calibration targets before finishing.");
  assert.equal(tracker.reportedStatus, "calibration_failed");

  tracker.beginCalibration();
  assert.equal(tracker.pendingCalibration.length, 0);
  assert.equal(tracker.calibrationState, "collecting");
  assert.equal(tracker.diagnostics.calibration_failure, null);
});

test("WebGazer tracker loads without a real webcam and exposes diagnostics", () => {
  const tracker = new HeadDirectionTracker({
    onStatus: () => {},
    onEstimate: () => {},
  });
  assert.equal(tracker.diagnostics.status, "not_started");
  tracker.stop();
  assert.equal(tracker.diagnostics.status, "stopped");
});

test("returns null averages when pulse or HRV readings are absent", () => {
  assert.equal(averagePositiveMetric([{ pulse_bpm: 0 }, {}], "pulse_bpm"), null);
  assert.equal(averagePositiveMetric([{ hrv_ms: 0 }, { hrv_ms: null }], "hrv_ms"), null);
});

test("averages only positive pulse and HRV measurements", () => {
  assert.equal(
    averagePositiveMetric([{ pulse_bpm: 0 }, { pulse_bpm: 60 }, { pulse_bpm: 80 }], "pulse_bpm"),
    70,
  );
});

test("cardio baselines require a full window and sufficiently spread valid samples", () => {
  const baseline = computeCardioBaseline([
    { timestamp_ms: 0, pulse_bpm: 70, hrv_ms: 40, pulse_stable: true, hrv_stable: true },
    { timestamp_ms: 10_000, pulse_bpm: 72, hrv_ms: 42, pulse_stable: true, hrv_stable: true },
    { timestamp_ms: 20_000, pulse_bpm: 74, hrv_ms: 44, pulse_stable: true, hrv_stable: true },
    { timestamp_ms: 30_000, pulse_bpm: 76, hrv_ms: 46, pulse_stable: true, hrv_stable: true },
  ]);
  assert.equal(baseline.pulse_bpm.status, "established");
  assert.equal(baseline.pulse_bpm.value, 73);
  assert.equal(baseline.hrv_ms.status, "established");
  assert.equal(baseline.hrv_ms.value, 43);
});

test("cardio baselines remain unavailable when readings do not span enough time", () => {
  const baseline = computeCardioBaseline([
    { timestamp_ms: 0, pulse_bpm: 70, hrv_ms: 40, pulse_stable: true, hrv_stable: true },
    { timestamp_ms: 5_000, pulse_bpm: 72, hrv_ms: 42, pulse_stable: true, hrv_stable: true },
    { timestamp_ms: 10_000, pulse_bpm: 73, hrv_ms: 43, pulse_stable: true, hrv_stable: true },
    { timestamp_ms: 31_000, pulse_bpm: 74, hrv_ms: 44, pulse_stable: true, hrv_stable: true },
  ]);
  assert.equal(baseline.pulse_bpm.status, "insufficient_baseline_samples");
  assert.equal(baseline.pulse_bpm.value, null);
});

test("cardio baselines ignore unstable readings", () => {
  const baseline = computeCardioBaseline([
    { timestamp_ms: 0, pulse_bpm: 70, hrv_ms: 40, pulse_stable: false, hrv_stable: false },
    { timestamp_ms: 15_000, pulse_bpm: 72, hrv_ms: 42, pulse_stable: false, hrv_stable: false },
    { timestamp_ms: 30_000, pulse_bpm: 74, hrv_ms: 44, pulse_stable: false, hrv_stable: false },
  ]);
  assert.equal(baseline.pulse_bpm.status, "awaiting_stable_measurements");
  assert.equal(baseline.hrv_ms.status, "awaiting_stable_measurements");
});

test("cardio response stays null without both baseline-relative changes", () => {
  assert.deepEqual(computeCardioResponse(null, -20), {
    candidate: null,
    analysis_status: "not_computed_cardio_baseline_or_post_baseline_readings_missing",
  });
  assert.equal(computeCardioResponse(4, -15).candidate, true);
  assert.equal(computeCardioResponse(4, -14.9).candidate, false);
});

test("requests blink by default and includes only selected cardio metrics", () => {
  const metricType = { BLINKING: 12, PULSE_RATE: 15, HRV: 17 };
  assert.deepEqual(buildRequestedMetrics({ pulse: false, hrv: false }, metricType), [12]);
  assert.deepEqual(buildRequestedMetrics({ pulse: true, hrv: false }, metricType), [12, 15]);
  assert.deepEqual(buildRequestedMetrics({ pulse: false, hrv: true }, metricType), [12, 17]);
  assert.deepEqual(buildRequestedMetrics({ pulse: true, hrv: true }, metricType), [12, 15, 17]);
});

test("counts stable blink-on transitions without treating initial state or blink-off as events", () => {
  const initial = createBlinkTransition(
    { sample_id: "b-1", timestamp_ms: 0, blink_detected: false, blink_stable: true },
    null,
    "bl-1",
  );
  assert.equal(initial.event, null);
  const blinkOn = createBlinkTransition(
    { sample_id: "b-2", timestamp_ms: 100, blink_detected: true, blink_stable: true },
    initial.nextDetected,
    "bl-1",
  );
  assert.equal(blinkOn.event.event_id, "bl-1");
  assert.equal(blinkOn.event.biometric_sample_id, "b-2");
  assert.equal(blinkOn.event.counted_as_blink, true);
  const blinkOff = createBlinkTransition(
    { sample_id: "b-3", timestamp_ms: 200, blink_detected: false, blink_stable: true },
    blinkOn.nextDetected,
    "bl-2",
  );
  assert.equal(blinkOff.event, null);
  assert.equal(countBlinkEvents([blinkOn.event], 0, 200), 1);
});

test("records an unstable blink transition but excludes it from blink counts", () => {
  const result = createBlinkTransition(
    { sample_id: "b-2", timestamp_ms: 100, blink_detected: true, blink_stable: false },
    false,
    "bl-1",
  );
  assert.equal(result.event.counted_as_blink, false);
  assert.equal(countBlinkEvents([result.event], 0, 200), 0);
});

test("omits unavailable or zero SDK cardio measurements instead of storing zeros", () => {
  const result = extractBiometricReadings({
    cardio: { pulseRate: [{ value: 0 }], hrv: [{ rmssd: 0 }] },
    face: { blinking: [], talking: [] },
  });
  assert.deepEqual(result.fields, {});
  assert.equal(result.availability.pulse_rate, false);
  assert.equal(result.availability.hrv, false);
});

test("preserves valid readings, confidence, and face detection fields", () => {
  const result = extractBiometricReadings({
    cardio: {
      pulseRate: [{ value: 72.5, confidence: 83, stable: true }],
      hrv: [{ rmssd: 48, confidence: 91, stable: true }],
    },
    face: {
      blinking: [{ detected: false, stable: true }],
      talking: [{ detected: true, stable: true }],
    },
  });
  assert.deepEqual(result.fields, {
    pulse_bpm: 72.5,
    pulse_confidence: 83,
    pulse_stable: true,
    hrv_ms: 48,
    hrv_metric: "RMSSD",
    hrv_confidence: 91,
    hrv_stable: true,
    blink_detected: false,
    blink_stable: true,
    talking_detected: true,
    talking_stable: true,
  });
  assert.equal(result.availability.pulse_confidence, true);
  assert.equal(result.availability.hrv_confidence, true);
});

test("stores blinking observations when cardio metrics are absent", () => {
  const result = extractBiometricReadings({
    face: { blinking: [{ detected: true, stable: true }] },
  });
  assert.deepEqual(result.fields, { blink_detected: true, blink_stable: true });
  assert.equal(result.availability.blinking, true);
  assert.equal(result.availability.pulse_rate, false);
  assert.equal(result.availability.hrv, false);
});

test("reports head-direction tracker status on initialize", () => {
  const tracker = new HeadDirectionTracker({
    video: null,
    getElapsedMs: () => 0,
    onStatus: () => {},
    onEstimate: () => {},
  });
  tracker.start();
  assert.equal(tracker.diagnostics.status, "not_configured");
});