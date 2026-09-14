#!/data/data/com.termux/files/usr/bin/bash
#
# picturereader — Termux "level 3" bootstrap.
#
# Sets up the plugin's Python environments on an Android device, where pip
# cannot install them into Termux itself:
#
#   * `opencv-python-headless`, `pyclipper` and `shapely` publish no
#     Termux-compatible wheels (Termux uses Bionic, the wheels are manylinux)
#     and would have to be compiled from source;
#   * Debian arm64 has a manylinux-compatible glibc, so inside a
#     `proot-distro` rootfs every dependency resolves to a prebuilt aarch64
#     wheel and nothing is ever compiled.
#
# Both facts depend on the environments being built with the rootfs's *own*
# interpreter. proot-distro deliberately keeps Termux's $PREFIX/bin last in the
# guest PATH, so a rootfs that has no python3 of its own still answers
# `command -v python3` -- with Termux's Bionic interpreter, whose pip rejects
# every manylinux wheel and falls back to compiling from source. Every guest
# command below therefore names an absolute /usr/bin path, and a venv whose base
# prefix is not /usr is rebuilt instead of reused.
#
# The script works with proot-distro 4.x and 5.x: the rootfs is looked up in the
# current `containers/<name>/rootfs` layout first, then in the older
# `installed-rootfs/<name>` one.
#
# Two environments are created inside the rootfs:
#
#   media -> PyMuPDF + Pillow + OpenCV + piexif, used by document_to_image and
#            image_edit. Termux does package python-pymupdf and python-pillow,
#            but not OpenCV, and the plugin needs one interpreter that has all
#            of them — so this lives in the rootfs too.
#   ocr   -> RapidOCR on ONNX Runtime, the default OCR engine.
#
# Deliberately NOT installed:
#
#   * LibreOffice (~1.5 GB). It is only needed to convert Office documents to
#     PDF; pure PDFs are rendered by PyMuPDF directly. Install it inside the
#     rootfs only if you actually receive .docx/.xlsx/.pptx files:
#       proot-distro login debian -- apt-get install -y libreoffice-core
#   * rembg / rawpy (background removal, RAW). They are optional extras that
#     pull packages Termux cannot provide, so image_edit hides the actions that
#     need them while running under Termux.
#
# The script is idempotent: re-running it repairs the environments in place.
#
# Usage:
#   bash scripts/termux/setup.sh                  # install or repair, then register in DSH
#   bash scripts/termux/setup.sh --verify         # check only, change nothing
#   bash scripts/termux/setup.sh --profile tui    # register in a profile other than "web"
#   bash scripts/termux/setup.sh --skip-plugin    # environments only, no DSH registration
#   bash scripts/termux/setup.sh --help
#
# Environment:
#   PICREADER_DISTRO      proot-distro container to use (default: debian)
#   PICREADER_PROFILE     DSH profile to register in (default: web)
#   PICREADER_HEARTBEAT   seconds between "still running" lines (default: 15,
#                         0 turns the ticker off)

set -euo pipefail

DISTRO="${PICREADER_DISTRO:-debian}"
ROOT_VENVS="/opt/picturereader"                          # inside the rootfs
RAPIDOCR_PIN="rapidocr==3.9.2"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REQ_DIR="$SCRIPT_DIR/../requirements"

# --------------------------------------------------------------------------
# pretty output
# --------------------------------------------------------------------------
if [ -t 1 ]; then BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; OFF=$'\033[0m'
else BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; OFF=""; fi
step() { printf '\n%s▸ %s%s\n' "$BOLD" "$*" "$OFF"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$OFF" "$*"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$OFF" "$*"; }
note() { printf '    %s%s%s\n' "$DIM" "$*" "$OFF"; }
fail() { printf '  %s✗%s %s\n' "$RED" "$OFF" "$*" >&2; }
die()  { printf '\n%serror:%s %s\n' "$RED" "$OFF" "$*" >&2; exit 1; }

SCRIPT_START=$(date +%s)
HEARTBEAT_SECONDS="${PICREADER_HEARTBEAT:-15}"

elapsed_human() {
  local total="${1:-0}"
  if [ "$total" -lt 60 ]; then printf '%ss' "$total"
  else printf '%sm%02ss' $(( total / 60 )) $(( total % 60 ))
  fi
}

has_tty() { [ -t 2 ]; }

