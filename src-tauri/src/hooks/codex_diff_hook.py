"""Synchronous Codex execution-boundary snapshots; no DB or transcript writes.

Install under ~/.agmux/hooks and invoke for PreToolUse/PostToolUse (not async).
Only literal, supported commands are candidates. Python is parsed, never run.
Completed records contain measured stats only; the parent owns their import.
"""
import ast
import ctypes
import datetime
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys
import tempfile
import time


MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024
MAX_COMMAND_BYTES = 256 * 1024
MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024
MAX_COMPLETED_BYTES = 256 * 1024
MAX_TARGETS = 64
MAX_TOOLS = 2048
MAX_PENDING = 32
LOCK_WAIT_SECONDS = 4.0
PENDING_TTL = 3600
HANDLED_TTL = 86400
COMPLETED_TTL = 7 * 86400


class Unsupported(ValueError):
    pass


class CaptureTargets(set):
    def __init__(self, values=(), wide=False):
        super().__init__(values)
        self.wide = wide


class PythonWrites:
    """Track literal bindings in straight-line code, never interpret content."""
    def __init__(self, inputs=None):
        self.bindings = {}
        self.paths = set()
        self.remaining_statements = 512
        self.inputs = inputs if inputs is not None else []
        self.manifests = {}

    def value(self, node):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return ('str', node.value)
        if isinstance(node, ast.Name):
            return self.bindings.get(node.id)
        if isinstance(node, ast.Attribute) and node.attr == 'parent':
            base = self.value(node.value)
            if base and base[0] == 'path':
                return ('path', str(Path(base[1]).parent))
        if isinstance(node, (ast.List, ast.Tuple)) and len(node.elts) <= 64:
            values = [self.value(item) for item in node.elts]
            if all(value and value[0] == 'str' for value in values):
                return ('sequence', tuple(values))
        if isinstance(node, ast.Subscript):
            sequence = self.value(node.value)
            index = node.slice
            if (sequence and sequence[0] == 'sequence' and isinstance(index, ast.Constant)
                    and type(index.value) is int and 0 <= index.value < len(sequence[1])):
                return sequence[1][index.value]
        if isinstance(node, ast.BinOp):
            left, right = self.value(node.left), self.value(node.right)
            if left and right:
                if isinstance(node.op, ast.Add) and left[0] == right[0] == 'str':
                    return ('str', left[1] + right[1])
                if isinstance(node.op, ast.Add) and left[0] == right[0] == 'sequence' and len(left[1]) + len(right[1]) <= 64:
                    return ('sequence', left[1] + right[1])
                if isinstance(node.op, ast.Div) and left[0] == 'path' and right[0] in ('str', 'path'):
                    return ('path', str(Path(left[1]) / right[1]))
        if isinstance(node, ast.Call) and self.is_path(node.func):
            parts = [self.value(arg) for arg in node.args]
            if parts and all(part and part[0] in ('str', 'path') for part in parts) and not node.keywords:
                return ('path', str(Path(*(part[1] for part in parts))))
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and self.value(node.func.value) == ('module', 'json') and node.func.attr == 'loads'):
            return self.manifest(node)
        return None

    def manifest(self, node):
        if len(node.args) != 1 or node.keywords:
            raise Unsupported()
        read = node.args[0]
        if (not isinstance(read, ast.Call) or not isinstance(read.func, ast.Attribute)
                or read.func.attr != 'read_text' or read.args or read.keywords):
            raise Unsupported()
        source = self.value(read.func.value)
        if not source or source[0] != 'path' or not Path(source[1]).is_absolute():
            raise Unsupported()
        path = source[1]
        if path not in self.manifests:
            data = _read_patch(path)
            if len(data) > 64 * 1024:
                raise Unsupported()
            names = json.loads(data)
            if (not isinstance(names, list) or len(names) > 64
                    or not all(isinstance(name, str) and 0 < len(name) <= 4096
                               and '\x00' not in name and not Path(name).is_absolute()
                               and '..' not in Path(name).parts for name in names)):
                raise Unsupported()
            self.manifests[path] = ('sequence', tuple(('str', name) for name in names))
            self.inputs.append({'path': path, 'sha256': hashlib.sha256(data).hexdigest()})
        return self.manifests[path]

    def is_path(self, node):
        if isinstance(node, ast.Name):
            return self.bindings.get(node.id) == ('constructor', 'Path')
        return (isinstance(node, ast.Attribute) and node.attr == 'Path'
                and isinstance(node.value, ast.Name)
                and self.bindings.get(node.value.id) == ('module', 'pathlib'))

    def is_open(self, node):
        return isinstance(node, ast.Name) and node.id == 'open' and node.id not in self.bindings

    def open_target(self, call, receiver=None):
        keywords = {kw.arg: kw.value for kw in call.keywords}
        if None in keywords or 'opener' in keywords:
            raise Unsupported()
        args = call.args
        target = receiver or self.value(args[0] if args else keywords.get('file'))
        mode_index = 0 if receiver else 1
        mode = self.value(args[mode_index] if len(args) > mode_index
                          else keywords.get('mode', ast.Constant(value='r')))
        if not mode or mode[0] != 'str' or not re.fullmatch(r'[rwax][bt]?\+?|[rwax]\+[bt]?', mode[1]):
            raise Unsupported()
        if mode[1][0] != 'r' or '+' in mode[1]:
            if not target or target[0] not in ('str', 'path'):
                raise Unsupported()
            self.paths.add(target[1])
        return ('handle', '')

    def expression(self, node):
        if node is None:
            return
        # Strings (including quoted code examples) are leaves in the AST.
        for child in ast.iter_child_nodes(node):
            self.expression(child)
        if isinstance(node, (ast.Lambda, ast.NamedExpr, ast.ListComp, ast.SetComp,
                             ast.DictComp, ast.GeneratorExp, ast.Await, ast.Yield)):
            raise Unsupported()
        if not isinstance(node, ast.Call):
            return
        if self.is_path(node.func):
            return
        if self.is_open(node.func):
            self.open_target(node)
            return
        if isinstance(node.func, ast.Attribute):
            receiver = self.value(node.func.value)
            method = node.func.attr
            if receiver == ('module', 'json') and method == 'loads':
                self.manifest(node)
                return
            if receiver == ('module', 'shutil') and method in ('copyfile', 'copy', 'copy2'):
                args = [self.value(arg) for arg in node.args]
                if (len(args) != 2 or node.keywords
                        or not all(arg and arg[0] in ('str', 'path') and Path(arg[1]).is_absolute() for arg in args)
                        or Path(args[1][1]).is_dir()):
                    raise Unsupported()
                self.paths.add(args[1][1])
                return
            if method == 'mkdir' and receiver and receiver[0] == 'path':
                if node.args or any(kw.arg not in ('parents', 'exist_ok') or not isinstance(kw.value, ast.Constant)
                                    or type(kw.value.value) is not bool for kw in node.keywords):
                    raise Unsupported()
                return
            if receiver == ('module', 're') and method == 'sub':
                keywords = {kw.arg: kw.value for kw in node.keywords}
                replacement = self.value(node.args[1] if len(node.args) > 1 else keywords.get('repl'))
                # Callable replacements can write or change bindings/cwd.
                # Literal replacement text is a pure content transformation.
                if any(isinstance(arg, ast.Starred) for arg in node.args) or None in keywords or not replacement or replacement[0] != 'str':
                    raise Unsupported()
                return
            if method in ('write_text', 'write_bytes', 'open'):
                if not receiver or receiver[0] != 'path':
                    raise Unsupported()
                if method == 'open':
                    self.open_target(node, receiver)
                else:
                    self.paths.add(receiver[1])
                return
            if method == 'exists' and receiver and receiver[0] == 'path' and not node.args and not node.keywords:
                return
            if method in ('write', 'writelines', 'close', 'flush'):
                base = node.func.value
                handle = isinstance(base, ast.Name) and self.bindings.get(base.id) == ('handle', '')
                if isinstance(base, ast.Call):
                    handle = self.is_open(base.func) or (
                        isinstance(base.func, ast.Attribute) and base.func.attr == 'open'
                        and self.value(base.func.value) and self.value(base.func.value)[0] == 'path')
                if not handle:
                    raise Unsupported()
                return
            if method in ('read', 'readlines', 'readline', 'read_text', 'read_bytes',
                          'replace', 'index', 'split', 'splitlines', 'join', 'strip', 'lstrip',
                          'rstrip', 'encode', 'decode', 'format', 'upper', 'lower'):
                return
        if isinstance(node.func, ast.Name) and node.func.id in (
                'print', 'len', 'str', 'bytes', 'RuntimeError', 'ValueError', 'Exception', 'SystemExit'):
            if node.func.id not in self.bindings:
                return
        raise Unsupported()

    def assignment_value(self, node):
        if isinstance(node, ast.Call):
            if self.is_open(node.func):
                return ('handle', '')
            if isinstance(node.func, ast.Attribute) and node.func.attr == 'open':
                return ('handle', '')
        return self.value(node)

    def abort_guard(self, node):
        return (isinstance(node, ast.If) and not node.orelse and len(node.body) == 1
                and isinstance(node.body[0], ast.Raise) and isinstance(node.test, ast.Call)
                and isinstance(node.test.func, ast.Attribute) and node.test.func.attr == 'exists')

    def statements(self, statements):
        for node in statements:
            self.remaining_statements -= 1
            if self.remaining_statements < 0:
                raise Unsupported()
            if isinstance(node, ast.ImportFrom) and node.module == 'pathlib' and node.level == 0:
                for alias in node.names:
                    if alias.name != 'Path':
                        raise Unsupported()
                    self.bindings[alias.asname or alias.name] = ('constructor', 'Path')
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name not in ('pathlib', 're', 'json', 'shutil'):
                        raise Unsupported()
                    self.bindings[alias.asname or alias.name] = ('module', alias.name)
            elif isinstance(node, (ast.Assign, ast.AnnAssign)):
                self.expression(node.value)
                value = self.assignment_value(node.value)
                for target in node.targets if isinstance(node, ast.Assign) else [node.target]:
                    if not isinstance(target, ast.Name):
                        raise Unsupported()
                    self.bindings[target.id] = value
            elif isinstance(node, ast.AugAssign) and isinstance(node.op, ast.Add):
                if not isinstance(node.target, ast.Name):
                    raise Unsupported()
                previous = self.bindings.get(node.target.id)
                if previous and previous[0] == 'sequence':
                    raise Unsupported()  # Lists can mutate through aliases.
                self.expression(node.value)
                # Keep literal path concatenation, but invalidate unknown
                # content instead of retaining the target's previous binding.
                self.bindings[node.target.id] = self.value(ast.BinOp(
                    left=node.target, op=node.op, right=node.value))
            elif isinstance(node, ast.For):
                self.expression(node.iter)
                sequence = self.value(node.iter)
                guarded_raises = {id(child.body[0]) for child in ast.walk(node)
                                  if self.abort_guard(child)}
                if (not isinstance(node.target, ast.Name) or not sequence or sequence[0] != 'sequence'
                        or node.orelse or any(isinstance(child, (ast.Break, ast.Continue))
                                             or isinstance(child, ast.Raise) and id(child) not in guarded_raises
                                             for child in ast.walk(node))):
                    raise Unsupported()
                # Only bounded literal strings; unknown calls and mutations in
                # the body still reject the whole script before any snapshot.
                for value in sequence[1]:
                    self.bindings[node.target.id] = value
                    self.statements(node.body)
            elif self.abort_guard(node):
                # A pure guard may abort the script, but cannot change target
                # bindings. Actual snapshots still decide whether anything ran.
                self.expression(node.test)
                self.expression(node.body[0].exc)
            elif (isinstance(node, ast.If) and isinstance(node.test, ast.Call)
                  and isinstance(node.test.func, ast.Attribute) and node.test.func.attr == 'exists'):
                self.expression(node.test)
                before = self.bindings.copy()
                self.statements(node.body)
                yes = self.bindings.copy()
                self.bindings = before
                self.statements(node.orelse)
                self.bindings = {key: value if value == self.bindings.get(key) else None
                                 for key, value in yes.items()}
            elif isinstance(node, ast.With):
                for item in node.items:
                    self.expression(item.context_expr)
                    if item.optional_vars:
                        if not isinstance(item.optional_vars, ast.Name):
                            raise Unsupported()
                        self.bindings[item.optional_vars.id] = self.assignment_value(item.context_expr)
                self.statements(node.body)
            elif isinstance(node, ast.Expr):
                self.expression(node.value)
            elif isinstance(node, ast.Raise):
                self.expression(node.exc)
                break  # Changes preceding a failure still have an after-image.
            elif isinstance(node, ast.Assert):
                self.expression(node.test)
                self.expression(node.msg)
            elif not isinstance(node, ast.Pass):
                raise Unsupported()


