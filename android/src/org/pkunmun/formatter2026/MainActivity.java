package org.pkunmun.formatter2026;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.database.Cursor;
import android.graphics.Color;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.BufferedOutputStream;
import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The whole app: one WebView showing the same page as the website and the desktop apps (assets/site, built by
 * android/build-site.mjs), plus what a WebView cannot do by itself. android/bridge.js is the page's side of it.
 *
 * - Saving: the page's download link hands the file over (MunwordAndroid.begin / append / finish); it is written to
 *   the phone's Downloads folder, then the user can open it in WPS / Word or share it (through SavedFiles).
 * - Choosing a file: the page's file input opens the system file picker.
 * - "Open with" / "Share" from another app: the document is read here and given to the page's file input
 *   (window.__munwordReceive → openedName / openedSize / openedChunk / openedDone). Recognition, step 03 and
 *   generation stay the user's, exactly as on the website.
 *
 * Nothing is sent anywhere: the app has no INTERNET permission and the WebView loads nothing outside its assets.
 */
public final class MainActivity extends Activity {
    private static final String TAG = "Munword";
    private static final String SITE = "file:///android_asset/site/";
    private static final String PAGE = SITE + "index.html";
    static final String DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    private static final int PICK_FILE = 1;
    private static final int STORAGE_PERMISSION = 2;
    /** The page refuses files over 20 MB itself; anything much larger is not read into memory at all. */
    private static final long MAX_OPEN_BYTES = 25L * 1024 * 1024;
    private static final long MAX_SAVE_BYTES = 200L * 1024 * 1024;
    private static final int OPEN_CHUNK = 786432;

    private final Handler main = new Handler(Looper.getMainLooper());
    private WebView web;
    private boolean pageReady;
    private ValueCallback<Uri[]> chooserCallback;

    // Shared with the WebView's JavaBridge thread.
    private final Object lock = new Object();
    private final Map<Integer, Saving> savings = new HashMap<Integer, Saving>();
    private int nextSaving = 1;
    private String openedName;
    private byte[] openedBytes;

    // Waiting for the storage permission (Android 6–9).
    private final List<Saving> waitingToStore = new ArrayList<Saving>();
    private Uri waitingToOpen;

    /** A file the page is handing over, collected in the cache until it is complete. */
    private static final class Saving {
        final String name;
        final String mime;
        final long size;
        final File temp;
        OutputStream out;
        long written;
        String error;

        Saving(String name, String mime, long size, File temp) {
            this.name = name;
            this.mime = mime;
            this.size = size;
            this.temp = temp;
        }
    }

    /** Where a file ended up: its name there, a content URI of SavedFiles other apps can be granted, and a description. */
    private static final class Saved {
        final String name;
        final String mime;
        final Uri uri;
        final String where;

        Saved(String name, String mime, Uri uri, String where) {
            this.name = name;
            this.mime = mime;
            this.uri = uri;
            this.where = where;
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 27) {
            // Light navigation bar to match the page (Android 8.1+; the flag is not in the API 23 SDK).
            getWindow().setNavigationBarColor(Color.WHITE);
            getWindow().getDecorView().setSystemUiVisibility(getWindow().getDecorView().getSystemUiVisibility() | 0x10);
        }
        // Remote debugging only when asked for from a computer with `adb shell setprop debug.munword.devtools 1`
        // (the automated phone tests drive this exact APK that way); off for everyone else.
        WebView.setWebContentsDebuggingEnabled(devtoolsRequested());
        createWebView();
        receive(getIntent());
    }

