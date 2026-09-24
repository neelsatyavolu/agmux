"""agmux runtime limits for mlx_lm.server (0.31 has no --kv-bits flag, and its
prompt-cache byte cap is only enforced on the batched path).

Loaded because agmux prepends this directory to PYTHONPATH for every backend
spawn. Empty / missing env vars are a no-op.

Deliberately NOT applied: a rotating `max_kv_size` window. Agent harnesses
send 15-30K-token prompts (system prompt + tool schemas first), and a
rotating cache silently drops that head, so the model never sees its
instructions. Rotated caches also cannot be trimmed, which defeats prefix
reuse, and mlx-lm cannot quantize them at all. Context length is bounded by
the window agmux declares to each harness instead, so they compact in time.
"""
from __future__ import annotations

import importlib
import os


def _int_env(name: str):
    raw = os.environ.get(name, "").strip()
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


KV_BITS = _int_env("AGMUX_MLX_KV_BITS")
PROMPT_CACHE_BYTES = _int_env("AGMUX_MLX_PROMPT_CACHE_BYTES")


def _apply() -> None:
    if KV_BITS is None and PROMPT_CACHE_BYTES is None:
        return

    # `import mlx_lm.generate as generate` binds the package attribute, which
    # is the `generate` *function* re-exported by mlx_lm/__init__.py, not the
    # submodule. import_module returns the module from sys.modules.
    generate = importlib.import_module("mlx_lm.generate")
    cache = importlib.import_module("mlx_lm.models.cache")
    # `python -m mlx_lm.server` runs server.py as `__main__`, a fresh module
    # that imports these names from `mlx_lm.models.cache` when it starts — so
    # patching `cache` is what takes effect. `server` covers the
    # `python -m mlx_lm server` entry point, which imports the real module.
    server = importlib.import_module("mlx_lm.server")

    if KV_BITS is not None:
        orig_make = cache.make_prompt_cache

        def make_prompt_cache(model, *args, **kwargs):
            built = orig_make(model, *args, **kwargs)
            generate.maybe_quantize_kv_cache(
                built,
                quantized_kv_start=0,
                kv_group_size=64,
                kv_bits=KV_BITS,
            )
            return built

        cache.make_prompt_cache = make_prompt_cache
        server.make_prompt_cache = make_prompt_cache

    if PROMPT_CACHE_BYTES is not None:
        orig_lru = cache.LRUPromptCache

        class BoundedPromptCache(orig_lru):
            def __init__(self, max_size=10, max_bytes=None):
                if max_bytes is None or max_bytes > PROMPT_CACHE_BYTES:
                    max_bytes = PROMPT_CACHE_BYTES
                super().__init__(max_size=max_size, max_bytes=max_bytes)

        cache.LRUPromptCache = BoundedPromptCache
        server.LRUPromptCache = BoundedPromptCache


try:
    _apply()
except Exception as exc:  # noqa: BLE001
    # Never block server startup if a future mlx-lm rename breaks the patch,
    # but say so: a silent miss here once hid a crash behind a healthy port.
    import sys

    print(f"agmux sitecustomize: limits not applied: {exc!r}", file=sys.stderr)
