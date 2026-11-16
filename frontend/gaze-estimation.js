"use strict";

const HEAD_DIRECTION_SOURCE = "head_direction";
const CALIBRATION_TARGETS = [
  { x: -0.7, y: -0.7 },
  { x: 0, y: -0.7 },
  { x: 0.7, y: -0.7 },
  { x: -0.7, y: 0 },
  { x: 0, y: 0 },
  { x: 0.7, y: 0 },
  { x: -0.7, y: 0.7 },
  { x: 0, y: 0.7 },
  { x: 0.7, y: 0.7 },
];

const FEATURE_COUNT = 4;
const PRE_SPEECH_WINDOW_MS = 500;
const CARDIO_BASELINE_WINDOW_MS = 30_000;
const CARDIO_BASELINE_MIN_SAMPLES = 3;
const CARDIO_BASELINE_MIN_SPAN_MS = 15_000;

function pointAt(landmarks, index) {
  const point = landmarks[index];
  return point && Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
}

function eyeRatios(landmarks, irisIndex, cornerAIndex, cornerBIndex, lidAIndex, lidBIndex) {
  const iris = pointAt(landmarks, irisIndex);
  const cornerA = pointAt(landmarks, cornerAIndex);
  const cornerB = pointAt(landmarks, cornerBIndex);
  const lidA = pointAt(landmarks, lidAIndex);
  const lidB = pointAt(landmarks, lidBIndex);
  if (!iris || !cornerA || !cornerB || !lidA || !lidB) return null;

  const width = Math.abs(cornerB.x - cornerA.x);
  const height = Math.abs(lidB.y - lidA.y);
  if (width < 0.008 || height < 0.003) return null;

  const horizontal = (iris.x - Math.min(cornerA.x, cornerB.x)) / width;
  const vertical = (iris.y - Math.min(lidA.y, lidB.y)) / height;
  if (!Number.isFinite(horizontal) || !Number.isFinite(vertical) ||
      horizontal < -0.25 || horizontal > 1.25 || vertical < -0.25 || vertical > 1.25) {
    return null;
  }
  return [horizontal * 2 - 1, vertical * 2 - 1];
}

function extractEyeFeatures(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length < 478) return null;

  const firstEye = eyeRatios(landmarks, 468, 33, 133, 159, 145);
  const secondEye = eyeRatios(landmarks, 473, 362, 263, 386, 374);
  const cheekA = pointAt(landmarks, 234);
  const cheekB = pointAt(landmarks, 454);
  const nose = pointAt(landmarks, 1);
  const forehead = pointAt(landmarks, 10);
  const chin = pointAt(landmarks, 152);
  const eyeLinePoints = [159, 145, 386, 374].map((index) => pointAt(landmarks, index));
  if (!firstEye || !secondEye || !cheekA || !cheekB || !nose || !forehead || !chin ||
      eyeLinePoints.some((point) => point === null)) {
    return null;
  }

  const faceWidth = Math.abs(cheekB.x - cheekA.x);
  const faceHeight = Math.abs(chin.y - forehead.y);
  if (faceWidth < 0.08 || faceHeight < 0.12) return null;

  const eyeLineY = eyeLinePoints.reduce((sum, point) => sum + point.y, 0) / eyeLinePoints.length;
  const faceCenterX = (cheekA.x + cheekB.x) / 2;
  return [
    (firstEye[0] + secondEye[0]) / 2,
    (firstEye[1] + secondEye[1]) / 2,
    (nose.x - faceCenterX) / faceWidth,
    (nose.y - eyeLineY) / faceHeight,
  ];
}

function solveLinearSystem(matrix, vector) {
  const rows = matrix.map((row, index) => [...row, vector[index]]);
  const size = rows.length;

  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    }
    if (Math.abs(rows[pivot][column]) < 1e-10) return null;
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];

    const divisor = rows[column][column];
    for (let cell = column; cell <= size; cell += 1) rows[column][cell] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = rows[row][column];
      for (let cell = column; cell <= size; cell += 1) {
        rows[row][cell] -= factor * rows[column][cell];
      }
    }
  }

  return rows.map((row) => row[size]);
}

