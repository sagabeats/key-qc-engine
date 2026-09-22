# Vendored S-KEY engine

`engine/skey/` is a **verbatim copy** of the inference subset of the upstream
S-KEY package. Nothing in it has been edited. Key QC depends on this copy and
on no checkout outside this repository.

## Provenance

| | |
| --- | --- |
| Upstream | https://github.com/deezer/skey |
| Commit | `918b83d273568d5041569bb8068843d19a335726` |
| License | MIT — Copyright (c) 2019-present, Deezer SA (`engine/LICENSE`) |
| Paper | Kong et al., *S-KEY: Self-supervised Learning of Major and Minor Keys from Audio*, ICASSP 2025 |

## What was copied, and what was not

Copied — everything the model needs to run:

```
engine/skey/__init__.py
engine/skey/chromanet.py
engine/skey/cli.py
engine/skey/convnext.py
engine/skey/hcqt.py
engine/skey/key_detection.py
engine/skey/models/skey.pt      the pretrained ChromaNet checkpoint (765 KB)
engine/LICENSE                  upstream MIT license, verbatim
```

Left behind — not reachable from inference:

```
training_utils/    upstream states it is unused for inference (retraining only)
tests/             test suite and its audio fixture
Dockerfile         upstream's own container build
pyproject.toml     upstream packaging; this copy is imported by path, not installed
poetry.lock        superseded by requirements.txt below
```

The upstream README's own "Code organization" section is the source for that
split: it marks `training_utils/` as *not used in the `skey` package for
inference*.

## Integrity

These are the checksums of the copied files. They are the upstream bytes at the
commit above, and they are what the benchmark numbers in `benchmark-data/` were
produced with.

```
19741849ac5784779ac8970e26fa72cf05d04b22f79d5e949f9ae5ebcf8da055  skey/__init__.py
2d2d5dcbf05cb5fb61c024cd75c3e34b8041000100a7ed4812c872702f62ce3e  skey/chromanet.py
8a8344d87595d9b10e420a2b007d7967f37bae6408530cda837d7e7e5bc5b0b5  skey/cli.py
4bd29a94c24ab60f00bd14891959e39160b17e30f0b4c4a48147c2258a7ef9b0  skey/convnext.py
764aa8c3fea2a59e2f88f426506dc20eb3d3c6a56c002509aaf5dd8f316dc932  skey/hcqt.py
4c21564863f1ecd26a97d341f9f3e682126e4ebc25c1325f8a78d4c6305b598b  skey/key_detection.py
78dfd0ad4fa9434bf7cec70a25934b7c575bda9c80e994700140770ad3a5ead4  skey/models/skey.pt
c31e66d430753e96594714e6a473de791017edb0fa8318023c54de54e0a21248  LICENSE
```

Verify at any time (from the repository root):

```bash
sha256sum engine/skey/*.py engine/skey/models/skey.pt engine/LICENSE
```

## License obligations

The MIT license permits vendoring. It requires one thing: the copyright notice
and the permission notice must travel with the code. `engine/LICENSE` is that
notice, copied unaltered, and it must stay next to `engine/skey/`.

If you redistribute the Key Detector outside the company, `engine/LICENSE` goes
with it. If you publish research using this engine, cite the ICASSP 2025 paper
above.

## How the engine is reached

`skey-adapter/analyze.py` is passed `--skey-root <repo>/engine`, so Python
imports `skey` from this directory. The checkpoint resolves itself relative to
the package (`Path(__file__).parent / "models/skey.pt"` in `key_detection.py`),
so the vendored copy loads the vendored weights with no path configuration.

## Updating this copy

Re-copy the seven files from a fresh upstream checkout, record the new commit
and checksums here, then re-run the benchmark before trusting any number: a
different engine build is a different dataset, not a patch to this one.
