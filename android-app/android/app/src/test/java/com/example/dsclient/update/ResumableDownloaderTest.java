package com.example.dsclient.update;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

import java.io.File;
import java.nio.file.Files;
import java.util.Random;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 续传下载的行为测试。
 *
 * 这三条是"移动网络下能不能活"的关键：
 *  1. 有 .part 就必须只请求剩余部分（否则续传等于没做，白费流量）
 *  2. 服务端不支持 Range（回 200）必须整体重下，不能拼接出坏文件
 *  3. 哈希不符必须删掉残片并报错（否则用户会去装一个坏包）
 */
public class ResumableDownloaderTest {

    private static byte[] randomBytes(int size, long seed) {
        byte[] data = new byte[size];
        new Random(seed).nextBytes(data);
        return data;
    }

    @Test
    public void resumesFromPartialFile() throws Exception {
        byte[] body = randomBytes(300 * 1024, 42);
        String sha = ApkPatcher.sha256(body);
        File dir = Files.createTempDirectory("resume").toFile();
        File dest = new File(dir, "app.apk");
        // 模拟"下了一半断掉"：留下前 100KB 的 .part
        File part = new File(dest.getPath() + ".part");
        Files.write(part.toPath(), java.util.Arrays.copyOf(body, 100 * 1024));

        try (RangeTestServer server = new RangeTestServer(body, true)) {
            ResumableDownloader.Result result = ResumableDownloader.download(
                    server.url(), dest, sha, body.length, null, new AtomicBoolean(false)
            );
            assertEquals("落盘大小应与源一致", body.length, result.size);
            assertEquals("sha256 应一致", sha, result.sha256);
            assertEquals("应只发一次请求", 1, server.requests.get());
            assertEquals("应带上 Range 头", 1, server.rangedRequests.get());
            assertEquals("只应传输剩余字节（续传生效）", body.length - 100 * 1024, server.servedBytes.get());
            assertTrue(".part 应被清理", !part.exists());
            assertTrue("目标文件应存在", dest.exists());
        }
        dir.delete();
    }

    @Test
    public void restartsWhenServerIgnoresRange() throws Exception {
        byte[] body = randomBytes(120 * 1024, 7);
        String sha = ApkPatcher.sha256(body);
        File dir = Files.createTempDirectory("restart").toFile();
        File dest = new File(dir, "app.apk");
        File part = new File(dest.getPath() + ".part");
        Files.write(part.toPath(), new byte[]{1, 2, 3, 4});

        try (RangeTestServer server = new RangeTestServer(body, false)) {
            ResumableDownloader.Result result = ResumableDownloader.download(
                    server.url(), dest, sha, body.length, null, new AtomicBoolean(false)
            );
            assertEquals("服务端不支持 Range 时必须整体重下", sha, result.sha256);
            assertEquals("传输的应是完整文件", body.length, server.servedBytes.get());
        }
        dir.delete();
    }

    @Test
    public void rejectsCorruptedDownload() throws Exception {
        byte[] body = randomBytes(64 * 1024, 11);
        File dir = Files.createTempDirectory("corrupt").toFile();
        File dest = new File(dir, "app.apk");
        try (RangeTestServer server = new RangeTestServer(body, true)) {
            try {
                // 故意给一个错误的期望哈希
                ResumableDownloader.download(
                        server.url(), dest, "deadbeef", body.length, null, new AtomicBoolean(false)
                );
                fail("哈希不符时必须抛错");
            } catch (Exception expected) {
                assertTrue("错误信息应说明是校验失败", String.valueOf(expected.getMessage()).contains("校验"));
            }
            assertTrue("坏文件不能留在目标位置", !dest.exists());
            assertTrue("残片也要清掉，避免下次接着写", !new File(dest.getPath() + ".part").exists());
        }
        dir.delete();
    }

    @Test
    public void cancelsMidway() throws Exception {
        byte[] body = randomBytes(4 * 1024 * 1024, 3);
        File dir = Files.createTempDirectory("cancel").toFile();
        File dest = new File(dir, "app.apk");
        AtomicBoolean cancel = new AtomicBoolean(false);
        try (RangeTestServer server = new RangeTestServer(body, true)) {
            try {
                ResumableDownloader.download(
                        server.url(),
                        dest,
                        null,
                        body.length,
                        (received, total) -> cancel.set(true),
                        cancel
                );
                fail("取消后应抛出 CancelledException");
            } catch (ResumableDownloader.CancelledException expected) {
                assertTrue("取消不算失败，目标文件不应产生", !dest.exists());
            }
        }
        dir.delete();
    }
}
