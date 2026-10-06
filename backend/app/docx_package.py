from __future__ import annotations

import re
import json
import zipfile
import struct
import zlib
from io import BytesIO
from pathlib import Path

from .errors import InvalidDocxError


DOCTYPE_TEXT_RE = re.compile(r"<!\s*(?:DOCTYPE|ENTITY)", re.I)


def declares_dtd(data: bytes) -> bool:
    """A DTD or entity declaration in an XML part, in either encoding OPC allows.

    The raw-byte search alone missed a UTF-16 part ("<\x00!\x00D\x00..."),
    which lxml then parsed.  UTF-32 is not an OPC encoding and is refused.
    """

    if data[:4] in (b"\x00\x00\xfe\xff", b"\xff\xfe\x00\x00"):
        raise InvalidDocxError("DOCX 的 XML 部件使用了不支持的编码。")
    encoding = "utf-8"
    if data[:2] in (b"\xff\xfe", b"\xfe\xff") or data[:2] in (b"<\x00", b"\x00<"):
        encoding = "utf-16-be" if data[:2] in (b"\xfe\xff", b"\x00<") else "utf-16-le"
    try:
        text = data.decode(encoding)
    except UnicodeError as exc:
        raise InvalidDocxError("XML 部件包含无效编码，不能安全保留原文。") from exc
    # ASCII markup survives removal of UTF-16 NUL separators even when
    # leading whitespace prevents the encoding sniff (either byte order).
    return bool(DOCTYPE_TEXT_RE.search(text.replace("\x00", "")))
REQUIRED_PARTS = {"[Content_Types].xml", "word/document.xml"}
PACKAGE_POLICY = json.loads((Path(__file__).resolve().parents[2] / "shared/package-policy.json").read_text(encoding="utf-8"))
MAX_UPLOAD_BYTES = PACKAGE_POLICY["maxUploadBytes"]
MAX_UNCOMPRESSED_BYTES = PACKAGE_POLICY["maxExpandedBytes"]
MAX_XML_BYTES = PACKAGE_POLICY["maxXmlBytes"]
MAX_COMPRESSION_RATIO = PACKAGE_POLICY["maxCompressionRatio"]
MAX_PACKAGE_PARTS = PACKAGE_POLICY["maxParts"]


def validate_docx_package(content: bytes) -> None:
    """Reject malformed or explosively compressed OOXML packages early."""

    try:
        if not content or len(content) > MAX_UPLOAD_BYTES:
            raise InvalidDocxError("DOCX 文件为空或超过 20 MB。")
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
                offset = info.header_offset
                if offset < 0 or offset + 30 > len(content) or content[offset:offset + 4] != b"PK\x03\x04":
                    raise InvalidDocxError("ZIP 本地部件目录损坏。")
                flags, method = struct.unpack_from("<HH", content, offset + 6)
                if flags != info.flag_bits or method != info.compress_type:
                    raise InvalidDocxError("ZIP 本地与中央目录标记不一致。")
                if not flags & 8:
                    local_crc, compressed, expanded = struct.unpack_from("<III", content, offset + 14)
                    if (local_crc, compressed, expanded) != (info.CRC, info.compress_size, info.file_size):
                        raise InvalidDocxError("ZIP 本地与中央目录大小或 CRC 不一致。")
                if info.flag_bits & 1:
                    raise InvalidDocxError("不支持加密的 DOCX 部件。")
                if (info.filename == "__proto__" or re.search(r"[\x00-\x1f\\]", info.filename)
                        or info.filename.startswith("/") or ".." in info.filename.split("/")):
                    raise InvalidDocxError("DOCX 包含不安全的内部路径。")
                if info.compress_type not in PACKAGE_POLICY["compressionMethods"]:
                    raise InvalidDocxError("DOCX 使用了不支持的压缩方法。")
                if info.filename.lower().endswith((".xml", ".rels")) and info.file_size > MAX_XML_BYTES:
                    raise InvalidDocxError("DOCX 的 XML 部件过大，请拆分文档。")
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
    except (zipfile.BadZipFile, UnicodeError, EOFError, zlib.error) as exc:
        raise InvalidDocxError("文件不是有效的 DOCX 压缩包。") from exc
