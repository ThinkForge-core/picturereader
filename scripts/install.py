#!/usr/bin/env python3
"""Install the whole picturereader plugin into DeepSeek Harness.

This is the single entry point for installing picturereader. It does not just
create Python environments: it registers the plugin in one or more DSH profiles,
materializes its runtime dependencies, creates the two Python environments the
tools need, warms the OCR model cache, and records everything it created in a
state file that the plugin reads back at runtime.

Nothing is guessed and nothing is silent. Every step prints the command it runs,
what it is about to download and how large that download is expected to be, the
streamed output of the underlying tool, and how long the step took.

    python3 scripts/install.py                 # install into the "web" profile
    python3 scripts/install.py --dry-run       # print the plan and stop
    python3 scripts/install.py --verify        # check an existing installation
    python3 scripts/install.py --selftest      # test the installer's helpers

The companion script scripts/uninstall.py removes what this script created, and
only that.

@module scripts/install
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _ui import (  # noqa: E402  (import after sys.path setup)
    Console,
    describe_download,
    find_executable,
    human_duration,
    human_size,
    platform_summary,
    python_version_of,
    tree_size,
    version_string,
)

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
DEFAULT_PREFIX_PARTS = ("picturereader", "venvs")
STATE_PARTS = ("picturereader", "env.json")

# ---------------------------------------------------------------------------
# what we install
# ---------------------------------------------------------------------------

VENV_SPECS = {
    "media": {
        "label": "document + image processing (PyMuPDF, Pillow, OpenCV, piexif)",
        "requirements": "media.txt",
        "roles": ["doc", "image"],
        # Pillow/OpenCV/PyMuPDF all ship abi3 or cp314 wheels, so any modern
        # interpreter works; prefer the newest available.
        "min_python": (3, 10),
        "max_python": None,
    },
    "ocr": {
        "label": "OCR (RapidOCR + ONNX Runtime)",
        "requirements": "ocr.txt",
        "roles": ["ocr"],
        # onnxruntime publishes manylinux_2_28_aarch64 wheels for cp311..cp314,
        # so this environment installs on every architecture this plugin
        # targets — including aarch64, where PaddleOCR cannot be installed.
        "min_python": (3, 9),
        "max_python": None,
        # rapidocr is installed in a second pass with --no-deps: its
        # `opencv_python` requirement would otherwise pull the GUI OpenCV build
        # next to the headless one that ocr.txt pins, and the GUI build needs
        # libGL.so.1, which a proot rootfs does not have.
        "no_deps": ["rapidocr==3.9.2"],
    },
    "paddle": {
        "label": "OCR (legacy PaddleOCR)",
        "requirements": "paddle.txt",
        "roles": ["ocr"],
        # paddlepaddle publishes no cp314 wheels yet: cap the interpreter.
        # NOTE: also no linux-aarch64 wheel from 3.3.0 on, and paddle.txt pins a
        # newer version than the last ARM release (3.2.2) — which is exactly why
        # this environment is legacy-only and `ocr` is the default.
        "min_python": (3, 9),
        "max_python": (3, 13),
        "legacy": True,
    },
}

#: Which environment `--engine` selects by default.
DEFAULT_ENGINE_ROLE = "ocr"

OPTIONAL_REQUIREMENTS = "optional.txt"

# The plugin's own runtime dependencies. Listed so the manual fallback can
# materialize them next to the installed copy.
RUNTIME_DEPS = ("pngjs", "jpeg-js", "omggif")

WARMUP_IMAGE = HERE / "warmup-ocr.png"


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------

def dsh_home():
    """Resolve $DSH_HOME (defaults to ~/.dsh)."""
    value = os.environ.get("DSH_HOME", "").strip()
    return Path(value) if value else Path.home() / ".dsh"


def state_path():
    return dsh_home().joinpath(*STATE_PARTS)


def default_venv_prefix():
    return dsh_home().joinpath(*DEFAULT_PREFIX_PARTS)


def venv_python_path(venv_dir):
    """Interpreter path inside a venv (POSIX layout; the project is Linux-only)."""
    return Path(venv_dir) / "bin" / "python"


def read_state_file():
    """Read the installer state file, or None when it is absent or unreadable."""
    path = state_path()
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def paddle_cache_dir():
    """Where PaddleX should keep its downloaded models.

    This must agree with what the plugin computes at runtime
    (``paddleCacheHome`` in src/paths.js): ``DSH_PADDLE_CACHE`` first, then the
    recorded state file, then ``~/.paddlex-cache``. Getting this wrong means
    the warm-up populates one directory while the tool reads another, so the
    first real recognition call would still have to download everything — and
    ``--verify`` would check the wrong environment.
    """
    from_env = os.environ.get("DSH_PADDLE_CACHE", "").strip()
    if from_env:
        return Path(from_env)
    recorded = ((read_state_file() or {}).get("caches") or {}).get("paddlex")
    if isinstance(recorded, str) and recorded.strip():
        return Path(recorded)
    return Path.home() / ".paddlex-cache"


def paddle_env():
    """Environment for anything that imports PaddleOCR/PaddleX.

    PaddleX creates and writes its cache directory as a side effect of import,
    so the variable has to be set for the import check and the warm-up run too,
    not only for the model download.
    """
    cache = paddle_cache_dir()
    return {**os.environ, "PADDLE_PDX_CACHE_HOME": str(cache), "PYTHONIOENCODING": "utf-8"}


def load_requirements(name):
    """Read a pinned requirements file shipped next to this script."""
    path = HERE / "requirements" / name
    if not path.exists():
        return None, None
    lines = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        lines.append(line)
    return path, lines


def package_name(spec):
    """Extract the distribution name from a requirement specifier line.

    Handles extras and any version operator: ``paddlex[ocr-core]>=3.7`` yields
    ``paddlex``, which is the name to look up on PyPI.
    """
    text = spec.strip()
    cut = len(text)
    for sep in ("==", ">=", "<=", "~=", "!=", "===", "[", ";", " ", ">", "<"):
        index = text.find(sep)
        if index > 0:
            cut = min(cut, index)
    return text[:cut].strip()


def package_version(spec):
    if "==" in spec:
        return spec.split("==", 1)[1].split(";")[0].strip()
    return None


# ---------------------------------------------------------------------------
# preflight
# ---------------------------------------------------------------------------

class Preflight:
    """Collect environment facts, printing each check as it runs."""

    def __init__(self, console):
        self.console = console
        self.problems = []
        self.notes = []
        self.interpreters = []
        self.node = None
        self.dsh = None
        self.pnpm = None
        self.soffice = None
        self.free_bytes = None

    def check(self, label, ok, detail="", fatal=True):
        c = self.console
        if ok:
            c.ok("%s %s" % (label, c.dim(detail) if detail else ""))
        else:
            message = "%s%s" % (label, (": " + detail) if detail else "")
            if fatal:
                c.err(message)
                self.problems.append(message)
            else:
                c.warn(message)
                self.notes.append(message)
        return ok

    def run(self, profiles, engine_needed=True, engine_role=DEFAULT_ENGINE_ROLE):
        c = self.console
        c.step("Preflight checks", "everything below runs before a single file is written")
        c.item("platform", platform_summary())

        # Python interpreters -------------------------------------------------
        found = discover_interpreters()
        self.interpreters = found
        if found:
            rendered = ", ".join("%s (%s)" % (version_string(v), p) for p, v in found[:6])
            self.check("python", True, rendered)
        else:
            self.check("python", False, "no Python 3 interpreter found on PATH", fatal=True)

        # Media environment interpreter --------------------------------------
        pick = choose_interpreter(found, VENV_SPECS["media"])
        if pick is None:
            self.check(
                "python for media venv",
                False,
                "need Python %s or newer" % version_string(VENV_SPECS["media"]["min_python"]),
                fatal=True,
            )
        else:
            self.check("python for media venv", True, version_string(pick[1]))

        # OCR environment interpreter ----------------------------------------
        if engine_needed:
            role = engine_role
            spec = VENV_SPECS[role]
            pick = choose_interpreter(found, spec)
            if pick is None:
                maximum = spec.get("max_python")
                if maximum is None:
                    reason = "need Python %s or newer" % version_string(spec["min_python"])
                else:
                    reason = "%s needs Python <= %s (paddlepaddle has no newer wheels)" % (
                        spec["label"],
                        version_string(maximum),
                    )
                self.check("python for %s venv" % role, False, reason, fatal=True)
            else:
                self.check("python for %s venv" % role, True, version_string(pick[1]))
            if role == "paddle" and platform.machine() in ("aarch64", "arm64"):
                self.check(
                    "paddlepaddle has an aarch64 wheel",
                    False,
                    "the pinned paddlepaddle has no linux-aarch64 wheel (the last ARM release is 3.2.2); "
                    "use --engine ocr (RapidOCR) instead",
                    fatal=True,
                )

        # Node / dsh / pnpm ---------------------------------------------------
        self.node = find_executable(("node",))
        if self.node:
            version = node_version(self.node)
            self.check("node", version is not None, version or "could not read the version", fatal=version is None)
        else:
            self.check("node", False, "not found on PATH", fatal=True)

        self.dsh = find_executable(("dsh",))
        self.check(
            "dsh",
            self.dsh is not None,
            self.dsh or "not found on PATH (pass --dsh <path> if it lives elsewhere)",
            fatal=self.dsh is None,
        )

        self.pnpm = find_executable(("pnpm",))
        self.check(
            "pnpm",
            self.pnpm is not None,
            self.pnpm or "not found: the plugin will be materialized manually instead of via `dsh plugin add`",
            fatal=False,
        )

        # Writable DSH profile directories ------------------------------------
        home = dsh_home()
        if not home.exists():
            self.check("DSH home", True, "%s (will be created)" % home)
        else:
            self.check("DSH home", True, str(home))
        for profile in profiles:
            profile_dir = home / "profiles" / profile
            if not profile_dir.exists():
                self.check("profile %s" % profile, True, "%s (will be created)" % profile_dir)
                continue
            writable = os.access(profile_dir, os.W_OK)
            self.check(
                "profile %s is writable" % profile,
                writable,
                str(profile_dir) if writable else "%s is read-only — fix the permissions or mount" % profile_dir,
                fatal=True,
            )
        store = pnpm_store_path(self.pnpm)
        if store is not None and store.exists():
            self.check(
                "pnpm store is writable",
                os.access(store, os.W_OK),
                str(store),
                fatal=False,
            )

        # LibreOffice (optional but needed by document_to_image) --------------
        self.soffice = find_soffice()
        self.check(
            "LibreOffice",
            self.soffice is not None,
            self.soffice or "not found; document_to_image needs it for Office formats (install libreoffice-fresh / libreoffice)",
            fatal=False,
        )

        # Disk space -----------------------------------------------------------
        self.free_bytes = shutil.disk_usage(str(home if home.exists() else Path.home())).free
        self.check("free disk space", True, human_size(self.free_bytes))
        estimated = estimate_install_bytes(engine_needed, engine_role)
        if self.free_bytes < estimated:
            self.check(
                "disk space is sufficient",
                False,
                "about %s is needed but only %s is free" % (human_size(estimated), human_size(self.free_bytes)),
                fatal=True,
            )
        else:
            self.check("disk space is sufficient", True, "estimated need: about %s" % human_size(estimated))

        return not self.problems


def node_version(node):
    try:
        result = subprocess.run([node, "--version"], stdout=subprocess.PIPE, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip()


def pnpm_store_path(pnpm):
    if pnpm is None:
        return None
    try:
        result = subprocess.run([pnpm, "store", "path"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    value = result.stdout.strip().splitlines()
    return Path(value[-1]) if value else None


def find_soffice():
    for name in ("soffice", "libreoffice"):
        found = find_executable((name,))
        if found:
            return found
    for candidate in (
        "/usr/bin/soffice",
        "/usr/local/bin/soffice",
        "/usr/lib/libreoffice/program/soffice",
        "/opt/libreoffice/program/soffice",
    ):
        if Path(candidate).exists():
            return candidate
    return None


def discover_interpreters():
    """Find every usable Python 3 interpreter, newest first.

    Scans PATH plus the usual system locations so a machine that only has
    ``/usr/bin/python3.13`` still gets picked up for the PaddleOCR venv even
    when ``python3`` points at a newer release.
    """
    seen = {}
    names = ["python3.%d" % minor for minor in range(15, 8, -1)] + ["python3", "python"]
    for name in names:
        found = find_executable((name,))
        if found:
            real = os.path.realpath(found)
            seen.setdefault(real, found)
    for directory in ("/usr/bin", "/usr/local/bin", "/opt/python/bin"):
        base = Path(directory)
        if not base.is_dir():
            continue
        for entry in sorted(base.glob("python3.*")):
            if entry.name.endswith("-config"):
                continue
            real = os.path.realpath(entry)
            seen.setdefault(real, str(entry))
    interpreters = []
    for real, display in seen.items():
        version = python_version_of(display)
        if version is None or version[0] != 3:
            continue
        interpreters.append((display, version))
    interpreters.sort(key=lambda item: item[1], reverse=True)
    return interpreters


def choose_interpreter(interpreters, spec):
    """Pick the newest interpreter satisfying a venv spec's version bounds."""
    minimum = spec.get("min_python")
    maximum = spec.get("max_python")
    for path, version in interpreters:  # already newest first
        if minimum is not None and version[:2] < minimum:
            continue
        if maximum is not None and version[:2] > maximum:
            continue
        return (path, version)
    return None


