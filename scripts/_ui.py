"""Shared terminal helpers for the picturereader installer and uninstaller.

The two entry scripts (`install.py`, `uninstall.py`) must never leave the user
staring at a silent progress bar. Everything they do is narrated: the exact
command being run, what is being downloaded and how large it is expected to be,
the streamed output of pip and pnpm, per-step timings, and a steadily updating
heartbeat for the few phases that produce no output of their own.

Design rules:

* Human-readable output always goes to **stderr**, so stdout stays free for the
  machine-readable result of ``--json``.
* Child processes are streamed line by line, never captured silently.
* Colour is opt-in only when stderr is a terminal and ``NO_COLOR`` is unset.
* Standard library only: these helpers run before any virtualenv exists.

@module scripts/_ui
"""

from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

# ---------------------------------------------------------------------------
# formatting helpers
# ---------------------------------------------------------------------------

_UNITS = ("B", "KB", "MB", "GB", "TB")


def human_size(num_bytes):
    """Render a byte count as a compact human string (``1.4 GB``)."""
    try:
        value = float(num_bytes)
    except (TypeError, ValueError):
        return "?"
    if value < 0:
        return "?"
    for unit in _UNITS:
        if value < 1024 or unit == _UNITS[-1]:
            if unit == "B":
                return "%d %s" % (int(value), unit)
            return "%.1f %s" % (value, unit)
        value /= 1024.0
    return "%.1f TB" % value


def human_duration(seconds):
    """Render a duration as ``4.2s``, ``1m 20s`` or ``1h 02m``."""
    if seconds is None:
        return "?"
    if seconds < 1:
        return "%.2fs" % seconds
    if seconds < 60:
        return "%.1fs" % seconds
    minutes, secs = divmod(int(round(seconds)), 60)
    if minutes < 60:
        return "%dm %02ds" % (minutes, secs)
    hours, minutes = divmod(minutes, 60)
    return "%dh %02dm" % (hours, minutes)


def tree_size(path):
    """Return ``(apparent_bytes, on_disk_bytes, file_count)`` for a tree.

    ``on_disk`` uses ``st_blocks`` so it reflects what the filesystem really
    consumed (sparse files and block padding included) rather than the sum of
    the logical file sizes. Both numbers are reported by the uninstaller,
    because a venv full of many small files wastes far more disk than its
    apparent size suggests.
    """
    apparent = 0
    on_disk = 0
    files = 0
    stack = [path]
    while stack:
        current = stack.pop()
        try:
            entries = list(os.scandir(current))
        except (FileNotFoundError, NotADirectoryError):
            continue
        except OSError:
            continue
        for entry in entries:
            try:
                if entry.is_dir(follow_symlinks=False):
                    stack.append(entry.path)
                    continue
                info = entry.stat(follow_symlinks=False)
            except OSError:
                continue
            files += 1
            apparent += info.st_size
            blocks = getattr(info, "st_blocks", None)
            on_disk += blocks * 512 if blocks is not None else info.st_size
    return apparent, on_disk, files


# ---------------------------------------------------------------------------
# console
# ---------------------------------------------------------------------------

