"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

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
  classifyPreviewDirection,
  HEAD_DIRECTION_SOURCE,
  headDirectionFromLandmarks,
  mapDirection,
} = require("./gaze-estimation");

const utterance = { timestamp_start_ms: 1000, timestamp_end_ms: 3000 };

test("reports head-direction as unavailable when no estimator is configured", () => {
  const result = buildHeadDirectionAnalysis(utterance, []);
  assert.equal(result.gaze_estimation_method, "not_configured");
  assert.equal(result.analysis_status, "gaze_estimator_not_configured");
  assert.equal(result.cognitive_type, null);
});

test("does not classify unvalidated adapter coordinates as head direction or cognition", () => {
  const result = buildHeadDirectionAnalysis(utterance, [
    { sample_id: "g-00001", timestamp_ms: 1500, x: 0.8, y: 0.7, source: "adapter_unvalidated" },
  ]);
  assert.equal(result.analysis_status, "unvalidated_gaze_samples_not_classified");
  assert.equal(result.pre_speech_vector, null);
  assert.equal(result.nlp_code, null);
  assert.equal(result.cognitive_type, null);
  assert.deepEqual(result.associated_sample_ids, ["g-00001"]);
});

test("reports calibrated head-direction sample with NLP mapping applied", () => {
  const result = buildHeadDirectionAnalysis(utterance, [
    {
      sample_id: "g-00002",
      timestamp_ms: 900,
      x: -0.5,
      y: -0.4,
      source: HEAD_DIRECTION_SOURCE,
      calibrated: true,
    },
  ]);
  assert.equal(result.primary_direction, "UP_LEFT");
  assert.equal(result.primary_nlp_code, "Vc");
  assert.equal(result.primary_cognitive_type, "CONSTRUCTED");
  assert.equal(result.pre_speech_direction, "UP_LEFT");
  assert.equal(result.gaze_estimation_method, "experimental_head_pose_landmarks");
  assert.equal(result.analysis_status, "peak_deviation_classified");
  assert.equal(result.peak_sample_id, "g-00002");
  assert.equal(result.nlp_code, "Vc");
  assert.equal(result.nlp_classification, "Visual Constructed");
  assert.equal(result.cognitive_type, "CONSTRUCTED");
});

test("reports calibrated head-direction sample in utterance window when not in pre-speech window", () => {
  const result = buildHeadDirectionAnalysis(utterance, [
    { sample_id: "g-00004", timestamp_ms: 1500, x: 0.3, y: -0.3, source: HEAD_DIRECTION_SOURCE, calibrated: true },
  ]);
  assert.equal(result.primary_direction, "UP_RIGHT");
  assert.equal(result.pre_speech_direction, null);
  assert.equal(result.nlp_code, "Vr");
  assert.equal(result.cognitive_type, "REMEMBERED");
  assert.equal(result.gaze_sample_count, 1);
  assert.equal(result.associated_sample_ids.length, 1);
});

test("does not classify pre-speech uncalibrated samples but counts them", () => {
  const result = buildHeadDirectionAnalysis(utterance, [
    { sample_id: "g-00005", timestamp_ms: 900, x: -0.5, y: -0.4, source: HEAD_DIRECTION_SOURCE, calibrated: false },
  ]);
  assert.equal(result.pre_speech_direction, null);
  assert.equal(result.nlp_code, null);
  assert.equal(result.cognitive_type, null);
  assert.equal(result.gaze_sample_count, 1);
  assert.equal(result.associated_sample_ids.length, 1);
});

test("uses right-handedness direction mapping by default", () => {
  assert.equal(classifyPreviewDirection(-0.5, -0.5).direction, "UP_LEFT");
  assert.equal(classifyPreviewDirection(-0.5, -0.5).nlpCode, "Vc");
  assert.equal(classifyPreviewDirection(-0.5, -0.5).cognitiveType, "CONSTRUCTED");
});

test("handedness inversion flips horizontal direction", () => {
  const result = buildHeadDirectionAnalysis(utterance, [
    { sample_id: "g-00006", timestamp_ms: 1000, x: -0.3, y: 0.2, source: HEAD_DIRECTION_SOURCE, calibrated: true },
  ], "left");
  assert.equal(result.primary_direction, "LATERAL_RIGHT");
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

test("headDirectionFromLandmarks returns null for missing or invalid landmarks", () => {
  assert.equal(headDirectionFromLandmarks(null), null);
  assert.equal(headDirectionFromLandmarks([]), null);
  assert.equal(headDirectionFromLandmarks([{ x: 0.5, y: 0.5 }]), null);
  const landmarks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  assert.equal(headDirectionFromLandmarks(landmarks), null);
});

test("headDirectionFromLandmarks derives direction from nose relative to face center", () => {
  const landmarks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  landmarks[1] = { x: 0.6, y: 0.5 };
  landmarks[234] = { x: 0.2, y: 0.5 };
  landmarks[454] = { x: 0.8, y: 0.5 };
  landmarks[10] = { x: 0.5, y: 0.1 };
  landmarks[152] = { x: 0.5, y: 0.9 };
  const dir = headDirectionFromLandmarks(landmarks);
  assert.ok(dir !== null);
  assert.ok(Number.isFinite(dir.x));
  assert.ok(Number.isFinite(dir.y));
  assert.ok(Math.abs(dir.x - 0.166) < 0.02);
  assert.equal(dir.y, 0);
});

test("headDirectionFromLandmarks rejects too-small face boxes", () => {
  const landmarks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  landmarks[1] = { x: 0.51, y: 0.5 };
  landmarks[234] = { x: 0.49, y: 0.5 };
  landmarks[454] = { x: 0.51, y: 0.5 };
  landmarks[10] = { x: 0.5, y: 0.49 };
  landmarks[152] = { x: 0.5, y: 0.51 };
  assert.equal(headDirectionFromLandmarks(landmarks), null);
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
  assert.equal(baseline.hrv_ms.status, "insufficient_baseline_samples");
  assert.equal(baseline.hrv_ms.value, null);
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

test("requests FACE_LANDMARKS when headDirection feature is enabled", () => {
  const metricType = { BLINKING: 12, FACE_LANDMARKS: 11, PULSE_RATE: 15, HRV: 17 };
  assert.deepEqual(buildRequestedMetrics({ pulse: false, hrv: false, headDirection: true }, metricType), [12, 11]);
  assert.deepEqual(buildRequestedMetrics({ pulse: true, hrv: true, headDirection: true }, metricType), [12, 11, 15, 17]);
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