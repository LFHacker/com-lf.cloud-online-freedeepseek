package com.example.dsclient.update;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

/**
 * 分块落盘：JS 用 WebView 的 fetch 取字节，一块块交过来，这里负责拼成文件并校验。
 *
 * 为什么要这层：真机上原生 TLS 栈建连即被 reset（服务端连请求都没看到），
 * 只有 WebView 的网络是通的。于是网络 I/O 交给 WebView，原生只做"往磁盘写 + 校验"。
 *
 * 纯 java.io，无 Android API —— 这样这段"拼接/校验/重命名"的逻辑能在 JVM 上单测
 * （最容易出错的恰恰是"半截文件被当成下好了"）。
 */
public final class ChunkAssembler {
    private ChunkAssembler() {}

    public static final class Result {
        public final long size;
        public final String sha256;

        Result(long size, String sha256) {
            this.size = size;
            this.sha256 = sha256;
        }
    }

    /** 追加一块，返回累计字节数 */
    public static long append(File part, byte[] bytes) throws IOException {
        File parent = part.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new IOException("无法创建目录: " + parent);
        }
        try (FileOutputStream out = new FileOutputStream(part, true)) {
            out.write(bytes);
        }
        return part.length();
    }

    public static long partSize(File part) {
        return part.exists() ? part.length() : 0;
    }

    /**
     * 收尾：校验大小 + sha256，通过才重命名成正式文件。
     *
     * 校验失败要**删掉残片**：留着只会让下一次"以为续传了"、结果拼出坏文件。
     */
    public static Result finish(File part, File target, String expectedSha256, long expectedSize)
            throws IOException {
        if (!part.exists()) {
            throw new IOException("没有下到任何数据");
        }
        if (expectedSize > 0 && part.length() != expectedSize) {
            deleteQuietly(part);
            throw new IOException("下载不完整: " + part.length() + " != " + expectedSize);
        }
        String sha256 = ApkPatcher.sha256(part);
        if (expectedSha256 != null && !expectedSha256.isEmpty()
                && !expectedSha256.equalsIgnoreCase(sha256)) {
            deleteQuietly(part);
            throw new IOException("下载校验失败: sha256 不符");
        }
        deleteQuietly(target);
        if (!part.renameTo(target)) {
            throw new IOException("无法重命名下载文件: " + target);
        }
        return new Result(target.length(), sha256);
    }

    private static void deleteQuietly(File file) {
        if (file != null && file.exists()) {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
        }
    }
}
