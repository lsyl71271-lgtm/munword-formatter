"""Opt-in DOCX visual QA, using a local renderer or loopback-only Gotenberg.

Never runs in the public website. PDF/PNG/JSON outputs may contain private text.
References must have the SAME CONTENT; pixel comparison is not semantic matching.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import shutil
import os
import sys
import uuid
import zipfile
from io import BytesIO
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from xml.etree import ElementTree

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app.docx_package import validate_docx_package  # noqa: E402


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Renderer redirects are forbidden")


def validate_origin(origin: str) -> str:
    url = urlsplit(origin)
    if url.scheme != "http" or url.hostname not in {"127.0.0.1", "localhost", "::1"} or url.username or url.password or url.path not in {"", "/"} or url.query or url.fragment:
        raise ValueError("Gotenberg must be a local HTTP origin, e.g. http://127.0.0.1:3000")
    _ = url.port  # Reject invalid port values before making any request.
    return origin.rstrip("/")


def safe_render_input(content: bytes) -> None:
    if len(content) > 20 * 1024 * 1024:
        raise ValueError("DOCX exceeds 20 MB")
    validate_docx_package(content)
    with zipfile.ZipFile(BytesIO(content)) as package:
        if any(name.lower().endswith(("vbaproject.bin", ".ole")) or name.lower().startswith("word/embeddings/") for name in package.namelist()):
            raise ValueError("Active content is not permitted in automated rendering")
        for name in package.namelist():
            if not name.endswith(".rels"):
                continue
            for relation in ElementTree.fromstring(package.read(name)):
                target = relation.attrib.get("Target", "")
                # Hyperlinks are inert; linked images/objects/templates may fetch data.
                if relation.attrib.get("Type", "").endswith("/hyperlink"):
                    continue
                if relation.attrib.get("TargetMode", "").lower() == "external" or urlsplit(target).scheme or target.startswith("//"):
                    raise ValueError("Linked external resources are not permitted in automated rendering")


def render_gotenberg(content: bytes, origin: str) -> bytes:
    endpoint = validate_origin(origin) + "/forms/libreoffice/convert"
    safe_render_input(content)
    boundary = "munword-" + uuid.uuid4().hex
    payload = (f'--{boundary}\r\nContent-Disposition: form-data; name="files"; filename="document.docx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\n\r\n'.encode()
               + content + f"\r\n--{boundary}--\r\n".encode())
    opener = build_opener(ProxyHandler({}), NoRedirect())
    request = Request(endpoint, data=payload, headers={"Content-Type": f"multipart/form-data; boundary={boundary}"}, method="POST")
    with opener.open(request, timeout=120) as response:
        pdf = response.read(50 * 1024 * 1024 + 1)
    if len(pdf) > 50 * 1024 * 1024 or not pdf.startswith(b"%PDF-"):
        raise ValueError("Renderer returned an invalid or oversized PDF")
    return pdf


def pixel_difference(actual: Path, reference: Path, output: Path) -> dict:
    from PIL import Image, ImageChops, ImageStat
    with Image.open(actual) as a, Image.open(reference) as b:
        if a.size != b.size:
            return {"same_size": False, "mean_difference": 1.0}
        diff = ImageChops.difference(a.convert("RGB"), b.convert("RGB"))
        score = sum(ImageStat.Stat(diff).mean) / (3 * 255)
        diff.save(output)
        return {"same_size": True, "mean_difference": score}


def pdf_pages(pdf: Path, output: Path, dpi: int) -> tuple[list[Path], list[dict]]:
    from pypdf import PdfReader
    document = PdfReader(pdf)
    if len(document.pages) > 100:
        raise ValueError("Visual QA is limited to 100 pages")
    # Re-rasterize with an explicit Poppler binary when supplied (Cairo is
    # preferable on macOS builds whose default backend drops CJK glyphs).
    rasterizer = os.environ.get("MUNWORD_PDF_RASTERIZER")
    if rasterizer or not list(output.glob("page-*.png")):
        rasterizer = rasterizer or shutil.which("pdftoppm")
        if not rasterizer:
            raise ValueError("Install Poppler or set MUNWORD_PDF_RASTERIZER")
        subprocess.run([rasterizer, "-png", "-r", str(dpi), str(pdf), str(output / "page")], check=True, timeout=120)
    for path in output.glob("page-*.png"):
        normalized = output / f"page-{int(path.stem.split('-')[-1])}.png"
        if path != normalized:
            path.replace(normalized)
    pages = sorted(output.glob("page-*.png"), key=lambda path: int(path.stem.split("-")[-1]))
    if len(pages) != len(document.pages):
        raise ValueError("PDF/PNG page counts differ")
    spans = []
    for index, page in enumerate(document.pages):
        def visitor(text, current_matrix, text_matrix, font, size):
            if text.strip():
                name = str((font or {}).get("/BaseFont", "unknown"))
                spans.append({"page": index + 1, "text": text.strip(), "size": size, "font": name,
                              "italic": "italic" in name.lower() or "oblique" in name.lower()})
        page.extract_text(visitor_text=visitor)
    return pages, spans


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    engine = parser.add_mutually_exclusive_group(required=True)
    engine.add_argument("--renderer", type=Path, help="Local render_docx.py path")
    engine.add_argument("--gotenberg-url", help="Explicit loopback-only Gotenberg origin")
    parser.add_argument("--reference-pages", type=Path, help="PNG directory for the same content/fonts/renderer")
    parser.add_argument("--threshold", type=float, default=0.002)
    parser.add_argument("--max-font-size", type=float, default=12.25)
    parser.add_argument("--require-italic", action="append", default=[], help="Exact phrase expected in an italic span")
    parser.add_argument("--dpi", type=int, default=115)
    args = parser.parse_args(argv)
    if not 72 <= args.dpi <= 200 or not 0 <= args.threshold <= 1 or args.max_font_size <= 0:
        parser.error("Invalid DPI, threshold or font size")
    content = args.source.read_bytes()
    safe_render_input(content)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    # A dedicated run directory prevents stale pages and never overwrites references.
    run = args.output_dir / uuid.uuid4().hex
    run.mkdir()
    pdf = run / (args.source.stem + ".pdf")
    if args.gotenberg_url:
        pdf.write_bytes(render_gotenberg(content, args.gotenberg_url))
    else:
        if not args.renderer.is_file():
            parser.error("Renderer script does not exist")
        subprocess.run([sys.executable, str(args.renderer), str(args.source.resolve()), "--output_dir", str(run), "--emit_pdf", "--dpi", str(args.dpi)], check=True, timeout=180)
        if not pdf.is_file():
            raise ValueError("Renderer did not produce the expected PDF")
    pages, spans = pdf_pages(pdf, run, args.dpi)
    failures = []
    if not pages or not spans:
        failures.append("Rendered document has no visible text")
    if any(span["size"] > args.max_font_size for span in spans):
        failures.append("Rendered text exceeds the configured font-size ceiling")
    for phrase in args.require_italic:
        if not any(phrase in span["text"] and span["italic"] for span in spans):
            failures.append(f"Required italic phrase was not found: {phrase}")
    comparison = []
    if args.reference_pages:
        references = sorted(args.reference_pages.glob("page-*.png"), key=lambda path: int(path.stem.split("-")[-1]))
        if len(references) != len(pages):
            failures.append("Reference and output page counts differ")
        for index, (page, reference) in enumerate(zip(pages, references)):
            result = pixel_difference(page, reference, run / f"diff-{index + 1}.png")
            comparison.append(result)
            if not result["same_size"] or result["mean_difference"] > args.threshold:
                failures.append(f"Page {index + 1} exceeds the visual difference threshold")
    report = {"schema_version": 1, "status": "failed" if failures else "checked", "page_count": len(pages), "failures": failures,
              "pixel_comparison": comparison, "spans": spans, "renderer": "gotenberg" if args.gotenberg_url else "local",
              "scope": "Configured typography assertions and optional same-content pixel comparison only; not proof of complete academic compliance."}
    (run / "visual-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"status": report["status"], "pages": len(pages), "report": str(run / "visual-report.json"), "failures": failures}, ensure_ascii=False))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
