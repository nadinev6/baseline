# NLP Eye-Accessing Cues & Telemetry Reference Guide

*Specification Version: BASELINE-COGNISYNC-NLP-1.0*

*Target Schema: Post-Hoc Cognitive Load & Telemetry JSON Mapper*

> **Implementation and validity notice:** Blink detection is requested by
> default. Pulse, HRV, and experimental local head-direction tracking are optional in the
> Electron Features menu. Head direction requires calibration, but calibration controls
> are not currently exposed, so enabling it does not yet produce head-direction estimates.
> Transcript text and coarse timing-based pacing are available; semantic text
> scores and acoustic prosody are not implemented. The directional-cue rules
> below are hypotheses, not a validated head-direction or cognitive-state model. Generic
> facial landmarks or head movement must not be treated as evidence of cognitive
> state.

## 1. Directional Head Direction Matrix

> **Note on Handedness & Perspective:**
>
> All vectors are defined from the **observer's view** (camera frame) of a **right-handed subject**.
>
> If subject handedness is set to `LEFT`, invert horizontal directional vectors (`UP_LEFT` <-> `UP_RIGHT`, `LATERAL_LEFT` <-> `LATERAL_RIGHT`, `DOWN_LEFT` <-> `DOWN_RIGHT`).

| Vector Code | Vector Direction (Observer View) | Subject Eye Direction | NLP Cue Classification | Cognitive State Description | Baseline Expectation | 
| ----- | ----- | ----- | ----- | ----- | ----- | 
| `Vc` | `UP_LEFT` | Up-Right | **Visual Constructed** | Imagining novel images, synthesizing unseen scenarios, or altering visual details of past events. | High Cognitive Construction | 
| `Vr` | `UP_RIGHT` | Up-Left | **Visual Remembered** | Accessing stored visual memories, recalling exact colors, layouts, or past visual experiences. | Memory Recall | 
| `Ac` | `LATERAL_LEFT` | Mid-Right | **Auditory Constructed** | Synthesizing novel sounds, formulating hypothetical dialog, or crafting deliberate verbal phrasing. | High Cognitive Construction | 
| `Ar` | `LATERAL_RIGHT` | Mid-Left | **Auditory Remembered** | Recalling specific auditory memories, distinct voices, known sounds, or previously heard statements. | Memory Recall | 
| `K` | `DOWN_LEFT` | Down-Right | **Kinesthetic / Tactile** | Processing bodily sensations, visceral emotions, tactile memories, or physical feelings. | Internal Feeling | 
| `Ai` | `DOWN_RIGHT` | Down-Left | **Auditory Internal** | Engaging in internal monologue, self-talk, or deliberating specific wording prior to speaking. | Internal Processing | 

## 2. SmartSpectra Cardio & Face Measurements

The app requests `BLINKING` by default. `PULSE_RATE` and `HRV` can be enabled
independently in the Electron Features menu. Other SmartSpectra metrics,
including face landmarks, talking, expressions, and arterial pressure trace,
are not requested. Missing readings remain `null`/omitted, not zero. Pulse
generally needs about 12 seconds and HRV about 60 seconds of measurement before
the SDK may emit a value; these are indicative minimums, not guarantees.

### Talking (SDK Voice-Activity Detection)

The SmartSpectra `face.talking` metric emits a per-packet `talking_detected`
boolean (and a stability flag). Baseline records every talking state change as
a face-speech event and exposes it in three places:

| Surface | Field | Meaning |
|---------|-------|---------|
| Export JSON | `talking_detected` | Boolean; `true` when the SDK reports talking in that packet |
| Export JSON | `talking_stable` | Boolean; `true` when the talking state is stable (non-noisy) |
| Session diagnostics | `smartspectra_talking` | `talking_packets_received_transitions_recorded` or `unavailable_no_face_talking_packets` |
| Telemetry grid | `TALKING` cell | Live view: `ACTIVE` / `ACTIVE STABLE` / `OFF` |
| Rich Text | Speech badge | Green `TALKING` (stable), amber `TALKING` (active), gray `LISTENING` (off) |

**Caveat:** Talking detection is **packet-quantized** (~30 fps), not a measured
audio speech onset. A brief talking burst could be missed if the packet
interval is sparse. The export note
`raw_smartspectra_talking_transitions_window_correlated_not_a_measured_speech_onset`
records this distinction. Baseline uses talking as a **native VAD tied to
landmarks** to avoid transcribing other speakers; background noise is recorded
as `talking_detected: false` for transparency.

Stable rising blink-detection transitions are exported as events. Per-utterance
blink counts/rates are calculated over approximate transcript-result windows;
they are descriptive and are not cognitive-state measures.

Each channel's within-session baseline is the median of its first 30 seconds of
stable readings. Establishment requires at least three samples spanning at
least 15 seconds. Only later stable samples are compared with that baseline.
This is a technical reference window, not a quiet/resting baseline.

