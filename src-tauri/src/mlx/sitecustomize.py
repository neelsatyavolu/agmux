"""Apply catalog KV limits to mlx_lm.server (0.31 has no --kv-bits / --max-kv-size).

Loaded only when agmux prepends this directory to PYTHONPATH for a backend
spawn that has catalog limits. Empty / missing env vars are a no-op.
"""
from __future__ import annotations

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
MAX_KV_SIZE = _int_env("AGMUX_MLX_MAX_KV_SIZE")


def _apply() -> None:
    if KV_BITS is None and MAX_KV_SIZE is None:
        return

    import mlx_lm.generate as generate
    import mlx_lm.models.cache as cache
    import mlx_lm.server as server

    orig_make = cache.make_prompt_cache

    def make_prompt_cache(model, max_kv_size=None, *args, **kwargs):
        if max_kv_size is None:
            max_kv_size = MAX_KV_SIZE
        built = orig_make(model, max_kv_size=max_kv_size, *args, **kwargs)
        if KV_BITS is not None:
            generate.maybe_quantize_kv_cache(
                built,
                quantized_kv_start=0,
                kv_group_size=64,
                kv_bits=KV_BITS,
            )
        return built

    cache.make_prompt_cache = make_prompt_cache
    server.make_prompt_cache = make_prompt_cache

    orig_stream = generate.stream_generate

    def stream_generate(*args, **kwargs):
        if kwargs.get("kv_bits") is None and KV_BITS is not None:
            kwargs["kv_bits"] = KV_BITS
        if kwargs.get("max_kv_size") is None and MAX_KV_SIZE is not None:
            kwargs["max_kv_size"] = MAX_KV_SIZE
        return orig_stream(*args, **kwargs)

    generate.stream_generate = stream_generate
    server.stream_generate = stream_generate

    orig_init = generate.BatchGenerator.__init__

    def batch_init(self, model, *args, **kwargs):
        if kwargs.get("max_kv_size") is None and MAX_KV_SIZE is not None:
            kwargs["max_kv_size"] = MAX_KV_SIZE
        return orig_init(self, model, *args, **kwargs)

    generate.BatchGenerator.__init__ = batch_init


try:
    _apply()
except Exception:
    # Never block server startup if a future mlx-lm rename breaks the patch.
    pass
