"""Full flow of the installed offline page in a real system browser (Edge, Chrome, Firefox, Safari).

    python desktop/acceptance/browser_flow.py --browser edge --page <installed site/index.html> --out <dir>
        [--opener <直接用浏览器打开.html> --expect <site directory the opener must reach>] [--quick]

Every acceptance input (six document types, Chinese and English) goes through select type → upload →
recognize → editable step 03 present (never filled in by the test) → generate (ZIP read back) → original
and generated previews; then a new file from the template panel. The page must make no http(s) request
and its Content-Security-Policy must refuse one. WebDriver cannot drive native file pickers in every
browser, so inputs are handed to the page's file field through a DataTransfer, and the generated file is
read from the Blob behind the download link. Writes <out>/<browser>.json and a screenshot; exit code 1 on
failure, 3 when the browser is not installed.
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os
import platform
import sys
import time
import traceback
import zipfile
from pathlib import Path

from selenium import webdriver
from selenium.common.exceptions import WebDriverException
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait

ROOT = Path(__file__).resolve().parents[2]
INPUTS = ROOT / "examples" / "acceptance-inputs"
CASES = [
    ("立场文件", "01_中文立场文件"), ("立场文件", "02_English_Position_Paper"), ("工作文件", "03_中文工作文件"),
    ("工作文件", "04_English_Working_Paper"), ("指令草案", "05_中文指令草案"), ("指令草案", "06_English_Draft_Directive"),
    ("决议草案", "07_中文决议草案"), ("决议草案", "08_English_Draft_Resolution"), ("友好修正案", "09_中文友好修正案"),
    ("非友好修正案", "10_中文非友好修正案"), ("友好修正案", "11_English_Amendment"),
]
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

# Re-installed after every page load: remembers the Blob behind a download link instead of saving it.
CAPTURE = """
window.__munword = { blobs: [], download: null };
const create = URL.createObjectURL;
URL.createObjectURL = function (blob) { window.__munword.blobs.push(blob); return create.call(URL, blob); };
const click = HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click = function () {
  if (this.hasAttribute("download")) { window.__munword.download = this.getAttribute("download"); return; }
  return click.call(this);
};
"""
READ_DOWNLOAD = """
const done = arguments[arguments.length - 1];
const blobs = window.__munword.blobs.filter(function (b) { return b.size > 1000; });
const reader = new FileReader();
reader.onload = function () { done({ name: window.__munword.download, url: reader.result }); };
reader.onerror = function () { done({ error: String(reader.error) }); };
reader.readAsDataURL(blobs[blobs.length - 1]);
"""
UPLOAD = """
const [data, name, type] = arguments;
const bytes = Uint8Array.from(atob(data), function (c) { return c.charCodeAt(0); });
const input = document.querySelector('input[type="file"]');
const transfer = new DataTransfer();
transfer.items.add(new File([bytes], name, { type: type }));
input.files = transfer.files;
input.dispatchEvent(new Event("change", { bubbles: true }));
"""
CLICK_TYPE = """
const wanted = arguments[0];
const card = Array.from(document.querySelectorAll(".typeCard")).find(function (c) {
  const b = c.querySelector("b"); return b && b.textContent.trim() === wanted;
});
if (!card) return false;
card.scrollIntoView({ block: "center" }); card.click(); return true;
"""
CLICK_BUTTON = """
const label = arguments[0];
const button = Array.from(document.querySelectorAll((arguments[1] + " button").trim())).find(function (b) {
  return b.textContent.indexOf(label) >= 0 && !b.disabled;
});
if (!button) return false;
button.scrollIntoView({ block: "center" }); button.click(); return true;
"""
NETWORK = """
return performance.getEntriesByType("resource").map(function (e) { return e.name; })
  .filter(function (n) { return /^https?:/i.test(n); });
