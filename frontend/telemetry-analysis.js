"use strict";

const PRE_SPEECH_WINDOW_MS = 500;
const CARDIO_BASELINE_WINDOW_MS = 30_000;
const CARDIO_BASELINE_MIN_SAMPLES = 3;
const CARDIO_BASELINE_MIN_SPAN_MS = 15_000;

const {
  classifyPreviewDirection,
  buildHeadDirectionAnalysis,
  HEAD_DIRECTION_SOURCE,
} = require("./gaze-estimation");

function hasPositiveMeasurement(value) {
  return Number.isFinite(value) && value > 0;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function computeMetricBaseline(samples, field, stableField) {
  const measurements = samples
    .filter((sample) => hasPositiveMeasurement(sample[field]))
    .sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  const validSamples = measurements.filter((sample) => sample[stableField] === true);
  if (!validSamples.length) {
    return {
      value: null,
      status: measurements.length ? "awaiting_stable_measurements" : "awaiting_measurements",
      sample_count: 0,
      start_ms: null,
      end_ms: null,
    };
  }

  const startMs = validSamples[0].timestamp_ms;
  const endMs = startMs + CARDIO_BASELINE_WINDOW_MS;
  const baselineSamples = validSamples.filter((sample) => sample.timestamp_ms <= endMs);
  const spanMs = baselineSamples.at(-1).timestamp_ms - startMs;
  if (validSamples.at(-1).timestamp_ms < endMs) {
    return {
      value: null,
      status: "collecting_baseline",
      sample_count: baselineSamples.length,
      start_ms: startMs,
      end_ms: endMs,
    };
  }
  if (
    baselineSamples.length < CARDIO_BASELINE_MIN_SAMPLES ||
    spanMs < CARDIO_BASELINE_MIN_SPAN_MS
  ) {
    return {
      value: null,
      status: "insufficient_baseline_samples",
      sample_count: baselineSamples.length,
      start_ms: startMs,
      end_ms: endMs,
    };
  }

  return {
    value: median(baselineSamples.map((sample) => sample[field])),
    status: "established",
    sample_count: baselineSamples.length,
    start_ms: startMs,
    end_ms: endMs,
  };
}

function computeCardioBaseline(samples) {
  return {
    pulse_bpm: computeMetricBaseline(samples, "pulse_bpm", "pulse_stable"),
    hrv_ms: computeMetricBaseline(samples, "hrv_ms", "hrv_stable"),
    method: "median_of_first_30_seconds_of_stable_valid_readings_per_metric",
    minimum_samples_per_metric: CARDIO_BASELINE_MIN_SAMPLES,
    minimum_sample_span_ms: CARDIO_BASELINE_MIN_SPAN_MS,
  };
}

function computeCardioResponse(pulseDeltaBpm, hrvDeltaMs) {
  if (!Number.isFinite(pulseDeltaBpm) || !Number.isFinite(hrvDeltaMs)) {
    return {
      candidate: null,
      analysis_status: "not_computed_cardio_baseline_or_post_baseline_readings_missing",
    };
  }
  return {
    candidate: pulseDeltaBpm >= 4 && hrvDeltaMs <= -15,
    analysis_status: "computed_cardio_heuristic_not_stress_diagnosis",
  };
}

function buildRequestedMetrics(features, metricType) {
  const requested = [metricType.BLINKING];
  if (features.pulse) requested.push(metricType.PULSE_RATE);
  if (features.hrv) requested.push(metricType.HRV);
  return requested;
}

function createBlinkTransition(sample, previousDetected, eventId) {
  const detected = sample.blink_detected;
  if (typeof detected !== "boolean" || detected === previousDetected) {
    return { nextDetected: previousDetected, event: null };
  }
  if (previousDetected === null) {
    return { nextDetected: detected, event: null };
  }
  return {
    nextDetected: detected,
    event: detected
      ? {
          event_id: eventId,
          timestamp_ms: sample.timestamp_ms,
          detected,
          previous_detected: previousDetected,
          stable: sample.blink_stable ?? null,
          counted_as_blink: sample.blink_stable === true,
          biometric_sample_id: sample.sample_id,
          ...(sample.source_timestamp_us === undefined
            ? {}
            : { source_timestamp_us: sample.source_timestamp_us }),
        }
      : null,
  };
}

function countBlinkEvents(events, startMs, endMs) {
  return events.filter((event) =>
    event.counted_as_blink === true &&
    event.timestamp_ms >= startMs &&
    event.timestamp_ms <= endMs,
  ).length;
}

function extractBiometricReadings(metrics) {
  const pulse = metrics.cardio?.pulseRate?.at(-1);
  const hrv = metrics.cardio?.hrv?.at(-1);
  const blink = metrics.face?.blinking?.at(-1);
  const talking = metrics.face?.talking?.at(-1);
  const availability = {
    pulse_rate: hasPositiveMeasurement(pulse?.value),
    hrv: hasPositiveMeasurement(hrv?.rmssd),
    pulse_stable: typeof pulse?.stable === "boolean" && pulse.stable,
    hrv_stable: typeof hrv?.stable === "boolean" && hrv.stable,
    blinking: typeof blink?.detected === "boolean",
    talking: typeof talking?.detected === "boolean",
  };
  availability.pulse_confidence = availability.pulse_rate && Number.isFinite(pulse.confidence);
  availability.hrv_confidence = availability.hrv && Number.isFinite(hrv.confidence);
  const fields = {};

  if (availability.pulse_rate) {
    fields.pulse_bpm = pulse.value;
    if (Number.isFinite(pulse.confidence)) fields.pulse_confidence = pulse.confidence;
    if (typeof pulse.stable === "boolean") fields.pulse_stable = pulse.stable;
  }
  if (availability.hrv) {
    fields.hrv_ms = hrv.rmssd;
    fields.hrv_metric = "RMSSD";
    if (Number.isFinite(hrv.confidence)) fields.hrv_confidence = hrv.confidence;
    if (typeof hrv.stable === "boolean") fields.hrv_stable = hrv.stable;
  }
  if (availability.blinking) {
    fields.blink_detected = blink.detected;
    fields.blink_stable = Boolean(blink.stable);
  }
  if (availability.talking) {
    fields.talking_detected = talking.detected;
    fields.talking_stable = Boolean(talking.stable);
  }

  return { fields, availability };
}

function averagePositiveMetric(samples, field) {
  const values = samples
    .map((sample) => sample[field])
    .filter((value) => Number.isFinite(value) && value > 0);
  return values.length
    ? values.reduce((total, value) => total + value, 0) / values.length
    : null;
}

module.exports = {
  buildHeadDirectionAnalysis,
  averagePositiveMetric,
  buildRequestedMetrics,
  countBlinkEvents,
  createBlinkTransition,
  computeCardioBaseline,
  computeCardioResponse,
  extractBiometricReadings,
  hasPositiveMeasurement,
};