def selected_venv_roles(cfg):
    """The venv roles this run will install, in order."""
    roles = ["media"]
    if cfg["engine_needed"]:
        roles.append(cfg.get("engine_role", DEFAULT_ENGINE_ROLE))
    return roles


def estimate_install_bytes(engine_needed, engine_role=DEFAULT_ENGINE_ROLE):
    """Rough disk estimate so the plan can warn before a big download."""
    total = 0
    for role in selected_venv_roles({"engine_needed": engine_needed, "engine_role": engine_role}):
        spec = VENV_SPECS[role]
        _, lines = load_requirements(spec["requirements"])
        if lines:
            for line in lines:
                size = describe_size_for(line)
                total += size or 0
        total += 150 * 1024 * 1024  # unpacked overhead
    return total


def describe_size_for(spec):
    from _ui import pypi_wheel_size

    return pypi_wheel_size(package_name(spec), package_version(spec))


# ---------------------------------------------------------------------------
# plan
# ---------------------------------------------------------------------------

def build_plan(cfg):
    """Return the list of actions install() would perform."""
    actions = []
    for profile in cfg["profiles"]:
        profile_dir = dsh_home() / "profiles" / profile
        installed = profile_dir / "node_modules" / "picturereader"
        actions.append(
            {
                "component": "plugin in profile %r" % profile,
                "path": str(installed),
                "action": "reinstall" if installed.exists() else "install",
                "detail": "register via dsh plugin add"
                if cfg["pnpm"] is not None
                else "materialize manually (pnpm unavailable)",
            }
        )
    for role in selected_venv_roles(cfg):
        spec = VENV_SPECS[role]
        venv_dir = Path(cfg["prefix"]) / role
        python = venv_python_path(venv_dir)
        if python.exists():
            action = "repair" if cfg["force"] else "reuse"
        else:
            action = "create"
        _, lines = load_requirements(spec["requirements"])
        sizes = [describe_size_for(line) for line in (lines or [])]
        known = sum(size for size in sizes if size)
        detail = spec["label"]
        if action == "create":
            detail += " — expected download %s" % (human_size(known) if known else "unknown")
        actions.append({"component": "venv %r" % role, "path": str(venv_dir), "action": action, "detail": detail})
    if cfg["with_optional"]:
        actions.append(
            {
                "component": "optional image extras",
                "path": str(Path(cfg["prefix"]) / "media"),
                "action": "install into media venv",
                "detail": "rembg (background removal) + rawpy (RAW)",
            }
        )
    if cfg["install_skill"]:
        actions.append(
            {
                "component": "skill files",
                "path": str(dsh_home() / "skills"),
                "action": "copy",
                "detail": "skills/*.md",
            }
        )
    actions.append(
        {
            "component": "state file",
            "path": str(state_path()),
            "action": "write",
            "detail": "what the plugin reads back at runtime",
        }
    )
    return actions


