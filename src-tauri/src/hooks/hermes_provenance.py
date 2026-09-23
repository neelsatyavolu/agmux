"""Observe Hermes session creation before its late plugin discovery.

Loaded by agmux's private sitecustomize directory, never installed into Hermes.
No transcript/history/cwd/time inference: evidence is a committed create_session
insertion, checked inside Hermes's own BEGIN IMMEDIATE transaction.
"""
import functools
import importlib.abc
import importlib.machinery
import inspect
import json
import os
import math
import re
import time
import socket
import sqlite3
import sys
import threading

_created = set()


def usage_owner(root, relay_owner, session_id, exact=False):
    """Match the ledger key to the immutable registry's exact native owner.

    New sessions inside imported tabs have independent self-origins. Keep the
    old relay key when proof is absent; the consumer still excludes unknown IDs.
    """
    from contextlib import closing
    try:
        with closing(sqlite3.connect((root / "agmux.db").as_uri() + "?mode=ro", uri=True, timeout=1)) as db:
            row = db.execute("""SELECT b.owner_id FROM session_origin_bindings b
                JOIN session_origins o ON o.provider=b.provider AND o.owner_id=b.owner_id
                WHERE b.provider='Hermes' AND b.session_id=? AND o.created_in_agmux=1""",
                (session_id,)).fetchone()
        return row[0] if row else (None if exact else relay_owner)
    except (OSError, sqlite3.Error):
        return None if exact else relay_owner


_pending = {}
_pending_lock = threading.Lock()
_pending_worker = False


def _deliver_usage(item):
    root, relay, data, writer = item
    owner = usage_owner(root, relay, data["session_id"], exact=True)
    if owner is None:
        return False
    writer(root, owner, data)
    # The existing writer deliberately returns no success value. Verify its
    # idempotency key before dropping a buffered record (including busy DBs).
    from contextlib import closing
    try:
        with closing(sqlite3.connect((root / "teams/hermes-usage.sqlite").as_uri() + "?mode=ro", uri=True, timeout=1)) as db:
            return db.execute("SELECT 1 FROM hermes_api_usage WHERE owner_id=? AND session_id=? AND api_request_id=?",
                              (owner, data["session_id"], data["api_request_id"])).fetchone() is not None
    except (OSError, sqlite3.Error):
        return False


def _flush_pending_usage():
    with _pending_lock:
        items = list(_pending.items())
    for key, item in items:
        if _deliver_usage(item):
            with _pending_lock:
                if _pending.get(key) is item:
                    _pending.pop(key, None)


def _drain_usage():
    global _pending_worker
    delay = 0.05
    while True:
        _flush_pending_usage()
        with _pending_lock:
            if not _pending:
                _pending_worker = False
                return
        time.sleep(delay)
        delay = min(delay * 2, 2)


def persist_usage_when_owned(root, relay, payload, writer, created=False):
    """Buffer only normalized counters while explicit proof is being admitted.

    The buffer is process-local; it covers the async socket/registry race and
    transient busy writes. It cannot recover a process killed before admission.
    """
    global _pending_worker
    keys = ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens")
    usage = payload.get("usage")
    if not isinstance(usage, dict):
        return
    data = {key: payload.get(key) for key in ("session_id", "api_request_id", "ended_at", "model")}
    if any(not isinstance(data[key], str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,256}", data[key])
           for key in ("session_id", "api_request_id")):
        return
    model = data["model"]
    if not isinstance(model, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}(?:/[A-Za-z0-9][A-Za-z0-9_.:-]{0,127})?", model):
        return
    at = data["ended_at"]
    if type(at) not in (int, float) or not math.isfinite(at) or at <= 0:
        return
    if any(type(usage.get(key)) is not int or not 0 <= usage[key] <= 2**63 - 1 for key in keys):
        return
    data["usage"] = {key: usage[key] for key in keys}
    if not created and usage_owner(root, relay, data["session_id"], exact=True) is None:
        return  # Unknown outside resume: not even a provisional creation.
    item = (root, relay, data, writer)
    if _deliver_usage(item):
        return
    with _pending_lock:
        _pending[(str(root), data["session_id"], data["api_request_id"])] = item
        if _pending_worker:
            return
        _pending_worker = True
        threading.Thread(target=_drain_usage, name="agmux-hermes-usage", daemon=True).start()


