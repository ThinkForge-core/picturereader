# -*- coding: utf-8 -*-
"""
doc-to-image.py — Office/PDF per-page PNG rendering script (called by the DSH
document_to_image tool).

The caller runs this script with the plugin's media Python environment (PyMuPDF
is installed there), so the interpreter is never resolved here.

Full chain:
  .pdf                              ──directly──►    PyMuPDF(fitz) renders each page to PNG
  .docx/.doc/.xlsx/.xls/.pptx/.ppt  ──► LibreOffice(soffice) headless converts to PDF ──► fitz renders PNG

Usage (argv):
  python doc-to-image.py <input> <out_dir> <prefix> <dpi> <max_pages>

  <input>      absolute local path of the source document (pdf or office file;
               the Node side has already materialized it).
  <out_dir>    output directory (already exists; the PNGs are written here).
  <prefix>     PNG file name prefix, output looks like <out_dir>/<prefix>_<i>.png, i starting at 1.
  <dpi>        rendering resolution (72..300, default 150).
  <max_pages>  render at most the first N pages (default 50).

Output:
  stdout prints a single JSON line:
    {"pages": [{"path": "...", "width": 888, "height": 1258, "bytes": 123456}], "page_count": 42, "truncated": false}

  page_count is the real total page count of the document; pages only holds the
  pages actually rendered (<= max_pages).
  Any error is reported with a non-zero exit code plus a stderr/stdout message.

soffice executable path:
  The DSH_SOFFICE environment variable wins when it is set (the caller always
  sets it); otherwise soffice/libreoffice are looked up on PATH, and finally the
  known Linux locations /usr/bin/soffice, /usr/local/bin/soffice,
  /usr/lib/libreoffice/program/soffice and /opt/libreoffice/program/soffice are
  probed. A missing soffice is reported as a clear error.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

# ---- constants --------------------------------------------------------------

SUPPORTED_EXTS = {".pdf", ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt"}
OFFICE_EXTS = SUPPORTED_EXTS - {".pdf"}
DEFAULT_SOFFICE = "/usr/bin/soffice"
SOFFICE_CANDIDATES = (
    "/usr/bin/soffice",
    "/usr/local/bin/soffice",
    "/usr/lib/libreoffice/program/soffice",
    "/opt/libreoffice/program/soffice",
)


def find_soffice():
    """Return a usable soffice executable path, or None when LibreOffice is absent."""
    env = os.environ.get("DSH_SOFFICE", "").strip()
    if env:
        if os.path.exists(env):
            return env
        # DSH_SOFFICE is set but does not exist -> keep looking.
    for name in ("soffice", "libreoffice"):
        hit = shutil.which(name)
        if hit:
            return hit
    for cand in SOFFICE_CANDIDATES:
        if os.path.exists(cand):
            return cand
    return None


def soffice_to_pdf(src, out_dir, soffice, timeout_s=120):
    """Convert an office file to pdf with headless soffice; returns the pdf path.
    Uses a dedicated UserInstallation profile so parallel runs cannot clash."""
    profile_dir = os.path.join(out_dir, ".lo_profile")
    os.makedirs(profile_dir, exist_ok=True)
    profile_uri = "file:///" + profile_dir.replace("\\", "/")
    cmd = [
        soffice,
        "--headless",
        "--norestore",
        "--nofirststartwizard",
        "-env:UserInstallation=" + profile_uri,
        "--convert-to", "pdf",
        "--outdir", out_dir,
        src,
    ]
    # soffice keeps no pipe open, so capture_output returns promptly; the
    # timeout is the safeguard against a hang.
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s)
    base = os.path.splitext(os.path.basename(src))[0]
    pdf_path = os.path.join(out_dir, base + ".pdf")
    if not os.path.exists(pdf_path):
        msg = "soffice produced no PDF"
        if proc.stderr and proc.stderr.strip():
            msg += ": " + proc.stderr.strip()[-500:]
        raise RuntimeError(msg)
    return pdf_path


def render_pdf(pdf_path, out_dir, prefix, dpi, max_pages):
    """Render the pdf to PNG page by page with fitz; returns (pages:list[dict], page_count:int, truncated:bool)."""
    import fitz  # PyMuPDF

    doc = fitz.open(pdf_path)
    total = doc.page_count
    n = min(total, max_pages)
    pages = []
    for i in range(n):
        pix = doc[i].get_pixmap(dpi=dpi)
        p = os.path.join(out_dir, "{}_{}.png".format(prefix, i + 1))
        pix.save(p)
        size = os.path.getsize(p)
        pages.append({
            "path": p,
            "width": pix.width,
            "height": pix.height,
            "bytes": size,
            "index": i + 1,
        })
    truncated = total > max_pages
    return pages, total, truncated


def main(argv):
    if len(argv) < 5:
        print(json.dumps({"error": "usage: doc-to-image.py <input> <out_dir> <prefix> <dpi> <max_pages>"}))
        return 2

    src, out_dir, prefix = argv[0], argv[1], argv[2]
    dpi = int(argv[3])
    max_pages = int(argv[4])

    if not os.path.exists(src):
        print(json.dumps({"error": "input file not found: {}".format(src)}))
        return 1

    ext = os.path.splitext(src)[1].lower()
    if ext not in SUPPORTED_EXTS:
        print(json.dumps({"error": "unsupported extension '{}' (supported: {})".format(
            ext, ", ".join(sorted(SUPPORTED_EXTS)))}))
        return 1

    os.makedirs(out_dir, exist_ok=True)

    # 1) Resolve the pdf path that will be rendered.
    pdf_path = None
    tmp_dir = None
    if ext == ".pdf":
        pdf_path = src
    else:
        soffice = find_soffice()
        if not soffice:
            print(json.dumps({"error": "LibreOffice (soffice) not found. Install it with your package manager "
                                        "(libreoffice on Debian/Ubuntu, libreoffice-fresh on Arch), or set the "
                                        "DSH_SOFFICE environment variable to the soffice executable path."}))
            return 1
        # Keep the intermediate pdf in its own temp directory so documents that
        # share a base name cannot overwrite each other.
        tmp_dir = tempfile.mkdtemp(prefix="lo_pdf_", dir=out_dir)
        try:
            pdf_path = soffice_to_pdf(src, tmp_dir, soffice)
        except subprocess.TimeoutExpired:
            print(json.dumps({"error": "soffice conversion timed out (>120s); check whether the document is damaged or too large."}))
            return 1
        except Exception as e:  # noqa: BLE001
            print(json.dumps({"error": "soffice conversion failed: {}".format(e)}))
            return 1

    # 2) Render with fitz.
    try:
        pages, page_count, truncated = render_pdf(pdf_path, out_dir, prefix, dpi, max_pages)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": "PDF rendering failed: {}".format(e)}))
        return 1
    finally:
        # Drop the intermediate pdf temp directory (keeping the final PNGs).
        if tmp_dir and os.path.isdir(tmp_dir):
            shutil.rmtree(tmp_dir, ignore_errors=True)

    print(json.dumps({
        "pages": pages,
        "page_count": page_count,
        "truncated": truncated,
        "input": os.path.basename(src),
        "out_dir": out_dir,
    }))
    return 0


if __name__ == "__main__":
    try:
        code = main(sys.argv[1:])
    except Exception as e:  # top-level safety net: every uncaught exception becomes a JSON error
        print(json.dumps({"error": "unexpected: {}".format(e)}))
        code = 1
    sys.exit(code)
