"""Bound API request bodies *before* multipart parsing can spool them to disk."""
from starlette.responses import JSONResponse
from .docx_package import PACKAGE_POLICY


class UploadLimitMiddleware:
    def __init__(self, app, max_bytes=PACKAGE_POLICY["maxMultipartBytes"]):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] != "POST" or not scope["path"].startswith("/api/"):
            return await self.app(scope, receive, send)

        async def refuse():
            await JSONResponse({"detail": "上传请求过大；文件限 20 MB，表单及文件合计限 21 MB。"}, status_code=413)(scope, receive, send)

        try:
            length = int(dict(scope["headers"]).get(b"content-length", b"0"))
        except ValueError:
            length = 0  # Never trust a missing/invalid length: also count actual bytes.
        if length > self.max_bytes:
            return await refuse()
        messages = []
        size = 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            size += len(message.get("body", b""))
            if size > self.max_bytes:
                return await refuse()
            messages.append(message)
            if not message.get("more_body", False):
                break
        # A bounded replay keeps rejection ahead of Starlette's multipart
        # parser, which otherwise may create large temporary files first.
        iterator = iter(messages)

        async def replay():
            return next(iterator, None) or await receive()

        await self.app(scope, replay, send)
