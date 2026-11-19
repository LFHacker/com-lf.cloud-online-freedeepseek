package com.example.dsclient.update;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 可续传的下载器（HTTP Range），纯 Java，可在 JVM 上单测。
 *
 * 为什么要续传：APK 5.3MB、补丁 160KB，手机网络下中断是常态。
 * 不能续传 = 断了从头再来，用户在外面用流量时会直接放弃更新。
 *
 * 语义：
 *  · 目标旁边放 `<dest>.part`，它的长度就是断点
 *  · 有断点就发 `Range: bytes=<len>-`，服务端回 206 就追加
 *  · 服务端回 200（不支持 Range / 文件变了）就**从零重下**，绝不拼错
 *  · 下完校验长度 + sha256，都过才重命名成正式文件
 *
 * ⚠️ 只用 java.io（不用 java.nio.file）：后者要 API 26，本项目 minSdk = 24。
 */
public final class ResumableDownloader {
    private ResumableDownloader() {}

    public interface ProgressListener {
        void onProgress(long received, long total);
    }

    /** 用户取消（不算失败，界面别弹错误） */
    public static final class CancelledException extends IOException {
        public CancelledException() {
            super("已取消");
        }
    }

    public static final class Result {
        public final long size;
        public final String sha256;

        Result(long size, String sha256) {
            this.size = size;
            this.sha256 = sha256;
        }
    }

    public static Result download(
            String url,
            File dest,
            String expectedSha256,
            long expectedSize,
            ProgressListener listener,
            AtomicBoolean cancel
    ) throws IOException {
        return download(url, dest, expectedSha256, expectedSize, listener, cancel, true);
    }

    private static Result download(
            String url,
            File dest,
            String expectedSha256,
            long expectedSize,
            ProgressListener listener,
            AtomicBoolean cancel,
            boolean allowRestart
    ) throws IOException {
        File part = new File(dest.getPath() + ".part");
        File parent = dest.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new IOException("无法创建下载目录: " + parent);
        }

        long existing = part.exists() ? part.length() : 0;
        if (expectedSize > 0 && existing > expectedSize) {
            // 残留的 .part 比目标还大：一定是别的东西，别接着写
            existing = 0;
            deleteQuietly(part);
        }

        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(30_000);
        connection.setInstanceFollowRedirects(true);
        connection.setRequestProperty("Accept-Encoding", "identity");
        if (existing > 0) {
            connection.setRequestProperty("Range", "bytes=" + existing + "-");
        }

        int code;
        try {
            code = connection.getResponseCode();
        } catch (IOException error) {
            connection.disconnect();
            throw error;
        }

        if (code == 416) {
            // 断点比服务端文件还长（文件被换掉了）：丢掉重来
            connection.disconnect();
            deleteQuietly(part);
            if (!allowRestart) {
                throw new IOException("下载失败: HTTP 416");
            }
            return download(url, dest, expectedSha256, expectedSize, listener, cancel, false);
        }
        if (code != 200 && code != 206) {
            connection.disconnect();
            throw new IOException("下载失败: HTTP " + code);
        }

        boolean append = code == 206 && existing > 0;
        long start = append ? existing : 0;
        if (!append) {
            deleteQuietly(part);
        }
        long contentLength = connection.getContentLengthLong();
        long total = expectedSize > 0
                ? expectedSize
                : (contentLength > 0 ? start + contentLength : -1);

        long received = start;
        try (InputStream in = connection.getInputStream();
             FileOutputStream out = new FileOutputStream(part, append)) {
            byte[] buffer = new byte[ApkPatcher.BUFFER];
            int read;
            long lastReport = 0;
            while ((read = in.read(buffer)) > 0) {
                if (cancel != null && cancel.get()) {
                    out.flush();
                    throw new CancelledException();
                }
                out.write(buffer, 0, read);
                received += read;
                if (listener != null && (received - lastReport >= 256 * 1024 || received == total)) {
                    lastReport = received;
                    listener.onProgress(received, total);
                }
            }
        } finally {
            connection.disconnect();
        }

        if (expectedSize > 0 && part.length() != expectedSize) {
            deleteQuietly(part);
            throw new IOException("下载不完整: " + part.length() + " != " + expectedSize);
        }
        String sha256 = ApkPatcher.sha256(part);
        if (expectedSha256 != null && !expectedSha256.isEmpty()
                && !expectedSha256.equalsIgnoreCase(sha256)) {
            // 哈希不符 = 内容坏了（半截 / 服务端换了文件）：删掉，下次重下
            deleteQuietly(part);
            throw new IOException("下载校验失败: sha256 不符");
        }
        if (listener != null) {
            listener.onProgress(part.length(), part.length());
        }
        deleteQuietly(dest);
        if (!part.renameTo(dest)) {
            throw new IOException("无法重命名下载文件: " + dest);
        }
        return new Result(dest.length(), sha256);
    }

    private static void deleteQuietly(File file) {
        if (file != null && file.exists()) {
            // 删不掉就留着：下次会因为大小/哈希不符被判掉
            //noinspection ResultOfMethodCallIgnored
            file.delete();
        }
    }
}
