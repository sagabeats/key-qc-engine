"""
S-KEY JSON adapter for the Key Detector benchmark UI.

Usage:
    python analyze.py "path\\to\\song.wav" [--device cpu] [--checkpoint path\\to\\model.pt] [--pretty]

Emits ONLY machine-readable JSON on stdout. All logging/warnings go to stderr.

Design notes (verified against the upstream S-KEY source, vendored at engine/skey
-- see engine/UPSTREAM.md for the commit it was taken from):

  * This adapter does NOT reimplement inference. It imports and calls the upstream
    functions directly (load_checkpoint, load_model_components, load_audio, key_map)
    and reproduces `skey.key_detection.infer_key` verbatim:

        new_batch = batch.unsqueeze(0)
        cropped   = crop_fn(hcqt(new_batch), torch.zeros(1))
        out       = chromanet(cropped)
        winner    = key_map[int(torch.mean(out, dim=0).argmax())]

  * ChromaNet.forward already ends with `self.softmax(x / self.temperature)`
    (nn.Softmax(dim=-1), temperature=1). The upstream variable is *named* `logits`
    but the tensor is a probability distribution over all 24 classes. So the score
    that selects the key is a PROBABILITY -> scoreType = "probability".

  * The true pre-softmax values (output of the final `flatten`, i.e. after
    classifier -> batch_norm) are captured with a forward hook so raw logits are
    preserved alongside the probabilities. Nothing is recomputed or re-normalised.

  * Aggregation is upstream's own: the whole file is one batch item; ChromaNet's
    AdaptiveAvgPool2d((12, 1)) collapses the time axis internally, and
    `torch.mean(..., dim=0)` averages over the batch dim (size 1, a no-op here).
    No new aggregation scheme is introduced.

  * Class order is the flatten of (B, 2, 12, 1) -> index = channel * 12 + pitch,
    channel 0 = Major, channel 1 = minor, exactly as upstream's `key_map`.
"""

import argparse
import contextlib
import io
import json
import os
import sys
import time
import traceback
from pathlib import Path

ENGINE = "skey"
PIPELINE_VERSION = "skey-v1"


