"use strict";

// Head-direction vectors are derived from SmartSpectra face landmarks. There is
// no local WebGazer/MediaPipe tracker in this build.
const HEAD_DIRECTION_SOURCE = "smartspectra_landmarks";
const PRE_SPEECH_WINDOW_MS = 500;

function pointAt(landmarks, index) {
  const point = landmarks[index];
  return point && Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
}

// Derives a normalized head-direction vector (observer view) from SmartSpectra
// face landmarks: the nose tip position relative to the face bounding-box
// center, scaled by face width and height. The result is roughly in [-1, 1]
// and left/right/up/down classification is applied later by the direction
// matrix. Returns null when the required landmarks are missing or too small.
function headDirectionFromLandmarks(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length < 478) return null;

  const cheekA = pointAt(landmarks, 234);
  const cheekB = pointAt(landmarks, 454);
  const nose = pointAt(landmarks, 1);
  const forehead = pointAt(landmarks, 10);
  const chin = pointAt(landmarks, 152);
  if (!cheekA || !cheekB || !nose || !forehead || !chin) return null;

  const faceWidth = Math.abs(cheekB.x - cheekA.x);
  const faceHeight = Math.abs(chin.y - forehead.y);
  if (faceWidth < 0.08 || faceHeight < 0.12) return null;

  const faceCenterX = (cheekA.x + cheekB.x) / 2;
  const faceCenterY = (forehead.y + chin.y) / 2;
  const x = (nose.x - faceCenterX) / faceWidth;
  const y = (nose.y - faceCenterY) / faceHeight;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
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