class Console:
    """Narrated console output on stderr with three verbosity levels."""

    QUIET = 0
    NORMAL = 1
    VERBOSE = 2

    def __init__(self, level=NORMAL, color="auto", stream=None):
        self.level = level
        self.stream = stream if stream is not None else sys.stderr
        self.color = self._resolve_color(color)
        self._total = 0
        self._index = 0
        self._started = time.time()
        self._heartbeat_lock = threading.Lock()

    # -- colour ------------------------------------------------------------
    @staticmethod
    def _resolve_color(color):
        if color == "never":
            return False
        if color == "always":
            return True
        if os.environ.get("NO_COLOR"):
            return False
        try:
            return bool(sys.stderr.isatty())
        except Exception:
            return False

    def _paint(self, text, code):
        if not self.color:
            return text
        return "\033[%sm%s\033[0m" % (code, text)

    def bold(self, text):
        return self._paint(text, "1")

    def green(self, text):
        return self._paint(text, "32")

    def yellow(self, text):
        return self._paint(text, "33")

    def red(self, text):
        return self._paint(text, "31")

    def cyan(self, text):
        return self._paint(text, "36")

    def dim(self, text):
        return self._paint(text, "2")

    # -- raw output --------------------------------------------------------
    def raw(self, text=""):
        """Write one line of already-formatted text."""
        self.stream.write(text + "\n")
        self.stream.flush()

    def out(self, text=""):
        if self.level >= self.NORMAL:
            self.raw(text)

    def verbose(self, text=""):
        if self.level >= self.VERBOSE:
            self.raw(self.dim(text))

    def err(self, text):
        self.raw(self.red("  ✗ " + text))

    def warn(self, text):
        self.raw(self.yellow("  ! " + text))

    def ok(self, text):
        self.out("  " + self.green("✓") + " " + text)

    # -- structure ---------------------------------------------------------
    def title(self, text):
        self.raw("")
        self.raw(self.bold(text))

    def set_total_steps(self, total):
        self._total = total
        self._index = 0

    def step(self, title, detail=None):
        """Announce a step: ``▸ [3/9] Installing the plugin into DSH``.

        The total is an estimate; if a step appears that the caller did not
        predict, the total grows rather than reporting an impossible "8/5".
        """
        self._index += 1
        if self._index > self._total:
            self._total = self._index
        head = "▸ [%d/%d]" % (self._index, self._total) if self._total else "▸"
        line = "%s %s" % (self.cyan(head), self.bold(title))
        self.raw("")
        self.raw(line)
        if detail:
            self.raw("  " + detail)

    def item(self, label, value):
        self.out("  %-22s %s" % (label + ":", value))

    def table(self, headers, rows, indent="  "):
        """Print a simple aligned table."""
        if not rows:
            return
        widths = [len(str(h)) for h in headers]
        for row in rows:
            for i, cell in enumerate(row):
                widths[i] = max(widths[i], len(str(cell)))
        header = "  ".join(str(h).ljust(widths[i]) for i, h in enumerate(headers))
        self.raw(indent + self.bold(header))
        self.raw(indent + self.dim("-" * len(header)))
        for row in rows:
            self.raw(indent + "  ".join(str(cell).ljust(widths[i]) for i, cell in enumerate(row)))

    def elapsed(self):
        return time.time() - self._started

    # -- child processes ---------------------------------------------------
    def command(self, cmd):
        """Echo the command about to run."""
        display = " ".join(_quote(part) for part in cmd)
        self.out("  " + self.dim("$ ") + display)
        self.verbose("    cwd: %s" % os.getcwd())

    def run(self, cmd, title=None, cwd=None, env=None, check=True, prefix="  │ "):
        """Run a command, streaming its output live.

        Returns ``(returncode, tail_lines)``. ``tail_lines`` holds the last few
        output lines so a caller can quote the real error instead of guessing.
        """
        if title:
            self.out("  " + title)
        self.command(cmd)
        started = time.time()
        try:
            proc = subprocess.Popen(
                cmd,
                cwd=cwd,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                errors="replace",
            )
        except FileNotFoundError:
            self.err("command not found: %s" % cmd[0])
            if check:
                raise SystemExit(1)
            return 127, []
        except OSError as exc:
            self.err("cannot start %s: %s" % (cmd[0], exc))
            if check:
                raise SystemExit(1)
            return 1, []

        tail = []
        assert proc.stdout is not None
        with self._pause_heartbeat():
            for line in proc.stdout:
                line = line.rstrip("\n")
                tail.append(line)
                if len(tail) > 40:
                    tail.pop(0)
                if self.level >= self.NORMAL:
                    self.raw(prefix + line)
        code = proc.wait()
        took = time.time() - started
        if code == 0:
            self.ok("finished in %s" % human_duration(took))
        else:
            self.err("exited with code %d after %s" % (code, human_duration(took)))
            if check:
                raise SystemExit(code)
        return code, tail

    # -- heartbeat ---------------------------------------------------------
    class _Heartbeat:
        def __init__(self, console, activity):
            self.console = console
            self.activity = activity
            self._stop = threading.Event()
            self._thread = None
            self._written = False

        def _loop(self):
            while not self._stop.wait(0.5):
                elapsed = time.time() - self._started
                text = "  ⏳ %s — %s" % (human_duration(elapsed), self.activity)
                try:
                    self.console.stream.write("\r" + text + " " * 8)
                    self.console.stream.flush()
                    self._written = True
                except Exception:
                    return

        def __enter__(self):
            self._started = time.time()
            if self.console.level >= Console.NORMAL:
                self._thread = threading.Thread(target=self._loop, daemon=True)
                self._thread.start()
            return self

        def __exit__(self, *exc):
            self._stop.set()
            if self._thread is not None:
                self._thread.join(timeout=1.0)
            if self._written:
                self.console.stream.write("\r" + " " * 72 + "\r")
                self.console.stream.flush()
            return False

    def heartbeat(self, activity):
        """Context manager narrating a phase that produces no output."""
        return Console._Heartbeat(self, activity)

    class _Pause:
        def __init__(self, console):
            self.console = console

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def _pause_heartbeat(self):
        return Console._Pause(self)


