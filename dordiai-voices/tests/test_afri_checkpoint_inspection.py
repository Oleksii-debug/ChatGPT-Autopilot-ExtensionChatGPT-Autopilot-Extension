"""Bounded safetensors-header observation, without downloading tensor weights."""
import importlib.util
import io
import json
from pathlib import Path
import struct
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("afri_checkpoint_inspector", ROOT / "tools/research/inspect_afri_checkpoint.py")
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


class Response(io.BytesIO):
    status = 206
    headers = {"Content-Range": "bytes 0-999/2000"}


class HeaderTests(unittest.TestCase):
    def test_counts_only_explicit_flow_lm_block_prefixes(self):
        header = {"__metadata__": {"format": "pt"},
                  "flow_lm.transformer.layers.0.self_attn.weight": {"shape": [2, 2], "dtype": "F32", "data_offsets": [0, 16]},
                  "flow_lm.transformer.layers.5.self_attn.weight": {"shape": [2, 2], "dtype": "F32", "data_offsets": [16, 32]},
                  "mimi.transformer.layers.23.weight": {"shape": [1], "dtype": "F32", "data_offsets": [32, 36]}}
        raw = json.dumps(header).encode("utf-8")
        with patch.object(tool, "urlopen", return_value=Response(struct.pack("<Q", len(raw)) + raw)):
            result = tool.checkpoint_header({"sha256": "declared-only"}, "https://example.invalid/pinned")
        self.assertEqual(result["strict_flow_lm_layer_ids"], [0, 5])
        self.assertEqual(result["parameter_count_from_header_shapes"], 9)
        self.assertFalse(result["full_checkpoint_sha256_verified"])
        self.assertEqual(result["only_header_received_bytes"], len(raw) + 8)

    def test_oversized_header_is_rejected_before_payload_read(self):
        with patch.object(tool, "urlopen", return_value=Response(struct.pack("<Q", 3 * 1024 * 1024))):
            with self.assertRaises(ValueError):
                tool.checkpoint_header({}, "https://example.invalid/pinned")

    def test_nonzero_range_start_cannot_be_misread_as_file_header(self):
        response = Response(b"does not matter")
        response.headers = {"Content-Range": "bytes 100-200/2000"}
        with patch.object(tool, "urlopen", return_value=response), self.assertRaises(ValueError):
            tool.checkpoint_header({}, "https://example.invalid/pinned")


if __name__ == "__main__":
    unittest.main()