// Per-utterance head-direction analysis.
//
// The classification is based on the peak-deviation outlier within the
// evaluation window (the 500 ms lead-up before speech onset plus the utterance
// window), not on a single pre-speech snapshot. A resting, neutral head
// produces small deviations, so taking the peak deviation isolates the actual
// movement event and avoids every utterance collapsing to CENTER. Variance is
// reported alongside the peak for jitter transparency.
function buildHeadDirectionAnalysis(utterance, headDirectionSamples, handedness = "right") {
  const estimatedSamples = headDirectionSamples.filter((sample) =>
    sample.source === HEAD_DIRECTION_SOURCE && sample.calibrated === true
  );
  const candidateSamples = estimatedSamples.length ? estimatedSamples : headDirectionSamples;

  const leadUpSamples = estimatedSamples
    .filter((sample) =>
      sample.timestamp_ms >= utterance.timestamp_start_ms - PRE_SPEECH_WINDOW_MS &&
      sample.timestamp_ms < utterance.timestamp_start_ms
    )
    .sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  const utteranceSamples = estimatedSamples
    .filter((sample) =>
      sample.timestamp_ms >= utterance.timestamp_start_ms &&
      sample.timestamp_ms <= utterance.timestamp_end_ms
    )
    .sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  const evaluationSamples = [...leadUpSamples, ...utteranceSamples];
  const associatedSamples = estimatedSamples.length ? evaluationSamples : candidateSamples;

  // Peak-deviation (outlier) sample: the largest ||(x, y)|| across the window.
  let peak = null;
  for (const sample of evaluationSamples) {
    if (sample.x == null || sample.y == null) continue;
    const deviation = Math.sqrt(sample.x * sample.x + sample.y * sample.y);
    if (!Number.isFinite(deviation)) continue;
    if (!peak || deviation > peak.deviation) peak = { sample, deviation };
  }

  const classifyFromSample = (sample) => {
    if (!sample || sample.x == null || sample.y == null) return null;
    return classifyPreviewDirection(sample.x, sample.y, handedness);
  };

  let duringPeak = null;
  for (const sample of utteranceSamples) {
    if (sample.x == null || sample.y == null) continue;
    const deviation = Math.sqrt(sample.x * sample.x + sample.y * sample.y);
    if (!Number.isFinite(deviation)) continue;
    if (!duringPeak || deviation > duringPeak.deviation) duringPeak = { sample, deviation };
  }
  const duringInfo = duringPeak ? classifyFromSample(duringPeak.sample) : null;

  let preSpeechPeak = null;
  for (const sample of leadUpSamples) {
    if (sample.x == null || sample.y == null) continue;
    const deviation = Math.sqrt(sample.x * sample.x + sample.y * sample.y);
    if (!Number.isFinite(deviation)) continue;
    if (!preSpeechPeak || deviation > preSpeechPeak.deviation) preSpeechPeak = { sample, deviation };
  }
  const preSpeechInfo = preSpeechPeak ? classifyFromSample(preSpeechPeak.sample) : null;

  const primaryInfo = peak ? classifyFromSample(peak.sample) : null;
  const primaryVector = peak ? { x: peak.sample.x, y: peak.sample.y } : null;

  const varianceOf = (samples, key) => {
    if (samples.length < 2) return null;
    const mean = samples.reduce((sum, sample) => sum + sample[key], 0) / samples.length;
    const variance = samples.reduce((sum, sample) => sum + (sample[key] - mean) ** 2, 0) / samples.length;
    return Number(variance.toFixed(6));
  };

  const gazeSampleCount = associatedSamples.length;
  const gazeEstimationMethod = estimatedSamples.length
    ? "experimental_head_pose_landmarks"
    : "not_configured";

  let analysisStatus;
  if (!estimatedSamples.length) {
    analysisStatus = candidateSamples.length
      ? "unvalidated_gaze_samples_not_classified"
      : "gaze_estimator_not_configured";
  } else if (evaluationSamples.length === 0) {
    analysisStatus = "no_gaze_samples_in_evaluation_window";
  } else if (primaryInfo) {
    analysisStatus = "peak_deviation_classified";
  } else {
    analysisStatus = "unvalidated_gaze_samples_not_classified";
  }

  return {
    primary_direction: primaryInfo?.direction ?? "CENTER",
    primary_vector: primaryVector,
    primary_nlp_code: primaryInfo?.nlpCode ?? null,
    primary_classification: primaryInfo?.classification ?? null,
    primary_cognitive_type: primaryInfo?.cognitiveType ?? null,
    peak_deviation: peak ? Number(peak.deviation.toFixed(4)) : null,
    peak_sample_id: peak?.sample.sample_id ?? null,
    peak_vector: primaryVector,
    variance_x: varianceOf(evaluationSamples, "x"),
    variance_y: varianceOf(evaluationSamples, "y"),
    during_utterance_direction: duringInfo?.direction ?? "CENTER",
    during_utterance_vector: duringPeak ? { x: duringPeak.sample.x, y: duringPeak.sample.y } : null,
    during_utterance_nlp_code: duringInfo?.nlpCode ?? null,
    during_utterance_classification: duringInfo?.classification ?? null,
    during_utterance_cognitive_type: duringInfo?.cognitiveType ?? null,
    pre_speech_direction: preSpeechInfo?.direction ?? null,
    pre_speech_vector: preSpeechPeak ? { x: preSpeechPeak.sample.x, y: preSpeechPeak.sample.y } : null,
    pre_speech_nlp_code: preSpeechInfo?.nlpCode ?? null,
    pre_speech_classification: preSpeechInfo?.classification ?? null,
    pre_speech_cognitive_type: preSpeechInfo?.cognitiveType ?? null,
    // Legacy aliases kept for downstream consumers of the export schema.
    nlp_code: primaryInfo?.nlpCode ?? null,
    nlp_classification: primaryInfo?.classification ?? null,
    cognitive_type: primaryInfo?.cognitiveType ?? null,
    associated_sample_ids: associatedSamples.map((sample) => sample.sample_id),
    gaze_sample_count: gazeSampleCount,
    gaze_estimation_method: gazeEstimationMethod,
    analysis_status: analysisStatus,
  };
}

module.exports = {
  HEAD_DIRECTION_SOURCE,
  buildHeadDirectionAnalysis,
  classifyPreviewDirection,
  headDirectionFromLandmarks,
  mapDirection,
};