def print_plan(console, plan):
    console.step("Plan", "nothing has been changed yet")
    console.table(
        ["component", "action", "path"],
        [[row["component"], row["action"], row["path"]] for row in plan],
        indent="  ",
    )
    estimated = sum(tree_size(row["path"])[1] for row in plan if Path(row["path"]).exists())
    if estimated:
        console.out("")
        console.out("  already on disk at these paths: %s" % human_size(estimated))


# ---------------------------------------------------------------------------
# plugin installation
# ---------------------------------------------------------------------------

def install_plugin(cfg, console):
    """Register the plugin in every requested DSH profile."""
    results = {}
    for profile in cfg["profiles"]:
        profile_dir = dsh_home() / "profiles" / profile
        installed = profile_dir / "node_modules" / "picturereader"
        entry = {"profile": profile, "dir": str(installed), "method": None, "bundles_entry": None}

        if cfg["pnpm"] is not None and cfg["dsh"] is not None:
            console.step(
                "Registering the plugin in DSH profile %r" % profile,
                "this runs `dsh plugin`, which forwards to pnpm and then reconciles dsh.profile.bundles",
            )
            code, _ = console.run(
                [cfg["dsh"], "plugin", "--profile", profile, "add", str(cfg["source"])],
                title="installing %s into the %r profile" % (cfg["source"], profile),
                check=False,
            )
            if code == 0:
                entry["method"] = "dsh-plugin"
                entry["spec"] = str(cfg["source"])
                verify_plugin_registration(profile_dir, profile, console, entry)
                results[profile] = entry
                continue
            console.warn("`dsh plugin add` failed (exit %d); falling back to manual materialization" % code)

        console.step(
            "Materializing the plugin manually in profile %r" % profile,
            "pnpm or dsh is unavailable, so the plugin tree is copied and registered by hand",
        )
        materialize_plugin(cfg["source"], profile_dir, installed, console)
        entry["method"] = "manual"
        entry["spec"] = "file:%s" % cfg["source"]
        register_in_profile_manifest(profile_dir, cfg["source"], console)
        verify_plugin_registration(profile_dir, profile, console, entry)
        results[profile] = entry
    return results


