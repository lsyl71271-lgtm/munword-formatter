package org.pkunmun.formatter2026;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.util.List;

/**
 * Lets WPS, Word or the share sheet read a file this app saved on Android 9 and earlier (Android 10+ shares the
 * MediaStore entry instead). Not exported: another app can only read a URI handed to it with a read grant, and only
 * a file directly inside the public Download folder or the app's own download folder, read-only.
 *
 *   content://org.pkunmun.formatter2026.files/downloads/<name>  → Download/<name>
 *   content://org.pkunmun.formatter2026.files/app/<name>        → Android/data/org.pkunmun.formatter2026/files/Download/<name>
 */
public final class SavedFiles extends ContentProvider {
    static final String AUTHORITY = "org.pkunmun.formatter2026.files";
    static final String DOWNLOADS = "downloads";
    static final String APP = "app";

    static Uri uriFor(String root, String name) {
        return new Uri.Builder().scheme("content").authority(AUTHORITY).appendPath(root).appendPath(name).build();
    }

    static File appFolder(Context context) throws IOException {
        File dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (dir == null) dir = new File(context.getFilesDir(), "Download");
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("无法创建 " + dir);
        return dir;
    }

    private File fileFor(Uri uri) throws FileNotFoundException {
        List<String> segments = uri.getPathSegments();
        if (segments.size() != 2) throw new FileNotFoundException(uri.toString());
        try {
            File dir = DOWNLOADS.equals(segments.get(0)) ? Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                    : APP.equals(segments.get(0)) ? appFolder(getContext()) : null;
            if (dir == null) throw new FileNotFoundException(uri.toString());
            File file = new File(dir, segments.get(1)).getCanonicalFile();
            if (!dir.getCanonicalFile().equals(file.getParentFile()) || !file.isFile()) throw new FileNotFoundException(uri.toString());
            return file;
        } catch (IOException e) {
            throw new FileNotFoundException(e.toString());
        }
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public String getType(Uri uri) {
        String path = uri.getPath() == null ? "" : uri.getPath().toLowerCase();
        if (path.endsWith(".docx")) return MainActivity.DOCX;
        if (path.endsWith(".json")) return "application/json";
        return "application/octet-stream";
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        File file;
        try {
            file = fileFor(uri);
        } catch (FileNotFoundException e) {
            return null;
        }
        String[] columns = (projection != null ? projection : new String[] {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}).clone();
        Object[] row = new Object[columns.length];
        int used = 0;
        for (int i = 0; i < columns.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(columns[i])) row[used] = file.getName();
            else if (OpenableColumns.SIZE.equals(columns[i])) row[used] = file.length();
            else continue;
            columns[used++] = columns[i];
        }
        String[] kept = new String[used];
        Object[] values = new Object[used];
        System.arraycopy(columns, 0, kept, 0, used);
        System.arraycopy(row, 0, values, 0, used);
        MatrixCursor cursor = new MatrixCursor(kept, 1);
        cursor.addRow(values);
        return cursor;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new SecurityException("read-only");
        return ParcelFileDescriptor.open(fileFor(uri), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException("read-only");
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("read-only");
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("read-only");
    }
}
