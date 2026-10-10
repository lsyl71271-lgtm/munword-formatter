from __future__ import annotations

import base64
import json
import zipfile
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from lxml import etree
from starlette.concurrency import run_in_threadpool
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .docx_package import MAX_UPLOAD_BYTES
from .errors import InvalidDocxError, InvalidRequestError, ProtectedContentError
from .pipelines import PIPELINES
from .diagnostics import build_diagnostic_report
from .upload_limit import UploadLimitMiddleware


ROOT = Path(__file__).resolve().parents[2]
TEMPLATE_DIR = ROOT / "templates" / "pkunmun2026"
LOCAL_WEB_DIR = ROOT / "local_web"
MAX_UPLOAD = MAX_UPLOAD_BYTES


def _version() -> str:
    """Single source of truth: the VERSION file shipped with the bundle."""

    try:
        return (ROOT / "VERSION").read_text(encoding="utf-8").strip() or "unknown"
    except OSError:
        return "unknown"


APP_VERSION = _version()
SERVICE_ID = "pkunmun-2026-formatter"

app = FastAPI(
    title="PKUNMUN 2026 文件自动排版系统",
    version=APP_VERSION,
    description="六种文件类型的独立 DOCX 解析、排版、校验与输出服务。",
)
app.add_middleware(UploadLimitMiddleware)
# The engine listens on 127.0.0.1 only, but a browser can still be pointed at
# it from a page whose DNS was rebound to the loopback address.  Requiring a
# loopback Host header makes that attempt fail before it reaches a handler.
app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=["127.0.0.1", "127.0.0.1:8000", "localhost", "localhost:8000", "[::1]", "[::1]:8000"],
)
CORS_ORIGINS = (
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "https://pkunmun-2026-docx-formatter.lsyl71271.chatgpt.site",
    "https://munword.lsyl71271.chatgpt.site",
)
# The local page itself; a browser sends Origin on every POST, same-origin too.
LOCAL_ORIGINS = ("http://127.0.0.1:8000", "http://localhost:8000", "http://[::1]:8000")
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(CORS_ORIGINS),
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition", "X-PKUNMUN-Validation"],
)


@app.middleware("http")
async def refuse_foreign_origins(request, call_next):
    """CORS only hides the response: any web page could still make this
    always-on engine parse an upload.  A POST from a page that is neither the
    local page nor a listed site is refused before it is read.  Requests
    without an Origin header (the CLI, scripts) are not browser requests."""

    origin = request.headers.get("origin")
    if request.method == "POST" and request.scope["path"].startswith("/api/") and origin is not None and origin not in (*CORS_ORIGINS, *LOCAL_ORIGINS):
        return JSONResponse({"detail": "来源网页不在允许列表中，已拒绝请求。"}, status_code=403)
    return await call_next(request)


def get_pipeline(document_type: str):
    pipeline_class = PIPELINES.get(document_type)
    if pipeline_class is None:
        raise HTTPException(status_code=404, detail="不支持的文件类型。")
    return pipeline_class(TEMPLATE_DIR)


def failure_detail(prefix: str, exc: Exception) -> str:
    """Keep API errors readable even when an exception has no message."""

    message = str(exc).strip()
    if not message:
        message = f"内部处理异常（{type(exc).__name__}）"
    return f"{prefix}：{message}"


def processing_failure(prefix: str, exc: Exception) -> HTTPException:
    """Map an exception to one of the three failure classes (see ``errors.py``)."""

    if isinstance(exc, etree.XMLSyntaxError) and "Excessive depth" in str(exc):
        # libxml2 refuses more than 256 nested elements; the browser engine
        # applies the same limit (docx-safety.nestsTooDeep).
        return HTTPException(status_code=422, detail="文件无法读取：XML 嵌套层级过深（超过 256 层）。")
    if isinstance(exc, (InvalidDocxError, zipfile.BadZipFile, etree.XMLSyntaxError)):
        return HTTPException(status_code=422, detail=f"文件无法读取：{exc}")
    if isinstance(exc, InvalidRequestError):
        return HTTPException(status_code=422, detail=f"第 03 步提交的字段无效：{exc}")
    if isinstance(exc, ProtectedContentError):
        return HTTPException(status_code=422, detail=f"为保护原有内容已中止输出：{exc}")
    return HTTPException(
        status_code=500,
        detail=f"{prefix}：程序内部错误（不是文件本身的问题），请把该文件反馈给维护者。{type(exc).__name__}: {str(exc)[:200]}",
    )