def _json(value):
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            pass
    return value


def _expands(text):
    # shlex removes quotes, so reject interpolation before tokenization.
    quote = None
    escaped = False
    for char in text:
        if escaped:
            escaped = False
        elif char == '\\' and quote != "'":
            escaped = True
        elif char == quote:
            quote = None
        elif char in "'\"" and quote is None:
            quote = char
        elif (char in '$`' and quote != "'") or (char in '~*?[{' and quote is None):
            return True
    return False


def _shell_words(text):
    if _expands(text):
        raise Unsupported()
    lexer = shlex.shlex(text, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    words = list(lexer)
    if any(word in (';', '&&', '||', '|', '&', '(', ')', '<', '>>', '>') for word in words):
        raise Unsupported()
    return words


def _shell_tokens(source):
    """Keep literal words distinct from unquoted shell operators."""
    tokens, index = [], 0
    while index < len(source):
        char = source[index]
        if char in ' \t\r':
            index += 1
            continue
        if char == '#':
            end = source.find('\n', index)
            index = len(source) if end < 0 else end
            continue
        operator = re.match(r'\d*>>?|[;\n|&<>()]+', source[index:])
        if operator:
            value = operator.group()
            if value not in (';', '\n', '|') and not re.fullmatch(r'\d*>>?', value):
                raise Unsupported()
            tokens.append(('op', value))
            index += operator.end()
            continue
        start, quote = index, None
        while index < len(source):
            char = source[index]
            if char == '\\' and quote != "'":
                if source[index + 1:index + 2] in ('', '\n'):
                    raise Unsupported()
                index += 2
                continue
            if char == quote:
                quote = None
            elif char in "'\"" and quote is None:
                quote = char
            elif quote is None and char in ' \t\r\n;|&<>()':
                break
            index += 1
        raw = source[start:index]
        if quote or _expands(raw):
            raise Unsupported()
        words = shlex.split(raw, comments=False)
        if len(words) != 1:
            raise Unsupported()
        tokens.append(('word', words[0]))
        if len(tokens) > 8192:
            raise Unsupported()
    return tokens


def _shell_invocation_paths(args):
    if not args:
        raise Unsupported()
    executable = Path(args[0]).name
    if executable in ('echo', 'printf', 'cat'):
        return set()
    if executable == 'sleep':
        if len(args) != 2 or not re.fullmatch(r'(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)', args[1]):
            raise Unsupported()
        return set()
    if executable in ('head', 'tail', 'wc', 'rg'):
        # Strict inspection-only options. In particular, rg preprocessors and
        # archive readers can launch programs and remain unknown writers.
        flags = {
            'head': {'-q', '-v'}, 'tail': {'-q', '-v', '-f', '-F', '-r'},
            'wc': {'--bytes', '--chars', '--lines', '--words', '--max-line-length'},
            'rg': {'--files', '--hidden', '--no-ignore', '--no-ignore-vcs', '--no-messages', '--no-config',
                   '--files-with-matches', '--files-without-match', '--ignore-case', '--smart-case',
                   '--fixed-strings', '--line-number', '--only-matching', '--multiline', '--count', '--stats'},
        }[executable]
        values = {'head': {'-n', '-c'}, 'tail': {'-n', '-c'}, 'wc': set(),
                  'rg': {'-e', '-g', '-t', '-T', '-m', '-A', '-B', '-C', '--glob', '--iglob', '--type',
                         '--type-not', '--regexp', '--max-count', '--after-context', '--before-context',
                         '--context', '--max-columns', '--max-filesize', '--color'}}[executable]
        if executable == 'rg' and os.environ.get('RIPGREP_CONFIG_PATH') and '--no-config' not in args[1:]:
            raise Unsupported()
        index = 1
        while index < len(args):
            arg = args[index]
            if arg == '--':
                break
            if arg in values:
                index += 1
                if index >= len(args):
                    raise Unsupported()
            elif arg.startswith('-') and arg not in flags:
                safe = ((executable in ('head', 'tail') and re.fullmatch(r'-[0-9]+|-[nc][+-]?[0-9]+', arg))
                        or (executable == 'wc' and re.fullmatch(r'-[clmwL]+', arg))
                        or (executable == 'rg' and (re.fullmatch(r'-[nliwsvFSoqHhUPcpu]+', arg)
                            or any(arg.startswith(option + '=') for option in values if option.startswith('--')))))
                if not safe:
                    raise Unsupported()
            index += 1
        return set()
    if executable == 'mkdir':
        if len(args) < 3 or args[1] != '-p' or any(arg.startswith('-') for arg in args[2:]):
            raise Unsupported()
        return set()
    files, options = set(), True
    if executable == 'tee':
        for arg in args[1:]:
            if options and arg == '--':
                options = False
            elif options and arg in ('-a', '--append', '-i', '--ignore-interrupts'):
                continue
            elif options and arg.startswith('-') and arg != '-':
                raise Unsupported()
            elif arg != '-':
                files.add(arg)
        return files
    if executable != 'sed':
        raise Unsupported()
    inplace, script, index = False, False, 1
    while index < len(args):
        arg = args[index]
        if arg.startswith('-i'):
            inplace = True
            if arg == '-i' and args[index + 1:index + 2] == ['']:
                index += 1
        elif arg in ('-n', '-E', '-r'):
            pass
        elif arg == '-e' or not arg.startswith('-') and not script:
            if arg == '-e':
                index += 1
                if index >= len(args):
                    raise Unsupported()
                arg = args[index]
            # Substitution scripts only; e/w flags can execute commands or
            # write extra dynamic targets. Separate BSD backup suffixes are ambiguous.
            if not (re.fullmatch(r's([^\w\s\\])(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[0-9gpI]*', arg)
                    or re.fullmatch(r'(?:(?:[0-9]+|\$)(?:,(?:[0-9]+|\$))?)?p', arg)):
                raise Unsupported()
            script = True
        elif arg.startswith('-'):
            raise Unsupported()
        else:
            files.add(arg)
        index += 1
    return files if inplace and script else set()


def _bulk_rename_paths(tree, cwd, inputs):
    """Recognize bounded Path.rglob text renames, never run transcript Python."""
    if cwd is None or not tree.body or not isinstance(tree.body[-1], ast.For):
        return None
    outer = tree.body[-1]
    if len(outer.body) != 1 or not isinstance(outer.body[0], ast.For):
        return None
    inner = outer.body[0]
    if not (isinstance(inner.iter, ast.Call) and isinstance(inner.iter.func, ast.Attribute)
            and inner.iter.func.attr == 'rglob'):
        return None
    if (not isinstance(outer.target, ast.Name) or not isinstance(inner.target, ast.Name)
            or outer.orelse or inner.orelse or len(inner.body) != 4):
        raise Unsupported()
    analyzer = PythonWrites(inputs)
    analyzer.statements(tree.body[:-1])
    roots = analyzer.value(outer.iter)
    if analyzer.paths or not roots or roots[0] != 'sequence':
        raise Unsupported()
    same = lambda node, source: ast.dump(node) == ast.dump(ast.parse(source, mode='eval').body)
    p = inner.target.id
    skip, read, replace, write = inner.body
    if (not isinstance(skip, ast.If) or skip.orelse or len(skip.body) != 1 or not isinstance(skip.body[0], ast.Continue)
            or not isinstance(skip.test, ast.BoolOp) or not isinstance(skip.test.op, ast.Or) or len(skip.test.values) != 2
            or not same(skip.test.values[0], f'not {p}.is_file()')):
        raise Unsupported()
    condition = skip.test.values[1]
    if (not isinstance(condition, ast.Compare) or not same(condition.left, f'{p}.suffix')
            or len(condition.ops) != 1 or not isinstance(condition.ops[0], ast.NotIn)
            or not isinstance(condition.comparators[0], (ast.Set, ast.List, ast.Tuple))):
        raise Unsupported()
    suffixes = [analyzer.value(item) for item in condition.comparators[0].elts]
    if (not all(isinstance(item, ast.Constant) for item in condition.comparators[0].elts)
            or len(suffixes) > 32 or not all(item and item[0] == 'str' and re.fullmatch(r'\.[\w]+', item[1]) for item in suffixes)):
        raise Unsupported()
    suffixes = {item[1] for item in suffixes}
    if (not all(isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) for node in (read, replace))
            or not same(read.value, f'{p}.read_text()')):
        raise Unsupported()
    old, new = read.targets[0].id, replace.targets[0].id
    mutated = {outer.target.id, inner.target.id, old, new}
    if len(mutated) != 4:
        raise Unsupported()
    if (not isinstance(write, ast.If) or write.orelse or not same(write.test, f'{new} != {old}')
            or len(write.body) != 1 or not isinstance(write.body[0], ast.Expr)
            or not same(write.body[0].value, f'{p}.write_text({new})')):
        raise Unsupported()

    def transforms(node, depth=0):
        if depth > 8:
            raise Unsupported()
        if isinstance(node, ast.Name) and node.id == old:
            return []
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute) or node.keywords:
            raise Unsupported()
        method = node.func.attr
        if method == 'replace' and len(node.args) == 2:
            previous = transforms(node.func.value, depth + 1)
        elif (method == 'sub' and len(node.args) == 3 and analyzer.value(node.func.value) == ('module', 're')
              and not any(isinstance(child, ast.Name) and child.id in mutated for child in ast.walk(node.func.value))):
            previous = transforms(node.args[2], depth + 1)
        else:
            raise Unsupported()
        if any(isinstance(child, ast.Name) and child.id in mutated for arg in node.args[:2] for child in ast.walk(arg)):
            raise Unsupported()
        a, b = [analyzer.value(arg) for arg in node.args[:2]]
        if not a or not b or a[0] != 'str' or b[0] != 'str':
            raise Unsupported()
        if method == 'sub' and (not re.fullmatch(r'[A-Za-z0-9 _-]+', a[1].removeprefix(r'\b').removesuffix(r'\b')) or '\\' in b[1]):
            raise Unsupported()  # No callbacks, backreferences or expensive regex grammars.
        return previous + [(method, a[1], b[1])]

    operations = transforms(replace.value)
    if len(inner.iter.args) != 1 or inner.iter.keywords or analyzer.value(inner.iter.args[0]) != ('str', '*'):
        raise Unsupported()
    paths, entries, total = set(), 0, 0
    deadline = time.monotonic() + 1
    cwd = Path(cwd).resolve(strict=True)
    for value in roots[1]:
        analyzer.bindings[outer.target.id] = value
        directory = analyzer.value(inner.iter.func.value)
        if not directory or directory[0] != 'path':
            raise Unsupported()
        directory = _target(cwd, directory[1]) if (cwd / directory[1]) != cwd else cwd
        pending = [directory] if directory.is_dir() else []
        while pending:
            current = pending.pop()
            with os.scandir(current) as listing:
                for entry in listing:
                    entries += 1
                    if entries > 4096 or time.monotonic() > deadline:
                        raise Unsupported()
                    path = Path(entry.path)
                    if entry.is_symlink():
                        raise Unsupported()
                    if entry.is_dir(follow_symlinks=False):
                        pending.append(path)
                        continue
                    if path.suffix not in suffixes or not entry.is_file(follow_symlinks=False):
                        continue
                    data = _snapshot(cwd, path)
                    total += len(data)
                    if total > MAX_SNAPSHOT_BYTES:
                        raise Unsupported()
                    before = text = data.decode('utf-8').replace('\r\n', '\n').replace('\r', '\n')
                    for method, a, b in operations:
                        count = text.count(a) if method == 'replace' else sum(1 for _ in re.finditer(a, text))
                        if len(text) + count * len(b) > MAX_FILE_BYTES:
                            raise Unsupported()
                        text = text.replace(a, b) if method == 'replace' else re.sub(a, b, text)
                    if text != before:
                        paths.add(str(path))
                        if len(paths) > MAX_TARGETS:
                            raise Unsupported()
    # Files currently unchanged can become matches after another writer runs.
    # They need a collision claim even though they do not need snapshots now.
    return CaptureTargets(paths, wide=True)