function regressionCoefficients(samples, targetKey, means, scales) {
  const size = FEATURE_COUNT + 1;
  const matrix = Array.from({ length: size }, () => Array(size).fill(0));
  const vector = Array(size).fill(0);

  for (const sample of samples) {
    const row = [1, ...sample.features.map((feature, index) => (feature - means[index]) / scales[index])];
    for (let i = 0; i < size; i += 1) {
      vector[i] += row[i] * sample[targetKey];
      for (let j = 0; j < size; j += 1) matrix[i][j] += row[i] * row[j];
    }
  }

  for (let index = 1; index < size; index += 1) matrix[index][index] += 1e-4;
  return solveLinearSystem(matrix, vector);
}

function predict(features, calibration) {
  const row = [1, ...features.map((feature, index) =>
    (feature - calibration.means[index]) / calibration.scales[index])
  ];
  return {
    x: row.reduce((sum, value, index) => sum + value * calibration.xCoefficients[index], 0),
    y: row.reduce((sum, value, index) => sum + value * calibration.yCoefficients[index], 0),
  };
}

function fitGazeCalibration(samples) {
  if (!Array.isArray(samples) || samples.length !== CALIBRATION_TARGETS.length ||
      samples.some((sample) =>
        !Array.isArray(sample.features) ||
        sample.features.length !== FEATURE_COUNT ||
        sample.features.some((value) => !Number.isFinite(value)) ||
        !Number.isFinite(sample.x) ||
        !Number.isFinite(sample.y))) {
    return { ok: false, error: "Capture all nine calibration targets before finishing." };
  }

  const means = Array.from({ length: FEATURE_COUNT }, (_, index) =>
    samples.reduce((sum, sample) => sum + sample.features[index], 0) / samples.length);
  const scales = Array.from({ length: FEATURE_COUNT }, (_, index) => {
    const variance = samples.reduce((sum, sample) =>
      sum + (sample.features[index] - means[index]) ** 2, 0) / samples.length;
    return Math.max(Math.sqrt(variance), 1e-3);
  });
  if (scales[0] < 0.035 || scales[1] < 0.035) {
    return { ok: false, error: "Eye movement varied too little. Retake calibration while looking at each target." };
  }

  const calibration = {
    means,
    scales,
    xCoefficients: regressionCoefficients(samples, "x", means, scales),
    yCoefficients: regressionCoefficients(samples, "y", means, scales),
  };
  if (!calibration.xCoefficients || !calibration.yCoefficients) {
    return { ok: false, error: "Calibration data could not produce a stable mapping. Please try again." };
  }

  const errors = samples.map((sample) => {
    const estimate = predict(sample.features, calibration);
    return (estimate.x - sample.x) ** 2 + (estimate.y - sample.y) ** 2;
  });
  const rmsError = Math.sqrt(errors.reduce((sum, error) => sum + error, 0) / errors.length);
  if (!Number.isFinite(rmsError) || rmsError > 0.3) {
    return { ok: false, error: "Calibration did not fit consistently. Improve lighting, keep your head still, and try again." };
  }
  return { ok: true, calibration: { ...calibration, rmsError } };
}

function estimateGaze(features, calibration) {
  if (!Array.isArray(features) || features.length !== FEATURE_COUNT ||
      features.some((value) => !Number.isFinite(value)) || !calibration) {
    return null;
  }
  const raw = predict(features, calibration);
  return {
    x: Math.max(-1, Math.min(1, raw.x)),
    y: Math.max(-1, Math.min(1, raw.y)),
    direction: classifyPreviewDirection(raw.x, raw.y),
    clipped: raw.x < -1 || raw.x > 1 || raw.y < -1 || raw.y > 1,
  };
}

// Mapping from normalized direction to NLP cue code, classification, cognitive type per nlp_reference_guide.md §17.
const DIRECTION_MAP = {
  UP_LEFT: { nlpCode: "Vc", classification: "Visual Constructed", cognitiveType: "CONSTRUCTED" },
  UP_RIGHT: { nlpCode: "Vr", classification: "Visual Remembered", cognitiveType: "REMEMBERED" },
  DOWN_LEFT: { nlpCode: "K", classification: "Kinesthetic / Tactile", cognitiveType: "INTERNAL_PROCESSING" },
  DOWN_RIGHT: { nlpCode: "Ai", classification: "Auditory Internal", cognitiveType: "INTERNAL_PROCESSING" },
  LATERAL_LEFT: { nlpCode: "Ac", classification: "Auditory Constructed", cognitiveType: "CONSTRUCTED" },
  LATERAL_RIGHT: { nlpCode: "Ar", classification: "Auditory Remembered", cognitiveType: "REMEMBERED" },
  CENTER: { nlpCode: null, classification: "CENTER", cognitiveType: "CENTRAL" },
};