# Runs "$@" with its output wired straight to the terminal, so pip and apt keep
# printing what they are doing instead of sitting behind --quiet; adds a
# "still running" line on stderr every HEARTBEAT_SECONDS, because the long
# steps here (a rootfs download, a wheel cache fill, a model fetch) are quiet
# for minutes at a time; and ends with one verdict line carrying the elapsed
# time. The child status is returned to the caller.
#
# PICREADER_HEARTBEAT=0 disables the ticker (useful for non-interactive logs).
with_heartbeat() {
  local label="$1"; shift
  local start now rc=0 ticker=""
  start=$(date +%s)
  note "$label"
  if has_tty && [ "$HEARTBEAT_SECONDS" -gt 0 ]; then
    (
      while :; do
        sleep "$HEARTBEAT_SECONDS" || exit 0
        now=$(date +%s)
        printf '\r\033[K%s    · %s — still running, %s elapsed%s' \
          "$DIM" "$label" "$(elapsed_human $(( now - start )))" "$OFF" >&2
      done
    ) &
    ticker=$!
  fi
  "$@" || rc=$?
  if [ -n "$ticker" ]; then
    kill "$ticker" 2>/dev/null || true
    wait "$ticker" 2>/dev/null || true
    printf '\r\033[K' >&2
  fi
  now=$(date +%s)
  if [ "$rc" = 0 ]; then
    ok "$label — $(elapsed_human $(( now - start )))"
  else
    fail "$label — failed after $(elapsed_human $(( now - start ))) (exit $rc)"
  fi
  return "$rc"
}

# The pinned requirement names of a requirements file, for the log.
req_pins() {
  sed -e 's/#.*//' -e '/^[[:space:]]*$/d' "$1" | tr '\n' ' '
}

VERIFY_ONLY=0
PROFILE="${PICREADER_PROFILE:-web}"
REGISTER_PLUGIN=1
while [ $# -gt 0 ]; do
  case "$1" in
    --verify)     VERIFY_ONLY=1 ;;
    --profile)    shift; [ $# -gt 0 ] || die "--profile needs a profile name"; PROFILE="$1" ;;
    --profile=*)  PROFILE="${1#*=}" ;;
    --skip-plugin) REGISTER_PLUGIN=0 ;;
    -h|--help)    sed -n '/^# Usage:/,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)            die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done
[ -n "$PROFILE" ] || die "--profile must not be empty"

printf '%spicturereader — Termux setup (level 3)%s\n' "$BOLD" "$OFF"
if [ "$VERIFY_ONLY" = 0 ]; then
  note "a first run downloads a Debian rootfs, on the order of 250 MiB of wheels and the OCR models;"
  note "expect 10-30 minutes on a phone. Every long step reports what it is doing, shows the output"
  note "of pip and apt, and ticks with its elapsed time (PICREADER_HEARTBEAT=0 silences the ticker)."
fi

# --------------------------------------------------------------------------
# 0. are we where we think we are?
# --------------------------------------------------------------------------
step "Checking the environment"
[ -n "${PREFIX:-}" ] || die "PREFIX is not set — run this inside Termux, not inside proot."
case "$PREFIX" in
  *com.termux*) : ;;
  *) die "this does not look like Termux (PREFIX=$PREFIX)." ;;
esac
ok "Termux prefix: $PREFIX"
for tool in proot-distro python3; do
  if command -v "$tool" >/dev/null 2>&1; then ok "$tool: $(command -v "$tool")"
  elif [ "$VERIFY_ONLY" = 1 ]; then warn "$tool is missing"
  else warn "$tool is missing — will be installed"; fi
done
for req in media.txt ocr.txt; do
  [ -f "$REQ_DIR/$req" ] || die "requirements file not found: $REQ_DIR/$req"
done
ok "requirements: $REQ_DIR/{media,ocr}.txt"

case "$(uname -m)" in
  aarch64) ok "architecture: aarch64" ;;
  *) warn "architecture is $(uname -m); this script targets aarch64 (aarch64 wheels exist for every dependency, others may differ)" ;;
esac
# A full run needs roughly 1.5 GB (rootfs ~350 MB + wheels + ONNX models), so
# say up front how much room there is instead of dying halfway through.
avail_kb="$(df -k "$PREFIX" 2>/dev/null | awk 'NR==2 {print $4}' || true)"
case "$avail_kb" in
  ''|*[!0-9]*) : ;;
  *)
    note "free space on $PREFIX: $(( avail_kb / 1024 )) MiB"
    [ "$avail_kb" -lt 1500000 ] && warn "a full install needs ~1.5 GB; consider freeing space first"
    ;;