def _shell_paths(source, depth, inputs=None, cwd=None):
    tokens = _shell_tokens(source)
    paths, args, index, piped = CaptureTargets(), [], 0, False
    while index <= len(tokens):
        kind, value = tokens[index] if index < len(tokens) else ('op', ';')
        if kind == 'word':
            args.append(value)
        elif value in (';', '\n', '|'):
            if args:
                # All stages must be known literal invocations. In particular,
                # cd/eval/source/control flow cannot change subsequent path scope.
                found = _command_paths(args, depth + 1, inputs, cwd)
                paths.update(found)
                paths.wide = paths.wide or getattr(found, 'wide', False)
            elif piped or value == '|':
                raise Unsupported()
            args = []
            piped = value == '|'
        else:
            index += 1
            if index >= len(tokens) or tokens[index][0] != 'word':
                raise Unsupported()
            paths.add(tokens[index][1])
        index += 1
    return paths


def _command_paths(command, depth=0, inputs=None, cwd=None):
    if depth > 3:
        raise Unsupported()
    decoded = _json(command)
    if decoded != command:
        return _command_paths(decoded, depth + 1, inputs, cwd)
    if isinstance(command, dict):
        return _command_paths(command.get('command'), depth + 1, inputs, cwd)
    body = None
    if isinstance(command, str):
        if len(command.encode()) > MAX_COMMAND_BYTES:
            raise Unsupported()
        header, newline, rest = command.partition('\n')
        heredoc = re.search(r"<<\s*('([A-Za-z_][\w]*)'|\"([A-Za-z_][\w]*)\"|([A-Za-z_][\w]*))", header)
        if heredoc and newline:
            delimiter = next(group for group in heredoc.groups()[1:] if group is not None)
            lines = rest.splitlines(keepends=True)
            end = next((i for i, line in enumerate(lines) if line.rstrip('\r\n') == delimiter), None)
            if end is None:
                raise Unsupported()
            # The initial standalone heredoc supplies known targets. Trailing
            # tests/diffs are not analyzed; PostToolUse measures the whole tool.
            body = ''.join(lines[:end])
            if heredoc.group(4) and any(char in body for char in '$`\\'):
                raise Unsupported()
            header = header[:heredoc.start()] + header[heredoc.end():]
            # cat heredoc bodies are data, even when they look like code.
            if re.match(r'^\s*(?:cat|mkdir)\s', header):
                return _shell_paths(header, depth, inputs, cwd)
            words = _shell_words(header)
        else:
            return _shell_paths(command, depth, inputs, cwd)
    elif isinstance(command, list) and all(isinstance(word, str) for word in command):
        words = command
    else:
        raise Unsupported()
    if not words:
        return set()
    executable = Path(words[0]).name
    if executable in ('sh', 'bash', 'zsh') and len(words) == 3 and words[1] in ('-c', '-lc'):
        return _command_paths(words[2], depth + 1, inputs, cwd)
    if not re.fullmatch(r'python(?:3(?:\.\d+)?)?', executable):
        if body is not None:
            raise Unsupported()
        return _shell_invocation_paths(words)
    args = words[1:]
    while args and args[0] in ('-u', '-B'):
        args = args[1:]
    if args == ['-'] and body is not None:
        code = body
    elif len(args) == 2 and args[0] == '-c' and body is None:
        code = args[1]
    else:
        raise Unsupported()
    if len(code.encode()) > MAX_COMMAND_BYTES:
        raise Unsupported()
    tree = ast.parse(code)
    if sum(1 for _ in ast.walk(tree)) > 30000:
        raise Unsupported()
    bulk = _bulk_rename_paths(tree, cwd, inputs)
    if bulk is not None:
        return bulk
    analyzer = PythonWrites(inputs)
    analyzer.statements(tree.body)
    return analyzer.paths


def _patch_paths(value):
    value = _json(value)
    if isinstance(value, dict):
        value = value.get('patch', value.get('input'))
    if not isinstance(value, str) or len(value.encode()) > MAX_COMMAND_BYTES:
        raise Unsupported()
    lines = value.strip().splitlines()
    if not lines or lines[0] != '*** Begin Patch' or lines[-1] != '*** End Patch':
        raise Unsupported()
    return {match.group(1) for line in lines
            if (match := re.fullmatch(r'\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)', line))}


def _command_scope(cwd, tool_input):
    # Structured command wrappers may override the execution directory. Never
    # silently fall back to the payload directory when that override is unknown.
    value = tool_input
    for _ in range(4):
        value = _json(value)
        if not isinstance(value, dict):
            return cwd, value
        overrides = [value[key] for key in ('cwd', 'workdir') if key in value]
        if overrides:
            if not all(isinstance(item, str) and item for item in overrides):
                raise Unsupported()
            directories = {(cwd / item).resolve(strict=True) for item in overrides}
            if len(directories) != 1:
                raise Unsupported()
            cwd = directories.pop()
            if not cwd.is_dir():
                raise Unsupported()
        value = value.get('command', value.get('cmd'))
    raise Unsupported()


