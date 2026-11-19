package com.example.dsclient.update;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.Reader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;

/**
 * 应用内更新（原生侧）：查清单 / 下载（可续传）/ 打补丁 / 唤起安装。
 *
 * 分工说明：
 *  · **原生**负责网络与大文件与安装 —— WebView 里做这些会被系统杀、也没有安装权限
 *  · **JS** 负责流程决策（要不要更新、有补丁就下补丁、失败回退全量）
 *
 * 所有文件都放在 `cacheDir/updates`：
 *  · 不占用户可见存储、不进备份
 *  · 走 FileProvider（cache-path）交给系统安装器，不需要外部存储权限
 *
 * 线程：下载/打补丁放到单线程执行器里，避免堵住 Capacitor 的 bridge 线程
 * （堵住的话整个 WebView 的其它插件调用都会卡住）。
 */
@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {
    /** 文件名白名单（与服务端 /update/file 的规则一致，同时挡住路径穿越） */
    private static final Pattern SAFE_NAME = Pattern.compile("^[A-Za-z0-9._-]{4,120}$");

    private ExecutorService worker;
    private final AtomicBoolean cancelFlag = new AtomicBoolean(false);

    @Override
    public void load() {
        worker = Executors.newSingleThreadExecutor();
    }

    @Override
    protected void handleOnDestroy() {
        cancelFlag.set(true);
        if (worker != null) {
            worker.shutdownNow();
            worker = null;
        }
    }

    /** 更新文件目录（cache/updates） */
    private File updatesDir() {
        File dir = new File(getContext().getCacheDir(), "updates");
        if (!dir.exists() && !dir.mkdirs()) {
            // 目录建不出来时后续 IO 会报明确错误，这里不抛
            return dir;
        }
        return dir;
    }

    private void runAsync(PluginCall call, ThrowingTask task) {
        if (worker == null) {
            call.reject("插件已销毁", "destroyed");
            return;
        }
        worker.execute(() -> {
            try {
                task.run(call);
            } catch (ResumableDownloader.CancelledException cancelled) {
                call.reject("已取消", "cancelled");
            } catch (Throwable error) {
                String message = error.getMessage() == null ? error.toString() : error.getMessage();
                call.reject(message, error.getClass().getSimpleName());
            }
        });
    }

    private interface ThrowingTask {
        void run(PluginCall call) throws Exception;
    }

    /** 本机版本与安装环境（JS 用它判断要不要更新、能不能直接安装） */
    @PluginMethod
    public void getInfo(PluginCall call) {
        try {
            PackageInfo info = getContext().getPackageManager()
                    .getPackageInfo(getContext().getPackageName(), 0);
            JSObject result = new JSObject();
            result.put("versionName", info.versionName == null ? "" : info.versionName);
            result.put("versionCode", versionCodeOf(info));
            result.put("packageName", getContext().getPackageName());
            result.put("apkPath", getContext().getApplicationInfo().sourceDir);
            result.put("cacheDir", updatesDir().getAbsolutePath());
            result.put("canInstall", UpdateInstaller.canInstall(getContext()));
            result.put("sdk", Build.VERSION.SDK_INT);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("读取版本信息失败: " + error.getMessage(), "info_failed");
        }
    }

    /** 拉更新清单（公开接口，不需要登录）；返回体直接是清单字段 + fileBaseUrl */
    @PluginMethod
    public void checkManifest(PluginCall call) {
        String baseUrl = call.getString("baseUrl");
        String channel = call.getString("channel", "release");
        if (baseUrl == null || baseUrl.trim().isEmpty()) {
            call.reject("缺少 baseUrl", "bad_args");
            return;
        }
        runAsync(call, ignored -> {
            String url = trimSlash(baseUrl)
                    + "/update/manifest?channel=" + URLEncoder.encode(channel, "UTF-8");
            String body = httpGet(url);
            JSObject manifest = new JSObject(body);
            manifest.put("fileBaseUrl", trimSlash(baseUrl) + "/update/file/");
            call.resolve(manifest);
        });
    }

    /**
     * 下载（断点续传）。
     * params: { url, name, sha256?, size? }
     * 已存在且哈希一致时直接返回（重复点击/重进页面不会重下）。
     */
    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        String name = call.getString("name");
        String sha256 = call.getString("sha256");
        Long size = call.getLong("size");
        if (url == null || name == null || !SAFE_NAME.matcher(name).matches()) {
            call.reject("参数不合法", "bad_args");
            return;
        }
        runAsync(call, ignored -> {
            File target = new File(updatesDir(), name);
            if (target.exists() && sha256 != null && !sha256.isEmpty()) {
                String existing = ApkPatcher.sha256(target);
                if (sha256.equalsIgnoreCase(existing)) {
                    call.resolve(fileResult(name, target, existing));
                    return;
                }
            }
            cancelFlag.set(false);
            ResumableDownloader.Result result = ResumableDownloader.download(
                    url,
                    target,
                    sha256,
                    size == null ? -1 : size,
                    (received, total) -> {
                        JSObject progress = new JSObject();
                        progress.put("name", name);
                        progress.put("received", received);
                        progress.put("total", total);
                        progress.put("phase", "download");
                        notifyListeners("progress", progress);
                    },
                    cancelFlag
            );
            call.resolve(fileResult(name, target, result.sha256));
        });
    }

    // ── WebView 代下（原生 TLS 被网络打断时的兜底通道）─────────
    /**
     * 为什么需要这一组方法：
     *   真机上出现过「原生 HttpURLConnection 建连即被 reset，而 WebView 走同一地址完全正常」
     *   （服务端访问日志里连一条 /update 请求都没有 → 请求死在 TLS 握手）。
     *   这种环境下唯一可靠的网络栈就是已经跑通的 WebView，所以：
     *   **JS 用 fetch 取字节 → 分块交给原生落盘 → 原生校验、打补丁、安装。**
     *
     * 断点续传照样保留：JS 先问 partSize，再从该偏移发 Range 请求。
     */

    /** 分配一个新下载（清掉同名的旧残片） */
    @PluginMethod
    public void beginDownload(PluginCall call) {
        String name = call.getString("name");
        if (name == null || !SAFE_NAME.matcher(name).matches()) {
            call.reject("参数不合法", "bad_args");
            return;
        }
        runAsync(call, ignored -> {
            File part = new File(updatesDir(), name + ".part");
            //noinspection ResultOfMethodCallIgnored
            part.delete();
            JSObject result = new JSObject();
            result.put("name", name);
            result.put("bytes", 0);
            call.resolve(result);
        });
    }

    /** 已有残片长度（JS 拿它决定 Range 起点） */
    @PluginMethod
    public void partSize(PluginCall call) {
        String name = call.getString("name");
        if (name == null || !SAFE_NAME.matcher(name).matches()) {
            call.reject("参数不合法", "bad_args");
            return;
        }
        runAsync(call, ignored -> {
            File part = new File(updatesDir(), name + ".part");
            JSObject result = new JSObject();
            result.put("name", name);
            result.put("bytes", ChunkAssembler.partSize(part));
            call.resolve(result);
        });
    }

    /**
     * 追加一块（base64）。
     * params: { name, data } → 返回累计字节数
     */
    @PluginMethod
    public void appendChunk(PluginCall call) {
        String name = call.getString("name");
        String data = call.getString("data");
        if (name == null || !SAFE_NAME.matcher(name).matches() || data == null) {
            call.reject("参数不合法", "bad_args");
            return;
        }
        runAsync(call, ignored -> {
            // android.util.Base64：minSdk 24 上不能用 java.util.Base64（那是 API 26）
            byte[] bytes = android.util.Base64.decode(data, android.util.Base64.DEFAULT);
            File part = new File(updatesDir(), name + ".part");
            long size = ChunkAssembler.append(part, bytes);
            JSObject result = new JSObject();
            result.put("name", name);
            result.put("bytes", size);
            call.resolve(result);
        });
    }

    /**
     * 收尾：校验大小 + sha256，通过才重命名成正式文件。
     * params: { name, sha256?, size? }
     */
    @PluginMethod
    public void finishDownload(PluginCall call) {
        String name = call.getString("name");
        String expectedSha256 = call.getString("sha256");
        Long expectedSize = call.getLong("size");
        if (name == null || !SAFE_NAME.matcher(name).matches()) {
            call.reject("参数不合法", "bad_args");
            return;
        }
        runAsync(call, ignored -> {
            File part = new File(updatesDir(), name + ".part");
            File target = new File(updatesDir(), name);
            ChunkAssembler.Result result = ChunkAssembler.finish(
                    part,
                    target,
                    expectedSha256,
                    expectedSize == null ? -1 : expectedSize
            );
            call.resolve(fileResult(name, target, result.sha256));
        });
    }

    /** 放弃本次下载（清残片） */
    @PluginMethod
    public void abortDownload(PluginCall call) {
        String name = call.getString("name");
        if (name != null && SAFE_NAME.matcher(name).matches()) {
            //noinspection ResultOfMethodCallIgnored
            new File(updatesDir(), name + ".part").delete();
        }
        call.resolve();
    }

    /**
     * 打补丁：用**本机已安装的 APK** 当字典，还原出目标 APK。
     * params: { patchName, targetName, sha256?, size? }
     */    @PluginMethod
    public void applyPatch(PluginCall call) {
        String patchName = call.getString("patchName");
        String targetName = call.getString("targetName");
        String expectedSha256 = call.getString("sha256");
        Long expectedSize = call.getLong("size");
        if (patchName == null || targetName == null
                || !SAFE_NAME.matcher(patchName).matches()
                || !SAFE_NAME.matcher(targetName).matches()) {
            call.reject("参数不合法", "bad_args");
            return;
        }
        runAsync(call, ignored -> {
            File oldApk = new File(getContext().getApplicationInfo().sourceDir);
            File patch = new File(updatesDir(), patchName);
            File target = new File(updatesDir(), targetName);
            if (!patch.exists()) {
                call.reject("补丁文件不存在: " + patchName, "patch_missing");
                return;
            }
            JSObject started = new JSObject();
            started.put("name", targetName);
            started.put("phase", "patch");
            notifyListeners("progress", started);

            String actual = ApkPatcher.patch(
                    oldApk,
                    patch,
                    target,
                    expectedSize == null ? -1 : expectedSize
            );
            if (expectedSha256 != null && !expectedSha256.isEmpty()
                    && !expectedSha256.equalsIgnoreCase(actual)) {
                // 打出来的东西不对：删掉，别让 JS 拿它去安装
                //noinspection ResultOfMethodCallIgnored
                target.delete();
                call.reject("补丁产物校验失败（sha256 不符）", "patch_mismatch");
                return;
            }
            call.resolve(fileResult(targetName, target, actual));
        });
    }

    /**
     * 唤起系统安装器。
     * params: { name }
     * 返回 { launched, needsPermission }：needsPermission=true 时 JS 应引导用户去授权。
     */
    @PluginMethod
    public void install(PluginCall call) {
        String name = call.getString("name");
        if (name == null || !SAFE_NAME.matcher(name).matches()) {
            call.reject("参数不合法", "bad_args");
            return;
        }
        File apk = new File(updatesDir(), name);
        if (!apk.exists()) {
            call.reject("安装包不存在: " + name, "apk_missing");
            return;
        }
        if (!UpdateInstaller.signatureMatches(getContext(), apk)) {
            call.reject("安装包签名与当前应用不一致", "signature_mismatch");
            return;
        }
        if (!UpdateInstaller.canInstall(getContext())) {
            JSObject result = new JSObject();
            result.put("launched", false);
            result.put("needsPermission", true);
            call.resolve(result);
            return;
        }
        final Intent intent = UpdateInstaller.installIntent(getContext(), apk);
        getActivity().runOnUiThread(() -> {
            try {
                getActivity().startActivity(intent);
                JSObject result = new JSObject();
                result.put("launched", true);
                result.put("needsPermission", false);
                call.resolve(result);
            } catch (Exception error) {
                call.reject("无法唤起安装器: " + error.getMessage(), "install_failed");
            }
        });
    }

    /** 打开"允许安装未知应用"设置页 */
    @PluginMethod
    public void openInstallPermission(PluginCall call) {
        final Intent intent = UpdateInstaller.permissionIntent(getContext());
        getActivity().runOnUiThread(() -> {
            try {
                getActivity().startActivity(intent);
                call.resolve();
            } catch (Exception error) {
                call.reject("无法打开设置页: " + error.getMessage(), "settings_failed");
            }
        });
    }

    /** 取消进行中的下载 */
    @PluginMethod
    public void cancel(PluginCall call) {
        cancelFlag.set(true);
        call.resolve();
    }

    /** 清理下载缓存（安装完或放弃更新时调用） */
    @PluginMethod
    public void clearCache(PluginCall call) {
        runAsync(call, ignored -> {
            File dir = updatesDir();
            File[] files = dir.listFiles();
            int removed = 0;
            if (files != null) {
                for (File file : files) {
                    if (file.delete()) {
                        removed += 1;
                    }
                }
            }
            JSObject result = new JSObject();
            result.put("removed", removed);
            call.resolve(result);
        });
    }

    // ── 小工具 ────────────────────────────────────────────────

    private JSObject fileResult(String name, File file, String sha256) {
        JSObject result = new JSObject();
        result.put("name", name);
        result.put("path", file.getAbsolutePath());
        result.put("size", file.length());
        result.put("sha256", sha256);
        return result;
    }

    private static long versionCodeOf(PackageInfo info) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            return info.getLongVersionCode();
        }
        //noinspection deprecation
        return info.versionCode;
    }

    private static String trimSlash(String value) {
        String trimmed = value.trim();
        while (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        return trimmed;
    }

    private static String httpGet(String url) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(20_000);
        connection.setRequestProperty("Accept", "application/json");
        try {
            int code = connection.getResponseCode();
            if (code != 200) {
                throw new IllegalStateException("清单请求失败: HTTP " + code);
            }
            try (InputStream in = connection.getInputStream();
                 Reader reader = new InputStreamReader(in, "UTF-8")) {
                StringBuilder builder = new StringBuilder();
                char[] buffer = new char[4096];
                int read;
                while ((read = reader.read(buffer)) > 0) {
                    builder.append(buffer, 0, read);
                }
                return builder.toString();
            }
        } finally {
            connection.disconnect();
        }
    }
}
