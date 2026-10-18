import importlib.util
import io
import json
import os
import sys
import unittest
from unittest import mock


SKILL_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SCRIPT_PATH = os.path.join(SKILL_ROOT, "shared", "scripts", "doxent_api.py")


def load_doxent_api():
    spec = importlib.util.spec_from_file_location("doxent_api_under_test", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeResponse:
    def __init__(self, payload, headers=None):
        self.payload = payload
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


class ClosingFakeResponse(FakeResponse):
    """记录业务响应是否已经关闭，用于锁定补批信号的严格发送顺序。"""

    def __init__(self, payload):
        super().__init__(payload)
        self.closed = False

    def __exit__(self, exc_type, exc, traceback):
        self.closed = True
        return False


class DoxentApiSyncGateTest(unittest.TestCase):
    def setUp(self):
        self.api = load_doxent_api()

    def run_wait_for_sync(self, status, url="http://127.0.0.1:46588/open-model-schedule/overview", method="GET"):
        stderr = io.StringIO()
        with mock.patch.object(self.api.urllib.request, "urlopen", return_value=FakeResponse({"data": status})), \
                mock.patch.object(sys, "stderr", stderr):
            result = self.api.wait_for_sync(url, method)
        return result, stderr.getvalue()

    def partial_idle_status(self):
        """返回不含业务数据的合法批次间状态，供路径矩阵复用。"""
        return {
            "running": False,
            "startupSyncPending": True,
            "syncFinished": False,
            "syncUsable": False,
            "initialSyncPhase": "partial_idle",
            "partialReadUsable": True,
            "nextInitialSyncAt": 700000,
            "lastSyncSucceeded": None,
        }

    def test_partial_idle_allows_whitelisted_read_with_warning(self):
        result, stderr = self.run_wait_for_sync(
            self.partial_idle_status(),
            "http://127.0.0.1:46588/open-model-note/search?keyword=周报",
            "GET",
        )

        self.assertTrue(result)
        self.assertIn("首次全量同步尚未完成", stderr)
        self.assertIn("结果可能缺失或不是最新", stderr)
        self.assertNotIn("本次请求已停止", stderr)

    def test_partial_idle_read_allowlist_covers_lists_and_content(self):
        paths = (
            "/open-model-note/list",
            "/open-model-note/fileList",
            "/open-model-note/file/content",
            "/open-model-office/list",
            "/open-model-office/document/content",
            "/open-model-schedule/overview",
            "/open-model-schedule/item",
            "/open-model-schedule/nimble/list",
            "/open-model-schedule/nimble/detail",
        )
        for path in paths:
            with self.subTest(path=path):
                result, stderr = self.run_wait_for_sync(
                    self.partial_idle_status(),
                    "http://127.0.0.1:46588" + path,
                    "GET",
                )
                self.assertTrue(result)
                self.assertIn(self.api.PARTIAL_READ_WARNING, stderr)

    def test_partial_idle_allows_post_write_with_write_warning(self):
        result, stderr = self.run_wait_for_sync(
            self.partial_idle_status(),
            "http://127.0.0.1:46588/open-model-note/file/delete",
            "POST",
        )

        self.assertTrue(result)
        self.assertIn(self.api.PARTIAL_WRITE_WARNING, stderr)
        self.assertNotIn(self.api.PARTIAL_READ_WARNING, stderr)

    def test_partial_idle_blocks_unknown_get_path(self):
        result, stderr = self.run_wait_for_sync(
            self.partial_idle_status(),
            "http://127.0.0.1:46588/open-model-note/file/delete",
            "GET",
        )

        self.assertFalse(result)
        self.assertIn("不在读写白名单内", stderr)

    def test_partial_idle_blocks_unknown_paths_and_wrong_methods(self):
        requests = (
            ("GET", "/open-model/sync"),
            ("GET", "/open-model-common/knowledge/query"),
            ("POST", "/open-model-note/file/unknown"),
            ("POST", "/open-model-note/file/create/extra"),
            ("POST", "/open-model-note/list"),
            ("PUT", "/open-model-note/file/rename"),
            ("DELETE", "/open-model-office/document/delete"),
            ("GET", "/sync/status"),
        )
        for method, path in requests:
            with self.subTest(method=method, path=path):
                result, stderr = self.run_wait_for_sync(
                    self.partial_idle_status(),
                    "http://127.0.0.1:46588" + path,
                    method,
                )
                self.assertFalse(result)
                self.assertIn("首次全量同步尚未完成", stderr)

    def test_partial_idle_supported_writes_reach_business_api_without_waking_batch(self):
        # 按现有模块接口独立列举，防止新增白名单时漏掉文件夹、任务状态或上传入口。
        paths = (
            "/open-model-note/file/create", "/open-model-note/file/rename",
            "/open-model-note/file/move", "/open-model-note/file/delete",
            "/open-model-note/folder/create", "/open-model-note/folder/rename",
            "/open-model-note/folder/move", "/open-model-note/folder/delete",
            "/open-model-office/document/rename", "/open-model-office/document/move",
            "/open-model-office/document/delete", "/open-model-office/folder/create",
            "/open-model-office/folder/rename", "/open-model-office/folder/move",
            "/open-model-office/folder/delete", "/open-model-schedule/create",
            "/open-model-schedule/update", "/open-model-schedule/delete",
            "/open-model-schedule/operate", "/open-model-book/file/upload",
            "/open-model/sync",
        )
        for path in paths:
            with self.subTest(path=path):
                url = "http://127.0.0.1:46588" + path
                responses = [FakeResponse({"data": self.partial_idle_status()}), FakeResponse({"code": 200})]
                with mock.patch.object(self.api, "ensure_service", return_value=url), \
                        mock.patch.object(self.api.urllib.request, "urlopen", side_effect=responses) as urlopen, \
                        mock.patch.object(self.api, "request_next_initial_note_batch") as wake, \
                        mock.patch.object(sys, "argv", ["doxent_api.py", "--url", url, "--method", "POST", "--body", "{}"]), \
                        mock.patch.object(sys, "stdout", io.StringIO()) as stdout, \
                        mock.patch.object(sys, "stderr", io.StringIO()) as stderr:
                    result = self.api.main()
                self.assertEqual(result, 0)
                self.assertEqual(json.loads(stdout.getvalue()), {"code": 200})
                self.assertIn(self.api.PARTIAL_WRITE_WARNING, stderr.getvalue())
                self.assertEqual(urlopen.call_count, 2)
                request = urlopen.call_args_list[1].args[0]
                self.assertEqual((request.full_url, request.get_method(), request.data), (url, "POST", b"{}"))
                wake.assert_not_called()

    def test_whitelisted_write_still_blocks_when_initial_sync_is_not_idle(self):
        # 所有非空闲状态继续失败关闭，不能因 POST 白名单跳过原有同步状态验证。
        statuses = (
            {**self.partial_idle_status(), "running": True, "initialSyncPhase": "running", "partialReadUsable": False},
            {**self.partial_idle_status(), "initialSyncPhase": "not_started", "partialReadUsable": False},
            {"running": False, "startupSyncPending": True, "syncFinished": False},
            {**self.partial_idle_status(), "running": True},
        )
        url = "http://127.0.0.1:46588/open-model-note/file/create"
        for status in statuses:
            with self.subTest(status=status):
                with mock.patch.object(self.api, "ensure_service", return_value=url), \
                        mock.patch.object(self.api.urllib.request, "urlopen", return_value=FakeResponse({"data": status})) as urlopen, \
                        mock.patch.object(self.api.time, "time", side_effect=[0, 0, 301]), \
                        mock.patch.object(self.api.time, "sleep"), \
                        mock.patch.object(self.api, "request_next_initial_note_batch") as wake, \
                        mock.patch.object(sys, "argv", ["doxent_api.py", "--url", url, "--method", "POST"]), \
                        mock.patch.object(sys, "stdout", io.StringIO()), \
                        mock.patch.object(sys, "stderr", io.StringIO()):
                    result = self.api.main()
                self.assertEqual(result, 2)
                self.assertEqual(urlopen.call_count, 1)
                self.assertTrue(urlopen.call_args.args[0].full_url.endswith("/sync/status"))
                wake.assert_not_called()

    def test_partial_write_http_failure_is_preserved_without_waking_batch(self):
        url = "http://127.0.0.1:46588/open-model-note/file/rename"
        error = self.api.urllib.error.HTTPError(url, 404, "not found", {}, io.BytesIO(b'{"code":404}'))
        with mock.patch.object(self.api, "ensure_service", return_value=url), \
                mock.patch.object(self.api.urllib.request, "urlopen", side_effect=[FakeResponse({"data": self.partial_idle_status()}), error]), \
                mock.patch.object(self.api, "request_next_initial_note_batch") as wake, \
                mock.patch.object(sys, "argv", ["doxent_api.py", "--url", url, "--method", "POST"]), \
                mock.patch.object(sys, "stderr", io.StringIO()) as stderr:
            result = self.api.main()
        self.assertEqual(result, 1)
        self.assertIn("HTTP 404", stderr.getvalue())
        wake.assert_not_called()

    def test_explicit_sync_waits_for_running_batch_then_posts_once(self):
        url = "http://127.0.0.1:46588/open-model/sync"
        running = {**self.partial_idle_status(), "running": True, "initialSyncPhase": "running", "partialReadUsable": False}
        complete = {**self.partial_idle_status(), "startupSyncPending": False, "syncFinished": True,
                    "syncUsable": True, "initialSyncPhase": "complete", "partialReadUsable": False,
                    "nextInitialSyncAt": 0}
        # 无论当前批次结束后仍是部分空闲还是已全量完成，都只发送一条同步 POST。
        for settled in (self.partial_idle_status(), complete):
            with self.subTest(phase=settled["initialSyncPhase"]):
                responses = [FakeResponse({"data": running}), FakeResponse({"data": settled}),
                             FakeResponse({"code": 200, "data": True})]
                with mock.patch.object(self.api, "ensure_service", return_value=url), \
                        mock.patch.object(self.api.urllib.request, "urlopen", side_effect=responses) as urlopen, \
                        mock.patch.object(self.api.time, "time", side_effect=[0, 0, 0]), \
                        mock.patch.object(self.api.time, "sleep") as sleep, \
                        mock.patch.object(self.api, "request_next_initial_note_batch") as wake, \
                        mock.patch.object(sys, "argv", ["doxent_api.py", "--url", url, "--method", "POST"]), \
                        mock.patch.object(sys, "stdout", io.StringIO()), \
                        mock.patch.object(sys, "stderr", io.StringIO()):
                    result = self.api.main()
                self.assertEqual(result, 0)
                requests = [(call.args[0].full_url, call.args[0].get_method()) for call in urlopen.call_args_list]
                self.assertEqual(requests, [("http://127.0.0.1:46588/sync/status", "GET")] * 2 + [(url, "POST")])
                sleep.assert_called_once()
                wake.assert_not_called()

    def test_explicit_sync_connection_failure_does_not_replay_request(self):
        url = "http://127.0.0.1:46588/open-model/sync"
        with mock.patch.object(self.api, "ensure_service", return_value=url), \
                mock.patch.object(self.api, "wait_for_sync_gate", return_value=self.api.SYNC_GATE_READY), \
                mock.patch.object(self.api.urllib.request, "urlopen", side_effect=self.api.urllib.error.URLError("connection lost")) as urlopen, \
                mock.patch.object(self.api, "query_cli_endpoint") as endpoint, \
                mock.patch.object(sys, "argv", ["doxent_api.py", "--url", url, "--method", "POST"]), \
                mock.patch.object(sys, "stderr", io.StringIO()) as stderr:
            result = self.api.main()
        self.assertEqual(result, 1)
        urlopen.assert_called_once()
        endpoint.assert_not_called()
        self.assertIn("不自动重复调用", stderr.getvalue())

    def test_invalid_partial_state_is_rejected(self):
        result, stderr = self.run_wait_for_sync({
            "running": True,
            "startupSyncPending": True,
            "syncFinished": False,
            "syncUsable": False,
            "initialSyncPhase": "partial_idle",
            "partialReadUsable": True,
            "nextInitialSyncAt": 700000,
            "lastSyncSucceeded": None,
        })

        self.assertFalse(result)
        self.assertIn("同步状态响应无效", stderr)

    def test_pending_state_cannot_claim_full_sync_is_usable(self):
        status = self.partial_idle_status()
        status["syncFinished"] = True
        status["syncUsable"] = True
        result, stderr = self.run_wait_for_sync(status)

        self.assertFalse(result)
        self.assertIn("同步状态响应无效", stderr)

    def test_finished_partial_sync_allows_query_with_warning(self):
        result, stderr = self.run_wait_for_sync({
            "running": False,
            "startupSyncPending": False,
            "syncFinished": True,
            "syncUsable": True,
            "syncWarning": "存在部分同步异常，结果可能不完整",
            "lastSyncSucceeded": False,
            "lastSyncError": "部分同步失败",
        })

        self.assertTrue(result)
        self.assertIn("存在部分同步异常，结果可能不完整", stderr)
        self.assertNotIn("本次请求已停止", stderr)

    def test_complete_incremental_running_waits_then_queries_without_initial_warning(self):
        running_status = {
            "running": True,
            "startupSyncPending": False,
            "syncFinished": False,
            "syncUsable": False,
            "initialSyncPhase": "complete",
            "partialReadUsable": False,
            "nextInitialSyncAt": 0,
            "lastSyncSucceeded": None,
        }
        completed_status = {
            **running_status,
            "running": False,
            "syncFinished": True,
            "syncUsable": True,
            "lastSyncSucceeded": True,
        }
        stdout = io.StringIO()
        stderr = io.StringIO()
        responses = [FakeResponse({"data": running_status}), FakeResponse({"data": completed_status})]
        with mock.patch.object(self.api.urllib.request, "urlopen", side_effect=responses), \
                mock.patch.object(self.api.time, "time", side_effect=[0, 0, 0]), \
                mock.patch.object(self.api.time, "sleep"), \
                mock.patch.object(sys, "stdout", stdout), \
                mock.patch.object(sys, "stderr", stderr):
            result = self.api.wait_for_sync("http://127.0.0.1:46588/open-model-note/list", "GET")

        self.assertTrue(result)
        self.assertIn("Doxent 正在同步数据，请稍候", stdout.getvalue())
        self.assertNotIn("首次全量同步尚未完成", stderr.getvalue())

    def test_old_cli_pending_status_never_enables_partial_read(self):
        status = {
            "running": False,
            "startupSyncPending": True,
            "syncFinished": False,
            "syncUsable": False,
            "lastSyncCompletedAt": 100,
        }
        stdout = io.StringIO()
        stderr = io.StringIO()
        with mock.patch.object(self.api.urllib.request, "urlopen", return_value=FakeResponse({"data": status})), \
                mock.patch.object(self.api.time, "time", side_effect=[0, 0, 301]), \
                mock.patch.object(self.api.time, "sleep"), \
                mock.patch.object(sys, "stdout", stdout), \
                mock.patch.object(sys, "stderr", stderr):
            result = self.api.wait_for_sync("http://127.0.0.1:46588/open-model-note/list", "GET")

        self.assertFalse(result)
        self.assertIn("同步等待已超时", stderr.getvalue())
        self.assertNotIn(self.api.PARTIAL_READ_WARNING, stderr.getvalue())


    def test_query_cli_endpoint_accepts_only_running_cli_runtime(self):
        result = mock.Mock(returncode=0)
        result.stdout = json.dumps({"ok": True, "data": {
            "runtime": "cli", "coreState": "running", "port": 46589,
            "baseUrl": "http://127.0.0.1:46589", "instanceId": "instance-1"
        }}).encode("utf-8")
        with mock.patch.object(self.api.os.path, "isfile", return_value=True), \
                mock.patch.object(self.api.subprocess, "run", return_value=result):
            self.assertEqual(self.api.query_cli_endpoint("/tmp/doxent-cli"), "http://127.0.0.1:46589")

    def test_query_cli_endpoint_rejects_electron_runtime(self):
        result = mock.Mock(returncode=0)
        result.stdout = json.dumps({"ok": True, "data": {
            "runtime": "electron", "coreState": "running", "port": 46588,
            "baseUrl": "http://127.0.0.1:46588", "instanceId": "instance-2"
        }}).encode("utf-8")
        with mock.patch.object(self.api.os.path, "isfile", return_value=True), \
                mock.patch.object(self.api.subprocess, "run", return_value=result):
            self.assertIsNone(self.api.query_cli_endpoint("/tmp/doxent-cli"))

    def test_legacy_finished_partial_sync_allows_query_with_default_warning(self):
        result, stderr = self.run_wait_for_sync({
            "running": False,
            "startupSyncPending": False,
            "lastSyncSucceeded": False,
            "lastSyncError": "部分同步失败",
        })

        self.assertTrue(result)
        self.assertIn("存在部分同步异常，结果可能不完整", stderr)
        self.assertNotIn("本次请求已停止", stderr)

    def test_unfinished_sync_still_fails_closed_after_timeout(self):
        status = {
            "running": False,
            "startupSyncPending": False,
            "syncFinished": False,
            "syncUsable": False,
            "lastSyncSucceeded": None,
            "lastSyncError": "",
        }
        stdout = io.StringIO()
        stderr = io.StringIO()
        with mock.patch.object(self.api.urllib.request, "urlopen", return_value=FakeResponse({"data": status})), \
                mock.patch.object(self.api.time, "time", side_effect=[0, 0, 301]), \
                mock.patch.object(self.api.time, "sleep"), \
                mock.patch.object(sys, "stdout", stdout), \
                mock.patch.object(sys, "stderr", stderr):
            result = self.api.wait_for_sync("http://127.0.0.1:46588/open-model-note/search")

        self.assertFalse(result)
        self.assertIn("Doxent 正在同步数据，请稍候", stdout.getvalue())
        self.assertIn("同步等待已超时", stderr.getvalue())

    def test_status_without_required_fields_still_blocks_query(self):
        result, stderr = self.run_wait_for_sync({
            "running": False,
            "lastSyncSucceeded": False,
        })

        self.assertFalse(result)
        self.assertIn("同步状态响应无效", stderr)

    def test_partial_business_response_closes_before_requesting_next_batch(self):
        business_response = ClosingFakeResponse({"code": 200, "data": []})
        requests = []

        def urlopen(request, **_kwargs):
            requests.append((request.full_url, request.get_method()))
            return business_response

        wake_after_close = []

        def request_next_batch():
            wake_after_close.append(business_response.closed)
            return True

        stdout = io.StringIO()
        with mock.patch.object(self.api, "ensure_service", return_value="http://127.0.0.1:46588/open-model-note/list"), \
                mock.patch.object(self.api, "wait_for_sync_gate", return_value=self.api.SYNC_GATE_PARTIAL), \
                mock.patch.object(self.api, "request_next_initial_note_batch", side_effect=request_next_batch) as wake_request, \
                mock.patch.object(self.api.urllib.request, "urlopen", side_effect=urlopen), \
                mock.patch.object(sys, "argv", ["doxent_api.py", "--url", "http://127.0.0.1:46588/open-model-note/list"]), \
                mock.patch.object(sys, "stdout", stdout):
            result = self.api.main()

        self.assertEqual(result, 0)
        self.assertEqual(json.loads(stdout.getvalue()), {"code": 200, "data": []})
        self.assertEqual(requests, [("http://127.0.0.1:46588/open-model-note/list", "GET")])
        self.assertEqual(wake_after_close, [True])
        wake_request.assert_called_once_with()

    def test_status_ready_query_does_not_request_next_batch(self):
        business_response = FakeResponse({"code": 200, "data": []})
        with mock.patch.object(self.api, "ensure_service", return_value="http://127.0.0.1:46588/open-model-note/list"), \
                mock.patch.object(self.api, "wait_for_sync_gate", return_value=self.api.SYNC_GATE_READY), \
                mock.patch.object(self.api.urllib.request, "urlopen", return_value=business_response) as urlopen, \
                mock.patch.object(sys, "argv", ["doxent_api.py", "--url", "http://127.0.0.1:46588/open-model-note/list"]), \
                mock.patch.object(sys, "stdout", io.StringIO()):
            result = self.api.main()

        self.assertEqual(result, 0)
        self.assertEqual(urlopen.call_count, 1)

    def test_next_batch_request_failure_does_not_override_query_result(self):
        business_response = FakeResponse({"code": 200, "data": {"title": "已同步笔记"}})
        with mock.patch.object(self.api, "ensure_service", return_value="http://127.0.0.1:46588/open-model-note/file/content"), \
                mock.patch.object(self.api, "wait_for_sync_gate", return_value=self.api.SYNC_GATE_PARTIAL), \
                mock.patch.object(self.api, "request_next_initial_note_batch", return_value=False), \
                mock.patch.object(self.api.urllib.request, "urlopen", return_value=business_response), \
                mock.patch.object(sys, "argv", ["doxent_api.py", "--url", "http://127.0.0.1:46588/open-model-note/file/content"]), \
                mock.patch.object(sys, "stdout", io.StringIO()):
            result = self.api.main()

        self.assertEqual(result, 0)

    def test_partial_business_http_error_still_wakes_after_error_response_closes(self):
        error = self.api.urllib.error.HTTPError(
            "http://127.0.0.1:46588/open-model-note/file/content",
            404,
            "not found",
            {},
            io.BytesIO(b'{"code":404,"message":"not found"}'),
        )
        with mock.patch.object(self.api, "ensure_service", return_value="http://127.0.0.1:46588/open-model-note/file/content"), \
                mock.patch.object(self.api, "wait_for_sync_gate", return_value=self.api.SYNC_GATE_PARTIAL), \
                mock.patch.object(self.api, "request_next_initial_note_batch", return_value=True) as wake_request, \
                mock.patch.object(self.api.urllib.request, "urlopen", side_effect=error) as urlopen, \
                mock.patch.object(sys, "argv", ["doxent_api.py", "--url", "http://127.0.0.1:46588/open-model-note/file/content"]), \
                mock.patch.object(sys, "stderr", io.StringIO()):
            result = self.api.main()

        self.assertEqual(result, 1)
        self.assertEqual(urlopen.call_count, 1)
        wake_request.assert_called_once_with()

    def test_service_start_timeout_rechecks_login_status(self):
        stderr = io.StringIO()
        with mock.patch.object(self.api, "ensure_service", side_effect=RuntimeError("Doxent CLI 启动后未在 15 秒内提供本地服务")), \
                mock.patch.object(self.api, "recheck_login_status", return_value="未登录") as recheck, \
                mock.patch.object(sys, "argv", ["doxent_api.py", "--url", "http://127.0.0.1:46588/open-model-note/list"]), \
                mock.patch.object(sys, "stderr", stderr):
            result = self.api.main()

        self.assertEqual(result, 1)
        recheck.assert_called_once_with()
        self.assertIn("启动后未在 15 秒内提供本地服务", stderr.getvalue())
        self.assertIn("登录状态复核结果：未登录", stderr.getvalue())

    def test_connection_failure_rechecks_login_status(self):
        stderr = io.StringIO()
        with mock.patch.object(self.api, "ensure_service", return_value="http://127.0.0.1:46588/open-model-note/list"), \
                mock.patch.object(self.api, "wait_for_sync_gate", return_value=self.api.SYNC_GATE_READY), \
                mock.patch.object(self.api.urllib.request, "urlopen", side_effect=self.api.urllib.error.URLError("connection refused")), \
                mock.patch.object(self.api, "recheck_login_status", return_value="已登录") as recheck, \
                mock.patch.object(sys, "argv", ["doxent_api.py", "--url", "http://127.0.0.1:46588/open-model-note/list"]), \
                mock.patch.object(sys, "stderr", stderr):
            result = self.api.main()

        self.assertEqual(result, 1)
        recheck.assert_called_once_with()
        self.assertIn("登录状态复核结果：已登录", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