esac
if [ -n "${DSH_OCR_PYTHON:-}" ] || [ -n "${DSH_MEDIA_PYTHON:-}" ]; then
  warn "DSH_OCR_PYTHON/DSH_MEDIA_PYTHON are already set and win over the state file — check they point where you expect"
fi

if [ "$VERIFY_ONLY" = 1 ]; then
  printf '\n%sverification mode: nothing will be changed%s\n' "$DIM" "$OFF"
fi

# --------------------------------------------------------------------------
# 1. proot-distro + the Debian rootfs
# --------------------------------------------------------------------------
step "Installing proot-distro and the Debian rootfs"
# Termux's own python3 is installed here as well, even though both environments
# live inside the rootfs: step 5 writes the state file with it, and it is what
# runs `install.py --verify` at the end. On a bare Termux it is absent, and
# without this the script would die at set -e after an hour of downloads.
NEED_PKGS=""
command -v proot-distro >/dev/null 2>&1 || NEED_PKGS="proot-distro"
command -v python3      >/dev/null 2>&1 || NEED_PKGS="${NEED_PKGS:+$NEED_PKGS }python3"
if [ -n "$NEED_PKGS" ]; then
  [ "$VERIFY_ONLY" = 1 ] && die "missing from Termux: $NEED_PKGS (install with: pkg install -y $NEED_PKGS)"
  note "installing into Termux first: $NEED_PKGS"
  with_heartbeat "pkg install -y $NEED_PKGS" pkg install -y $NEED_PKGS \
    || die "pkg install -y $NEED_PKGS failed (see its output above)"
fi
ok "proot-distro: $(proot-distro --version 2>/dev/null || echo present)"

# proot-distro 5.x stores containers as `containers/<name>/rootfs`; releases up
# to 4.x used `installed-rootfs/<name>`. Probe both, newest first, so an
# existing rootfs is never mistaken for a missing one (and `install` re-run).
find_rootfs() {
  local candidate
  for candidate in \
    "$PREFIX/var/lib/proot-distro/containers/$DISTRO/rootfs" \
    "$PREFIX/var/lib/proot-distro/installed-rootfs/$DISTRO"
  do
    if [ -d "$candidate" ]; then printf '%s' "$candidate"; return 0; fi
  done
  return 1
}

ROOTFS_DIR="$(find_rootfs || true)"
if [ -z "$ROOTFS_DIR" ]; then
  [ "$VERIFY_ONLY" = 1 ] && die "the $DISTRO rootfs is not installed"
  note "one-time download: the rootfs layer is ~50 MiB, and unpacking it takes a few minutes on a phone"
  with_heartbeat "proot-distro install $DISTRO" proot-distro install "$DISTRO" \
    || die "proot-distro install $DISTRO failed (see its output above)"
  ROOTFS_DIR="$(find_rootfs || true)"
  [ -n "$ROOTFS_DIR" ] || die "proot-distro install $DISTRO finished without a rootfs"
fi
ok "rootfs: $ROOTFS_DIR"

# `--shared-tmp` binds the Termux temp dir to /tmp inside the guest. Newer
# proot-distro releases have it, older ones do not, so probe rather than assume.
SHARED_TMP=""
if proot-distro login --help 2>&1 | grep -q -- '--shared-tmp'; then SHARED_TMP="--shared-tmp"; ok "proot-distro supports --shared-tmp"
else warn "proot-distro has no --shared-tmp; continuing without it"; fi

# Runs a command inside the rootfs. proot-distro binds the Termux home, $PREFIX
# and /sdcard at their original paths, so an absolute path means the same thing
# on both sides and no path translation is needed anywhere.
in_guest() {
  proot-distro login "$DISTRO" $SHARED_TMP -- "$@"
}

