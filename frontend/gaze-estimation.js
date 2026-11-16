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

  let directionInfo = null;
  if (estimatedSample && estimatedSample.x != null && estimatedSample.y != null) {
    directionInfo = classifyPreviewDirection(estimatedSample.x, estimatedSample.y, handedness);
  }

  const gazeSampleCount = associatedSamples.length;
  const gazeEstimationMethod = estimatedSamples.length
    ? "experimental_head_pose_landmarks"
    : "not_configured";

  return {
    pre_speech_vector: null,
    pre_speech_direction: directionInfo?.direction ?? null,
    nlp_code: directionInfo?.nlpCode ?? null,
    nlp_classification: directionInfo?.classification ?? null,
    cognitive_type: directionInfo?.cognitiveType ?? null,
    associated_sample_ids: associatedSamples.map((sample) => sample.sample_id),
    gaze_sample_count: gazeSampleCount,
    gaze_estimation_method: gazeEstimationMethod,
    analysis_status: associatedEstimate
      ? "experimental_preview_gaze_available_nlp_mapping_disabled"
      : estimatedSamples.length
        ? "no_calibrated_gaze_samples_in_utterance_window"
        : associatedSamples.length
          ? "unvalidated_gaze_samples_not_classified"
          : "gaze_estimator_not_configured",
  };
}

module.exports = {
  HEAD_DIRECTION_SOURCE,
  buildHeadDirectionAnalysis,
  classifyPreviewDirection,
  headDirectionFromLandmarks,
  mapDirection,
};
