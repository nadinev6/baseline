from dataclasses import asdict, dataclass
from math import isfinite
from typing import Any


def _validate_timestamp(timestamp_ms: int) -> None:
    if timestamp_ms < 0:
        raise ValueError("timestamps must be non-negative")


@dataclass(frozen=True)
class Utterance:
    utterance_id: str
    transcript_text: str
    timestamp_start_ms: int
    timestamp_end_ms: int

    def __post_init__(self) -> None:
        _validate_timestamp(self.timestamp_start_ms)
        _validate_timestamp(self.timestamp_end_ms)
        if self.timestamp_end_ms < self.timestamp_start_ms:
            raise ValueError("utterance end must not precede its start")


@dataclass(frozen=True)
class GazeSample:
    timestamp_ms: int
    x: float
    y: float
    z: float | None = None

    def __post_init__(self) -> None:
        _validate_timestamp(self.timestamp_ms)
        values = (self.x, self.y) if self.z is None else (self.x, self.y, self.z)
        if not all(isfinite(value) for value in values):
            raise ValueError("gaze vector values must be finite")


@dataclass(frozen=True)
class BiometricSample:
    timestamp_ms: int
    blink_rate_hz: float | None = None
    hrv_ms: float | None = None
    pulse_bpm: float | None = None

    def __post_init__(self) -> None:
        _validate_timestamp(self.timestamp_ms)
        values = (self.blink_rate_hz, self.hrv_ms, self.pulse_bpm)
        if any(value is not None and (not isfinite(value) or value < 0) for value in values):
            raise ValueError("biometric values must be finite and non-negative")


@dataclass(frozen=True)
class UtteranceAlignment:
    utterance_id: str
    transcript_text: str
    timestamp_start_ms: int
    timestamp_end_ms: int
    gaze_samples: tuple[GazeSample, ...]
    presage_biometrics: tuple[BiometricSample, ...]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def to_json(self) -> str:
        import json

        return json.dumps(self.to_dict(), separators=(",", ":"), allow_nan=False)