    private void createWebView() {
        pageReady = false;
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(0xed, 0xf5, 0xfa));
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        // The page lives in the app's assets, which stay readable; nothing else on the phone is.
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setBuiltInZoomControls(false);
        settings.setSupportZoom(false);
        settings.setTextZoom(Math.round(getResources().getConfiguration().fontScale * 100));
        web.addJavascriptInterface(new Bridge(), "MunwordAndroid");
        web.setWebViewClient(new PageClient());
        web.setWebChromeClient(new ChromeClient());
        web.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String disposition, String mime, long length) {
                showMessage("无法保存", "这个文件无法从页面直接保存。请重新点击下载按钮。");
            }
        });
        setContentView(web);
        web.loadUrl(PAGE);
    }

    private static boolean devtoolsRequested() {
        try {
            Process process = new ProcessBuilder("getprop", "debug.munword.devtools").redirectErrorStream(true).start();
            BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream()));
            String line = reader.readLine();
            process.waitFor();
            return line != null && line.trim().equals("1");
        } catch (Exception e) {
            return false;
        }
    }

    private final class PageClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return !url.startsWith(SITE); // the page has no links out; nothing else is ever loaded
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            String url = request.getUrl().toString();
            if (url.startsWith(SITE) || url.startsWith("data:") || url.startsWith("blob:")) return null;
            Log.w(TAG, "blocked " + url);
            return new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            pageReady = true;
            deliverOpened();
        }

        // Not marked @Override: the method is Android 8.0's (API 26) and this compiles against API 23.
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // Android 8+: the page's process was stopped (usually low memory). Start the page again instead of
            // letting the app close; the document the user was working on is gone with it.
            Log.w(TAG, "render process gone, crash=" + detail.didCrash());
            if (view == web) {
                ((ViewGroup) web.getParent()).removeView(web);
                web.destroy();
                web = null;
                createWebView();
                Toast.makeText(MainActivity.this, "页面意外关闭，已重新打开。请重新选择文件。", Toast.LENGTH_LONG).show();
            }
            return true;
        }
    }

    private final class ChromeClient extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (chooserCallback != null) chooserCallback.onReceiveValue(null);
            chooserCallback = callback;
            Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
            pick.addCategory(Intent.CATEGORY_OPENABLE);
            pick.setType("*/*");
            // Word documents, and files a provider could not name a type for (e.g. received through chat apps).
            pick.putExtra(Intent.EXTRA_MIME_TYPES, new String[] {DOCX, "application/octet-stream", "application/zip"});
            try {
                startActivityForResult(pick, PICK_FILE);
            } catch (ActivityNotFoundException e) {
                try {
                    startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*"), PICK_FILE);
                } catch (ActivityNotFoundException again) {
                    chooserCallback = null;
                    callback.onReceiveValue(null);
                    Toast.makeText(MainActivity.this, "没有找到文件选择器。可以在微信、QQ 或文件管理里用「其他应用打开」选择本应用。", Toast.LENGTH_LONG).show();
                }
            }
            return true;
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage message) {
            Log.i(TAG, "console " + message.messageLevel() + ": " + message.message());
            return true;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != PICK_FILE) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        ValueCallback<Uri[]> callback = chooserCallback;
        chooserCallback = null;
        if (callback == null) return;
        Uri uri = resultCode == RESULT_OK && data != null ? data.getData() : null;
        callback.onReceiveValue(uri == null ? null : new Uri[] {uri});
    }

    // ---- The page's side: window.MunwordAndroid (called on the WebView's JavaBridge thread) ----

    private final class Bridge {
        @JavascriptInterface
        public int begin(String name, String mime, long size) {
            String safe = safeName(name);
            if (size < 0 || size > MAX_SAVE_BYTES) {
                reportFailure(safe, "文件过大（" + size + " 字节）。");
                return 0;
            }
            try {
                File dir = new File(getCacheDir(), "saving");
                if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
                Saving saving = new Saving(safe, mime == null || mime.isEmpty() ? "application/octet-stream" : mime, size, File.createTempFile("save", ".part", dir));
                saving.out = new BufferedOutputStream(new FileOutputStream(saving.temp), 1 << 16);
                synchronized (lock) {
                    int id = nextSaving++;
                    savings.put(id, saving);
                    return id;
                }
            } catch (IOException e) {
                reportFailure(safe, e.toString());
                return 0;
            }
        }

        @JavascriptInterface
        public void append(int id, String base64) {
            Saving saving;
            synchronized (lock) {
                saving = savings.get(id);
            }
            if (saving == null || saving.error != null) return;
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                saving.out.write(bytes);
                saving.written += bytes.length;
            } catch (IOException | IllegalArgumentException e) {
                saving.error = e.toString();
            }
        }

        @JavascriptInterface
        public void finish(int id) {
            final Saving saving;
            synchronized (lock) {
                saving = savings.remove(id);
            }
            if (saving == null) return;
            try {
                saving.out.close();
            } catch (IOException e) {
                if (saving.error == null) saving.error = e.toString();
            }
            if (saving.error == null && saving.written != saving.size) saving.error = "收到 " + saving.written + " / " + saving.size + " 字节";
            if (saving.error != null) {
                saving.temp.delete();
                reportFailure(saving.name, saving.error);
                return;
            }
            main.post(new Runnable() {
                @Override
                public void run() {
                    store(saving);
                }
            });
        }

        @JavascriptInterface
        public void failed(String name, String message) {
            reportFailure(safeName(name), message);
        }

        @JavascriptInterface
        public String openedName() {
            synchronized (lock) {
                return openedName == null ? "" : openedName;
            }
        }

        @JavascriptInterface
        public int openedSize() {
            synchronized (lock) {
                return openedBytes == null ? 0 : openedBytes.length;
            }
        }

        /** A piece of the opened file as base64; pieces are a multiple of 3 bytes, so each decodes on its own. */
        @JavascriptInterface
        public String openedChunk(int offset, int length) {
            synchronized (lock) {
                if (openedBytes == null || offset < 0 || offset >= openedBytes.length || length <= 0) return "";
                int count = Math.min(Math.min(length, OPEN_CHUNK), openedBytes.length - offset);
                return Base64.encodeToString(openedBytes, offset, count, Base64.NO_WRAP);
            }
        }

        @JavascriptInterface
        public void openedDone() {
            synchronized (lock) {
                openedName = null;
                openedBytes = null;
            }
        }
    }

    // ---- Saving to Downloads ----

    private void store(Saving saving) {
        if (Build.VERSION.SDK_INT >= 23 && Build.VERSION.SDK_INT < 29
                && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            waitingToStore.add(saving);
            if (waitingToStore.size() == 1) requestPermissions(new String[] {Manifest.permission.WRITE_EXTERNAL_STORAGE}, STORAGE_PERMISSION);
            return;
        }
        storeInBackground(saving, true);
    }

    private void storeInBackground(final Saving saving, final boolean publicFolder) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    final Saved saved = Build.VERSION.SDK_INT >= 29 ? storeInMediaStore(saving)
                            : publicFolder ? storeInDownloads(saving) : storeInAppFolder(saving);
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            showSaved(saved);
                        }
                    });
                } catch (Exception e) {
                    Log.e(TAG, "save failed", e);
                    reportFailure(saving.name, e.toString());
                } finally {
                    saving.temp.delete();
                }
            }
        }, "save").start();
    }

    /** Android 10+: the shared Downloads collection; no permission needed, and the phone names duplicates "x (1)". */
    private Saved storeInMediaStore(Saving saving) throws IOException {
        ContentResolver resolver = getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, saving.name);
        values.put(MediaStore.MediaColumns.MIME_TYPE, saving.mime);
        values.put("relative_path", Environment.DIRECTORY_DOWNLOADS + "/"); // MediaColumns.RELATIVE_PATH (API 29)
        values.put("is_pending", 1); // MediaColumns.IS_PENDING (API 29): hidden from other apps until complete
        Uri uri = resolver.insert(Uri.parse("content://media/external/downloads"), values);
        if (uri == null) throw new IOException("系统没有创建下载文件");
        try {
            OutputStream out = resolver.openOutputStream(uri);
            if (out == null) throw new IOException("无法写入下载文件");
            try {
                copy(new FileInputStream(saving.temp), out);
            } finally {
                out.close();
            }
            ContentValues done = new ContentValues();
            done.put("is_pending", 0);
            resolver.update(uri, done, null, null);
        } catch (IOException | RuntimeException e) {
            resolver.delete(uri, null, null);
            throw e;
        }
        String name = saving.name;
        Cursor cursor = resolver.query(uri, new String[] {MediaStore.MediaColumns.DISPLAY_NAME}, null, null, null);
        if (cursor != null) {
            try {
                if (cursor.moveToFirst() && cursor.getString(0) != null) name = cursor.getString(0);
            } finally {
                cursor.close();
            }
        }
        return new Saved(name, saving.mime, SavedFiles.mediaUriFor(ContentUris.parseId(uri), name), "手机的「下载」（Download）文件夹");
    }

    /** Android 5–9 with the storage permission: the public Download folder. */
    private Saved storeInDownloads(Saving saving) throws IOException {
        File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("无法创建 " + dir);
        File target = unique(dir, saving.name);
        copy(new FileInputStream(saving.temp), new FileOutputStream(target));
        MediaScannerConnection.scanFile(this, new String[] {target.getPath()}, new String[] {saving.mime}, null);
        return new Saved(target.getName(), saving.mime, SavedFiles.uriFor(SavedFiles.DOWNLOADS, target.getName()), "手机的「下载」（Download）文件夹");
    }

    /** Android 6–9 without the permission: the app's own folder, still reachable through 打开 / 分享. */
    private Saved storeInAppFolder(Saving saving) throws IOException {
        File dir = SavedFiles.appFolder(this);
        File target = unique(dir, saving.name);
        copy(new FileInputStream(saving.temp), new FileOutputStream(target));
        return new Saved(target.getName(), saving.mime, SavedFiles.uriFor(SavedFiles.APP, target.getName()),
                "应用自己的文件夹（" + dir.getPath() + "），因为没有获得存储权限。可以点「分享」发送或用 WPS 打开");
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        if (requestCode != STORAGE_PERMISSION) return;
        boolean granted = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        List<Saving> pending = new ArrayList<Saving>(waitingToStore);
        waitingToStore.clear();
        for (Saving saving : pending) storeInBackground(saving, granted);
        Uri open = waitingToOpen;
        waitingToOpen = null;
        if (open != null) {
            if (granted) readOpened(open);
            else showMessage("无法打开文件", "打开这个文件需要存储权限。也可以在本应用里点「选择文件」重新选择它。");
        }
    }

    private void showSaved(final Saved saved) {
        if (isFinishing()) return;
        boolean docx = saved.mime.equals(DOCX);
        new AlertDialog.Builder(this)
                .setTitle("已保存")
                .setMessage("文件：" + saved.name + "\n位置：" + saved.where + "。"
                        + (docx ? "\n\n可以用 WPS Office 或 Microsoft Word 打开。" : ""))
                .setPositiveButton("打开", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        openSaved(saved);
                    }
                })
                .setNeutralButton("分享", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        shareSaved(saved);
                    }
                })
                .setNegativeButton("完成", null)
                .show();
    }

    private void openSaved(Saved saved) {
        Intent view = new Intent(Intent.ACTION_VIEW).setDataAndType(saved.uri, saved.mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            startActivity(view);
        } catch (ActivityNotFoundException | SecurityException e) {
            showMessage("没有可以打开的应用", saved.mime.equals(DOCX)
                    ? "手机上没有能打开 DOCX 的应用。请先安装 WPS Office 或 Microsoft Word；文件已经保存在「下载」文件夹里。"
                    : "手机上没有能打开这种文件的应用。文件已经保存，可以点「分享」发送。");
        }
    }

    private void shareSaved(Saved saved) {
        Intent send = new Intent(Intent.ACTION_SEND).setType(saved.mime).putExtra(Intent.EXTRA_STREAM, saved.uri)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        send.setClipData(ClipData.newRawUri(saved.name, saved.uri));
        try {
            startActivity(Intent.createChooser(send, "分享文件"));
        } catch (ActivityNotFoundException | SecurityException e) {
            showMessage("无法分享", "手机上没有可以接收文件的应用。");
        }
    }

    // ---- "Open with" / "Share" from another app ----

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        receive(intent);
    }

    private void receive(Intent intent) {
        if (intent == null) return;
        Uri uri = null;
        if (Intent.ACTION_VIEW.equals(intent.getAction())) uri = intent.getData();
        else if (Intent.ACTION_SEND.equals(intent.getAction())) uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (uri == null) return;
        // Handled once: coming back to the app later must not hand the same file over again.
        intent.setAction(Intent.ACTION_MAIN);
        if ("file".equals(uri.getScheme()) && Build.VERSION.SDK_INT >= 23 && Build.VERSION.SDK_INT < 29
                && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            waitingToOpen = uri; // an older app sent a plain file path, which needs the storage permission to read
            requestPermissions(new String[] {Manifest.permission.WRITE_EXTERNAL_STORAGE}, STORAGE_PERMISSION);
            return;
        }
        readOpened(uri);
    }

    private void readOpened(final Uri uri) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    String name = null;
                    long size = -1;
                    if ("content".equals(uri.getScheme())) {
                        Cursor cursor = getContentResolver().query(uri, new String[] {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null);
                        if (cursor != null) {
                            try {
                                if (cursor.moveToFirst()) {
                                    if (!cursor.isNull(0)) name = cursor.getString(0);
                                    if (!cursor.isNull(1)) size = cursor.getLong(1);
                                }
                            } finally {
                                cursor.close();
                            }
                        }
                    }
                    if (name == null || name.trim().isEmpty()) name = uri.getLastPathSegment();
                    if (size > MAX_OPEN_BYTES) throw new IOException("文件超过 20 MB，请精简图片后重试。");
                    InputStream in = getContentResolver().openInputStream(uri);
                    if (in == null) throw new IOException("无法读取这个文件。");
                    ByteArrayOutputStream bytes = new ByteArrayOutputStream(size > 0 ? (int) size : 1 << 16);
                    try {
                        byte[] buffer = new byte[1 << 16];
                        for (int count; (count = in.read(buffer)) > 0; ) {
                            bytes.write(buffer, 0, count);
                            if (bytes.size() > MAX_OPEN_BYTES) throw new IOException("文件超过 20 MB，请精简图片后重试。");
                        }
                    } finally {
                        in.close();
                    }
                    synchronized (lock) {
                        openedName = safeName(name == null ? "未命名.docx" : name);
                        openedBytes = bytes.toByteArray();
                    }
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            deliverOpened();
                        }
                    });
                } catch (Exception e) {
                    Log.e(TAG, "open failed", e);
                    final String message = e instanceof IOException && e.getMessage() != null && !e.getMessage().startsWith("/") ? e.getMessage() : e.toString();
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            showMessage("无法打开文件", message + "\n\n也可以在本应用里点上传区域，从手机里选择这个文件。");
                        }
                    });
                }
            }
        }, "open").start();
    }

    /** Hands the opened file to the page once it is loaded (android/bridge.js reads it back in pieces). */
    private void deliverOpened() {
        boolean waiting;
        synchronized (lock) {
            waiting = openedBytes != null;
        }
        if (waiting && pageReady && web != null) web.evaluateJavascript("window.__munwordReceive && window.__munwordReceive()", null);
    }

    // ---- Activity plumbing ----

    @Override
    public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        if (web != null) web.getSettings().setTextZoom(Math.round(configuration.fontScale * 100));
    }

    @Override
    public void onBackPressed() {
        // The page is a single screen: Back leaves the app but keeps the work in progress for when the user returns.
        moveTaskToBack(true);
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            ((ViewGroup) web.getParent()).removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    private void reportFailure(final String name, final String message) {
        Log.e(TAG, "save failed: " + name + ": " + message);
        main.post(new Runnable() {
            @Override
            public void run() {
                showMessage("保存失败", "「" + name + "」没有保存成功：" + message + "\n\n请再点一次下载按钮；如果仍然失败，请检查手机存储空间。");
            }
        });
    }

    private void showMessage(String title, String message) {
        if (isFinishing()) return;
        new AlertDialog.Builder(this).setTitle(title).setMessage(message).setPositiveButton("好", null).show();
    }

    /** A file name safe for any folder: no path, no characters Android or Windows refuse, a sensible length. */
    static String safeName(String name) {
        String safe = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f\\x7f]", "_").trim();
        while (safe.startsWith(".")) safe = safe.substring(1);
        if (safe.isEmpty()) safe = "PKUNMUN2026.docx";
        if (safe.length() > 120) {
            int dot = safe.lastIndexOf('.');
            String extension = dot > 0 && safe.length() - dot <= 10 ? safe.substring(dot) : "";
            safe = safe.substring(0, 120 - extension.length()) + extension;
        }
        return safe;
    }

    private static File unique(File dir, String name) {
        File file = new File(dir, name);
        if (!file.exists()) return file;
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name, extension = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; ; i++) {
            file = new File(dir, base + " (" + i + ")" + extension);
            if (!file.exists()) return file;
        }
    }

    private static void copy(InputStream in, OutputStream out) throws IOException {
        try {
            byte[] buffer = new byte[1 << 16];
            for (int count; (count = in.read(buffer)) > 0; ) out.write(buffer, 0, count);
            out.flush();
        } finally {
            in.close();
            out.close();
        }
    }
}
