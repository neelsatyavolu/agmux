"""Install agmux's observer, then preserve the original Python startup hook."""
from agmux_hermes_provenance import install
install()

import importlib.machinery
import importlib.util
from pathlib import Path
import sys

_own_directory = Path(__file__).resolve().parent
_original_paths = [p for p in sys.path if Path(p or '.').resolve() != _own_directory]
_original_spec = importlib.machinery.PathFinder.find_spec('sitecustomize', _original_paths)
if _original_spec is not None and _original_spec.loader is not None:
    _original_module = importlib.util.module_from_spec(_original_spec)
    sys.modules['sitecustomize'] = _original_module
    _original_spec.loader.exec_module(_original_module)
