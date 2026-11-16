from collections.abc import Iterable

from .models import (
    BiometricSample,
    GazeSample,
    Utterance,
    UtteranceAlignment,
)


def align_utterance(
    utterance: Utterance,
    gaze_samples: Iterable[GazeSample],
    biometric_samples: Iterable[BiometricSample],
) -> UtteranceAlignment:
    """Bind samples in the utterance's inclusive timestamp window."""
    start_ms = utterance.timestamp_start_ms
    end_ms = utterance.timestamp_end_ms

    matched_gaze = tuple(
        sorted(
            (sample for sample in gaze_samples if start_ms <= sample.timestamp_ms <= end_ms),
            key=lambda sample: sample.timestamp_ms,
        )
    )
    matched_biometrics = tuple(
        sorted(
            (
                sample
                for sample in biometric_samples
                if start_ms <= sample.timestamp_ms <= end_ms
            ),
            key=lambda sample: sample.timestamp_ms,
        )
    )

    return UtteranceAlignment(
        utterance_id=utterance.utterance_id,
        transcript_text=utterance.transcript_text,
        timestamp_start_ms=start_ms,
        timestamp_end_ms=end_ms,
        gaze_samples=matched_gaze,
        presage_biometrics=matched_biometrics,
    )
