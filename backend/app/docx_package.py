from __future__ import annotations

import re
import zipfile
from io import BytesIO

from .errors import InvalidDocxError


DOCTYPE_RE = re.compile(rb"<!\s*(?:DOCTYPE|ENTITY)", re.I)
DOCTYPE_TEXT_RE = re.compile(r"<!\s*(?:DOCTYPE|ENTITY)", re.I)


def declares_dtd(data: bytes) -> bool:
    """A DTD or entity declaration in an XML part, in either encoding OPC allows.

    The raw-byte search alone missed a UTF-16 part ("<\x00!\x00D\x00..."),
    which lxml then parsed.  UTF-32 is not an OPC encoding and is refused.
    """

    if data[:4] in (b"\x00\x00\xfe\xff", b"\xff\xfe\x00\x00"):
        raise InvalidDocxError("DOCX 的 XML 部件使用了不支持的编码。")
    if data[:2] in (b"\xff\xfe", b"\xfe\xff") or data[:2] in (b"<\x00", b"\x00<"):
        encoding = "utf-16-be" if data[:2] in (b"\xfe\xff", b"\x00<") else "utf-16-le"
        return bool(DOCTYPE_TEXT_RE.search(data.decode(encoding, errors="replace")))
    # ASCII markup survives removal of UTF-16 NUL separators even when
    # leading whitespace prevents the encoding sniff (either byte order).
    return bool(DOCTYPE_RE.search(data.replace(b"\x00", b"")))
REQUIRED_PARTS = {"[Content_Types].xml", "word/document.xml"}
MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024
MAX_COMPRESSION_RATIO = 250
MAX_PACKAGE_PARTS = 5000


def validate_docx_package(content: bytes) -> None:
    """Reject malformed or explosively compressed OOXML packages early."""

    try:
        with zipfile.ZipFile(BytesIO(content)) as archive:
            infos = archive.infolist()
            if len(infos) > MAX_PACKAGE_PARTS:
                raise InvalidDocxError("DOCX 内部文件数量异常。")
            names = {info.filename for info in infos}
            if len(names) != len(infos):
                raise InvalidDocxError("DOCX 包含重复内部路径。")
            missing = REQUIRED_PARTS - names
            if missing:
                raise InvalidDocxError("DOCX 缺少必要的 Word 文档部件。")
            total_uncompressed = 0
            for info in infos:
                if info.flag_bits & 1:
                    raise InvalidDocxError("不支持加密的 DOCX 部件。")
                normalized = info.filename.replace("\\", "/")
                if normalized.startswith("/") or "../" in f"/{normalized}":
                    raise InvalidDocxError("DOCX 包含不安全的内部路径。")
                total_uncompressed += info.file_size
                if total_uncompressed > MAX_UNCOMPRESSED_BYTES:
                    raise InvalidDocxError("DOCX 解压后的体积过大。")
                if info.file_size and info.compress_size == 0:
                    raise InvalidDocxError("DOCX 压缩结构异常。")
                if info.compress_size and info.file_size / info.compress_size > MAX_COMPRESSION_RATIO:
                    raise InvalidDocxError("DOCX 压缩比异常。")
            # Every part, images included, must pass its CRC: a damaged
            # picture would otherwise survive into the output unnoticed.
            if archive.testzip() is not None:
                raise InvalidDocxError("DOCX 压缩包校验失败。")
            for info in infos:
                # Any case: Word reads "header1.XML" as XML too.
                if not info.filename.lower().endswith((".xml", ".rels")):
                    continue
                # Scanning the raw bytes avoids the two full-size string copies
                # that ``.decode().upper()`` needed for a 100 MB part.
                if declares_dtd(archive.read(info)):
                    raise InvalidDocxError("不支持 XML 实体或 DTD。")
    except zipfile.BadZipFile as exc:
        raise InvalidDocxError("文件不是有效的 DOCX 压缩包。") from exc