"""
CSP_PROBE = """
const done = arguments[arguments.length - 1];
fetch("https://example.com/munword-csp-probe").then(function () { done("allowed"); }, function () { done("refused"); });
"""


def make_driver(name: str):
    binary = os.environ.get("MUNWORD_BROWSER_BINARY")  # local runs against a browser outside the usual place
    if name == "edge":
        options = webdriver.EdgeOptions()
        options.add_argument("--no-first-run")
        return webdriver.Edge(options=options)
    if name == "chrome":
        options = webdriver.ChromeOptions()
        options.add_argument("--no-first-run")
        if binary:
            options.binary_location = binary
            options.add_argument("--no-sandbox")
        return webdriver.Chrome(options=options)
    if name == "firefox":
        return webdriver.Firefox()
    if name == "safari":
        return webdriver.Safari()
    if name == "webkitgtk":  # Linux stand-in for Safari's engine in local runs
        options = webdriver.WebKitGTKOptions()
        options.binary_location = binary or "/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/MiniBrowser"
        options.add_argument("--automation")
        return webdriver.WebKitGTK(options=options)
    raise ValueError(name)


def wait(driver, condition, seconds=90, what="condition"):
    last = []

    def attempt(d):
        try:
            return condition(d)
        except WebDriverException as exc:  # transient while the page re-renders; kept for the report
            last[:] = [f"{type(exc).__name__}: {str(exc).splitlines()[0] if str(exc) else ''}"]
            return False
    try:
        return WebDriverWait(driver, seconds, poll_frequency=0.25).until(attempt)
    except Exception as exc:  # noqa: BLE001 - re-raised with context
        raise AssertionError(f"timed out waiting for {what}" + (f" (last error {last[0]})" if last else "")) from exc


def body_text(driver) -> str:
    return driver.execute_script("return document.body ? document.body.innerText : ''")


def frame_has_docx(driver, title: str) -> bool:
    frames = [f for f in driver.find_elements(By.TAG_NAME, "iframe") if f.get_attribute("title") == title]
    if not frames:
        return False
    driver.switch_to.frame(frames[0])
    try:
        return driver.execute_script("return document.querySelectorAll('section.docx').length") > 0
    finally:
        driver.switch_to.default_content()


def read_download(driver, label: str, out: Path) -> dict:
    wait(driver, lambda d: d.execute_script("return window.__munword && window.__munword.download"), what=f"{label} download")
    data = driver.execute_async_script(READ_DOWNLOAD)
    if "error" in data:
        raise AssertionError(f"{label}: {data['error']}")
    raw = base64.b64decode(data["url"].split(",", 1)[1])
    with zipfile.ZipFile(io.BytesIO(raw)) as package:
        document = package.read("word/document.xml")
    if len(document) <= 100:
        raise AssertionError(f"{label}: generated DOCX has no document body")
    (out / f"{label}.docx").write_bytes(raw)
    return {"download": data["name"], "bytes": len(raw)}


def run_case(driver, page_url: str, doc_type: str, name: str, out: Path) -> dict:
    driver.get(page_url)
    wait(driver, lambda d: d.find_elements(By.CSS_SELECTOR, ".typeCard"), what="the type cards")
    driver.execute_script(CAPTURE)
    if not driver.execute_script(CLICK_TYPE, doc_type):
        raise AssertionError(f"no type card {doc_type}")
    data = base64.b64encode((INPUTS / f"{name}.docx").read_bytes()).decode()
    driver.execute_script(UPLOAD, data, f"{name}.docx", DOCX)
    wait(driver, lambda d: d.execute_script(CLICK_BUTTON, "识别文件结构", ""), what="the recognize button")
    wait(driver, lambda d: "确认识别结果" in body_text(d), what="step 03")
    # Step 03 stays a real, editable review; the test never fills it in.
    editable = driver.execute_script("return document.querySelectorAll('.reviewSection input').length")
    if not editable:
        raise AssertionError("step 03 has no editable fields")
    if not driver.execute_script(CLICK_BUTTON, "生成并下载 DOCX", ""):
        raise AssertionError("no generate button")
    result = read_download(driver, name, out)
    wait(driver, lambda d: "成品已下载" in body_text(d), what="step 04")
    wait(driver, lambda d: d.execute_script(CLICK_BUTTON, "查看实际 DOCX 页面", ""), what="the preview button")
    wait(driver, lambda d: frame_has_docx(d, "原稿页面"), what="the original preview")
    wait(driver, lambda d: frame_has_docx(d, "生成后的 DOCX 页面"), what="the generated preview")
    return {"input": name, "type": doc_type, "editable_fields": editable, **result}


def run_template(driver, page_url: str, out: Path) -> dict:
    driver.get(page_url)
    wait(driver, lambda d: d.find_elements(By.CSS_SELECTOR, ".typeCard"), what="the page")
    driver.execute_script(CAPTURE)
    driver.execute_script("""
      const summary = Array.from(document.querySelectorAll("summary, button")).find(function (e) {
        return e.textContent.trim().indexOf("从规范模板新建文件") >= 0; });
      summary.scrollIntoView({ block: "center" }); summary.click();
    """)
    wait(driver, lambda d: d.find_elements(By.CSS_SELECTOR, ".templatePanel textarea"), what="the template panel")
    driver.execute_script("""
      const area = document.querySelector(".templatePanel textarea");
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(area, arguments[0]);
      area.dispatchEvent(new Event("input", { bubbles: true }));
    """, "第一条 要求建立合作机制。\n第二条 决定继续协商。")
    wait(driver, lambda d: d.execute_script(CLICK_BUTTON, "生成规范 DOCX", ".templatePanel"), what="the template button")
    return read_download(driver, "template", out)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", required=True, choices=("edge", "chrome", "firefox", "safari", "webkitgtk"))
    parser.add_argument("--page", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--opener", type=Path)
    parser.add_argument("--expect", type=Path, help="site directory the opener page must reach")
    parser.add_argument("--quick", action="store_true", help="only the English draft resolution")
    args = parser.parse_args()
    out = args.out / args.browser
    out.mkdir(parents=True, exist_ok=True)
    report = {"browser": args.browser, "platform": platform.platform(), "page": str(args.page), "passed": False}
    try:
        # safaridriver sometimes exits right after `safaridriver --enable` on fresh machines; retry briefly.
        for attempt in range(3):
            try:
                driver = make_driver(args.browser)
                break
            except WebDriverException:
                if args.browser != "safari" or attempt == 2:
                    raise
                time.sleep(5)
    except WebDriverException as exc:
        report.update(available=False, error=str(exc).splitlines()[0] if str(exc) else repr(exc))
        (args.out / f"{args.browser}.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"{args.browser}: not available ({report['error']})")
        return 3
    report["available"] = True
    report["version"] = driver.capabilities.get("browserVersion")
    started = time.monotonic()
    try:
        driver.set_window_size(1440, 1000)
        page_url = args.page.resolve().as_uri()
        report["page_url"] = page_url
        cases = [c for c in CASES if not args.quick or c[1] == "08_English_Draft_Resolution"]
        report["cases"] = [run_case(driver, page_url, doc_type, name, out) for doc_type, name in cases]
        report["template"] = run_template(driver, page_url, out)
        report["http_requests"] = driver.execute_script(NETWORK)
        report["csp_probe"] = driver.execute_async_script(CSP_PROBE)
        if report["http_requests"] or report["csp_probe"] != "refused":
            raise AssertionError(f"page reached the network: {report['http_requests']} csp={report['csp_probe']}")
        driver.save_screenshot(str(out / "final.png"))
        if args.opener:
            driver.get(args.opener.resolve().as_uri())
            target = (args.expect.resolve().as_uri() + "/index.html") if args.expect else "/site/index.html"
            wait(driver, lambda d: d.current_url.endswith(target) or d.current_url == target, seconds=30, what=f"the opener to reach {target}")
            wait(driver, lambda d: d.find_elements(By.CSS_SELECTOR, ".typeCard"), what="the app behind the opener")
            report["opener"] = {"from": args.opener.resolve().as_uri(), "reached": driver.current_url}
        report["passed"] = True
    except Exception as exc:  # noqa: BLE001 - reported, then exit 1
        report["error"] = f"{type(exc).__name__}: {exc}"
        report["traceback"] = traceback.format_exc()
        try:
            driver.save_screenshot(str(out / "failure.png"))
            report["page_text"] = body_text(driver)[:2000]
            report["url_at_failure"] = driver.current_url
            report["diagnostics"] = driver.execute_script("""
              var root = document.getElementById("root");
              return { href: location.href, ready: document.readyState, title: document.title,
                scripts: Array.prototype.map.call(document.scripts, function (s) { return s.src || "inline"; }),
                stylesheets: Array.prototype.map.call(document.styleSheets, function (s) { try { return (s.href || "inline") + ":" + s.cssRules.length; } catch (e) { return (s.href || "inline") + ":" + e.name; } }),
                root: root ? root.innerHTML.slice(0, 400) : null, findLast: typeof Array.prototype.findLast,
                layers: typeof window.CSSLayerBlockRule, userAgent: navigator.userAgent };
            """)
        except Exception as diag:  # noqa: BLE001
            report["diagnostics_error"] = repr(diag)
        # CI logs are often all there is; print what the page looked like.
        print(json.dumps({k: report.get(k) for k in ("url_at_failure", "diagnostics", "diagnostics_error", "page_text")}, ensure_ascii=False)[:3000])
    finally:
        report["seconds"] = round(time.monotonic() - started, 1)
        driver.quit()
    (args.out / f"{args.browser}.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    summary = f"{len(report.get('cases', []))} inputs + template" if report["passed"] else report.get("error")
    print(f"{args.browser} {report.get('version')}: {'PASS' if report['passed'] else 'FAIL'} — {summary}")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