# --------------------------------------------------------------------------
# 2. the guest interpreter
# --------------------------------------------------------------------------
step "Installing the Python interpreter inside $DISTRO"
# `command -v python3` is not a valid test inside the guest: proot-distro appends
# Termux's $PREFIX/bin to the guest PATH, so the question is answered by Termux's
# python3 whenever the rootfs has none of its own. That interpreter is Bionic,
# pip refuses every manylinux wheel for it and compiles from source. Ask for the
# guest's file by absolute path instead, and install it when it is missing.
if [ "$VERIFY_ONLY" = 0 ]; then
  GUEST_PY_READY=0
  if in_guest /bin/sh -c 'test -x /usr/bin/python3 && /usr/bin/python3 -m venv --help >/dev/null 2>&1' 2>/dev/null; then
    GUEST_PY_READY=1
    ok "python3 is already present inside $DISTRO"
  fi
  if [ "$GUEST_PY_READY" = 0 ]; then
    note "apt-get update, then python3 + python3-venv + python3-pip + libgomp1 + ca-certificates (~40 MiB)"
    note "Debian 13 ships Python 3.13, and every pinned dependency has a cp313 aarch64 wheel"
    with_heartbeat "apt-get install python3 inside $DISTRO" \
      in_guest /bin/sh -c '/usr/bin/apt-get update -q &&
        DEBIAN_FRONTEND=noninteractive /usr/bin/apt-get install -y \
          -o Dpkg::Progress-Fancy=0 -o Dpkg::Use-Pty=0 \
          --no-install-recommends python3 python3-venv python3-pip libgomp1 ca-certificates' \
      || die "installing python3 inside $DISTRO failed (see the apt output above)"
  fi
fi
GUEST_PY="$(in_guest /usr/bin/python3 -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])' 2>/dev/null || true)"
[ -n "$GUEST_PY" ] || die "python3 is not available at /usr/bin/python3 inside $DISTRO"
GUEST_PY_PREFIX="$(in_guest /usr/bin/python3 -c 'import sys; print(sys.base_prefix)' 2>/dev/null || true)"
case "$GUEST_PY_PREFIX" in
  /usr) ok "guest python: $GUEST_PY" ;;
  "")   die "could not query the interpreter at /usr/bin/python3 inside $DISTRO" ;;
  *)    die "/usr/bin/python3 inside $DISTRO is backed by $GUEST_PY_PREFIX, not the rootfs; refusing to build environments on Termux's interpreter" ;;
esac

# --------------------------------------------------------------------------
# 3. the environments
# --------------------------------------------------------------------------
build_venv() {
  local role="$1" req="$2"
  local venv="$ROOT_VENVS/$role"
  step "Installing the '$role' environment"
  if [ "$VERIFY_ONLY" = 0 ]; then
    note "requirements: $(req_pins "$req")"
    note "pip downloads the aarch64 wheels first; the ticker keeps reporting while it is quiet"
    # Arguments are passed positionally rather than interpolated into the guest
    # script, so a path with a space survives the trip through `shlex.join`.
    # A venv left behind by an earlier run may be based on Termux's interpreter
    # (see step 2); pip cannot install manylinux wheels there, so such a venv is
    # removed and rebuilt instead of being reused. The interpreter that creates
    # it is named absolutely for the same reason. pip output is deliberately not
    # silenced: this is the longest step and the one that used to fail blind.
    with_heartbeat "$role: venv + pip install" \
      in_guest /bin/bash -c '
        set -e
        venv="$1"; req="$2"
        if [ -f "$venv/pyvenv.cfg" ] && \
           ! "$venv/bin/python" -c "import sys; raise SystemExit(0 if sys.base_prefix == \"/usr\" else 7)" 2>/dev/null; then
          echo "  removing $venv: it was not built on the guest interpreter"
          rm -rf "$venv"
        fi
        if [ ! -x "$venv/bin/python" ]; then
          echo "  creating the virtual environment at $venv"
          /usr/bin/python3 -m venv "$venv"
        fi
        "$venv/bin/python" -m pip install --upgrade pip \
          --progress-bar on --disable-pip-version-check --no-input
        "$venv/bin/python" -m pip install -r "$req" \
          --progress-bar on --disable-pip-version-check --no-input
      ' _ "$venv" "$req" \
      || die "the '$role' environment failed to install — pip said why in the output above"
  fi
  if in_guest "$venv/bin/python" -c 'import sys; raise SystemExit(0 if sys.base_prefix == "/usr" else 7)' >/dev/null 2>&1; then
    ok "$role -> $venv"
  else
    die "the '$role' environment is not usable — re-run without --verify"
  fi
}

build_venv media "$REQ_DIR/media.txt"

# rapidocr is installed without its dependencies on purpose: its
# `opencv_python` requirement would otherwise install the GUI OpenCV build next
# to the headless one that ocr.txt pins, and the GUI build needs libGL.so.1,
# which the minimal rootfs does not have.
build_venv ocr "$REQ_DIR/ocr.txt"
if [ "$VERIFY_ONLY" = 0 ]; then
  note "adding $RAPIDOCR_PIN with --no-deps (its opencv_python pin would pull the GUI build)"
  with_heartbeat "ocr: installing $RAPIDOCR_PIN" \
    in_guest "$ROOT_VENVS/ocr/bin/python" -m pip install \
      --progress-bar on --disable-pip-version-check --no-input --no-deps "$RAPIDOCR_PIN" \
    || die "installing $RAPIDOCR_PIN failed (see the pip output above)"