class ExecLiterals:
    """Literal sequential/parallel tool calls. Strings are data, never evaluated."""
    def __init__(self, source):
        if not isinstance(source, str) or len(source.encode()) > MAX_TRANSCRIPT_BYTES:
            raise Unsupported()
        self.source, self.pos = source, 0

    def space(self):
        while True:
            match = re.match(r'\s+|//[^\n]*(?:\n|$)|/\*[\s\S]*?\*/', self.source[self.pos:])
            if not match:
                return
            self.pos += match.end()

    def take(self, token):
        self.space()
        if self.source.startswith(token, self.pos):
            end = self.pos + len(token)
            if token.isidentifier() and re.match(r'[\w$]', self.source[end:end + 1]):
                return False
            self.pos += len(token)
            return True
        return False

    def need(self, token):
        if not self.take(token):
            raise Unsupported()

    def identifier(self):
        self.space()
        match = re.match(r'[A-Za-z_$][\w$]*', self.source[self.pos:])
        if not match:
            raise Unsupported()
        self.pos += match.end()
        return match.group()

    def literal(self, depth=0, values=None):
        if depth > 32:
            raise Unsupported()
        self.space()
        if self.take('{'):
            result = {}
            while not self.take('}'):
                self.space()
                key = (self.literal(depth + 1) if self.source[self.pos:self.pos + 1] in ('"', "'")
                       else self.identifier())
                if not isinstance(key, str) or key in result or key == '__proto__':
                    raise Unsupported()
                if values is not None and key in values and not self.take(':'):
                    result[key] = values[key]
                else:
                    if values is None or key not in values:
                        self.need(':')
                    result[key] = self.literal(depth + 1, values)
                if not self.take(','):
                    self.need('}')
                    break
            return result
        if self.take('['):
            result = []
            while not self.take(']'):
                result.append(self.literal(depth + 1, values))
                if not self.take(','):
                    self.need(']')
                    break
            return result
        if self.take('`'):
            return self.template_literal()
        if values:
            for name, value in values.items():
                if self.take(name):
                    return value
        # JSON handles double-quoted strings, numbers, booleans and null.
        # Convert only simple JS single-quoted strings to JSON string spelling.
        if self.take("'"):
            chars = []
            while self.pos < len(self.source):
                char = self.source[self.pos]
                self.pos += 1
                if char == "'":
                    return json.loads('"' + ''.join(chars) + '"')
                if char == '\\':
                    escaped = self.source[self.pos:self.pos + 1]
                    self.pos += 1
                    chars.append("'" if escaped == "'" else '\\' + escaped)
                else:
                    chars.append('\\"' if char == '"' else char)
            raise Unsupported()
        value, end = json.JSONDecoder().raw_decode(self.source, self.pos)
        self.pos = end
        return value

    def template_literal(self):
        """Cook a static JavaScript template; interpolation is never evaluated."""
        chars = []
        escapes = {'n': '\n', 'r': '\r', 't': '\t', 'b': '\b', 'f': '\f', 'v': '\v', '0': '\0'}
        while self.pos < len(self.source):
            char = self.source[self.pos]
            self.pos += 1
            if char == '`':
                try:
                    return ''.join(chars).encode('utf-16', 'surrogatepass').decode('utf-16')
                except UnicodeError:
                    raise Unsupported()
            if char == '$' and self.source[self.pos:self.pos + 1] == '{':
                raise Unsupported()
            if char == '\r':
                if self.source[self.pos:self.pos + 1] == '\n':
                    self.pos += 1
                chars.append('\n')
            elif char != '\\':
                chars.append(char)
            else:
                escaped = self.source[self.pos:self.pos + 1]
                self.pos += 1
                if not escaped:
                    raise Unsupported()
                if escaped in '\n\r\u2028\u2029':
                    if escaped == '\r' and self.source[self.pos:self.pos + 1] == '\n':
                        self.pos += 1
                    continue
                if escaped.isdigit() and (escaped != '0' or self.source[self.pos:self.pos + 1].isdigit()):
                    raise Unsupported()
                if escaped in ('x', 'u'):
                    if escaped == 'u' and self.source[self.pos:self.pos + 1] == '{':
                        match = re.match(r'\{([0-9a-fA-F]{1,6})\}', self.source[self.pos:])
                        if not match or int(match[1], 16) > 0x10ffff:
                            raise Unsupported()
                        chars.append(chr(int(match[1], 16)))
                        self.pos += len(match[0])
                    else:
                        size = 2 if escaped == 'x' else 4
                        digits = self.source[self.pos:self.pos + size]
                        if len(digits) != size or not re.fullmatch('[0-9a-fA-F]+', digits):
                            raise Unsupported()
                        chars.append(chr(int(digits, 16)))
                        self.pos += size
                else:
                    chars.append(escapes.get(escaped, escaped))
        raise Unsupported()

    def tool_call(self, commands, values=None):
        self.need('tools')
        self.need('.')
        name = self.identifier()
        self.need('(')
        args = self.literal(values=values)
        self.need(')')
        if name in ('exec_command', 'shell_command'):
            if not isinstance(args, dict) or len(commands) >= 256:
                raise Unsupported()
            commands.append(args)

    def tool_discovery(self):
        # Framework metadata is often printed beside actual tool calls. Only
        # accept this pure name filter; never evaluate callbacks or regex data.
        self.need('.')
        if self.identifier() not in ('filter', 'find'):
            raise Unsupported()
        self.need('(')
        name = self.identifier()
        self.need('=>')
        self.space()
        pattern = re.match(r'/(?:\\[^\r\n]|[^/\\\r\n])+/[dgimsuvy]*', self.source[self.pos:])
        if not pattern:
            raise Unsupported()
        self.pos += pattern.end()
        for token in ('.', 'test', '(', name, '.', 'name', ')', ')'):
            self.need(token)

    def parallel_calls(self, commands):
        self.need('.')
        if self.identifier() not in ('all', 'allSettled'):
            raise Unsupported()
        self.need('(')
        position = self.pos
        try:
            entries = self.literal()
        except ValueError:
            entries = None
        if isinstance(entries, list) and self.take('.'):
            self.literal_command_map(commands, entries)
            self.need(')')
            return
        self.pos = position
        self.need('[')
        while not self.take(']'):
            # Code mode commonly prints each result through an immediate async
            # arrow. Accept that exact form, not arbitrary callbacks/control flow.
            wrapped = self.take('(')
            if wrapped:
                for token in ('async', '(', ')', '=>', 'text', '(', 'await'):
                    self.need(token)
            self.tool_call(commands)
            if wrapped:
                for token in (')', ')', '(', ')'):
                    self.need(token)
            if not self.take(','):
                self.need(']')
                break
        self.need(')')

    def literal_command_map(self, commands, entries):
        for token in ('map', '(', 'async'):
            self.need(token)
        wrapped = self.take('(')
        tupled = wrapped and self.take('[')
        names = [self.identifier()]
        if tupled:
            self.need(',')
            names.append(self.identifier())
            self.need(']')
        if wrapped:
            self.need(')')
        if len(set(names)) != len(names) or set(names) & {'tools', 'text', 'Promise', 'ALL_TOOLS'}:
            raise Unsupported()
        self.need('=>')
        if not 0 < len(entries) <= 64:
            raise Unsupported()
        start = self.pos
        for entry in entries:
            values = entry if tupled else [entry]
            if not isinstance(values, list) or len(values) != len(names) or any(type(value) not in (str, int) for value in values):
                raise Unsupported()
            self.pos = start
            for token in ('text', '(', '{'):
                self.need(token)
            if self.identifier() not in names:
                raise Unsupported()
            for token in (',', '...', 'await'):
                self.need(token)
            self.tool_call(commands, dict(zip(names, values)))
            for token in ('}', ')'):
                self.need(token)
        self.need(')')

    def result_print(self, name):
        for token in ('.', 'forEach', '('):
            self.need(token)
        if self.take('text'):
            self.need(')')
            return
        self.need('(')
        value = self.identifier()
        self.need(',')
        index = self.identifier()
        if value == index or {value, index} & {'tools', 'text', 'Promise', 'ALL_TOOLS', name}:
            raise Unsupported()
        for token in (')', '=>', 'text', '(', '{', index, ',', '...', value, '}', ')', ')'):
            self.need(token)

    def literal_loop(self, commands, bindings):
        self.need('(')
        if not (self.take('const') or self.take('let')):
            raise Unsupported()
        name = self.identifier()
        if name in bindings or name in ('tools', 'text', 'Promise', 'ALL_TOOLS'):
            raise Unsupported()
        if self.take('='):
            # Only this pure indexed result-print loop; no loop body can invoke a tool.
            for token in ('0', ';', name, '<'):
                self.need(token)
            result = self.identifier()
            if result not in bindings:
                raise Unsupported()
            for token in ('.', 'length', ';', name, '++', ')', 'text', '(', '{', name, ',',
                          '...', result, '[', name, ']', '}', ')'):
                self.need(token)
        else:
            self.need('of')
            if self.take('await'):
                self.need('Promise')
                self.parallel_calls(commands)
                for token in (')', 'text', '(', name, ')'):
                    self.need(token)
            else:
                ids = self.literal()
                if not isinstance(ids, list) or not 0 < len(ids) <= 64 or any(type(x) is not int or x <= 0 for x in ids):
                    raise Unsupported()
                for token in (')', 'text', '(', 'await', 'tools', '.', 'write_stdin', '('):
                    self.need(token)
                args = self.literal(values={name: ids[0]})
                if not isinstance(args, dict) or args.get('chars', '') != '' or args.get('session_id') != ids[0]:
                    raise Unsupported()
                for token in (')', ')'):
                    self.need(token)
        self.need(';')

    def commands(self):
        commands = []
        bindings = set()
        while True:
            self.space()
            if self.pos == len(self.source):
                return commands
            if self.take('for'):
                self.literal_loop(commands, bindings)
                continue
            assigned = self.take('const') or self.take('let')
            if assigned:
                name = self.identifier()
                if name in bindings or name in ('tools', 'text', 'Promise', 'ALL_TOOLS') or len(bindings) >= 128:
                    raise Unsupported()
                self.need('=')
            wrapped = not assigned and (self.take('text') or self.take('image') or self.take('audio'))
            if wrapped:
                self.need('(')
            if wrapped and self.take('('):
                self.need('await')
                self.tool_call(commands)
                self.need(')')
                if self.take('.') and self.identifier() not in ('image_url', 'structuredContent', 'content', 'output'):
                    raise Unsupported()
            elif self.take('await'):
                if self.take('Promise'):
                    self.parallel_calls(commands)
                    if self.take('.'):
                        for token in ('then', '('):
                            self.need(token)
                        result = self.identifier()
                        for token in ('=>', result, '.', 'forEach', '(', 'text', ')', ')'):
                            self.need(token)
                else:
                    self.tool_call(commands)
            elif wrapped or assigned:
                if self.take('ALL_TOOLS'):
                    self.tool_discovery()
                else:
                    position = self.pos
                    try:
                        reference = self.identifier()
                    except Unsupported:
                        reference = None
                    if assigned or reference not in bindings:
                        self.pos = position
                        if assigned:
                            raise Unsupported()
                        self.literal()  # Literal metadata only; never search its contents.
            else:
                result = self.identifier()
                if result not in bindings:
                    raise Unsupported()
                self.result_print(result)
            if assigned:
                bindings.add(name)
            if wrapped:
                self.need(')')
            self.space()
            if self.pos < len(self.source):
                self.need(';')


