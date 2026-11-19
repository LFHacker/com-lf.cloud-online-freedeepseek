package com.example.dsclient.update;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import java.io.File;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * 唤起系统安装器 + 签名比对。只碰 Android API，不含流程逻辑。
 *
 * 签名比对为什么重要：安装器只接受"与已装应用同一个签名"的 APK。
 * 签名不同的话，用户点完安装会被系统拒绝（或者更糟：提示覆盖失败），
 * 而这完全可以在下载完就判出来 —— 提前判，就能自动改下全量，而不是让用户白等。
 */
public final class UpdateInstaller {
    private UpdateInstaller() {}

    /** 是否已允许"安装未知应用"（Android 8+ 才能查） */
    public static boolean canInstall(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return true;
        }
        return context.getPackageManager().canRequestPackageInstalls();
    }

    /** 跳转到"允许安装此来源的应用"设置页 */
    public static Intent permissionIntent(Context context) {
        Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
        intent.setData(Uri.parse("package:" + context.getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return intent;
    }

    /** 已安装包的签名摘要 */
    @SuppressWarnings("deprecation")
    public static String installedSignatureDigest(Context context) {
        try {
            PackageInfo info = context.getPackageManager()
                    .getPackageInfo(context.getPackageName(), PackageManager.GET_SIGNATURES);
            if (info == null || info.signatures == null || info.signatures.length == 0) {
                return null;
            }
            return digest(info.signatures[0].toByteArray());
        } catch (PackageManager.NameNotFoundException error) {
            return null;
        }
    }

    /** 待安装 APK 的签名摘要 */
    @SuppressWarnings("deprecation")
    public static String apkSignatureDigest(Context context, File apk) {
        PackageInfo info = context.getPackageManager()
                .getPackageArchiveInfo(apk.getAbsolutePath(), PackageManager.GET_SIGNATURES);
        if (info == null || info.signatures == null || info.signatures.length == 0) {
            return null;
        }
        return digest(info.signatures[0].toByteArray());
    }

    /**
     * 签名是否与已装应用一致。
     * 任一侧读不出来就**不阻断**：宁可让系统安装器自己报错，
     * 也不要因为解析失败把一次正常更新误判成"签名不符"。
     */
    public static boolean signatureMatches(Context context, File apk) {
        String installed = installedSignatureDigest(context);
        String candidate = apkSignatureDigest(context, apk);
        return installed == null || candidate == null || installed.equals(candidate);
    }

    public static Uri uriFor(Context context, File apk) {
        return FileProvider.getUriForFile(
                context,
                context.getPackageName() + ".fileprovider",
                apk
        );
    }

    public static Intent installIntent(Context context, File apk) {
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uriFor(context, apk), "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        return intent;
    }

    private static String digest(byte[] data) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] bytes = digest.digest(data);
            StringBuilder builder = new StringBuilder(bytes.length * 2);
            for (byte value : bytes) {
                builder.append(Character.forDigit((value >> 4) & 0xF, 16));
                builder.append(Character.forDigit(value & 0xF, 16));
            }
            return builder.toString();
        } catch (NoSuchAlgorithmException error) {
            return null;
        }
    }
}