fi

step "Checking the OCR environment"
if VERSIONS="$(in_guest "$ROOT_VENVS/ocr/bin/python" -c \
    'import cv2, onnxruntime; print("onnxruntime %s, opencv %s" % (onnxruntime.__version__, cv2.__version__))' 2>/dev/null)"; then
  ok "$VERSIONS"
else
  die "the OCR environment is not importable — re-run without --verify"
fi

# --------------------------------------------------------------------------
# 4. warm-up: download the models once, so the first tool call is instant
# --------------------------------------------------------------------------
step "Downloading the OCR models"
if [ "$VERIFY_ONLY" = 0 ]; then
  # `--probe` builds the same two engines a real call uses (Chinese/English and
  # East Slavic), which is what pulls both model sets into the cache. Its stdout
  # is the base64 payload meant for the plugin, so it is discarded here.
  note "first run only: the detector and both recognition models are fetched now"
  if with_heartbeat "ocr warm-up (model download)" \
       in_guest /bin/sh -c '"$0" "$1" --probe >/dev/null' \
         "$ROOT_VENVS/ocr/bin/python" "$SCRIPT_DIR/../ocr.py"
  then
    ok "models are in place"
  else
    warn "the warm-up run failed; the environment itself is fine — the first image_ocr call will retry"
  fi
fi

# --------------------------------------------------------------------------
# 5. wrappers + runtime wiring
# --------------------------------------------------------------------------
step "Wiring the interpreters into the plugin"
make_wrapper() {
  local role="$1"
  local wrapper="${PREFIX}/bin/picturereader-${role}-python"
  if [ "$VERIFY_ONLY" = 0 ]; then
    cat > "$wrapper" <<EOF
#!${PREFIX}/bin/sh
# Generated by picturereader scripts/termux/setup.sh — safe to delete.
# Enters the $DISTRO rootfs and runs the '$role' interpreter with the arguments
# the plugin passed. proot-distro binds the Termux home and \$PREFIX at
# unchanged paths, so script and image paths work verbatim on both sides.
exec proot-distro login $DISTRO $SHARED_TMP --env PYTHONIOENCODING=utf-8 -- $ROOT_VENVS/$role/bin/python "\$@"
EOF
    chmod 0755 "$wrapper"
  fi
  ok "wrapper: $wrapper"
}
make_wrapper media
make_wrapper ocr
MEDIA_WRAPPER="${PREFIX}/bin/picturereader-media-python"
OCR_WRAPPER="${PREFIX}/bin/picturereader-ocr-python"

DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
if [ "$VERIFY_ONLY" = 0 ]; then
  python3 - "$MEDIA_WRAPPER" "$OCR_WRAPPER" "$DSH_HOME_DIR" <<'PY'
import json, sys
from pathlib import Path

media, ocr, dsh_home = sys.argv[1], sys.argv[2], Path(sys.argv[3])
state_file = dsh_home / "picturereader" / "env.json"
state_file.parent.mkdir(parents=True, exist_ok=True)
state = {}
if state_file.exists():
    try:
        state = json.loads(state_file.read_text())
    except Exception:
        state = {}
venvs = state.setdefault("venvs", {})
venvs["media"] = {"python": media, "roles": ["doc", "image"],
                  "label": "document + image processing (proot-distro)",
                  "path": "proot-distro:debian:/opt/picturereader/media"}
venvs["ocr"] = {"python": ocr, "roles": ["ocr"],
                "label": "OCR (RapidOCR, proot-distro)",
                "path": "proot-distro:debian:/opt/picturereader/ocr"}
state_file.write_text(json.dumps(state, indent=2) + "\n")
print("  state file updated: %s" % state_file)
PY
fi

# --------------------------------------------------------------------------
# 6. register the plugin itself in a DSH profile
# --------------------------------------------------------------------------
# Building the interpreters is only half an installation: the plugin also has to
# be added to the profile's bundle stack, which `install.py` normally does with
# `dsh plugin ... add`. On a device that call is the ONLY part of `install.py`
# that can work (it never builds a venv), so it is repeated here instead of
# telling the operator to run an installer that would fail on Termux.
step "Registering the plugin in the DSH profile"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
LINKED="$PROFILE_DIR/node_modules/picturereader"
DSH_BIN="$(command -v dsh || true)"
register_hint() { printf '      dsh plugin --profile %s add "%s"\n' "$PROFILE" "$REPO_ROOT"; }