def _fail(message: str, detail: str | None = None) -> None:
    """Emit a JSON error object on stdout and exit non-zero."""
    payload = {
        "engine": ENGINE,
        "pipelineVersion": PIPELINE_VERSION,
        "ok": False,
        "error": message,
    }
    if detail:
        payload["errorDetail"] = detail
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.stdout.flush()
    sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser(description="S-KEY JSON adapter (stdout = JSON only)")
    parser.add_argument("audio", help="Path to a single audio file")
    parser.add_argument("--device", default="cpu", help="Computation device (default: cpu)")
    parser.add_argument("--checkpoint", default=None, help="Path to model checkpoint (.pt). Default S-KEY model if omitted.")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print the JSON")
    parser.add_argument(
        "--skey-root",
        default=None,
        help="Path to the S-KEY repo root (only needed if `skey` is not importable)",
    )
    args = parser.parse_args()

    audio_path = Path(args.audio)
    if not audio_path.exists():
        _fail(f"Audio file not found: {audio_path}")
    if not audio_path.is_file():
        _fail(f"Not a file (this adapter analyses one file at a time): {audio_path}")

    if args.skey_root:
        sys.path.insert(0, str(Path(args.skey_root)))

    started = time.time()

    # Keep stdout pristine: every import / model-load side effect is redirected to stderr.
    noise = io.StringIO()
    try:
        with contextlib.redirect_stdout(sys.stderr):
            import torch

            from skey.key_detection import (
                DEFAULT_CHECKPOINT_PATH,
                key_map,
                load_audio,
                load_checkpoint,
                load_model_components,
            )
    except Exception as exc:  # noqa: BLE001
        _fail(f"Failed to import S-KEY: {exc}", traceback.format_exc())

    del noise

    if args.device != "cpu":
        _fail("This adapter is CPU-only for now; omit --device or pass --device cpu.")

    ckpt_path = Path(args.checkpoint) if args.checkpoint else DEFAULT_CHECKPOINT_PATH

    try:
        with contextlib.redirect_stdout(sys.stderr):
            torch.manual_seed(0)  # inference is deterministic anyway; pinned for reproducibility
            device = torch.device("cpu")

            ckpt = load_checkpoint(ckpt_path)
            sr = ckpt["audio"]["sr"]
            hcqt, chromanet, crop_fn = load_model_components(ckpt, device)

            # --- capture the pre-softmax 24-vector -------------------------------
            # ChromaNet.forward: ... -> classifier -> batch_norm -> flatten -> softmax
            # so the output of `flatten` is exactly the softmax input (temperature = 1).
            captured: dict[str, "torch.Tensor"] = {}

            def _grab(_module, _inputs, output):
                captured["preSoftmax"] = output.detach().clone()

            handle = chromanet.flatten.register_forward_hook(_grab)

            # --- upstream infer_key(), verbatim ----------------------------------
            waveform = load_audio(str(audio_path), sr).to(device)
            n_samples = int(waveform.shape[-1])

            with torch.no_grad():
                new_batch = waveform.unsqueeze(0).to(device)
                cropped = crop_fn(hcqt(new_batch), torch.zeros(1).to(device))
                model_out = chromanet(cropped)  # (B, 24) -- ALREADY softmaxed upstream
                probs = torch.mean(model_out, dim=0)  # upstream aggregation over batch dim
                winner_index = int(probs.argmax())

            handle.remove()

            pre_softmax = captured["preSoftmax"]
            logits = torch.mean(pre_softmax, dim=0)  # same aggregation, applied to raw logits

            # Sanity: confirm the captured tensor really is the softmax input.
            recomputed = torch.softmax(pre_softmax / chromanet.temperature, dim=-1)
            softmax_matches = bool(torch.allclose(recomputed, model_out, atol=1e-6))
            prob_sum = float(probs.sum())
    except Exception as exc:  # noqa: BLE001
        _fail(f"S-KEY inference failed: {exc}", traceback.format_exc())

    if len(key_map) != 24 or int(probs.shape[-1]) != 24:
        _fail(f"Unexpected class count: model={int(probs.shape[-1])}, key_map={len(key_map)}")

    prob_list = [float(v) for v in probs.tolist()]
    logit_list = [float(v) for v in logits.tolist()]

    ordered = sorted(range(24), key=lambda i: prob_list[i], reverse=True)
    candidates = [
        {
            "rank": rank,
            "key": key_map[idx],
            "score": prob_list[idx],
            "probability": prob_list[idx],
            "logit": logit_list[idx],
            "classIndex": idx,
        }
        for rank, idx in enumerate(ordered, start=1)
    ]

    result = {
        "engine": ENGINE,
        "pipelineVersion": PIPELINE_VERSION,
        "ok": True,
        "winner": key_map[winner_index],
        "winnerScore": prob_list[winner_index],
        "scoreType": "probability",
        "candidates": candidates,
        "meta": {
            "scoreSource": "ChromaNet.forward output (post-softmax), averaged over batch dim as in skey.key_detection.infer_key",
            "softmaxAppliedInModel": True,
            "temperature": float(chromanet.temperature),
            "logitSource": "ChromaNet.flatten output (post classifier + batch_norm, pre-softmax)",
            "logitsPreserved": True,
            "softmaxOfLogitsMatchesModelOutput": softmax_matches,
            "probabilitySum": prob_sum,
            "classOrder": "flatten of (B, 2, 12, 1): index = channel*12 + pitch; channel 0 = Major, channel 1 = minor (skey.key_detection.key_map)",
            "classCount": 24,
            "aggregation": "upstream only: AdaptiveAvgPool2d((12,1)) over time inside ChromaNet, then torch.mean(dim=0) over the batch dim (size 1)",
            "winnerClassIndex": winner_index,
            "device": "cpu",
            "sampleRate": int(sr),
            "samples": n_samples,
            "durationSeconds": n_samples / float(sr),
            "checkpoint": str(ckpt_path),
            "torchVersion": torch.__version__,
            "audioPath": str(audio_path),
            "audioFileName": audio_path.name,
            "elapsedSeconds": time.time() - started,
        },
    }

    json.dump(result, sys.stdout, ensure_ascii=False, indent=2 if args.pretty else None)
    sys.stdout.write("\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