@app.get("/", include_in_schema=False)
def local_app():
    return FileResponse(LOCAL_WEB_DIR / "index.html", media_type="text/html; charset=utf-8", headers={"Cache-Control": "no-store"})


@app.get("/app.js", include_in_schema=False)
def local_app_script():
    path = ROOT / "public" / "local-app.js"
    if not path.is_file():
        raise HTTPException(status_code=503, detail="请先运行 pnpm build:local-tools，或使用包含离线界面的本机发布包。")
    return FileResponse(path, media_type="text/javascript; charset=utf-8", headers={"Cache-Control": "no-store"})


@app.get("/favicon.svg", include_in_schema=False)
def local_app_icon():
    return FileResponse(ROOT / "public" / "favicon.svg", media_type="image/svg+xml")


@app.get("/studio-tools.js", include_in_schema=False)
def local_studio_tools():
    path = ROOT / "public" / "studio-tools.js"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Run pnpm build:local-tools, or use the desktop package containing this asset.")
    return FileResponse(path, media_type="text/javascript; charset=utf-8", headers={"Cache-Control": "no-store"})


@app.get("/styles.css", include_in_schema=False)
def local_app_styles():
    path = ROOT / "public" / "local-styles.css"
    if not path.is_file():
        raise HTTPException(status_code=503, detail="请先运行 pnpm build:local-tools，或使用包含离线界面的本机发布包。")
    return FileResponse(path, media_type="text/css; charset=utf-8", headers={"Cache-Control": "no-store"})


async def read_docx(file: UploadFile) -> bytes:
    if not file.filename or not file.filename.lower().endswith(".docx"):
        raise HTTPException(status_code=415, detail="仅支持 .docx 文件。")
    content = await file.read(MAX_UPLOAD + 1)
    if len(content) > MAX_UPLOAD:
        raise HTTPException(status_code=413, detail="文件不能超过 20 MB。")
    return content


@app.get("/api/health")
def health():
    # ``service`` lets the launcher tell this engine apart from any other
    # program that happens to hold port 8000.
    return {"status": "ok", "service": SERVICE_ID, "version": APP_VERSION, "pipelines": list(PIPELINES)}


@app.post("/api/parse/{document_type}")
async def parse_document(document_type: str, file: UploadFile = File(...)):
    pipeline = get_pipeline(document_type)
    content = await read_docx(file)
    try:
        model = await run_in_threadpool(pipeline.parse, content)
    except Exception as exc:
        raise processing_failure("DOCX 解析失败", exc) from exc
    return {**model.to_dict(), "diagnostics": build_diagnostic_report(model)}


@app.post("/api/format/{document_type}")
async def format_document(
    document_type: str,
    file: UploadFile = File(...),
    overrides_json: str = Form("{}"),
    preserve_country_order: bool = Form(False),
    normalize_punctuation: bool = Form(True),
    session_label: str = Form(""),
    submitting_country: str = Form(""),
    version: str = Form("v1"),
):
    pipeline = get_pipeline(document_type)
    content = await read_docx(file)
    try:
        overrides = json.loads(overrides_json or "{}")
        result = await run_in_threadpool(pipeline.run,
            content,
            overrides=overrides,
            preserve_country_order=preserve_country_order,
            normalize_punctuation=normalize_punctuation,
            session_label=session_label,
            submitting_country=submitting_country,
            version=version,
            source_name=file.filename or "",
        )
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=422, detail="识别结果 JSON 无效。") from exc
    except Exception as exc:
        raise processing_failure("格式化失败", exc) from exc

    if any(item.status == "error" for item in result.validations):
        details = [item.to_dict() for item in result.validations]
        raise HTTPException(status_code=409, detail={"message": "格式校验未通过，已中止输出。", "validations": details})

    validation_header = base64.urlsafe_b64encode(
        json.dumps([item.to_dict() for item in result.validations], ensure_ascii=False).encode("utf-8")
    ).decode("ascii")
    disposition = f"attachment; filename*=UTF-8''{quote(result.filename)}"
    return Response(
        content=result.content,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={
            "Content-Disposition": disposition,
            "X-PKUNMUN-Validation": validation_header,
        },
    )
