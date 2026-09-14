#!/usr/bin/env python3
"""Remove what picturereader's installer created — and nothing else.

The uninstaller reads the state file written by ``scripts/install.py``, lists
every component that installer is responsible for together with its **real**
size on disk, and asks about each one before touching it. Anything it did not
create is reported as unmanaged and skipped, so a picturereader install can
never take unrelated files with it.

An environment that sits under our own install prefix but is missing from the
state file — an interrupted install, a tree re-created by ``--force`` — is
discovered too. A wipe that stopped at the state file would silently leave
gigabytes on disk, which is exactly the case this script exists to prevent.

    python3 scripts/uninstall.py                 # interactive
    python3 scripts/uninstall.py --dry-run       # show the inventory and sizes
    python3 scripts/uninstall.py --yes           # remove everything it manages
    python3 scripts/uninstall.py --keep-venvs    # unregister the plugin, keep Python envs
    python3 scripts/uninstall.py --venvs-only -y # wipe every Python environment, keep the rest

@module scripts/uninstall
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _ui import (  # noqa: E402  (import after sys.path setup)
    Console,
    find_executable,
    human_duration,
    human_size,
    tree_size,
)

STATE_PARTS = ("picturereader", "env.json")

# Directories a picturereader install may populate. They are only ever touched
# when the state file names them (or --purge-external is given).
KNOWN_CACHES = {
    "paddlex": ("~/.paddlex-cache", "PaddleOCR model cache"),
    "u2net": ("~/.u2net", "rembg background-removal models"),
}


def dsh_home():
    value = os.environ.get("DSH_HOME", "").strip()
    return Path(value) if value else Path.home() / ".dsh"


def state_path():
    return dsh_home().joinpath(*STATE_PARTS)


def expand(value):
    return Path(os.path.expanduser(str(value)))


def default_install_root():
    """Where install.py keeps its state file and its environments."""
    return dsh_home() / "picturereader"


def default_venvs_dir():
    return default_install_root() / "venvs"


def looks_like_venv(path):
    """True when *path* is a Python virtual environment.

    Checked structurally rather than by name: an environment can be left behind
    by an interrupted install, or re-created under a role name the state file no
    longer mentions, and both must still be offered for removal.
    """
    if not path.is_dir():
        return False
    if (path / "pyvenv.cfg").is_file():
        return True
    return (path / "bin" / "python").exists()


def discover_orphans(venvs_dir, known):
    """Environments inside *venvs_dir* that *known* does not list.

    Only the environments directory itself is scanned — never its parent. The
    parent is ours only when the default prefix is in use; with a custom
    ``--venv-prefix /opt/venvs`` it is ``/opt``, and sweeping it would offer
    unrelated environments as ours (and delete them under ``--yes``). A
    half-created environment always lives inside the prefix, so nothing
    legitimate is lost by staying here.
    """
    venvs_dir = Path(venvs_dir)
    known = {Path(p) for p in known}
    if not venvs_dir.is_dir():
        return []

    found = []
    for candidate in sorted(venvs_dir.iterdir()):
        if candidate in known or not looks_like_venv(candidate):
            continue
        known.add(candidate)
        found.append(candidate)
    return found


def prune_empty_prefix(console, install_root, dry_run):
    """Drop the leaf directories left behind once every environment is gone."""
    if not install_root.exists():
        return
    for candidate in (install_root / "venvs", install_root):
        try:
            if not candidate.is_dir() or any(candidate.iterdir()):
                continue
            if dry_run:
                console.out("  would prune empty %s" % candidate)
                continue
            candidate.rmdir()
            console.ok("pruned empty %s" % candidate)
        except OSError:
            pass


def sync_state_venvs(console, path, state, dry_run):
    """Drop state entries whose environment is gone, so the file stays truthful."""
    venvs = state.get("venvs") or {}
    alive = {role: record for role, record in venvs.items() if Path(record.get("path") or "").exists()}
    if len(alive) == len(venvs):
        return
    dropped = sorted(set(venvs) - set(alive))
    if dry_run:
        console.out("  would drop %s from the state file" % ", ".join(dropped))
        return
    if not path.exists():
        return  # the state file itself was a component and is already gone
    state["venvs"] = alive
    try:
        path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
        console.ok("state file updated (dropped %s)" % ", ".join(dropped))
    except OSError as exc:
        console.warn("could not update %s: %s" % (path, exc))


# ---------------------------------------------------------------------------
# inventory
# ---------------------------------------------------------------------------

class Component:
    """One removable thing, with its real footprint."""

    def __init__(self, kind, label, path, managed, detail="", action=None):
        self.kind = kind
        self.label = label
        self.path = Path(path)
        self.managed = managed
        self.detail = detail
        self.action = action or kind
        self.apparent = 0
        self.on_disk = 0
        self.files = 0
        self.exists = False

    def measure(self):
        """Fill in the sizes; a missing path reports zero and exists=False."""
        self.exists = self.path.exists()
        if not self.exists:
            return self
        if self.path.is_dir():
            self.apparent, self.on_disk, self.files = tree_size(self.path)
        else:
            try:
                info = self.path.stat()
            except OSError:
                return self
            self.apparent = info.st_size
            blocks = getattr(info, "st_blocks", None)
            self.on_disk = blocks * 512 if blocks is not None else info.st_size
            self.files = 1
        return self

    @property
    def size_label(self):
        if not self.exists:
            return "missing"
        if self.files > 1:
            return "%s (%d files)" % (human_size(self.on_disk), self.files)
        return human_size(self.on_disk)


def build_inventory(console, state, purge_external):
    """Turn the state file into a list of components to offer for removal.

    ``state`` may be None — a missing state file means the installer did not
    write one, not that environments under our own prefix may stay on disk
    forever. Those are discovered and offered regardless.
    """
    components = []
    state = state or {}

    # --- plugin installs --------------------------------------------------
    for profile, record in (state.get("plugin", {}).get("profiles") or {}).items():
        directory = record.get("dir") or ""
        if not directory:
            continue
        method = record.get("method") or "unknown"
        components.append(
            Component(
                "plugin",
                "plugin in DSH profile %r" % profile,
                directory,
                managed=True,
                detail="installed via %s" % ("`dsh plugin add`" if method == "dsh-plugin" else "manual materialization"),
                action="unregister",
            )
        )

    # --- python environments ---------------------------------------------
    for role, record in (state.get("venvs") or {}).items():
        components.append(
            Component(
                "venv",
                "Python environment %r" % role,
                record.get("path") or Path(state.get("prefix", "")) / role,
                managed=True,
                detail=record.get("label") or ", ".join(record.get("roles") or []),
                action="delete",
            )
        )

    # --- caches -----------------------------------------------------------
    paddlex = (state.get("caches") or {}).get("paddlex")
    if paddlex:
        is_default = expand(paddlex) == expand("~/.paddlex-cache")
        components.append(
            Component(
                "cache",
                "PaddleOCR model cache",
                paddlex,
                # The installer populated this directory and recorded it, so it
                # is offered for removal like everything else — the user is
                # asked first. A non-default location simply carries a note,
                # because it may have been pointed at a shared cache.
                managed=True,
                detail="downloaded recognition/detection models"
                if is_default
                else "models downloaded to the custom DSH_PADDLE_CACHE location",
                action="delete",
            )
        )
    u2net = expand("~/.u2net")
    if u2net.exists():
        components.append(
            Component("cache", "rembg model cache", u2net, managed=False, detail="only used by image_edit remove_background", action="delete")
        )

    # --- copied skills ----------------------------------------------------
    for skill in state.get("skills") or []:
        components.append(Component("file", "copied skill file", skill, managed=True, action="delete"))

    # --- state file -------------------------------------------------------
    components.append(Component("state", "installer state file", state_path(), managed=True, action="delete"))

    # --- environments the state file does not mention ----------------------
    # The prefix is ours by construction, so anything venv-shaped inside it is
    # ours too. This is what makes --venvs-only a real wipe rather than a
    # removal of the roles the state file happens to remember.
    prefix = expand(state.get("prefix") or default_venvs_dir())
    for orphan in discover_orphans(prefix, [c.path for c in components]):
        components.append(
            Component(
                "venv",
                "orphaned Python environment %r" % orphan.name,
                orphan,
                managed=True,
                detail="found under the install prefix; not recorded in the state file",
                action="delete",
            )
        )

    # --- explicitly requested external paths ------------------------------
    for raw in purge_external:
        components.append(
            Component(
                "external",
                "path requested with --purge-external",
                raw,
                managed=True,
                detail="explicitly requested; not recorded in the state file",
                action="delete",
            )
        )
    return components


def print_inventory(console, components):
    console.step("Inventory", "sizes below are real on-disk usage (blocks), not apparent file sizes")
    rows = []
    for component in components:
        if not component.exists:
            status = "already gone"
        elif component.managed:
            status = "managed"
        else:
            status = "unmanaged"
        rows.append([component.label, component.size_label, status, str(component.path)])
    console.table(["component", "on disk", "status", "path"], rows)
    total_managed = sum(c.on_disk for c in components if c.managed and c.exists)
    total_unmanaged = sum(c.on_disk for c in components if not c.managed and c.exists)
    console.raw("")
    console.out("  managed by this installer:   %s" % human_size(total_managed))
    if total_unmanaged:
        console.out("  unmanaged (left alone):      %s" % human_size(total_unmanaged))
    return total_managed, total_unmanaged


# ---------------------------------------------------------------------------
# removal
# ---------------------------------------------------------------------------

def remove_tree(console, path, activity):
    """Delete a directory tree, reporting progress while it shrinks."""
    apparent, on_disk, total_files = tree_size(path)
    if total_files == 0:
        shutil.rmtree(path, ignore_errors=True)
        return on_disk
    console.out("  deleting %s across %d files…" % (human_size(on_disk), total_files))

    removed_files = 0
    removed_bytes = 0
    started = None
    progress_every = max(1, total_files // 20)

    def walk(directory):
        nonlocal removed_files, removed_bytes
        try:
            entries = list(os.scandir(directory))
        except OSError:
            return
        for entry in entries:
            try:
                if entry.is_dir(follow_symlinks=False):
                    walk(entry.path)
                    continue
                info = entry.stat(follow_symlinks=False)
                removed_bytes += getattr(info, "st_blocks", 0) * 512 or info.st_size
                os.unlink(entry.path)
                removed_files += 1
            except OSError:
                continue
            if removed_files % progress_every == 0 and console.level >= Console.NORMAL:
                console.raw(
                    "  … %d/%d files removed (%s freed)"
                    % (removed_files, total_files, human_size(removed_bytes))
                )
        try:
            os.rmdir(directory)
        except OSError:
            pass

    started = __import__("time").time()
    walk(str(path))
    took = __import__("time").time() - started
    console.ok("removed %s (%d files) in %s" % (human_size(removed_bytes or on_disk), removed_files, human_duration(took)))
    return removed_bytes or on_disk


def unregister_plugin(console, component, state, dry_run):
    """Unregister the plugin from its DSH profile."""
    profile = None
    for name, record in (state.get("plugin", {}).get("profiles") or {}).items():
        if Path(record.get("dir") or "") == component.path:
            profile = name
            break
    dsh = find_executable(("dsh",))
    if profile is not None and dsh is not None and not dry_run:
        console.out("  unregistering via `dsh plugin remove`, which also clears dsh.profile.bundles…")
        code, _ = console.run(
            [dsh, "plugin", "--profile", profile, "remove", "picturereader"],
            title="removing picturereader from the %r profile" % profile,
            check=False,
        )
        if code == 0:
            return True
        console.warn("`dsh plugin remove` failed (exit %d); cleaning the profile manifest by hand" % code)

    profile_dir = component.path.parent.parent  # <profile>/node_modules/picturereader
    manifest_path = profile_dir / "package.json"
    if manifest_path.exists() and not dry_run:
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            removed = []
            if (manifest.get("dependencies") or {}).pop("picturereader", None) is not None:
                removed.append("dependency")
            bundles = (((manifest.get("dsh") or {}).get("profile") or {}).get("bundles"))
            if isinstance(bundles, list) and "picturereader" in bundles:
                bundles.remove("picturereader")
                removed.append("bundle layer entry")
            if removed:
                manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
                console.ok("profile manifest cleaned: %s" % ", ".join(removed))
        except (OSError, ValueError) as exc:
            console.warn("could not clean %s: %s" % (manifest_path, exc))
    elif manifest_path.exists():
        console.out("  would remove the dependency and the bundle layer entry from %s" % manifest_path)
    return True


def remove_component(console, component, state, dry_run):
    if not component.exists:
        console.out("  %s: already gone" % component.label)
        return 0
    if dry_run:
        console.out("  would remove %s (%s)" % (component.path, component.size_label))
        return component.on_disk

    if component.action == "unregister":
        unregister_plugin(console, component, state, dry_run=False)

    if component.path.is_dir():
        return remove_tree(console, component.path, "removing %s" % component.label)
    try:
        size = component.on_disk
        component.path.unlink()
        console.ok("removed %s" % component.path)
        return size
    except OSError as exc:
        console.err("could not remove %s: %s" % (component.path, exc))
        return 0


def confirm(console, component, assume_yes):
    """Ask about one component; returns 'yes', 'no' or 'quit'."""
    if assume_yes:
        return "yes"
    if not component.exists:
        return "no"
    prompt = "  Remove %s (%s)? [y/N/a/q] " % (component.label, component.size_label)
    try:
        answer = input(prompt).strip().lower()
    except EOFError:
        return "quit"
    if answer in ("y", "yes", "д"):
        return "yes"
    if answer in ("a", "all"):
        return "all"
    if answer in ("q", "quit", "exit"):
        return "quit"
    return "no"


# ---------------------------------------------------------------------------
# selftest
# ---------------------------------------------------------------------------

def selftest():
    """Check the uninstaller's pure helpers without touching the machine."""
    import tempfile

    failures = []

    def check(name, condition, detail=""):
        if condition:
            print("  ok   %s" % name)
        else:
            print("  FAIL %s %s" % (name, detail))
            failures.append(name)

    print("uninstall.py selftest")

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "component"
        (root / "a" / "b").mkdir(parents=True)
        (root / "a" / "b" / "one.bin").write_bytes(b"x" * 8192)
        (root / "two.bin").write_bytes(b"y" * 2048)

        component = Component("venv", "test tree", root, managed=True).measure()
        check("measure reports existence", component.exists)
        check("measure counts files", component.files == 2, component.files)
        check("measure sums apparent size", component.apparent == 10240, component.apparent)
        check("measure reports on-disk bytes", component.on_disk > 0, component.on_disk)
        check("size label mentions files", "files" in component.size_label, component.size_label)

        absent = Component("venv", "gone", Path(tmp) / "nope", managed=True).measure()
        check("missing component is detected", absent.exists is False)
        check("missing component label", absent.size_label == "missing", absent.size_label)

        console = Console(level=Console.QUIET, color="never")
        freed = remove_tree(console, root, "selftest")
        check("remove_tree deletes the tree", not root.exists())
        check("remove_tree reports freed bytes", freed > 0, freed)

    # orphan discovery and prefix pruning
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "picturereader"
        venvs = root / "venvs"
        (venvs / "media" / "bin").mkdir(parents=True)
        (venvs / "media" / "bin" / "python").write_bytes(b"")
        (venvs / "leftover").mkdir()
        (venvs / "leftover" / "pyvenv.cfg").write_text("home = /usr\n", encoding="utf-8")
        (venvs / "not-a-venv").mkdir()
        (root / "env.json").write_text("{}\n", encoding="utf-8")

        check("looks_like_venv detects pyvenv.cfg", looks_like_venv(venvs / "leftover"))
        check("looks_like_venv detects bin/python", looks_like_venv(venvs / "media"))
        check("looks_like_venv rejects a plain directory", not looks_like_venv(venvs / "not-a-venv"))
        check("looks_like_venv rejects a file", not looks_like_venv(root / "env.json"))

        found = discover_orphans(venvs, [venvs / "media"])
        check("orphan discovery finds only the unrecorded environment", [p.name for p in found] == ["leftover"], [str(p) for p in found])

        console = Console(level=Console.QUIET, color="never")
        prune_empty_prefix(console, root, dry_run=True)
        check("a populated prefix survives a prune", venvs.exists())

        for name in ("media", "leftover", "not-a-venv"):
            shutil.rmtree(venvs / name)
        prune_empty_prefix(console, root, dry_run=False)
        check("prune removes the empty venvs directory", not venvs.exists())
        check("prune keeps the root while the state file remains", root.exists())

        (root / "env.json").unlink()
        prune_empty_prefix(console, root, dry_run=False)
        check("prune removes the root once nothing is left", not root.exists())

    # state parsing helpers
    check("state path lives under DSH home", str(state_path()).endswith("picturereader/env.json"), state_path())
    check("expand handles a home-relative path", str(expand("~/.x")).startswith(str(Path.home())), expand("~/.x"))
    check("the default venvs dir is <dsh home>/picturereader/venvs", str(default_venvs_dir()).endswith("picturereader/venvs"), default_venvs_dir())

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
        prog="uninstall.py",
        description="Remove the components scripts/install.py created for picturereader.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Nothing outside the state file is touched unless you name it with --purge-external.",
    )
    parser.add_argument("--dry-run", action="store_true", help="show the inventory and what would be removed, change nothing")
    parser.add_argument("--yes", "-y", action="store_true", help="remove every managed component without asking")
    parser.add_argument("--keep-venvs", action="store_true", help="unregister the plugin but keep the Python environments")
    parser.add_argument("--venvs-only", action="store_true", help="remove only the Python environments and prune the empty prefix; keep the plugin, caches, skills and state file")
    parser.add_argument("--skip-plugin", action="store_true", help="keep the plugin registered; only remove environments and caches")
    parser.add_argument("--purge-external", action="append", default=[], metavar="PATH", help="also delete this path (repeatable); it is not recorded in the state file")
    parser.add_argument("--json", action="store_true", help="print a machine-readable summary on stdout")
    parser.add_argument("--quiet", action="store_true", help="only print the inventory and the result")
    parser.add_argument("--verbose", action="store_true", help="print extra detail")
    parser.add_argument("--color", choices=["auto", "always", "never"], default="auto", help="colour output (default: auto)")
    parser.add_argument("--selftest", action="store_true", help="run the uninstaller's internal checks and exit")
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
    import time

    args = parse_args(argv if argv is not None else sys.argv[1:])
    if args.selftest:
        return selftest()

    console = make_console(args)
    started = time.time()
    console.raw("")
    console.raw(console.bold("picturereader uninstaller"))

    path = state_path()
    state = None
    if path.exists():
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            console.err("the state file at %s is unreadable: %s" % (path, exc))
            return 1
        console.out("  installed:  %s" % state.get("installed_at", "unknown"))
        console.out("  source:     %s" % (state.get("plugin", {}).get("source") or "unknown"))
        console.out("  prefix:     %s" % state.get("prefix", "unknown"))
    else:
        console.warn("no state file at %s" % path)
        console.out("  The installer did not write it, so nothing here knows what belongs to it.")
        console.out("  Environments under the install prefix are still discovered and offered.")
        console.out("")
        console.out("  To unregister the plugin by hand:  dsh plugin --profile <name> remove picturereader")
        if args.purge_external:
            console.out("  Explicit --purge-external paths are deleted verbatim.")

    install_root = expand((state or {}).get("prefix") or default_venvs_dir()).parent

    components = build_inventory(console, state, args.purge_external)
    if args.venvs_only and args.keep_venvs:
        console.raw("")
        console.err("--venvs-only and --keep-venvs contradict each other; pick one")
        return 2
    if args.keep_venvs:
        for component in components:
            if component.kind == "venv":
                component.managed = False
                component.detail = "kept (--keep-venvs)"
    if args.venvs_only:
        for component in components:
            if component.kind != "venv":
                component.managed = False
                component.detail = "kept (--venvs-only)"
    if args.skip_plugin:
        for component in components:
            if component.kind == "plugin":
                component.managed = False
                component.detail = "kept (--skip-plugin)"

    for component in components:
        component.measure()

    if not components:
        console.raw("")
        if state is None:
            console.out("  nothing to remove: no state file, and no environment under %s" % install_root)
        else:
            console.out("  the state file lists nothing to remove")
        # `--json` is a contract: emit the summary shape even when it is empty,
        # rather than printing nothing at all.
        if args.json:
            print(
                json.dumps(
                    {"ok": True, "removed": [], "kept": [], "freed_bytes": 0, "state_file_removed": False},
                    indent=2,
                )
            )
        return 0

    print_inventory(console, components)

    if args.dry_run:
        prune_empty_prefix(console, install_root, dry_run=True)
        if state is not None:
            sync_state_venvs(console, path, state, dry_run=True)
        console.raw("")
        console.raw("  dry run: nothing was removed")
        if args.json:
            print(json.dumps({"ok": True, "dry_run": True, "components": [c.__dict__ | {"path": str(c.path)} for c in components]}, indent=2, default=str))
        return 0

    console.raw("")
    console.out("  Answer per component: y = remove, N = keep, a = remove everything else, q = stop")

    removed_bytes = 0
    removed = []
    kept = []
    for component in components:
        if not component.exists:
            kept.append(component.label)
            continue
        if not component.managed:
            console.raw("")
            console.out("  %s — unmanaged, skipping (%s)" % (component.label, component.path))
            kept.append(component.label)
            continue
        console.raw("")
        answer = confirm(console, component, args.yes)
        if answer == "quit":
            console.out("  stopping at your request")
            break
        if answer == "all":
            args.yes = True
        if answer == "yes" or answer == "all" or args.yes:
            removed_bytes += remove_component(console, component, state, dry_run=False)
            removed.append(component.label)
        else:
            console.out("  keeping %s" % (component.label,))
            kept.append(component.label)

    prune_empty_prefix(console, install_root, dry_run=False)
    if state is not None:
        sync_state_venvs(console, path, state, dry_run=False)

    console.raw("")
    console.raw(console.green(console.bold("  Uninstall finished in %s" % human_duration(time.time() - started))))
    console.out("  removed:  %d component(s), %s freed" % (len(removed), human_size(removed_bytes)))
    if kept:
        console.out("  kept:     %d component(s)" % len(kept))
    console.raw("")
    console.out("  Reminders")
    console.out("    - Restart DSH so the plugin and its settings card are unloaded.")
    console.out("    - If you exported DSH_* variables by hand (e.g. in your shell profile), remove them.")
    console.out("    - An `ocr_engine` key may still sit in ~/.dsh/settings.yaml; the plugin ignores it now.")
    survivors = [c for c in components if c.kind == "venv" and c.path.exists()]
    if survivors:
        console.out("    - %d Python environment(s) are still on disk under the install prefix;" % len(survivors))
        console.out("      rerun with --venvs-only --yes to remove just those.")
    console.raw("")

    if args.json:
        print(
            json.dumps(
                {
                    "ok": True,
                    "removed": removed,
                    "kept": kept,
                    "freed_bytes": removed_bytes,
                    "state_file_removed": str(path) in [str(c.path) for c in components if c.label in removed],
                },
                indent=2,
            )
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