The paired `cardio_response_candidate` heuristic is `true` only when both
post-baseline changes are available and pulse is at least 4 BPM above baseline
while HRV RMSSD is at least 15 ms below baseline. It is a provisional
co-occurrence rule, not a validated stress measure, diagnosis, or inference
about cognition. `elevated_cognitive_load` and `biometric_congruence` remain
`null`; blink-derived cognitive rules are not implemented. Transcript-derived
semantic scores and acoustic prosody are also not currently computed.

## 3. Mapping Rules for JSON Parser

### Rule A: Utterance-Head-Direction Association

* **Window Activation (**$T_0 \to T_1$**):** Evaluate head direction vector during the **0ms to 500ms pre-speech window** prior to speech onset ($T_1$).

* **Primary Classification Assignment:**

  * If Primary Vector == `Vc` OR `Ac`: Assign `cognitive_type: "CONSTRUCTED"`

  * If Primary Vector == `Vr` OR `Ar`: Assign `cognitive_type: "REMEMBERED"`

  * If Primary Vector == `K` OR `Ai`: Assign `cognitive_type: "INTERNAL_PROCESSING"`

* **Analysis Status Codes:**

  | Status | Description |
  | ------ | ----------- |
  | `pre_speech_direction_classified` | Pre-speech window (0-500ms before speech onset) contains a classifiable head-direction sample. |
  | `utterance_window_direction_classified` | Pre-speech window empty, but utterance window (during speech) contains a classifiable head-direction sample. |
  | `raw_coordinates_only_no_classifiable_samples` | Head-direction samples exist but are not classifiable (e.g., noisy landmarks, coordinates outside threshold). |
  | `head_direction_samples_received_no_pre_speech_coverage` | Head-direction samples received but none fall into the pre-speech window and none in utterance window. |
  | `no_head_direction_samples_received` | No head-direction samples received from the local tracker or adapter (tracker disabled, calibration unavailable, camera unavailable, or session too short). |

* **Head Direction Analysis Metadata:**

  Each utterance's `gaze_analysis` block includes:
  * `gaze_sample_count`: Number of head-direction samples evaluated in the window.
  * `pre_speech_direction`: Experimental preview-relative direction when a calibrated sample is available. This is not an NLP cue.
  * `gaze_estimation_method`: `"experimental_preview_relative_mediapipe_iris_landmarks"` when a calibrated tracker sample is associated; never `"landmark_centroid"`.
  * `nlp_code`, `nlp_classification`, and `cognitive_type`: remain `null`; these rules are not implemented.

### Rule B: Cardio-Response Candidate

* `pulse_spike_bpm` and `hrv_delta_ms` are computed only from observations
  later than their respective established baselines.
* `cardio_response_candidate` and its backwards-compatible alias
  `autonomic_shift_detected` are `true` only when both changes meet the paired
  thresholds above, `false` when both are available but the pair does not meet
  them, and `null` otherwise.
* `elevated_cognitive_load` and `biometric_congruence` remain `null`. No
  cognitive or stress diagnosis is made.

## 4. Turn-Level Analysis Mapping

* Turn-level grouping (gap threshold `<= 2000ms`) is for transcript organization;
  it does not classify cognitive state.

* The `utterance_groups` export field mirrors `turn_groups` turn IDs but contains analysis fields computed per turn:
  * Turn-level aggregation joins constituent utterances' `spoken_text` with a space-separated join.
  * Turn's pre-speech window uses the first utterance's `timestamp_start_ms`.
  * Turn averages include available positive pulse/HRV readings; absent readings
    remain `null`.

## 5. Proposed JSON Export Structure Example

The following is a hypothetical schema example, not the current app output.

```json
{
  "session_metadata": {
    "session_id": "8820-XF",
    "app_name": "Baseline CogniSync",
    "timestamp_iso": "2026-11-09T12:43:00Z",
    "handedness_setting": "RIGHT",
    "gaze_inversion_active": false
  },
  "utterance_telemetry_stream": [
    {
      "utterance_id": "UTT-001",
      "timestamp_start": "00:18.200",
      "timestamp_end": "00:23.500",
      "spoken_text": "After leaving the building, I immediately took a cab home.",
      "gaze_analysis": {
        "pre_speech_vector": null,
        "pre_speech_direction": null,
        "nlp_code": null,
        "nlp_classification": null,
        "cognitive_type": null,
        "associated_sample_ids": [],
        "gaze_sample_count": 0,
        "gaze_estimation_method": "not_configured",
        "analysis_status": "gaze_tracking_disabled_by_user"
      },
      "presage_biometrics": {
        "pulse_bpm": null,
        "pulse_baseline_bpm": null,
        "pulse_spike_bpm": null,
        "hrv_ms": null,
        "hrv_baseline_ms": null,
        "hrv_delta_ms": null,
        "talking_detected": false,
        "talking_stable": false,
        "analysis_status": "cardio_metrics_disabled"
      },
      "telemetry_flags": {
        "elevated_cognitive_load": null,
        "autonomic_shift_detected": null,
        "cardio_response_candidate": null,
        "biometric_congruence": null,
        "analysis_status": "not_computed_cardio_baseline_or_post_baseline_readings_missing"
      }
    }
  ]
}
```