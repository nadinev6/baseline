*This is a submission for the [Presage SmartSpectra SDK Challenge](https://dev.to/challenges/presage-2026-11-04)*

## Table of Contents

- [Quick Glossary](#quick-glossary)
- [What I Built](#what-i-built)
- [Demo](#demo)
- [Code](#code)
- [How It Responds to Human Signals](#how-it-responds-to-human-signals)
- [Analyzing Speech Through Human Signals](#analyzing-speech-through-human-signals)
- [Prize Categories](#prize-categories)
- [Consent and Data Handling](#consent-and-data-handling)



**Quick Glossary**

| Term | What it means in Baseline CogniSync |
| :--- | :--- |
| **NLP** | **Neuro-Linguistic Programming** (tracking eye movements to study cognitive focus, *not* Natural Language Processing). |
| **Handedness** | A user preference recorded by the app; it inverts horizontal gaze vectors for LEFT-handed subjects before NLP mapping. |
| **Utterance** | A single block of transcribed speech used to anchor data. |

## What I Built

After 13 years practicing NLP, I built Baseline CogniSync to test and apply its principles scientifically with SmartSpectra. NLP is a behavioral practice based on a theory that the direction a person's eyes move when answering a question or remembering something corresponds to a specific cognitive pathway. Head and eye movements are subconscious, autonomic behaviors just like heart rate and respiration.

Baseline CogniSync is a tool that associates approximate speech-transcript windows, called utterances, with available camera-derived biometric and spatial data. These metrics are computed and stored in arrays alongside chunks of speech transcribed by a local speech model. Experimental cognitive types and NLP processing classifications are estimated by computing head and facial direction vectors using SmartSpectra's FaceMesh landmark data points. 

The data and biometric timelines describe the speaker's observable micro-behaviors at the time of recording. All the data is available for export so that a person, like an interviewer, can inspect the session data.

## Demo


[![Baseline CogniSync Demo](https://dev-to-uploads.s3.us-east-2.amazonaws.com/uploads/articles/kitkczyqgza1lotar8un.png)](https://github.com/user-attachments/assets/3cfb37fc-37e5-4d60-b9f5-b9e394193551)

Note: Auto-generated speech transcripts in the sample capture contain occasional recognition errors due to accent variability with Whisper.

(_Sample/demo interview footage sourced from Pexels (Person Having an Interview, video #5442623)_)

[Open Baseline CogniSync Interpreter on Gemini](https://gemini.google.com/share/1e130c1c9e53?social_preview=true&skid=5cf3976a-9750-4fe6-b3e9-fb1854e55b64&pli=1)

[Demo `free-practice-session-20-11-26.json` (Raw)](https://raw.githubusercontent.com/nadinev6/baseline/master/exports/free-practice-session-20-11-26.json)

<!-- Embed or link your demo video showing the live Presage signal(s) in action. Public hosting of your app is optional. -->

## Code

<!-- Share a link to your public code repository. Make sure it includes setup instructions. -->

{% embed https://github.com/nadinev6/baseline %}


### Capturing Active Cognitive Shifts via Head Direction

The app captures multiple pose samples rather than relying on a single pre-speech snapshot. Because a resting, neutral head produces small deviations, taking the **peak-deviation outlier** across the evaluation window isolates the actual movement event and prevents every utterance from defaulting to `CENTER`. 

* **Evaluation Window:** Combines a 500ms pre-speech lead-up plus the active utterance duration.
* **Magnitude Calculation:** Computes `sqrt(x² + y²)` for each sample to find the maximum deviation from center (representing **peak yaw/roll**).
* **Primary Classification:** Maps the peak outlier to directional categories: `Vc · UP_LEFT`, `Vr · UP_RIGHT`, `Ac · LATERAL_LEFT`, `Ar · LATERAL_RIGHT`, `K · DOWN_LEFT`, `Ai · DOWN_RIGHT`, or `CENTER`. Variance is also reported alongside the peak for transparency.

### The Baseline CogniSync Interpreter

The session explorer maps gazes visually. Some NLP cues are missing while coordinates exist because they fall inside a **deadzone box** in the direction classifier: when `|x| ≤ 0.22` **AND** `|y| ≤ 0.22`, the result is `CENTER`. This is a deliberate threshold to avoid false positives from micro-jitter. Center is considered a resting, neutral position; only when the nose offset from face center exceeds ±0.22 on at least one axis does a directional classification (`LATERAL_LEFT`, `UP_RIGHT`, etc.) and corresponding NLP code fire. Lowering this threshold would increase false positives.

### Speech-to-Text (STT) Flush

The utterance window defaults to 4s (4000ms) chunks, but continuous speech overrides the STT flush to avoid cutting the speaker mid-sentence. Audio capture uses a `ScriptProcessorNode` with a continuous `onaudioprocess` callback.

**Export Example**

Each utterance block contains an array of `associated_sample_ids` (such as `g-00577` through `g-00589`) to link a specific chunk of transcribed speech to the exact camera-derived landmark frames or spatial direction vectors captured during that temporal window.


Handedness is important to set in the app because orientation is reversed in left-handed individuals. 



```json
{
      "utterance_id": "u-0005",
      "timestamp_start": "00:28.946",
      "timestamp_end": "00:32.971",
      "timestamp_start_ms": 28946,
      "timestamp_end_ms": 32971,
      "timestamp_basis": "approximate_browser_recognition_result_window",
      "handedness_setting": "RIGHT",
      "spoken_text": "I believe that I will make a good team lead.",
      "gaze_analysis": {
        "primary_direction": "DOWN_RIGHT",
        "primary_nlp_code": "Ai",
        "primary_classification": "Auditory Internal",
        "primary_cognitive_type": "INTERNAL_PROCESSING",
        "peak_deviation": 0.287,
        "peak_sample_id": "g-00589",
        "peak_vector": { "x": 0.15, "y": 0.24 },
        "variance_x": 0.0018,
        "variance_y": 0.0021,
        "during_utterance_direction": "DOWN_RIGHT",
        "during_utterance_nlp_code": "Ai",
        "during_utterance_classification": "Auditory Internal",
        "during_utterance_cognitive_type": "INTERNAL_PROCESSING",
        "pre_speech_direction": "DOWN_RIGHT",
        "pre_speech_nlp_code": "Ai",
        "pre_speech_classification": "Auditory Internal",
        "pre_speech_cognitive_type": "INTERNAL_PROCESSING",
        "nlp_code": "Ai",
        "nlp_classification": "Auditory Internal",
        "cognitive_type": "INTERNAL_PROCESSING",
        "associated_sample_ids": [
          "g-00589",
...
        ],
        "gaze_sample_count": 13,
        "gaze_estimation_method": "experimental_head_pose_landmarks",
        "analysis_status": "peak_deviation_classified"
      },
```


After studying a few recordings I found the occasional mid-utterance outlier where the pre-speech was `DOWN_RIGHT` but one set of coordinates suggest head was `LATERAL_RIGHT` `(|x|>0.22, y=0.037 → lateral)`. The new `during_utterance_direction` field now surfaces this.

Example of facial geometry coordinates mapped during the speech windows:

```json
        "sample_id": "g-00456",
        "timestamp_ms": 20703,
        "x": 0.05263157894736842,
        "y": 0.02702702702702703,
        "source": "smartspectra_landmarks",
        "calibrated": true,
        "linked_utterance_id": "u-0004"
      },
```

Even when there is no speech detected this block provides behavioral telemetry during a silent or listening window:

```json
      "blink_analysis": {
        "event_ids": [
          "bl-00004",
          "bl-00005"
        ],
        "sample_count": 88,
        "blink_event_count": 2,
        "blink_rate_per_minute": 30.11,
        "analysis_status": "stable_blink_transitions_in_approximate_transcription_window"
      },
      "speech_detection": {
        "linked_event_ids": [],
        "analysis_status": "unavailable_no_face_talking_packets"
      },
```
This is an example of non-verbal data (like the jump to a 30.11 blink rate) that gives you a reliable baseline for baseline stillness versus cognitive processing for this person.

Talking also appears in the live telemetry grid (TALKING: ACTIVE / ACTIVE STABLE / OFF) and as a per-utterance badge in Rich Text. It is treated as optional and is disabled by default because the SmartSpectra face-landmark talking detection adds a concurrent metric that increases the likelihood of the processing pipeline stalling (kProcessingFailed). When enabled, talking events are exported as face-speech transitions alongside transcript windows.

---



## How It Responds to Human Signals

<!-- Which live Presage signal(s) does your app use (such as pulse, breathing rate, HRV, or expressions), and how does the experience respond to them in real time? Walk us through how you integrated the SmartSpectra SDK. -->

Baseline CogniSync uses five live Presage signals from the SmartSpectra SDK:

| Signal | SDK Metric | How Baseline CogniSync Uses It |
| :--- | :--- | :--- |
| **Blink rate** | `BLINKING` (stable transitions) | Primary signal. Stable blink-on transitions are counted in real time and correlated with approximate transcript windows. Blink rate per minute is computed and displayed live. |
| **Pulse rate** | `PULSE_RATE` (stable readings) | Physiological context. Pulse BPM is shown once the SDK emits stable readings. Pulse baseline is established after ~12 s of stable data; post-baseline changes are flagged. |
| **HRV (RMSSD)** | `HRV` (stable readings) | Physiological context. HRV in ms is shown once the SDK emits stable readings. HRV baseline is established after ~60 s of stable data; post-baseline changes are flagged. |
| **Face (headDirection)** | `FACE_LANDMARKS`| Logs first observation followed by transitions. Computes a bounding box of landmarks and derives a normalized gaze vector by calculating the face width. |
| **Talking** | `face.talking` (per-packet `talking.detected` / `talking.stable`) | Goal is to record every talking state change as a face-speech event. Verifies if the subject is talking or if sounds are background noise or from another source. |

The app's primary features rely on the 478 x,y pixels which are captured almost instantly when the face is facing the direction of the camera. Once the subject starts speaking, speech blocks are recorded in the context of all physiological events. 

The HRV baseline is built over ~30-second windows (requiring at least 15 seconds of stable readings), and I wait for two rounds (~60 seconds total) before treating HRV as meaningful. Because it takes a full minute of stable data to settle, it may not appear right away in real time and can be toggled off in the menu.

I use SmartSpectra's `talking` metric as a face-landmark-derived voice-activity annotation for whether the subject was speaking during a transcribed window; it is not used to suppress transcription of other speakers.

### Why Blink Rate and Pulse Matter in Speech Context

Blink rate and pulse are not just biometric curiosities: they carry meaning when anchored to speech segments. Here is what each signal indicates and why it matters:

**Blink Rate During Speech Turns**

Blink rate is measured **within** each utterance's approximate transcript window, not as a global average. This is significant because:

- **Blink suppression**: During active speech production, the natural blink rate drops as the brain coordinates eye closure with articulation. A stable, low blink rate during a speech turn indicates the speaker is actively engaged in vocal production.
- **Blink recovery**: After a speech turn ends, blink rate typically rises as the speaker's oculomotor system resets. This transition can be used to detect turn boundaries.
- **Cognitive load marker**: When a speaker is formulating complex thoughts or retrieving memories, blink rate may increase due to increased cognitive processing. This is the core NLP insight: blink rate fluctuations during speech reflect the internal state of the speaker.
- **Turn-level analysis**: By computing blink rate per minute **within each utterance window** where it can compare blink patterns across different speech turns and identify whether a particular turn was associated with higher or lower cognitive engagement.


**Pulse Rate as Physiological Context**

Pulse rate provides a complementary autonomic signal:

- **Arousal indicator**: Elevated pulse rate during a speech turn may indicate heightened arousal, stress, or cognitive effort. This is particularly useful when blink rate is ambiguous.
- **Baseline establishment**: Pulse baseline is established from the first ~12 seconds of stable readings. Post-baseline changes (spikes) during speech turns can flag moments of physiological arousal.
- **Cross-validation**: When both blink rate and pulse rate change in the same direction during a speech turn, it strengthens the interpretation that the speaker was experiencing cognitive or emotional engagement.

**What This Means for NLP Practice**

In traditional NLP, the practitioner watches eye movements to infer representational systems (visual, auditory, kinesthetic) and cognitive states. Baseline operationalizes this by:

1. **Anchoring signals to speech**: Every blink and pulse reading is timestamped and linked to the nearest utterance, so you can see what the speaker was doing *while* they were saying something.
2. **Computing turn-level metrics**: Rather than tracking raw blinks, Baseline computes blink rate per minute within each utterance window, making it possible to compare cognitive engagement across different parts of a conversation.
3. **Providing physiological context**: Pulse and HRV data help distinguish whether a blink rate change is due to cognitive processing (internal state) or physical arousal (external stimulus).

The key insight: **blink rate and pulse, when anchored to speech segments, provide a supplementary window into the speaker's internal state alongside head-direction mapping**. The signals are not a replacement for gaze analysis but rather a complementary layer that helps distinguish between cognitive processing and physical arousal across a conversation.

The SDK derives face‑landmark vectors from SmartSpectra to determine the cognitive state from the head movement:

```text
SmartSpectra SDK face landmarks → preview-relative screen-direction vectors
                                              ↓
        handedness inversion → NLP mapping → nlp_code / cognitive_type
                               (experimental, not validated)
```

**Proposed NLP interpretations (implemented, experimental, not validated by Baseline CogniSync)**

_Note: The head direction feature is experimental and attempts to map head poses to eye gaze direction. The head direction vector is computed from the nose tip relative to the face bounding-box center (a geometric proxy), not from actual pupil or iris movement. The NLP classification is therefore experimental and derived from this proxy, not validated eye-gaze tracking._

| Gaze Vector | NLP Code | NLP Classification | Cognitive Type |
| :--- | :--- | :--- | :--- |
| **UP_LEFT** | `Vc` | Visual Constructed | CONSTRUCTED |
| **UP_RIGHT** | `Vr` | Visual Remembered | REMEMBERED |
| **DOWN_LEFT** | `K` | Kinesthetic/Tactile | INTERNAL_PROCESSING |
| **DOWN_RIGHT** | `Ai` | Auditory Internal | INTERNAL_PROCESSING |
| **LATERAL_LEFT** | `Ac` | Auditory Constructed | CONSTRUCTED |
| **LATERAL_RIGHT** | `Ar` | Auditory Remembered | REMEMBERED |

The app aligns synchronized biometrics, blink events, and head pose telemetry to the nearest utterance window and records talking events alongside them for export when turned on.

The full [nlp_reference_guide.md](https://github.com/nadinev6/baseline/blob/master/nlp_reference_guide.md ) is in the repository.


---

## Analyzing Speech Through Human Signals

The core premise of Baseline CogniSync is that **speech is validated and enriched by simultaneous human signals**. Rather than treating the transcript as an isolated artifact, Baseline CogniSync anchors every utterance to the biometric state of the speaker at the moment of speaking.

### What Speech Tells Us Without Signals

A transcript alone tells you *what* was said, but not *how* it was said or *what was happening inside the speaker* while saying it. Two people can say the same sentence with vastly different internal states: one calm and reflective, another anxious and rushed. Without signals, you cannot distinguish these states.

### What Signals Add to Speech Analysis

When blink rate and pulse are overlaid on the transcript, several analytical possibilities emerge:

1. **Turn segmentation**: Blink rate transitions (suppression during speech, recovery after) provide a physiological marker for turn boundaries, even when the transcript is noisy or incomplete.

2. **Cognitive engagement and processing scoring**: Utterances linked to specific head-pose vectors (`buildHeadDirectionAnalysis`) reveal the speaker's internal processing mode (such as visual, auditory, or kinesthetic patterns). Paired with elevated blink or pulse rates, this flags higher cognitive load, memory retrieval, or emotional processing during specific speech turns.

3. **Representational system inference**: When head-direction mapping is active, directional vectors (`buildHeadDirectionAnalysis`, `classifyPreviewDirection`) actively capture representational processing. For example, a shift toward `DOWN_RIGHT` (`Ai` / Auditory Internal) or `UP_LEFT` (`Vc` / Visual Constructed) during a descriptive turn provides structural insight into how the speaker is accessing information.

4. **Validation of self-report**: If a speaker reports feeling calm but their pulse rate spikes or their head-pose trajectory signals internal stress during a particular utterance, the signals provide objective evidence that contradicts or supports the self-report. This is the foundation of NLP's "calibration" principle: the practitioner observes micro-behaviors to validate or challenge the speaker's verbal report.

5. **Turn-by-turn comparison**: By computing directional vectors, blink rate, and pulse metrics for each utterance, you can compare turns and identify patterns across the entire session log.

### The NLP Approach in Baseline CogniSync

NLP is often misunderstood as a technique for reading eye movements to detect deception or manipulate communication. In this application, the approach is different:

- **Not about deception** : Baseline CogniSync does not attempt to detect whether someone is lying. Blink rate and pulse are physiological signals that reflect cognitive and emotional processing, not _truthfulness_.
- **Not about control** : The goal is not to manipulate the speaker but to understand their internal state so you can communicate more effectively.
- **About calibration** : The core NLP skill is calibration: learning to recognize the physiological signatures of different internal states so you can respond appropriately. Baseline CogniSync provides the data to practice this calibration.

### What the Export Contains

Each utterance in the export includes:
- `gaze_analysis`: primary (peak-deviation) direction, NLP code/classification, cognitive type, plus `during_utterance_*` and `pre_speech_*` views, `peak_deviation`, `peak_sample_id`, `peak_vector`, and `variance_x`/`variance_y`.
- `blink_rate_per_minute` : Blink rate within the utterance window
- `pulse_bpm` : Latest stable pulse reading
- `pulse_baseline_bpm` : Established pulse baseline
- `pulse_spike_bpm` : Post-baseline pulse change (if any)
- `hrv_ms` : Latest stable HRV reading
- `talking_detected` : SDK face-based voice-activity boolean for the utterance window
- `talking_stable` : whether the talking state was stable (non-noisy)
- `analysis_status` : Whether cardio baseline was ready

These fields allow you to reconstruct the physiological state of the speaker at each moment of speech, enabling the kind of turn-by-turn analysis that is central to NLP practice.

---

## Prize Categories

### Most Creative or Delightful Use

Baseline CogniSync reframes the NLP approach around what the SmartSpectra SDK can reliably measure in real time using live camera facial and landmark telemetry. Traditional computer vision gaze-trackers rely on iris-to-pupil boundary detection, which can struggle with dark eye pigmentations or low-light conditions. This app is inclusive and works for all pigmentations because it does not rely on eye color. The demo integrates **head direction estimation and blink rate** as primary live signals, mapping facial orientation vectors to proposed behavioral and cognitive categories alongside live speech recognition. By processing everything in real time on the device, the app creates an immediate, interactive feedback loop between spoken language and physiological micro-behaviors.

### Best Thoughtful Real-World Use

Baseline CogniSync can be used as a practice tool for exploring behavioral telemetry and communication patterns. It can also be applied in mock interviews or high-stakes presentation practice to help reviewers analyze cognitive and attentional states while someone is speaking. The session export automatically links subjects and labels them with biometric data alongside precise timestamps. By combining blink rate, pulse, and head pose direction, the tool captures a comprehensive behavioral and physiological profile. The app also logs pulse and HRV as physiological context, providing transparent export data so reviewers can audit exactly what was collected and how it was processed.

## Consent and Data Handling

**Audio and Camera Permissions**

Speech transcription runs locally in the Electron app with a downloaded model; microphone audio is not sent to a cloud service. The first run downloads the model (about 40 MB). The app does not retain data after the session ends. The SDK only needs the MediaStream. The camera preview is purely a consumer of that stream and can be hidden or offscreen. No video, audio, or biometric data is recorded to disk or sent to a cloud service. All processing runs locally on the device. 

**API Key and Exports**
The SmartSpectra SDK runs in-process and uses the Presage API key read from the environment; the key is never stored in the repository or renderer bundle. Session exports are written as JSON files only when the user explicitly clicks "Export JSON" (containing transcript, blink events, pulse/HRV samples, and SDK diagnostics) collected during that session.

<!-- Optional but encouraged: upload your transcript at https://dev.to/agent_sessions/new, curate or slice the parts worth showing, and embed it right here. Supported tools include Claude Code, Gemini CLI, Codex, GitHub Copilot CLI, and Pi. -->
<!-- Sessions are unlisted by default, so hit Make Public before you publish or judges won't be able to open it. Check your transcript for keys and sensitive data first. -->

<!-- Don't forget to add a cover image if you want! -->

<!-- Reminder: Team submissions are not allowed, and each participant may submit only one entry. -->

<!-- Thanks for participating! -->