function directionCombo(x, y, handedness = "right") {
  const invertedX = handedness === "left" ? -x : x;
  const horizontal = invertedX < -0.22 ? "LEFT" : invertedX > 0.22 ? "RIGHT" : "";
  const vertical = y < -0.22 ? "UP" : y > 0.22 ? "DOWN" : "";
  if (horizontal && vertical) return `${vertical}_${horizontal}`;
  if (horizontal) return `LATERAL_${horizontal}`;
  return "CENTER";
}

function classifyPreviewDirection(x, y, handedness = "right") {
  const combo = directionCombo(x, y, handedness);
  const info = DIRECTION_MAP[combo] || DIRECTION_MAP["CENTER"];
  return { direction: combo, nlpCode: info.nlpCode, classification: info.classification, cognitiveType: info.cognitiveType };
}

function mapDirection(x, y, handedness = "right") {
  const combo = directionCombo(x, y, handedness);
  const info = DIRECTION_MAP[combo] || DIRECTION_MAP["CENTER"];
  return { direction: combo, nlpCode: info.nlpCode, classification: info.classification, cognitiveType: info.cognitiveType };
}

function buildHeadDirectionAnalysis(utterance, headDirectionSamples, handedness = "right") {
  const estimatedSamples = headDirectionSamples.filter((sample) =>
    sample.source === HEAD_DIRECTION_SOURCE && sample.calibrated === true
  );
  const candidateSamples = estimatedSamples.length ? estimatedSamples : headDirectionSamples;
  const preSpeechSamples = candidateSamples
    .filter((sample) =>
      sample.timestamp_ms >= utterance.timestamp_start_ms - PRE_SPEECH_WINDOW_MS &&
      sample.timestamp_ms <= utterance.timestamp_start_ms
    )
    .sort((a, b) => b.timestamp_ms - a.timestamp_ms);
  const utteranceSamples = candidateSamples
    .filter((sample) =>
      sample.timestamp_ms >= utterance.timestamp_start_ms &&
      sample.timestamp_ms <= utterance.timestamp_end_ms
    )
    .sort((a, b) => b.timestamp_ms - a.timestamp_ms);
  const associatedSamples = preSpeechSamples.length ? preSpeechSamples : utteranceSamples;
  const estimatedSample = estimatedSamples.length ? associatedSamples[0] : null;
  const associatedEstimate = associatedSamples.some((sample) =>
    sample.source === HEAD_DIRECTION_SOURCE && sample.calibrated === true
  );

  let primaryVector = null;
  let directionInfo = null;
  if (estimatedSample && estimatedSample.x != null && estimatedSample.y != null) {
    primaryVector = { x: estimatedSample.x, y: estimatedSample.y };
    directionInfo = classifyPreviewDirection(estimatedSample.x, estimatedSample.y, handedness);
  }

  const headDirectionSampleCount = associatedSamples.length;
  const headDirectionEstimationMethod = estimatedSamples.length
    ? "experimental_preview_relative_head_direction"
    : "not_configured";

  return {
    pre_speech_vector: null,
    pre_speech_direction: directionInfo?.direction ?? null,
    nlp_code: directionInfo?.nlpCode ?? null,
    nlp_classification: directionInfo?.classification ?? null,
    cognitive_type: directionInfo?.cognitiveType ?? null,
    associated_sample_ids: associatedSamples.map((sample) => sample.sample_id),
    head_direction_sample_count: headDirectionSampleCount,
    head_direction_estimation_method: headDirectionEstimationMethod,
    analysis_status: associatedEstimate
      ? "experimental_preview_head_direction_available_nlp_mapping_disabled"
      : estimatedSamples.length
        ? "no_calibrated_head_direction_samples_in_utterance_window"
        : associatedSamples.length
          ? "unvalidated_head_direction_samples_not_classified"
          : "head_direction_estimator_not_configured",
  };
}

module.exports = {
  CALIBRATION_TARGETS,
  classifyPreviewDirection,
  estimateGaze,
  extractEyeFeatures,
  fitGazeCalibration,
  mapDirection,
  buildHeadDirectionAnalysis,
};