def _same_command(left, right):
    left, right = _json(left), _json(right)
    def shell_body(value):
        if (isinstance(value, list) and len(value) == 3
                and all(isinstance(word, str) for word in value)
                and Path(value[0]).name in ('sh', 'bash', 'zsh') and value[1] in ('-c', '-lc')):
            return value[2]
        return value
    left, right = shell_body(left), shell_body(right)
    if left == right:
        return True

    def words(value):
        if isinstance(value, list) and all(isinstance(word, str) for word in value):
            return value
        if not isinstance(value, str):
            raise Unsupported()
        # Only normalize simple argv quoting. Never erase shell control syntax,
        # comments, expansions, or unquoted newlines (including heredocs).
        quote, escaped = None, False
        for char in value:
            if escaped:
                if char == '\n':
                    raise Unsupported()
                escaped = False
            elif char == '\\' and quote != "'":
                escaped = True
            elif char == quote:
                quote = None
            elif char in "'\"" and quote is None:
                quote = char
            elif ((quote is None and char in '\n\r#;&|()<>')
                  or (char in '$`' and quote != "'")):
                raise Unsupported()
        return _shell_words(value)

    def unpack(value):
        try:
            return shell_body(words(value))
        except (ValueError, TypeError):
            return value

    # Also handle a shell argv serialized with shlex quoting, without parsing
    # operators inside the shell's script argument as argv separators.
    left, right = unpack(left), unpack(right)
    if left == right:
        return True
    try:
        return words(left) == words(right)
    except (ValueError, TypeError):
        return False


def _active_calls(path):
    if not isinstance(path, str) or not Path(path).is_absolute():
        raise Unsupported()
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise Unsupported()
        start = max(0, info.st_size - MAX_TRANSCRIPT_BYTES)
        file.seek(start)
        data = file.read(MAX_TRANSCRIPT_BYTES)
    if start:
        data = data.partition(b'\n')[2]  # Discard a potentially partial first line.
    lines = data.split(b'\n')[:-1]  # A partial final record is not PRE evidence.
    active, completed = {}, set()
    for line in lines:
        row = json.loads(line)
        if not isinstance(row, dict) or not isinstance(row.get('payload'), dict):
            raise Unsupported()
        item = row.get('payload', {})
        kind, call_id = item.get('type'), item.get('call_id')
        if row.get('type') == 'event_msg' and kind in ('task_complete', 'turn_aborted'):
            active.clear()
        if row.get('type') != 'response_item' or not isinstance(call_id, str):
            continue
        if kind in ('function_call_output', 'custom_tool_call_output'):
            output = _json(item.get('output'))
            header = output[0].get('text', '') if isinstance(output, list) and output and isinstance(output[0], dict) else output
            if kind == 'custom_tool_call_output' and isinstance(header, str) and header.startswith('Script running with cell ID'):
                # The original literal source still owns later nested calls.
                # A yielded code cell is not evidence that its script ended.
                continue
            completed.add(call_id)
            active.pop(call_id, None)
        elif kind in ('function_call', 'custom_tool_call') and call_id not in completed:
            if call_id in active:
                raise Unsupported()
            active[call_id] = item
    return active


def _effective_cwd(payload, cwd, command):
    """Unknown source returns None, so only absolute in-scope targets survive."""
    try:
        active = _active_calls(payload.get('transcript_path'))
        tool = payload['tool_use_id']
        if tool in active:
            item = active[tool]
            if item.get('type') != 'function_call' or item.get('name') not in ('exec_command', 'shell_command'):
                raise Unsupported()
            args = json.loads(item['arguments'])
            if not isinstance(args, dict):
                raise Unsupported()
            candidates = [args]
        elif re.fullmatch(r'exec-[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', tool):
            candidates = []
            for item in active.values():
                if item.get('type') == 'custom_tool_call' and item.get('name') == 'exec':
                    candidates.extend(ExecLiterals(item.get('input')).commands())
        else:
            raise Unsupported()
        directories = set()
        for args in candidates:
            directory, original = _command_scope(cwd, args)
            if _same_command(original, command):
                directories.add(directory)
        return directories.pop() if len(directories) == 1 else None
    except (OSError, ValueError, TypeError, KeyError, RecursionError):
        return None


def _target(cwd, name):
    if not isinstance(name, str) or not name or '\x00' in name:
        raise Unsupported()
    candidate = cwd / name
    # Check the original spelling too: resolve() would conceal symlinks.
    for component in (candidate, *candidate.parents):
        if component.is_symlink():
            raise Unsupported()
    candidate = candidate.resolve()
    candidate.relative_to(cwd)
    if candidate == cwd or '.git' in candidate.relative_to(cwd).parts:
        raise Unsupported()
    return candidate


def _git_read(cwd, args, data=None):
    result = subprocess.run(['git', '-C', str(cwd), *args], input=data,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=2)
    if result.returncode or len(result.stdout) > MAX_COMMAND_BYTES:
        raise Unsupported()
    return result.stdout


def _capture_root(cwd, effective):
    if effective is None or effective.is_relative_to(cwd):
        return cwd
    # The explicit command cwd must belong to a worktree registered by this
    # repository, and Git there must still resolve to the same common dir.
    entries = _git_read(cwd, ['worktree', 'list', '--porcelain', '-z']).split(b'\0')
    roots = [Path(os.fsdecode(row[9:])).resolve()
             for row in entries if row.startswith(b'worktree ')]
    candidates = [root for root in roots if effective.is_relative_to(root)]
    if len(candidates) != 1:
        raise Unsupported()
    common = ['rev-parse', '--path-format=absolute', '--git-common-dir']
    if _git_read(cwd, common).strip() != _git_read(effective, common).strip():
        raise Unsupported()
    return candidates[0]


