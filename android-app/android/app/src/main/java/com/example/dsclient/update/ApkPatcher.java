package com.example.dsclient.update;

import com.github.luben.zstd.ZstdInputStream;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * zstd `--patch-from` 的解码侧：拿"本机已装的旧 APK"当字典，把补丁还原成新 APK。
 *
 * 为什么不用 bspatch/apt：服务端已经用 `zstd --patch-from` 生成补丁
 * （实测 4.23MB → 160KB），解码端只要 zstd 库即可，不必再引一套二进制差分格式。
 *
 * ⚠️ 刻意只用 `java.io`，不用 `java.nio.file`：
 * 后者要 API 26，而本项目 minSdk = 24 —— 用了会在 Android 7 上 NoClassDefFoundError。
 *
 * 这个类不碰任何 Android API：补丁逻辑最容易出错，放在纯 Java 里就能在 JVM 上跑真实数据单测。
 */
public final class ApkPatcher {
    private ApkPatcher() {}

    public static final int BUFFER = 64 * 1024;

    /**
     * 打补丁。
     *
     * @param oldApk       本机已安装的 APK（字典）
     * @param patch        zstd 补丁文件
     * @param out          输出 APK（覆盖写）
     * @param expectedSize 期望输出字节数；<=0 表示不校验长度（仍会走 sha256 校验）
     * @return 输出的 sha256（小写 hex）
     */
    public static String patch(File oldApk, File patch, File out, long expectedSize) throws IOException {
        byte[] result = apply(readAll(oldApk), readAll(patch), expectedSize);
        writeAll(out, result);
        return sha256(result);
    }

    /** 纯内存版本（单测直接用） */
    public static byte[] apply(byte[] oldApk, byte[] patch, long expectedSize) throws IOException {
        if (oldApk == null || oldApk.length == 0) {
            throw new IOException("old APK 为空，无法作为补丁字典");
        }
        byte[] out;
        try {
            out = decompressWithDict(patch, oldApk, expectedSize);
        } catch (Throwable error) {
            // 补丁与旧版本对不上、或补丁损坏：统一转成 IOException，
            // 上层据此"回退去下全量"，绝不能让用户卡在这里。
            throw new IOException("补丁还原失败: " + error.getMessage(), error);
        }
        if (expectedSize > 0 && out.length != expectedSize) {
            throw new IOException("补丁还原大小不符: " + out.length + " != " + expectedSize);
        }
        return out;
    }

    /** 用"旧文件为字典"的方式解压 zstd 帧 */
    private static byte[] decompressWithDict(byte[] patch, byte[] dict, long expectedSize) throws IOException {
        int hint = expectedSize > 0 && expectedSize < Integer.MAX_VALUE ? (int) expectedSize : 4 * 1024 * 1024;
        ByteArrayOutputStream out = new ByteArrayOutputStream(hint);
        ZstdInputStream in = new ZstdInputStream(new ByteArrayInputStream(patch));
        try {
            in.setDict(dict);
            byte[] buffer = new byte[BUFFER];
            int read;
            while ((read = in.read(buffer)) > 0) {
                out.write(buffer, 0, read);
            }
        } finally {
            in.close();
        }
        return out.toByteArray();
    }

    public static byte[] readAll(File file) throws IOException {
        long length = file.length();
        if (length > Integer.MAX_VALUE) {
            throw new IOException("文件过大: " + file);
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream((int) Math.max(length, 1024));
        try (InputStream in = new FileInputStream(file)) {
            copy(in, out);
        }
        return out.toByteArray();
    }

    public static void writeAll(File file, byte[] data) throws IOException {
        File parent = file.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new IOException("无法创建目录: " + parent);
        }
        try (OutputStream out = new FileOutputStream(file)) {
            out.write(data);
        }
    }

    public static String sha256(byte[] data) {
        MessageDigest digest = newDigest();
        digest.update(data);
        return hex(digest.digest());
    }

    public static String sha256(File file) throws IOException {
        MessageDigest digest = newDigest();
        try (InputStream in = new FileInputStream(file)) {
            byte[] buffer = new byte[BUFFER];
            int read;
            while ((read = in.read(buffer)) > 0) {
                digest.update(buffer, 0, read);
            }
        }
        return hex(digest.digest());
    }

    public static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buffer = new byte[BUFFER];
        int read;
        while ((read = in.read(buffer)) > 0) {
            out.write(buffer, 0, read);
        }
    }

    private static MessageDigest newDigest() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 不可用", error);
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder builder = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) {
            builder.append(Character.forDigit((value >> 4) & 0xF, 16));
            builder.append(Character.forDigit(value & 0xF, 16));
        }
        return builder.toString();
    }
}
