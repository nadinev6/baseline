import json
import unittest

from sensor_alignment import (
    BiometricSample,
    GazeSample,
    Utterance,
    align_utterance,
)


class AlignUtteranceTests(unittest.TestCase):
    def test_includes_samples_at_window_boundaries_and_sorts_them(self) -> None:
        utterance = Utterance("u1", "Hello there.", 100, 200)
        gaze = [
            GazeSample(201, 0.0, 0.0),
            GazeSample(200, 1.0, 2.0),
            GazeSample(100, 3.0, 4.0),
        ]
        biometrics = [
            BiometricSample(150, blink_rate_hz=0.2, hrv_ms=45, pulse_bpm=70),
            BiometricSample(99, pulse_bpm=72),
        ]

        result = align_utterance(utterance, gaze, biometrics)

        self.assertEqual([sample.timestamp_ms for sample in result.gaze_samples], [100, 200])
        self.assertEqual([sample.timestamp_ms for sample in result.presage_biometrics], [150])
        self.assertEqual(result.transcript_text, "Hello there.")

    def test_serializes_as_sensor_alignment_json_without_inferences(self) -> None:
        result = align_utterance(
            Utterance("u2", "A sentence.", 0, 10),
            [GazeSample(5, 0.1, -0.2)],
            [BiometricSample(7, hrv_ms=50)],
        )

        payload = json.loads(result.to_json())

        self.assertEqual(payload["gaze_samples"][0]["x"], 0.1)
        self.assertEqual(payload["presage_biometrics"][0]["hrv_ms"], 50)
        self.assertNotIn("credibility_score", payload)
        self.assertNotIn("dominant_direction", payload)

    def test_rejects_reversed_utterance_window(self) -> None:
        with self.assertRaises(ValueError):
            Utterance("u3", "Invalid.", 10, 9)

    def test_rejects_non_finite_samples(self) -> None:
        with self.assertRaises(ValueError):
            GazeSample(1, float("nan"), 0.0)
        with self.assertRaises(ValueError):
            BiometricSample(1, pulse_bpm=float("inf"))


if __name__ == "__main__":
    unittest.main()