def _quote(part):
    text = str(part)
    if text == "" or any(ch in text for ch in " \t\"'$"):
        return "'" + text.replace("'", "'\\''") + "'"
    return text


# ---------------------------------------------------------------------------
# PyPI metadata (expected download sizes)
# ---------------------------------------------------------------------------

_PYPI_CACHE = {}


def pypi_wheel_size(package, version=None, python_version=None):
    """Look up the expected download size of a package's wheel.

    Printed before an install starts so the user knows the scale of the
    download even when pip's own progress bar is suppressed (non-TTY output).

    The lookup is deliberately best-effort: an offline machine, a missing
    package or an unexpected payload all return ``None``, and the installer
    simply reports the size as unknown instead of failing.

    Note: the version-pinned PyPI JSON endpoint carries only ``urls`` while the
    unpinned one carries the full ``releases`` map, so both are consulted.

    @param package: distribution name, e.g. ``paddlepaddle``.
    @param version: exact version, or None to use the latest release.
    @param python_version: interpreter version string used to prefer a matching wheel.
    @returns: size in bytes, or None when unknown.
    """
    key = (package, version, python_version)
    if key in _PYPI_CACHE:
        return _PYPI_CACHE[key]
    size = None
    try:
        with urllib.request.urlopen("https://pypi.org/pypi/%s/json" % package, timeout=8) as response:
            data = json.load(response)
        resolved = version or data.get("info", {}).get("version")
        files = (data.get("releases") or {}).get(resolved) or data.get("urls") or []
        tag = "cp%s" % (python_version or "%d.%d" % sys.version_info[:2])
        candidates = [
            (entry.get("filename", ""), entry.get("size") or 0)
            for entry in files
            if entry.get("filename", "").endswith(".whl") and not entry.get("yanked")
        ]
        # Restrict to wheels this machine could actually install: pure-Python,
        # or manylinux for the running architecture. Without this the "first
        # candidate" could be a wheel built for another operating system, and
        # the reported size would be wrong.
        machine = platform.machine()
        portable = [
            c for c in candidates
            if "py3-none-any" in c[0] or "manylinux" in c[0] and machine in c[0]
        ]
        pool = portable or candidates
        if pool:
            preferred = [c for c in pool if tag in c[0]]
            abi3 = [c for c in pool if "abi3" in c[0] or "py3-none-any" in c[0]]
            chosen = preferred or abi3 or pool
            size = chosen[0][1] or None
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, OSError, KeyError):
        size = None
    _PYPI_CACHE[key] = size
    return size


def describe_download(console, package, version=None):
    """Print ``expected download: 185.8 MB (paddlepaddle 3.3.1)`` when known."""
    size = pypi_wheel_size(package, version)
    if size:
        console.out("  expected download: %s (%s%s)" % (human_size(size), package, " %s" % version if version else ""))
    else:
        console.verbose("  expected download: unknown for %s" % package)


# ---------------------------------------------------------------------------
# environment probing
# ---------------------------------------------------------------------------

def find_executable(names, env=None):
    """Return the first of ``names`` found on PATH, or None."""
    for name in names:
        found = shutil.which(name, path=(env or os.environ).get("PATH"))
        if found:
            return found
    return None


def python_version_of(executable):
    """Return ``(major, minor, patch)`` for an interpreter, or None."""
    try:
        result = subprocess.run(
            [executable, "-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=20,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    try:
        parts = result.stdout.strip().split(".")
        return tuple(int(p) for p in parts[:3])
    except (ValueError, IndexError):
        return None


def version_string(version):
    return ".".join(str(p) for p in version) if version else "?"


def platform_summary():
    return "%s %s (%s)" % (platform.system(), platform.release(), platform.machine())
