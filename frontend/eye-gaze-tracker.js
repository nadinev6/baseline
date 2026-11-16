"use strict";

// WebGazer support removed due to skin/eye color issues; stubbed for compatibility
const { CALIBRATION_TARGETS } = require("./gaze-estimation");

const HEAD_DIRECTION_SOURCE = "head_direction";
const CALIBRATION_SETTLE_MS = 2000;
const CALIBRATED_SAMPLE_COUNT = 8;

class HeadDirectionTracker {
  constructor({ video, getElapsedMs, onStatus, onEstimate }) {
    this.video = video;
    this.getElapsedMs = getElapsedMs;
    this.onStatus = onStatus;
    this.onEstimate = onEstimate;
    this.stopped = false;
    this.calibrationState = "idle";
    this.startedAt = null;
    this.startedAtElapsed = null;
    this.headDirectionSamples = [];
    this.pendingCalibration = [];
    this.calibration = null;
    this.diagnostics = {
      status: "not_started",
      frames_processed: 0,
      faces_detected: 0,
      usable_eye_frames: 0,
      rejected_eye_frames: 0,
      estimates_emitted: 0,
      calibration_targets_captured: 0,
      calibration_failure: null,
      calibration_fit_rms_error: null,
      error: null,
    };
    this.frameRequest = null;
    this.lastStatus = null;
  }

  async start() {
    this.reportStatus("not_configured");
  }

  processFrame() {
    // WebGazer owns its own animation-frame loop via setGazeListener; keep this
    // as a no-op stub honoring the previous tracker contract.
    if (this.stopped) return;
    this.frameRequest = requestAnimationFrame(() => this.processFrame());
  }

  beginCalibration() {
    this.pendingCalibration = [];
    this.calibrationState = "collecting";
    this.diagnostics.calibration_failure = null;
    this.reportStatus("calibrating");
  }

  captureCalibrationTarget() {
    // WebGazer self-calibrates from user clicks/cursor movement; manual target
    // capture is not required, but report progress from collected samples.
    return this.headDirectionSamples.length;
  }

  completeCalibration() {
    const valid = this.pendingCalibration.length === CALIBRATION_TARGETS.length &&
      this.pendingCalibration.every((sample, index) =>
        Math.abs(sample.x - CALIBRATION_TARGETS[index].x) < 1e-6 &&
        Math.abs(sample.y - CALIBRATION_TARGETS[index].y) < 1e-6
      );
    if (!valid) {
      this.calibrationState = "failed";
      this.diagnostics.calibration_failure = "Capture all nine calibration targets before finishing.";
      this.reportStatus("calibration_failed", "Capture all nine calibration targets before finishing.");
      return { ok: false, error: "Capture all nine calibration targets before finishing." };
    }
    this.calibrationState = "calibrated";
    this.calibration = { rmsError: 0 };
    this.diagnostics.calibration_fit_rms_error = 0;
    this.reportStatus("calibrated");
    return { ok: true };
  }

  cancelCalibration() {
    this.calibrationState = "idle";
    this.reportStatus("ready");
  }

  reportStatus(status, detail = "") {
    if (this.lastStatus === status && !detail) return;
    this.lastStatus = status;
    this.diagnostics.status = status;
    if (detail) this.diagnostics.error = detail;
    this.onStatus(status, detail);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.diagnostics.status !== "error") {
      this.diagnostics.stopped_from_status = this.diagnostics.status;
      this.diagnostics.status = "stopped";
    }
  }
}
module.exports = {
  HeadDirectionTracker,
  HEAD_DIRECTION_SOURCE,
  CALIBRATION_SETTLE_MS,
  CALIBRATED_SAMPLE_COUNT,
};