def materialize_plugin(source, profile_dir, installed, console):
    """Copy the plugin tree (and its runtime deps) into a profile by hand."""
    ignore = shutil.ignore_patterns(
        ".git", "node_modules", "tests", "fixtures-out", ".npmcache-local", "__pycache__", "*.pyc"
    )
    with console.heartbeat("copying the plugin tree to %s" % installed):
        if installed.exists():
            shutil.rmtree(installed)
        profile_dir.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source, installed, ignore=ignore)
    console.ok("copied %s" % installed)

    source_modules = Path(source) / "node_modules"
    target_modules = installed / "node_modules"
    copied = []
    for dep in RUNTIME_DEPS:
        src = source_modules / dep
        if src.exists():
            target_modules.mkdir(parents=True, exist_ok=True)
            shutil.copytree(src, target_modules / dep, dirs_exist_ok=True)
            copied.append(dep)
    if copied:
        console.ok("runtime dependencies copied: %s" % ", ".join(copied))
    else:
        console.warn("no runtime dependencies found in %s — run `npm install` in the plugin checkout first" % source_modules)


def register_in_profile_manifest(profile_dir, source, console):
    """Add the dependency and the bundle layer entry to the profile package.json."""
    manifest_path = profile_dir / "package.json"
    if not manifest_path.exists():
        raise SystemExit(
            "profile manifest is missing: %s — create the profile first by running `dsh --profile <name> --help`" % manifest_path
        )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    deps = manifest.setdefault("dependencies", {})
    deps["picturereader"] = "file:%s" % source
    dsh_section = manifest.setdefault("dsh", {})
    profile_section = dsh_section.setdefault("profile", {})
    bundles = profile_section.setdefault("bundles", [])
    if "picturereader" not in bundles:
        bundles.append("picturereader")
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    console.ok("profile manifest updated: dependency + dsh.profile.bundles entry")


def verify_plugin_registration(profile_dir, profile, console, entry):
    """Confirm the plugin is installed, declared and listed as a bundle layer."""
    installed = profile_dir / "node_modules" / "picturereader"
    manifest_path = profile_dir / "package.json"
    problems = []
    if not installed.exists():
        problems.append("plugin directory missing")
    if not manifest_path.exists():
        problems.append("profile package.json missing")
    else:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if "picturereader" not in (manifest.get("dependencies") or {}):
            problems.append("not listed in dependencies")
        bundles = ((manifest.get("dsh") or {}).get("profile") or {}).get("bundles") or []
        if "picturereader" not in bundles:
            problems.append("not listed in dsh.profile.bundles")
        entry["bundles_entry"] = "picturereader" in bundles
    for dep in RUNTIME_DEPS:
        if not (installed / "node_modules" / dep).exists() and not (profile_dir / "node_modules" / dep).exists():
            problems.append("runtime dependency %s is not resolvable" % dep)
    if problems:
        console.err("profile %r is not fully registered: %s" % (profile, "; ".join(problems)))
        entry["verified"] = False
    else:
        console.ok("profile %r verified: installed, declared and active as a bundle layer" % profile)
        entry["verified"] = True


# ---------------------------------------------------------------------------
# Python environments
# ---------------------------------------------------------------------------