def creation_proof(session_id):
    return "hermes-create-session" if session_id in _created else None


def _emit(session_id):
    owner = os.environ.get("AGMUX_SESSION_ID") or os.environ.get("AGMUX_THREAD_ID")
    path = os.environ.get("AGMUX_HOOK_SOCKET")
    if not owner or not path:
        return
    message = {"event": "session-start", "session_id": owner, "provider": "hermes",
               "payload": {"session_id": session_id, "agmux_creation": creation_proof(session_id),
                           "agmux_provenance_only": True}}
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(2)
            connection.connect(path)
            connection.sendall((json.dumps(message) + "\n").encode())
    except OSError:
        pass  # The plugin repeats this exact native proof on later hooks.


def observe_session_db(cls, report=_emit):
    if cls is None:
        return False
    if getattr(cls, "_agmux_creation_observer", False):
        return True
    original_create = getattr(cls, "create_session", None)
    original_write = getattr(cls, "_execute_write", None)
    if not inspect.isfunction(original_create) or not inspect.isfunction(original_write):
        return False
    try:
        create_signature = inspect.signature(original_create)
        write_signature = inspect.signature(original_write)
    except (TypeError, ValueError):
        return False
    write_parameters = list(write_signature.parameters.values())
    if "session_id" not in create_signature.parameters or len(write_parameters) != 2:
        return False
    active = threading.local()

    @functools.wraps(original_create)
    def create(self, *args, **kwargs):
        try:
            session_id = create_signature.bind(self, *args, **kwargs).arguments.get("session_id")
        except TypeError:
            return original_create(self, *args, **kwargs)
        if not isinstance(session_id, str):
            return original_create(self, *args, **kwargs)
        previous = getattr(active, "session_id", None)
        active.session_id = session_id
        try:
            return original_create(self, *args, **kwargs)
        finally:
            active.session_id = previous

    @functools.wraps(original_write)
    def write(self, *args, **kwargs):
        sid = getattr(active, "session_id", None)
        if sid is None:
            return original_write(self, *args, **kwargs)
        try:
            bound = write_signature.bind(self, *args, **kwargs)
        except TypeError:
            return original_write(self, *args, **kwargs)
        operation_key = write_parameters[1].name
        operation = bound.arguments.get(operation_key)
        if not callable(operation):
            return original_write(self, *args, **kwargs)
        inserted = False

        def observed(connection):
            nonlocal inserted
            inserted = False  # Reset on the native writer's transaction retry.
            try:
                before = connection.execute("SELECT 1 FROM sessions WHERE id=?", (sid,)).fetchone()
            except (sqlite3.Error, AttributeError, TypeError):
                return operation(connection)
            result = operation(connection)
            try:
                inserted = before is None and connection.execute(
                    "SELECT 1 FROM sessions WHERE id=?", (sid,)).fetchone() is not None
            except (sqlite3.Error, AttributeError, TypeError):
                inserted = False
            return result

        bound.arguments[operation_key] = observed
        result = original_write(*bound.args, **bound.kwargs)  # Only after COMMIT.
        if inserted:
            _created.add(sid)
            report(sid)
        return result

    cls.create_session = create
    cls._execute_write = write
    cls._agmux_creation_observer = True
    return True


def install():
    if os.environ.get("AGMUX_PROVIDER") != "hermes":
        return
    if "hermes_state" in sys.modules:
        observe_session_db(getattr(sys.modules["hermes_state"], "SessionDB", None))
        return

    class Finder(importlib.abc.MetaPathFinder):
        def find_spec(self, fullname, path=None, target=None):
            if fullname != "hermes_state":
                return None
            spec = importlib.machinery.PathFinder.find_spec(fullname, path)
            if spec is None or spec.loader is None:
                return None
            original = spec.loader

            class Loader(importlib.abc.Loader):
                def create_module(self, spec):
                    create = getattr(original, "create_module", None)
                    return create(spec) if create else None

                def exec_module(self, module):
                    original.exec_module(module)
                    observe_session_db(getattr(module, "SessionDB", None))

            spec.loader = Loader()
            return spec

    if not any(getattr(f, "_agmux_hermes", False) for f in sys.meta_path):
        finder = Finder()
        finder._agmux_hermes = True
        sys.meta_path.insert(0, finder)