if [ "$REGISTER_PLUGIN" = 0 ]; then
  warn "skipped (--skip-plugin) — register it yourself with:"
  register_hint
elif [ -L "$LINKED" ] && [ "$(readlink "$LINKED")" = "$REPO_ROOT" ]; then
  ok "already linked into the '$PROFILE' profile"
elif [ "$VERIFY_ONLY" = 1 ]; then
  if [ -e "$LINKED" ]; then ok "plugin present in the '$PROFILE' profile"
  else warn "the plugin is NOT registered in the '$PROFILE' profile — re-run without --verify"; fi
elif [ -z "$DSH_BIN" ]; then
  warn "dsh is not on PATH — the environments are ready, but the plugin is not registered"
  warn "once dsh is installed:"
  register_hint
elif [ ! -d "$PROFILE_DIR" ]; then
  # `dsh plugin` forwards to pnpm inside the profile directory, so the profile
  # has to exist first. Booting DSH once creates it.
  warn "the '$PROFILE' profile does not exist yet — boot DSH once, then run:"
  register_hint
elif with_heartbeat "dsh plugin --profile $PROFILE add $REPO_ROOT" \
       "$DSH_BIN" plugin --profile "$PROFILE" add "$REPO_ROOT"; then
  ok "plugin registered in the '$PROFILE' profile"
else
  warn "dsh plugin did not complete — register it manually with:"
  register_hint
fi

# --------------------------------------------------------------------------
# summary
# --------------------------------------------------------------------------
# DSH_MEDIA_PYTHON, DSH_OCR_PYTHON and DSH_OCR_THREADS are read by the DSH host
# process (src/paths.js, src/core.js), never by the guest, so exporting them only
# helps if the file that gets read belongs to the shell that launches DSH. That
# shell is not necessarily bash, and a name hard-coded to ~/.bashrc is silently
# ignored under zsh or fish.
case "$(basename "${SHELL:-bash}")" in
  bash) SHELL_RC="~/.bashrc" ;;
  zsh)  SHELL_RC="~/.zshrc" ;;
  fish) SHELL_RC="~/.config/fish/config.fish" ;;
  *)    SHELL_RC="the startup file of ${SHELL:-your shell}" ;;
esac

TOTAL_SECONDS=$(( $(date +%s) - SCRIPT_START ))
if [ "$VERIFY_ONLY" = 1 ]; then
  printf '\n%s%s✓ verification finished in %s%s\n' "$BOLD" "$GREEN" "$(elapsed_human $TOTAL_SECONDS)" "$OFF"
else
  printf '\n%s%s✓ done in %s%s\n' "$BOLD" "$GREEN" "$(elapsed_human $TOTAL_SECONDS)" "$OFF"
fi
cat <<EOF

  The plugin now finds both interpreters:
    media  $MEDIA_WRAPPER
    ocr    $OCR_WRAPPER

  Two ways to point DSH at them (the first is what just happened):

    1. the state file $DSH_HOME_DIR/picturereader/env.json — already updated.
       NOTE: re-running "python3 scripts/install.py" rewrites that file and
       drops these entries, so on a Termux device prefer option 2.

    2. environment variables, exported from the shell that launches DSH and
       inherited by it ($SHELL_RC here). They always win over the state file:
         export DSH_MEDIA_PYTHON="$MEDIA_WRAPPER"
         export DSH_OCR_PYTHON="$OCR_WRAPPER"

       Recommended on a phone — ONNX Runtime otherwise keeps every core busy
       for a whole OCR run, which heats the device and drains the battery:
         export DSH_OCR_THREADS=2

  Do NOT run the Linux installer on this device: "python3 scripts/install.py"
  creates the environments with pip inside Termux, where the wheels do not
  exist, so it fails — and it rewrites the state file on the way. The one mode
  that is correct here is the read-only check:

    python3 scripts/install.py --verify

  Notes for this device:
    * document_to_image handles PDFs only (LibreOffice is deliberately absent).
    * image_edit hides remove_background / raw_convert / upscale, which need
      packages Termux cannot provide. Installing the extras inside the rootfs
      brings them back:
        proot-distro login debian -- $ROOT_VENVS/media/bin/python -m pip install rembg rawpy

EOF