def ensure_venv(role, spec, cfg, console):
    """Create (or reuse) one venv and install its pinned requirements."""
    venv_dir = Path(cfg["prefix"]) / role
    python = venv_python_path(venv_dir)
    interpreter = choose_interpreter(cfg["interpreters"], spec)
    if interpreter is None:
        raise SystemExit("no interpreter satisfies the requirements for the %r environment" % role)
    base_python, base_version = interpreter
    result = {
        "path": str(venv_dir),
        "python": str(python),
        "base_python": version_string(base_version),
        "roles": list(spec["roles"]),
        "packages": [],
        "label": spec["label"],
    }

    console.step(
        "Creating the %r environment" % role,
        "%s — Python %s (%s)" % (spec["label"], version_string(base_version), base_python),
    )

    if python.exists() and not cfg["force"]:
        usable = venv_is_usable(python)
        if usable:
            console.ok("existing environment reused: %s" % venv_dir)
        else:
            console.warn("existing environment is broken (the interpreter does not run); recreating it")
            shutil.rmtree(venv_dir, ignore_errors=True)
    if not python.exists():
        with console.heartbeat("creating the virtual environment (this can take a few seconds)"):
            created = subprocess.run(
                [base_python, "-m", "venv", str(venv_dir)],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
            )
        if created.returncode != 0 or not python.exists():
            console.err("could not create the virtual environment")
            console.out(created.stdout.strip()[-2000:])
            raise SystemExit(1)
        console.ok("virtual environment created at %s" % venv_dir)
        _, on_disk, files = tree_size(venv_dir)
        console.out("  size on disk: %s across %d files" % (human_size(on_disk), files))

    # requirements ---------------------------------------------------------
    req_file, lines = load_requirements(spec["requirements"])
    if not lines:
        raise SystemExit("requirements file is missing or empty: %s" % (HERE / "requirements" / spec["requirements"]))

    console.step("Installing Python packages into %r" % role, "from %s" % req_file)
    for line in lines:
        describe_download(console, package_name(line), package_version(line))
    cmd = [
        str(python),
        "-m",
        "pip",
        "install",
        "--progress-bar",
        "on",
        "--disable-pip-version-check",
        "--no-input",
    ]
    if cfg["index_url"]:
        console.out("  using package index: %s" % cfg["index_url"])
        cmd += ["--index-url", cfg["index_url"]]
    if cfg["locked"]:
        lock = req_file.with_suffix(".lock.txt")
        if not lock.exists():
            raise SystemExit(
                "--locked was requested but %s does not exist\n"
                "  Generate it from the pinned requirements with:\n"
                "    python3 -m pip download -r %s -d /tmp/pr-wheels --only-binary :all:\n"
                "    python3 -m pip hash /tmp/pr-wheels/* > %s" % (lock, req_file, lock)
            )
        cmd += ["--require-hashes", "-r", str(lock)]
    else:
        cmd += ["-r", str(req_file)]
    console.run(cmd, title="pip install (%d package(s))" % len(lines))
    result["packages"] = lines

    # Packages that must not resolve their own dependencies (see no_deps above).
    no_deps = spec.get("no_deps") or []
    if no_deps:
        console.step("Installing %r without dependencies" % role, "so the pinned headless builds are kept")
        console.run(
            [str(python), "-m", "pip", "install", "--progress-bar", "on", "--disable-pip-version-check", "--no-input"]
            + (["--index-url", cfg["index_url"]] if cfg["index_url"] else [])
            + ["--no-deps"]
            + list(no_deps),
            title="pip install --no-deps %s" % ", ".join(no_deps),
        )
        result["packages"] = lines + list(no_deps)

    if role == "media" and cfg["with_optional"]:
        _, optional = load_requirements(OPTIONAL_REQUIREMENTS)
        if optional:
            console.step("Installing optional image extras into %r" % role, "background removal and RAW support")
            for line in optional:
                describe_download(console, package_name(line), package_version(line))
            console.run(
                [str(python), "-m", "pip", "install", "--progress-bar", "on", "--disable-pip-version-check", "--no-input"]
                + (["--index-url", cfg["index_url"]] if cfg["index_url"] else [])
                + list(optional),
                title="pip install %s" % ", ".join(package_name(line) for line in optional),
            )
            result["packages"] = lines + optional

    return result