def _read_patch(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_FILE_BYTES:
            raise Unsupported()
        data = file.read(MAX_FILE_BYTES + 1)
        if len(data) > MAX_FILE_BYTES:
            raise Unsupported()
        return data


def _destination_root(path, roots, cache):
    for directory in roots:
        if path.is_relative_to(directory):
            return directory
    probe = path.parent
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    if probe not in cache:
        try:
            directory = Path(os.fsdecode(_git_read(probe, ['rev-parse', '--show-toplevel']).rstrip(b'\n'))).resolve(strict=True)
            cache[probe] = directory if directory.is_dir() and path.is_relative_to(directory) else None
        except (OSError, ValueError, subprocess.SubprocessError):
            cache[probe] = None
    directory = cache[probe]
    if directory is None:
        raise Unsupported()
    if directory not in roots:
        roots.append(directory)
    return directory


def _git_apply_paths(words, effective, patch_inputs):
    if effective is None or words[:2] != ['git', 'apply']:
        raise Unsupported()
    flags, files, options = [], [], True
    for word in words[2:]:
        if options and word == '--':
            options = False
        elif options and word.startswith('-'):
            if word == '--check':
                flags.append(word)
            elif word.startswith(('--exclude=', '--include=')):
                flags.append(word)
            else:
                raise Unsupported()
        else:
            files.append(word)
    if len(files) != 1 or files[0] == '-':
        raise Unsupported()
    path = (effective / files[0]).absolute()
    data = _read_patch(path)
    # Rename/copy output needs both endpoint identities; do not guess them from
    # numstat's single destination. Binary patches also stay unsupported.
    if re.search(rb'^(?:rename |copy |GIT binary patch|Binary files )', data, re.M):
        raise Unsupported()
    if '--check' in flags:
        return set()
    repository = Path(os.fsdecode(_git_read(effective, ['rev-parse', '--show-toplevel']).rstrip(b'\n')))
    output = _git_read(effective, ['apply', '--numstat', '-z', *flags], data)
    paths = set()
    for row in output.split(b'\0'):
        if not row:
            continue
        columns = row.split(b'\t', 2)
        if len(columns) != 3 or not all(value.isdigit() for value in columns[:2]):
            raise Unsupported()
        paths.add(str(repository / os.fsdecode(columns[2])))
    patch_inputs.append({'path': str(path), 'sha256': hashlib.sha256(data).hexdigest()})
    return paths


def _capture_single_command(command, effective, patch_inputs):
    value = _json(command)
    if isinstance(value, list) and len(value) == 3 and Path(value[0]).name in ('sh', 'bash', 'zsh') and value[1] in ('-c', '-lc'):
        value = value[2]
    if isinstance(value, str):
        try:
            words = _shell_words(value)
        except Unsupported:
            words = []
    else:
        words = value
    if isinstance(words, list) and words[:2] == ['git', 'apply']:
        return _git_apply_paths(words, effective, patch_inputs)
    return _command_paths(command, inputs=patch_inputs, cwd=effective)


def _capture_segments(source):
    for _ in range(64):
        header, newline, rest = source.partition('\n')
        try:
            words = _shell_words(header)
        except ValueError:
            words = []
        heredoc = re.search(r"<<\s*('([A-Za-z_][\w]*)'|\"([A-Za-z_][\w]*)\"|([A-Za-z_][\w]*))", header)
        if newline and heredoc:
            delimiter = next(group for group in heredoc.groups()[1:] if group is not None)
            lines = rest.splitlines(keepends=True)
            end = next((i for i, line in enumerate(lines) if line.rstrip('\r\n') == delimiter), None)
            if end is None:
                raise Unsupported()
            yield header + '\n' + ''.join(lines[:end + 1])
            source = ''.join(lines[end + 1:]).lstrip('\n')
        elif newline and (words[:2] == ['git', 'apply'] or words[:2] == ['mkdir', '-p']):
            yield header
            source = rest.lstrip('\n')
        else:
            yield source
            return
        if not source.strip():
            return
    raise Unsupported()


def _capture_command_paths(command, effective, patch_inputs):
    value = _json(command)
    if (isinstance(value, list) and len(value) == 3 and all(isinstance(item, str) for item in value)
            and Path(value[0]).name in ('sh', 'bash', 'zsh') and value[1] in ('-c', '-lc')):
        value = value[2]
    paths = set()
    wide = False
    try:
        for segment in _capture_segments(value) if isinstance(value, str) else [value]:
            found = _capture_single_command(segment, effective, patch_inputs)
            paths.update(found)
            wide = wide or getattr(found, 'wide', False)
        return paths, wide
    except (OSError, ValueError, subprocess.SubprocessError):
        # Keep concrete targets preceding an opaque tail, but also claim the
        # whole workspace as a possible writer. Never scan past unknown scope.
        return paths, True


def _snapshot(cwd, path):
    path = _target(cwd, str(path))
    # Open each directory without following links, including at the read boundary.
    fd = os.open(cwd, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        parts = path.relative_to(cwd).parts
        for part in parts[:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        source = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        with os.fdopen(source, 'rb') as file:
            info = os.fstat(file.fileno())
            if (not stat.S_ISREG(info.st_mode) or not info.st_mode & 0o444
                    or info.st_size > MAX_FILE_BYTES or info.st_nlink != 1):
                raise Unsupported()
            data = file.read(MAX_FILE_BYTES + 1)
            if len(data) > MAX_FILE_BYTES or b'\x00' in data:
                raise Unsupported()
            data.decode('utf-8')
            return data
    except FileNotFoundError:
        return b''  # Missing is a legitimate before/after image, unlike read errors.
    finally:
        os.close(fd)


def _ignored(cwd, path):
    result = subprocess.run(['git', '-C', str(cwd), 'check-ignore', '--no-index', '-q', '--', str(path)],
                            capture_output=True, timeout=2)
    if result.returncode in (0, 1):
        return result.returncode == 0
    # Non-repositories are supported; other git errors fail closed.
    repo = subprocess.run(['git', '-C', str(cwd), 'rev-parse', '--show-toplevel'],
                          capture_output=True, timeout=2)
    if repo.returncode == 0 or b'not a git repository' not in repo.stderr:
        raise Unsupported()
    return False


def _directory(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise Unsupported()
    path.chmod(0o700)


def _atomic(path, data):
    fd, temporary = tempfile.mkstemp(prefix='.tmp-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as file:
            file.write(data)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _save(root, state):
    _atomic(root / 'state.json', json.dumps(state, separators=(',', ':')).encode())


def _read_owned(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > limit:
            raise Unsupported()
        os.fchmod(file.fileno(), 0o600)
        return file.read(limit + 1)


def _discard(root, key, entry):
    for index in range(len(entry.get('paths', []))):
        (root / 'pending' / (key + '.' + str(index))).unlink(missing_ok=True)
    entry.pop('snapshots', None)


def _owner_dead(root, instance):
    if not isinstance(instance, str) or not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', instance):
        return False
    try:
        owner = json.loads(_read_owned(root / 'instances' / (instance + '.json'), 4096))
        pid = owner.get('pid')
        if owner.get('serverInstance') != instance or type(pid) is not int or pid <= 1:
            return False
    except (OSError, ValueError, AttributeError):
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    except (OSError, OverflowError):
        pass  # Permission errors and PID reuse cannot prove completion.
    return False


def _current_boot():
    """Kernel identity, without spawning a process for every tool boundary."""
    if sys.platform != 'darwin':
        return None
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        query = libc.sysctlbyname
        query.argtypes = [ctypes.c_char_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t),
                          ctypes.c_void_p, ctypes.c_size_t]
        query.restype = ctypes.c_int
        identity = ctypes.create_string_buffer(128)
        size = ctypes.c_size_t(ctypes.sizeof(identity))
        if query(b'kern.bootsessionuuid', identity, ctypes.byref(size), None, 0) != 0:
            return None
        boot_id = identity.value.decode('ascii')
        if not re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', boot_id):
            return None
        class Timeval(ctypes.Structure):
            _fields_ = [('seconds', ctypes.c_long), ('microseconds', ctypes.c_int)]
        started = Timeval()
        size = ctypes.c_size_t(ctypes.sizeof(started))
        if query(b'kern.boottime', ctypes.byref(started), ctypes.byref(size), None, 0) != 0:
            return None
        if size.value != ctypes.sizeof(started) or started.seconds <= 0:
            return None
        return boot_id.lower(), started.seconds
    except (AttributeError, OSError, ValueError):
        return None


def _claim_conflicts(state, key, entry, extra_roots=()):
    def roots(value):
        return {Path(value['cwd']), Path(value.get('captureCwd', value['cwd'])),
                *(Path(root) for root in value.get('captureRoots', {}).values())}
    for other_key, other in state.items():
        if other_key == key or other['status'] not in ('pending', 'expired'):
            continue
        overlap = set(entry['paths']) & set(other['paths'])
        if (entry.get('wide') or other.get('wide')) and any(
                left == right or left in right.parents or right in left.parents
                for left in roots(entry) | set(extra_roots) for right in roots(other)):
            overlap = set(entry['paths']) | set(other['paths'])
        if overlap:
            entry['conflicts'] = sorted(set(entry.get('conflicts', [])) | overlap)
            other['conflicts'] = sorted(set(other.get('conflicts', [])) | overlap)


def _cleanup(root, state, now):
    boot = _current_boot()
    dead_owners = {}
    # A previous PRE died while resolving targets. The command can still run;
    # invalidate overlapping captures before a receipt can retire this claim.
    for key, entry in state.items():
        if entry.get('preparing') and entry['status'] in ('pending', 'expired'):
            _claim_conflicts(state, key, entry)
    for key, entry in list(state.items()):
        age = now - entry['time']
        instance = entry.get('serverInstance')
        if entry['status'] in ('pending', 'expired'):
            recorded_boot = entry.get('bootId')
            # A reboot ends every writer, including terminal commands whose
            # completion hook never arrived. Pin legacy guards to the observed
            # boot first: wall-clock timestamps cannot prove a reboot occurred.
            previous_boot = boot and (
                isinstance(recorded_boot, str)
                and re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', recorded_boot)
                and recorded_boot != boot[0])
            if previous_boot:
                _discard(root, key, entry)
                entry.update(status='done', time=now)
                continue
            if boot and recorded_boot is None:
                entry['bootId'] = boot[0]
            if instance not in dead_owners:
                dead_owners[instance] = _owner_dead(root, instance)
            if dead_owners[instance]:
                _discard(root, key, entry)
                entry.update(status='done', time=now)
                continue
        if entry['status'] == 'pending' and age > PENDING_TTL:
            _discard(root, key, entry)
            entry.update(status='expired', time=now)
        elif entry['status'] == 'done' and age > HANDLED_TTL:
            del state[key]
    # Orphans from interrupted writes and old journals have bounded retention.
    for directory, ttl in (('pending', PENDING_TTL), ('completed', COMPLETED_TTL)):
        files = sorted((root / directory).iterdir(), key=lambda p: p.lstat().st_mtime)
        for index, path in enumerate(files):
            if now - path.lstat().st_mtime > ttl or (directory == 'completed' and index < len(files) - MAX_TOOLS):
                path.unlink(missing_ok=True)
    for path in root.glob('.tmp-*'):
        if now - path.lstat().st_mtime > PENDING_TTL:
            path.unlink(missing_ok=True)
    return boot


def _counts(root, before, after):
    with tempfile.TemporaryDirectory(prefix='.diff-', dir=root) as temporary:
        left, right = Path(temporary) / 'before', Path(temporary) / 'after'
        _atomic(left, before)
        _atomic(right, after)
        result = subprocess.run(['git', '-c', 'core.autocrlf=false', 'diff', '--no-index',
                                 '--no-ext-diff', '--no-textconv', '--numstat', '-z',
                                 '--', str(left), str(right)], capture_output=True, timeout=2)
        if result.returncode not in (0, 1):
            raise Unsupported()
        columns = result.stdout.split(b'\t', 2)
        if len(columns) < 3 or not all(column.isdigit() for column in columns[:2]):
            raise Unsupported()
        return int(columns[0]), int(columns[1])


def _finish_capture(root, state, key, entry, now, unsafe):
    if entry['status'] != 'pending':
        if entry['status'] == 'expired':
            # A late completion cannot recover expired snapshots, but it
            # does prove this tool no longer blocks later independent edits.
            entry.update(status='done', time=now)
        _save(root, state)
        return
    changes, total = [], 0
    cwd = Path(entry.get('captureCwd', entry['cwd']))
    try:
        if any(hashlib.sha256(_read_patch(item['path'])).hexdigest() != item['sha256']
               for item in entry.get('patchInputs', [])):
            entry['conflicts'] = entry['paths']
    except (OSError, ValueError):
        entry['conflicts'] = entry['paths']
    for index in entry.get('snapshots', []):
        name = entry['paths'][index]
        if name in entry['conflicts']:
            continue
        try:
            directory = Path(entry.get('captureRoots', {}).get(name, str(cwd)))
            if _ignored(directory, Path(name)):
                continue
            before = _read_owned(root / 'pending' / (key + '.' + str(index)), MAX_FILE_BYTES)
            after = _snapshot(directory, Path(name))
            total += len(after)
            if total > MAX_SNAPSHOT_BYTES:
                changes = []
                break
            if before != after:
                added, removed = _counts(root, before, after)
                if added or removed:
                    changes.append({'path': name, 'added': added, 'removed': removed})
        except (OSError, ValueError, subprocess.SubprocessError):
            continue
    entry.update(status='done', time=now)
    _discard(root, key, entry)
    _save(root, state)  # Persist handled before publishing, even if importer deletes it.
    if changes and not (unsafe.exists() and now - unsafe.stat().st_mtime < PENDING_TTL):
        groups = {}
        for change in changes:
            directory = entry.get('captureRoots', {}).get(change['path'], str(cwd))
            groups.setdefault(directory, []).append(change)
        for directory, group in groups.items():
            completed = json.dumps({
                'sessionId': entry['sessionId'], 'toolId': entry['toolId'],
                'cwd': directory, 'changes': group}, separators=(',', ':')).encode()
            suffix = '' if len(groups) == 1 else '.' + hashlib.sha256(directory.encode()).hexdigest()[:16]
            if len(completed) <= MAX_COMPLETED_BYTES:
                _atomic(root / 'completed' / (key + suffix + '.json'), completed)


def _open_receipt_transcript(path):
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise Unsupported()
    directory = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    finally:
        os.close(directory)
    return os.fdopen(fd, 'rb')


def _receipt_header(file, session, cwd, execution=None):
    header = file.readline(64 * 1024 + 1)
    if not header.endswith(b'\n') or len(header) > 64 * 1024:
        raise Unsupported()
    row = json.loads(header)
    meta = row.get('payload', {})
    identity = meta.get('id')
    if (row.get('type') != 'session_meta' or not isinstance(identity, str) or not 0 < len(identity) <= 512
            or not isinstance(meta.get('cwd'), str) or not Path(meta['cwd']).is_absolute()
            or not isinstance(cwd, str) or not Path(cwd).is_absolute()
            or Path(meta['cwd']).resolve() != Path(cwd).resolve()):
        raise Unsupported()
    if execution is not None and identity != execution:
        raise Unsupported()
    if identity != session:
        # A shared session_id alone is not child ownership proof. Require the
        # exact native header's explicit parent link as well.
        source = meta.get('source', {})
        if (meta.get('session_id') != session or not isinstance(source, dict)
                or source.get('subagent', {}).get('thread_spawn', {}).get('parent_thread_id') != session):
            raise Unsupported()
    elif meta.get('session_id', session) != session:
        raise Unsupported()
    return identity, hashlib.sha256(header).hexdigest()


def _receipt_start(path, session, cwd):
    with _open_receipt_transcript(path) as file:
        before = os.fstat(file.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid():
            raise Unsupported()
        execution, header_hash = _receipt_header(file, session, cwd)
        boundary = os.pread(file.fileno(), min(before.st_size, 4096), max(0, before.st_size - 4096))
        after = os.fstat(file.fileno())
        if (after.st_size < before.st_size
                or after.st_size == before.st_size and before.st_mtime_ns != after.st_mtime_ns
                or len(boundary) != min(before.st_size, 4096)):
            raise Unsupported()
        # Keep a bounded fingerprint of the original boundary as well as the
        # header and inode. A new file or changed pre-start bytes are not proof.
        checkpoint = {'identity': [before.st_dev, before.st_ino], 'offset': before.st_size,
                      'headerSha256': header_hash, 'boundarySha256': hashlib.sha256(boundary).hexdigest()}
        return {'executionSessionId': execution, 'receiptCheckpoint': checkpoint,
                'receiptCursor': [before.st_dev, before.st_ino, before.st_size]}


def _recorded_completions(path, session, cwd, cursor=None, execution=None, checkpoints=None):
    """Only exact native process-end receipts prove an unpolled command ended."""
    with _open_receipt_transcript(path) as file:
        before = os.fstat(file.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid():
            raise Unsupported()
        execution, header_hash = _receipt_header(file, session, cwd, execution)
        minimums = {}
        if checkpoints is not None:
            for tool, checkpoint in checkpoints.items():
                if not isinstance(checkpoint, dict):
                    continue
                offset = checkpoint.get('offset')
                if (checkpoint.get('identity') != [before.st_dev, before.st_ino]
                        or type(offset) is not int or not file.tell() <= offset <= before.st_size
                        or checkpoint.get('headerSha256') != header_hash):
                    continue
                boundary = os.pread(file.fileno(), min(offset, 4096), max(0, offset - 4096))
                if (len(boundary) == min(offset, 4096)
                        and hashlib.sha256(boundary).hexdigest() == checkpoint.get('boundarySha256')):
                    minimums[tool] = offset
            if not minimums:
                raise Unsupported()
        offset = min(minimums.values()) if minimums else 0
        if (isinstance(cursor, list) and len(cursor) == 3
                and cursor[:2] == [before.st_dev, before.st_ino]
                and type(cursor[2]) is int and 0 <= cursor[2] <= before.st_size):
            offset = cursor[2]
        file.seek(offset)
        data = file.read(MAX_TRANSCRIPT_BYTES)
        if offset and os.pread(file.fileno(), 1, offset - 1) != b'\n':
            data = data.partition(b'\n')[2]
        # Retain an incomplete record for the next chunk/append. A single
        # oversized line is skipped in bounded pieces without parsing its tail.
        boundary = data.rfind(b'\n')
        consumed = len(data) if boundary < 0 and len(data) == MAX_TRANSCRIPT_BYTES else boundary + 1
        next_offset = file.tell() - len(data) + consumed
        record_offset = file.tell() - len(data)
        caught_up = file.tell() >= before.st_size
        after = os.fstat(file.fileno())
        current = os.stat(path, follow_symlinks=False)
        if ((before.st_dev, before.st_ino) != (current.st_dev, current.st_ino)
                or after.st_size < before.st_size
                or after.st_size == before.st_size and after.st_mtime_ns != before.st_mtime_ns):
            raise Unsupported()
    completed = {}
    for line in data.split(b'\n')[:-1]:
        position = record_offset
        record_offset += len(line) + 1
        if not any(kind in line for kind in (b'CommandExecution', b'FileChange', b'patch_apply_end')):
            continue
        try:
            row = json.loads(line)
            payload = row.get('payload', {})
            item = payload.get('item', {})
            at = payload.get('completed_at_ms')
            tool = item.get('id')
            exit_code = item.get('exit_code')
            terminal = (payload.get('type') == 'item_completed' and payload.get('thread_id') == execution
                        and item.get('status') in ('completed', 'failed')
                        and (item.get('type') == 'CommandExecution' and type(exit_code) is int
                             or item.get('type') == 'FileChange'))
            if item.get('type') == 'FileChange':
                exit_code = 0 if item.get('status') == 'completed' else 1
            if payload.get('type') == 'patch_apply_end':
                terminal = (payload.get('thread_id', execution) == execution and type(payload.get('success')) is bool
                            and payload.get('status') in (None, 'completed' if payload['success'] else 'failed'))
                if checkpoints is None:
                    stamp = datetime.datetime.fromisoformat(row.get('timestamp', '').replace('Z', '+00:00'))
                    if stamp.tzinfo is None:
                        continue
                    at = int(stamp.timestamp() * 1000)
                tool = payload.get('call_id')
                exit_code = 0 if payload.get('success') else 1
            if checkpoints is not None:
                if tool not in minimums or position < minimums[tool]:
                    continue
                at = position  # Ordering comes from PRE's checkpoint, never the clock.
            if (row.get('type') == 'event_msg' and terminal
                    and type(at) is int and at > 0 and isinstance(tool, str) and tool):
                value = (at, exit_code)
                if tool in completed and (completed[tool] is None or completed[tool][1] != exit_code):
                    completed[tool] = None
                else:
                    completed[tool] = max(completed.get(tool, value), value)
        except (ValueError, TypeError, AttributeError):
            continue
    return ({tool: value[0] for tool, value in completed.items() if value is not None},
            [before.st_dev, before.st_ino, next_offset], caught_up)


def _reconcile_receipts(root, state, now, unsafe):
    groups = {}
    for key, entry in state.items():
        if entry.get('status') not in ('pending', 'expired'):
            continue
        if (not isinstance(entry.get('sessionId'), str) or not isinstance(entry.get('toolId'), str)
                or key != hashlib.sha256((entry['sessionId'] + entry['toolId']).encode()).hexdigest()):
            continue
        path = entry.get('transcriptPath')
        if not isinstance(path, str) or not Path(path).is_absolute():
            continue
        checkpointed = 'receiptCheckpoint' in entry or 'executionSessionId' in entry
        # Legacy captures lack an execution ID. Only the exact transcript's
        # validated native parent link can supply it; the old time bound remains.
        execution = entry.get('executionSessionId') if checkpointed else None
        if checkpointed and (not isinstance(entry.get('receiptCheckpoint'), dict)
                             or not isinstance(execution, str) or not execution):
            continue  # An invalid new PRE cannot downgrade to legacy clock evidence.
        groups.setdefault((path, entry['sessionId'], entry.get('cwd'), execution, checkpointed), []).append((key, entry))
    deadline, recovered = time.monotonic() + 1, 0
    remaining = list(groups.items())
    for position, ((path, session, cwd, execution, checkpointed), entries) in enumerate(remaining):
        if time.monotonic() >= deadline:
            for _, deferred in remaining[position:]:
                for _, entry in deferred:
                    entry['receiptCatchup'] = True
            break
        try:
            stat_result = os.stat(path, follow_symlinks=False)
            token = [stat_result.st_dev, stat_result.st_ino, stat_result.st_size, stat_result.st_mtime_ns]
            if all(entry.get('receiptScan') == token for _, entry in entries):
                continue
            cursors = []
            for _, entry in entries:
                previous = entry.get('receiptSource')
                rewritten = (isinstance(previous, list) and len(previous) == 4 and previous[:2] == token[:2]
                             and (token[2] < previous[2] or token[2] == previous[2] and token[3] != previous[3]))
                cursors.append(None if rewritten else entry.get('receiptCursor'))
            cursor = min(cursors, key=lambda value: value[2]) if all(
                isinstance(value, list) and len(value) == 3 and value[:2] == token[:2]
                and type(value[2]) is int and 0 <= value[2] <= token[2] for value in cursors) else None
            checkpoints = {entry['toolId']: entry['receiptCheckpoint'] for _, entry in entries} if checkpointed else None
            receipts, cursor, caught_up = _recorded_completions(path, session, cwd, cursor, execution, checkpoints)
            for key, entry in entries:
                entry['receiptCursor'] = cursor
                entry['receiptSource'] = token
                entry['receiptCatchup'] = not caught_up
                if caught_up:
                    entry['receiptScan'] = token
                started = entry.get('startedAt')
                if (entry['toolId'] in receipts and (checkpointed or
                        type(started) in (float, int) and math.isfinite(started) and started > 0
                        and receipts[entry['toolId']] >= int(started * 1000))):
                    _finish_capture(root, state, key, entry, now, unsafe)
                    recovered += 1
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            continue
    return recovered


def _handle(payload, root):
    if not isinstance(payload, dict):
        return
    event = payload.get('hook_event_name')
    if event not in ('PreToolUse', 'PostToolUse', 'CaptureReconcile'):
        return
    session, tool = payload.get('session_id'), payload.get('tool_use_id')
    if event == 'CaptureReconcile':
        session = tool = ''
    elif not all(isinstance(value, str) and 0 < len(value) <= 512 for value in (session, tool)):
        return
    key = hashlib.sha256((session + tool).encode()).hexdigest()
    for directory in (root, root / 'pending', root / 'completed', root / 'sessions', root / 'instances'):
        _directory(directory)
    if event == 'PreToolUse' and payload.get('tool_name') in ('Bash', 'apply_patch'):
        # Permanent activation proof lets the importer disable async captures for
        # this parent session, including subagent tools and commands with no diff.
        session_key = hashlib.sha256(session.encode('utf-8')).hexdigest()
        _atomic(root / 'sessions' / (session_key + '.json'),
                json.dumps({'sessionId': session}, separators=(',', ':')).encode())
    lock = os.open(root / 'lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    with os.fdopen(lock, 'rb') as locked:
        info = os.fstat(locked.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            return
        os.fchmod(locked.fileno(), 0o600)
        deadline = time.monotonic() + LOCK_WAIT_SECONDS
        while True:
            try:
                fcntl.flock(locked, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    # A timed-out hook may write without a claim. Suppress
                    # ambiguous captures, but ordinary parallel starts wait above.
                    _atomic(root / 'unsafe', str(time.time()).encode())
                    return
                time.sleep(min(0.01, remaining))
        now = time.time()
        unsafe = root / 'unsafe'
        if unsafe.exists() and now - unsafe.stat().st_mtime < PENDING_TTL:
            return
        try:
            state = json.loads(_read_owned(root / 'state.json', 8 * 1024 * 1024))
        except FileNotFoundError:
            state = {}
        original = json.dumps(state, separators=(',', ':'))
        boot = _cleanup(root, state, now)
        recovered = _reconcile_receipts(root, state, now, unsafe)
        if event == 'CaptureReconcile':
            if json.dumps(state, separators=(',', ':')) != original:
                _save(root, state)
            return {'pending': any(entry.get('status') == 'pending' or
                                   entry.get('status') == 'expired' and entry.get('receiptCatchup')
                                   for entry in state.values()), 'recovered': recovered}
        if len(state) >= MAX_TOOLS and key not in state:
            done = sorted((key for key in state if state[key]['status'] == 'done'),
                          key=lambda key: state[key]['time'])
            for old_key in done[:len(state) - MAX_TOOLS + 1]:
                del state[old_key]
            if len(state) >= MAX_TOOLS:
                _atomic(unsafe, str(now).encode())
                _save(root, state)
                return
        if event == 'PreToolUse':
            if key in state or (root / 'completed' / (key + '.json')).exists():
                _save(root, state)
                return
            cwd_value = payload.get('cwd')
            if not isinstance(cwd_value, str) or not Path(cwd_value).is_absolute():
                return
            cwd = Path(cwd_value).resolve(strict=True)
            entry = {'time': now, 'startedAt': now, 'status': 'pending', 'paths': [],
                     'cwd': str(cwd), 'sessionId': session, 'toolId': tool,
                     'wide': True, 'preparing': True, 'conflicts': [], 'snapshots': []}
            if boot:
                entry['bootId'] = boot[0]
            instance = os.environ.get('AGMUX_CODEX_CAPTURE_INSTANCE', '')
            if re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', instance):
                entry['serverInstance'] = instance
            transcript = payload.get('transcript_path')
            entry['receiptCheckpoint'] = None
            if isinstance(transcript, str) and Path(transcript).is_absolute():
                entry['transcriptPath'] = transcript
            state[key] = entry
            _save(root, state)  # Persist a writer claim before slow target discovery.
            if 'transcriptPath' in entry:
                try:
                    entry.update(_receipt_start(transcript, session, payload.get('cwd')))
                except (OSError, ValueError, TypeError, AttributeError):
                    pass  # Missing identity stays protected; POST can still settle it.
            tool_input = _json(payload.get('tool_input'))
            native = payload.get('tool_name') in ('apply_patch', 'ApplyPatch')
            wide = False
            capture_root, patch_inputs = cwd, []
            effective = None
            try:
                if native:
                    paths = _patch_paths(tool_input)
                elif payload.get('tool_name') == 'Bash' and isinstance(tool_input, dict):
                    _, command = _command_scope(cwd, tool_input)
                    effective = _effective_cwd(payload, cwd, command)
                    try:
                        capture_root = _capture_root(cwd, effective)
                    except (OSError, ValueError, subprocess.SubprocessError):
                        capture_root = cwd  # Absolute original-workspace targets remain valid.
                    paths, wide = _capture_command_paths(command, effective, patch_inputs)
                    if effective is None and any(not Path(name).is_absolute() for name in paths):
                        wide = True  # Unresolved relative writes still block ambiguous captures.
                    paths = {str(effective / name) if effective else name for name in paths
                             if effective is not None or Path(name).is_absolute()}
                else:
                    raise Unsupported()
                if len(paths) > MAX_TARGETS:
                    raise Unsupported()
            except (ValueError, SyntaxError, OSError, subprocess.SubprocessError):
                # Unknown write sets still participate in collision tracking.
                # No before-image can be captured for this command itself.
                paths, wide = set(), True
            targets, capture_roots = [], {}
            roots, repo_cache = [capture_root], {}
            for name in sorted(paths):
                try:
                    path = capture_root / name
                    directory = _destination_root(path, roots, repo_cache) if effective is not None or native else capture_root
                    target = str(_target(directory, name))
                    targets.append(target)
                    capture_roots[target] = str(directory)
                except (ValueError, OSError):
                    continue
            entry.update(status='pending', paths=sorted(set(targets)), cwd=str(cwd),
                         captureCwd=str(capture_root), patchInputs=patch_inputs,
                         captureRoots=capture_roots,
                         sessionId=session, toolId=tool, conflicts=[], snapshots=[], wide=wide)
            entry.pop('preparing', None)
            _claim_conflicts(state, key, entry, roots)
            _save(root, state)  # Claims survive failed reads and process interruption.
            if native or sum(e['status'] == 'pending' for e in state.values()) > MAX_PENDING:
                return
            total = 0
            for index, name in enumerate(entry['paths']):
                try:
                    path = Path(name)
                    directory = Path(capture_roots[name])
                    if name in entry['conflicts'] or _ignored(directory, path):
                        continue
                    data = _snapshot(directory, path)
                    total += len(data)
                    if total > MAX_SNAPSHOT_BYTES:
                        _discard(root, key, entry)
                        entry['snapshots'] = []
                        break
                    _atomic(root / 'pending' / (key + '.' + str(index)), data)
                    entry['snapshots'].append(index)
                except (OSError, ValueError, subprocess.SubprocessError):
                    continue
            _save(root, state)
            return
        entry = state.get(key)
        if not entry:
            state[key] = {'time': now, 'status': 'done', 'paths': []}
            _save(root, state)
            return
        instance = os.environ.get('AGMUX_CODEX_CAPTURE_INSTANCE')
        if instance is not None and entry.get('serverInstance') != instance:
            return
        return _finish_capture(root, state, key, entry, now, unsafe)


def handle(payload, root: Path):
    """Observe one boundary, synchronously. Capture failures never deny a tool."""
    try:
        return _handle(payload, Path(root))
    except Exception:
        pass


def main():
    if os.environ.get('AGMUX_SHELL_DIFF_HOOK') != '1':
        return
    try:
        if sys.argv[1:] == ['--reconcile']:
            result = handle({'hook_event_name': 'CaptureReconcile'}, Path(__file__).parent.parent / 'shell-diff-hooks')
            print(json.dumps(result if result is not None else {'pending': True, 'error': True}))
            return
        data = sys.stdin.buffer.read(MAX_COMMAND_BYTES * 4 + 1)
        if len(data) <= MAX_COMMAND_BYTES * 4:
            handle(json.loads(data), Path(__file__).parent.parent / 'shell-diff-hooks')
    except Exception:
        pass


if __name__ == '__main__':
    main()