def venv_is_usable(python):
    try:
        result = subprocess.run(
            [str(python), "-c", "import sys; print(sys.version_info[:2])"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def verify_environment(role, python, console):
    """Import the packages this role needs and report their versions."""
    if role == "media":
        script = (
            "import fitz, PIL, cv2, piexif, json;"
            "print(json.dumps({'pymupdf': fitz.__doc__.split()[1] if fitz.__doc__ else 'ok',"
            "'Pillow': PIL.__version__, 'opencv': cv2.__version__, 'piexif': piexif.VERSION}))"
        )
        env = None
    elif role == "ocr":
        script = (
            "import json, cv2, onnxruntime, rapidocr;"
            "print(json.dumps({'rapidocr': getattr(rapidocr, '__version__', 'ok'),"
            "'onnxruntime': onnxruntime.__version__, 'opencv': cv2.__version__}))"
        )
        env = None
    else:
        # Importing paddleocr makes PaddleX create its cache directory, so the
        # cache location must already be set correctly here.
        script = "import paddleocr; print(paddleocr.__version__)"
        env = paddle_env()
    try:
        result = subprocess.run(
            [str(python), "-c", script], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=180, env=env
        )
    except (OSError, subprocess.SubprocessError) as exc:
        console.err("%s environment check could not run: %s" % (role, exc))
        return False
    if result.returncode != 0:
        console.err("%s environment check failed:" % role)
        console.out((result.stderr or result.stdout).strip()[-1500:])
        return False
    console.ok("%s environment imports fine: %s" % (role, result.stdout.strip()))
    return True


def warm_up_ocr(role, python, console):
    """Run one real recognition so the model cache is populated up front."""
    if role == "ocr":
        return _warm_up_rapid(python, console)
    return _warm_up_paddle(python, console)


def _warm_up_rapid(python, console):
    """Load both recognition models once, so the first tool call is instant."""
    console.step(
        "Warming up RapidOCR",
        "the first run downloads the detection and recognition models next to the package",
    )
    code, tail = console.run(
        [str(python), str(HERE / "ocr.py"), "--probe"],
        title="loading the detection and recognition models",
        check=False,
    )
    if code != 0:
        console.warn(
            "the warm-up run failed; the environment itself is installed, so retry after a network hiccup "
            "or run the same command by hand:"
        )
        console.out("  %s %s --probe" % (python, HERE / "ocr.py"))
        for line in tail[-6:]:
            console.out("  " + line)
        return False
    summary = tail[-1].strip() if tail else ""
    console.ok("model cache ready%s" % ((": " + summary[:200]) if summary else ""))
    return True


def _warm_up_paddle(python, console):
    """Legacy PaddleOCR warm-up."""
    if not WARMUP_IMAGE.exists():
        console.warn("warm-up image is missing (%s); the first image_ocr call will download the models" % WARMUP_IMAGE)
        return True
    console.step(
        "Warming up PaddleOCR",
        "the first run downloads the detection and recognition models into %s" % paddle_cache_dir(),
    )
    script = (
        "import json, sys\n"
        "from paddleocr import PaddleOCR\n"
        "ocr = PaddleOCR(lang='ch', use_doc_orientation_classify=False, use_doc_unwarping=False,"
        " use_textline_orientation=False, enable_mkldnn=False)\n"
        "result = ocr.predict(sys.argv[1])\n"
        "lines = sum(len(r.get('rec_texts') or []) for r in result)\n"
        "print(json.dumps({'lines': lines}))\n"
    )
    env = paddle_env()
    try:
        Path(env["PADDLE_PDX_CACHE_HOME"]).mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        console.warn("could not create the model cache directory %s: %s" % (env["PADDLE_PDX_CACHE_HOME"], exc))
    code, tail = console.run(
        [str(python), "-c", script, str(WARMUP_IMAGE)],
        title="running one recognition on %s" % WARMUP_IMAGE.name,
        env=env,
        check=False,
    )
    if code != 0:
        console.warn(
            "the warm-up run failed; the environment itself is installed, so retry after a network hiccup "
            "or run the same command by hand:"
        )
        console.out("  %s -c '<paddle script>' %s" % (python, WARMUP_IMAGE))
        for line in tail[-6:]:
            console.out("  " + line)
        return False
    recognized = None
    for line in reversed(tail):
        if line.strip().startswith("{"):
            try:
                recognized = json.loads(line.strip())["lines"]
            except (ValueError, KeyError):
                recognized = None
            break
    if recognized:
        console.ok("model cache ready — recognized %d line(s) in the warm-up image" % recognized)
    else:
        console.ok("model cache ready (the warm-up image produced no text lines, which is still a successful load)")
    return True


# ---------------------------------------------------------------------------
# skills
# ---------------------------------------------------------------------------

def install_skills(console):
    target_dir = dsh_home() / "skills"
    source_dir = REPO_ROOT / "skills"
    copied = []
    target_dir.mkdir(parents=True, exist_ok=True)
    for md in sorted(source_dir.glob("*.md")):
        shutil.copy2(md, target_dir / md.name)
        copied.append(md.name)
    console.step("Copying skill files", "%s -> %s" % (source_dir, target_dir))
    for name in copied:
        console.ok(name)
    return [str(target_dir / name) for name in copied]


# ---------------------------------------------------------------------------
# state file
# ---------------------------------------------------------------------------

def write_state(prefix, plugin_records, venv_records, console, skills, for_verify=False):
    state = {
        "schema": 1,
        "installed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "platform": sys.platform,
        "arch": os.uname().machine if hasattr(os, "uname") else "",
        "managed": not for_verify,
        "prefix": str(prefix),
        "plugin": {
            "source": str(REPO_ROOT),
            "profiles": plugin_records,
        },
        "venvs": venv_records,
        "caches": {"paddlex": str(paddle_cache_dir())},
        "tools": {"soffice": find_soffice()},
        "skills": skills,
    }
    path = state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    console.step("Writing the state file", str(path))
    console.item("profiles", ", ".join(plugin_records) or "none")
    console.item("venvs", ", ".join(venv_records) or "none")
    console.item("soffice", state["tools"]["soffice"] or "not found")
    return state


# ---------------------------------------------------------------------------
# verify
# ---------------------------------------------------------------------------

def verify_installation(console):
    """Check an existing installation: profiles, state file, environments."""
    console.step("Verifying the installation")
    path = state_path()
    if not path.exists():
        console.err("no state file at %s — this installation was not created by scripts/install.py" % path)
        return False
    state = json.loads(path.read_text(encoding="utf-8"))
    ok_all = True

    dsh = find_executable(("dsh",))
    for profile, record in (state.get("plugin", {}).get("profiles") or {}).items():
        installed = Path(record.get("dir", ""))
        present = installed.exists()
        if present:
            console.ok("profile %r: plugin present at %s" % (profile, installed))
        else:
            console.err("profile %r: plugin directory is missing (%s)" % (profile, installed))
            ok_all = False
        if dsh is not None:
            code, tail = console.run(
                [dsh, "--profile", profile, "--dump-config"],
                title="composing the profile tree to confirm the plugin is active",
                check=False,
            )
            if code == 0 and any("picturereader" in line for line in tail):
                console.ok("profile %r: picturereader is present in the composed tree" % profile)
            elif code == 0:
                console.warn("profile %r: the composed tree did not mention picturereader (re-run without --json to inspect)" % profile)
            else:
                console.warn("profile %r: could not compose the profile tree (see the output above)" % profile)

    for role, record in (state.get("venvs") or {}).items():
        python = Path(record.get("python", ""))
        if python.exists():
            console.ok("venv %r: %s" % (role, python))
            if not verify_environment(role, python, console):
                ok_all = False
        else:
            console.err("venv %r: interpreter missing (%s)" % (role, python))
            ok_all = False

    soffice = (state.get("tools") or {}).get("soffice")
    if soffice and Path(soffice).exists():
        console.ok("LibreOffice: %s" % soffice)
    else:
        console.warn("LibreOffice: not found — document_to_image cannot convert Office formats")

    console.raw("")
    console.raw(console.green("  verification passed") if ok_all else console.red("  verification found problems"))
    return ok_all


# ---------------------------------------------------------------------------
# selftest
# ---------------------------------------------------------------------------

def selftest():
    """Exercise the pure helpers without touching the machine."""
    failures = []

    def check(name, condition, detail=""):
        if condition:
            print("  ok   %s" % name)
        else:
            print("  FAIL %s %s" % (name, detail))
            failures.append(name)

    print("install.py selftest")

    # human_size / human_duration
    check("human_size bytes", human_size(0) == "0 B", human_size(0))
    check("human_size MB", human_size(195000000).endswith("MB"), human_size(195000000))
    check("human_duration sub-second", human_duration(0.5).endswith("s"), human_duration(0.5))
    check("human_duration minutes", human_duration(80).startswith("1m"), human_duration(80))

    # requirement parsing
    check("package_name", package_name("paddlepaddle==3.3.1") == "paddlepaddle")
    check("package_name with extras", package_name("paddlex[ocr-core]>=3.7") == "paddlex")
    check("package_version", package_version("Pillow==12.3.0") == "12.3.0")
    check("package_version absent", package_version("paddleocr") is None)
    media_file, media_lines = load_requirements("media.txt")
    check("media requirements load", bool(media_lines), str(media_file))
    ocr_file, ocr_lines = load_requirements("ocr.txt")
    check("ocr requirements load", bool(ocr_lines), str(ocr_file))
    paddle_file, paddle_lines = load_requirements("paddle.txt")
    check("paddle requirements load", bool(paddle_lines), str(paddle_file))
    check("no unpinned specifier", all("==" in line for line in (media_lines or []) + (ocr_lines or []) + (paddle_lines or [])))
    check("the default engine is the aarch64-installable one", DEFAULT_ENGINE_ROLE == "ocr")
    check("the default engine specification exists", DEFAULT_ENGINE_ROLE in VENV_SPECS)
    check("the default engine has no interpreter cap", VENV_SPECS[DEFAULT_ENGINE_ROLE]["max_python"] is None)
    check("the default engine defers a no-deps pass", bool(VENV_SPECS[DEFAULT_ENGINE_ROLE].get("no_deps")))

    # interpreter selection
    fake = [("/usr/bin/python3.14", (3, 14, 7)), ("/usr/bin/python3.13", (3, 13, 9)), ("/usr/bin/python3.12", (3, 12, 1))]
    check("media picks the newest", choose_interpreter(fake, VENV_SPECS["media"])[1] == (3, 14, 7))
    check("paddle caps at 3.13", choose_interpreter(fake, VENV_SPECS["paddle"])[1] == (3, 13, 9))
    only_new = [("/usr/bin/python3.14", (3, 14, 7))]
    check("paddle rejects an unsupported interpreter", choose_interpreter(only_new, VENV_SPECS["paddle"]) is None)
    check("unparseable list yields None", choose_interpreter([], VENV_SPECS["media"]) is None)

    # tree_size against a known tree
    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp) / "tree"
        (target / "sub").mkdir(parents=True)
        (target / "sub" / "a.bin").write_bytes(b"x" * 4096)
        (target / "b.bin").write_bytes(b"y" * 1024)
        apparent, on_disk, files = tree_size(target)
        check("tree_size file count", files == 2, files)
        check("tree_size apparent", apparent == 5120, apparent)
        check("tree_size on-disk is positive", on_disk > 0, on_disk)

    # plan building does not touch the machine
    cfg = {
        "profiles": ["web"],
        "prefix": "/tmp/picturereader-selftest",
        "engine_needed": True,
        "force": False,
        "with_optional": False,
        "install_skill": False,
        "pnpm": None,
    }
    plan = build_plan(cfg)
    check("plan mentions the profile", any("web" in row["component"] for row in plan))
    check("plan mentions both venvs", len([r for r in plan if "venv" in r["component"]]) == 2)
    check(
        "the plan names the default engine",
        any(("venv '%s'" % DEFAULT_ENGINE_ROLE) in r["component"] for r in plan),
    )
    check("plan mentions the state file", any("state file" in row["component"] for row in plan))

    print("")
    if failures:
        print("selftest FAILED: %d check(s)" % len(failures))
        return 1
    print("selftest passed")
    return 0


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------

def parse_args(argv):
    parser = argparse.ArgumentParser(
        prog="install.py",
        description="Install the picturereader plugin, its Python environments and its DSH registration.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Run scripts/uninstall.py to remove what this script created.",
    )
    parser.add_argument("--from", dest="source", default=str(REPO_ROOT), help="plugin checkout to install (default: this repository)")
    parser.add_argument("--profiles", default="web", help="comma-separated DSH profiles to install into (default: web)")
    parser.add_argument("--dsh", dest="dsh", default=None, help="path to the dsh executable when it is not on PATH")
    parser.add_argument("--skip-ocr", action="store_true", help="do not create the OCR environment")
    parser.add_argument(
        "--engine",
        choices=sorted(VENV_SPECS),
        default=DEFAULT_ENGINE_ROLE,
        help="which OCR environment to install (default: %s)" % DEFAULT_ENGINE_ROLE,
    )
    parser.add_argument("--with-optional", action="store_true", help="also install rembg (background removal) and rawpy (RAW)")
    parser.add_argument("--venv-prefix", dest="prefix", default=None, help="where to create the Python environments")
    parser.add_argument("--index-url", dest="index_url", default=None, help="Python package index to use (default: PyPI)")
    parser.add_argument("--locked", action="store_true", help="install strictly from the hashed *.lock.txt files")
    parser.add_argument("--install-skill", action="store_true", help="also copy skills/*.md into the DSH skills directory")
    parser.add_argument("--yes", "-y", action="store_true", help="do not ask for confirmation")
    parser.add_argument("--dry-run", action="store_true", help="print the plan and stop without changing anything")
    parser.add_argument("--verify", action="store_true", help="check an existing installation and exit")
    parser.add_argument("--force", action="store_true", help="recreate environments that already exist")
    parser.add_argument("--json", action="store_true", help="print a machine-readable summary on stdout")
    parser.add_argument("--quiet", action="store_true", help="only print step headings and errors")
    parser.add_argument("--verbose", action="store_true", help="print every command and extra detail")
    parser.add_argument("--color", choices=["auto", "always", "never"], default="auto", help="colour output (default: auto)")
    parser.add_argument("--selftest", action="store_true", help="run the installer's internal checks and exit")
    return parser.parse_args(argv)


def make_console(args):
    if args.quiet:
        level = Console.QUIET
    elif args.verbose:
        level = Console.VERBOSE
    else:
        level = Console.NORMAL
    return Console(level=level, color=args.color)


def main(argv=None):
    args = parse_args(argv if argv is not None else sys.argv[1:])

    if args.selftest:
        return selftest()

    console = make_console(args)
    started = time.time()
    console.raw("")
    console.raw(console.bold("picturereader installer"))
    console.raw("  %s" % platform_summary())

    if args.verify:
        return 0 if verify_installation(console) else 1

    profiles = [p.strip() for p in args.profiles.split(",") if p.strip()]
    if not profiles:
        console.err("--profiles must name at least one profile")
        return 1
    source = Path(args.source).resolve()
    if not (source / "package.json").exists():
        console.err("%s does not look like the picturereader checkout (no package.json)" % source)
        return 1

    cfg = {
        "profiles": profiles,
        "source": source,
        "prefix": Path(args.prefix).resolve() if args.prefix else default_venv_prefix(),
        "engine_needed": not args.skip_ocr,
        "engine_role": args.engine,
        "with_optional": args.with_optional,
        "install_skill": args.install_skill,
        "index_url": args.index_url,
        "locked": args.locked,
        "force": args.force,
        "dsh": args.dsh,
        "pnpm": None,
        "interpreters": [],
    }

    # ---- preflight -------------------------------------------------------
    pre = Preflight(console)
    if args.dsh:
        cfg["dsh"] = args.dsh
    if args.dsh and not Path(args.dsh).exists():
        console.err("--dsh points at %s, which does not exist" % args.dsh)
        return 1
    if not pre.run(profiles, engine_needed=cfg["engine_needed"], engine_role=cfg["engine_role"]):
        console.raw("")
        console.raw(console.red("  preflight failed — nothing was changed"))
        console.raw("  resolve the problems above and run the installer again")
        return 1
    cfg["dsh"] = args.dsh or pre.dsh
    cfg["pnpm"] = pre.pnpm if args.dsh is None else find_executable(("pnpm",)) or pre.pnpm
    cfg["interpreters"] = pre.interpreters

    # ---- plan ------------------------------------------------------------
    plan = build_plan(cfg)
    print_plan(console, plan)
    if args.dry_run:
        console.raw("")
        console.raw("  dry run: nothing was changed")
        return 0
    if not args.yes:
        console.raw("")
        try:
            answer = input("Proceed with this plan? [y/N] ").strip().lower()
        except EOFError:
            answer = "n"
        if answer not in ("y", "yes"):
            console.raw("  aborted at your request; nothing was changed")
            return 1

    # ---- work ------------------------------------------------------------
    # plugin registration (1) + environments heading (1) + two steps per venv
    # (create, install) + optional extras (1) + OCR warm-up (1) + skills (1) +
    # state file (1). The Console also grows the total if a step appears that
    # was not predicted, so the counter never reads "8/5".
    console.set_total_steps(
        4
        + 2 * (1 + (1 if cfg["engine_needed"] else 0))
        + (1 if cfg["with_optional"] else 0)
        + (1 if cfg["engine_needed"] else 0)
        + (1 if cfg["install_skill"] else 0)
    )
    venv_records = {}
    plugin_records = {}
    skills = []
    plan_failed = False
    try:
        plugin_records = install_plugin(cfg, console)

        console.step("Creating the Python environments", "under %s" % cfg["prefix"])
        (cfg["prefix"]).mkdir(parents=True, exist_ok=True)
        media = ensure_venv("media", VENV_SPECS["media"], cfg, console)
        if not verify_environment("media", media["python"], console):
            plan_failed = True
        venv_records["media"] = media

        if cfg["engine_needed"]:
            role = cfg["engine_role"]
            engine = ensure_venv(role, VENV_SPECS[role], cfg, console)
            if not verify_environment(role, engine["python"], console):
                plan_failed = True
            venv_records[role] = engine
            if not warm_up_ocr(role, engine["python"], console):
                console.warn("the OCR environment works but its model cache is not warm yet")

        if cfg["install_skill"]:
            skills = install_skills(console)

        for role, record in venv_records.items():
            _, on_disk, files = tree_size(record["path"])
            record["size_on_disk_bytes"] = on_disk
            record["file_count"] = files
    except KeyboardInterrupt:
        console.raw("")
        console.err("interrupted — no state file was written")
        console.out("  remove any half-created environments with: python3 scripts/uninstall.py --purge-external %s" % cfg["prefix"])
        return 130

    write_state(cfg["prefix"], plugin_records, venv_records, console, skills)

    # ---- summary ---------------------------------------------------------
    console.raw("")
    console.raw(console.green(console.bold("  Installation finished in %s" % human_duration(time.time() - started))))
    console.raw("")
    console.table(
        ["component", "path", "on disk"],
        [[role, record["path"], human_size(record.get("size_on_disk_bytes", 0))] for role, record in venv_records.items()]
        + [["plugin (%s)" % profile, record["dir"], human_size(tree_size(record["dir"])[1])] for profile, record in plugin_records.items()],
    )
    console.raw("")
    console.out("  Next steps")
    console.out("    1. Restart DSH so the tool schemas and the settings card reload.")
    console.out("    2. In the model picker choose a model marked \"(Vision)\" to paste images with thumbnails.")
    console.out("    3. Check the setup at any time with: python3 scripts/install.py --verify")
    if not cfg["engine_needed"]:
        console.out("    note: --skip-ocr was used, so image_ocr will not work until you install the OCR environment.")
    if pre.soffice is None:
        console.out("    note: LibreOffice was not found; document_to_image needs it for Office formats.")
    console.out("")

    if args.json:
        print(
            json.dumps(
                {
                    "ok": not plan_failed,
                    "prefix": str(cfg["prefix"]),
                    "state_file": str(state_path()),
                    "profiles": plugin_records,
                    "venvs": venv_records,
                    "skills": skills,
                    "warnings": pre.notes,
                    "duration_seconds": round(time.time() - started, 2),
                },
                indent=2,
            )
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
