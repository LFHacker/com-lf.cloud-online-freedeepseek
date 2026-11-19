package com.example.dsclient.update;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Assume;
import org.junit.Test;

import java.io.File;
import java.nio.file.Files;

/**
 * 用**真实补丁数据**验证打补丁：服务端生成的 patch-1.0.0-to-1.0.1.zst
 * 打在真 APK 上，必须逐字节还原出 1.0.1。
 *
 * 数据从哪来：`delivery/updates-test/`（不进仓库）。没有就跳过（Assume），
 * 这样别人 clone 下来不会因为缺 4MB 的 APK 而红一片。
 *
 * 想补齐：
 *   scp root@<网关>:/opt/ds-gateway/updates/{freedeepseek-v1.0.0.apk,freedeepseek-v1.0.1.apk,patch-1.0.0-to-1.0.1.zst} delivery/updates-test/
 * 然后改名成 v1.0.0.apk / v1.0.1.apk / patch-1.0.0-to-1.0.1.zst。
 */
public class ApkPatcherTest {

    private static File testDir() {
        String fromEnv = System.getenv("DSH_UPDATE_TEST_DIR");
        if (fromEnv != null && !fromEnv.isEmpty()) {
            return new File(fromEnv);
        }
        // Android 单测的工作目录是模块目录（android-app/android/app），仓库根在三级之上；
        // 少数环境可能是四级，两个都试一下。
        File[] candidates = {
                new File("../../../delivery/updates-test"),
                new File("../../../../delivery/updates-test"),
                new File("delivery/updates-test"),
        };
        for (File candidate : candidates) {
            if (candidate.isDirectory()) {
                return candidate;
            }
        }
        return candidates[0];
    }

    @Test
    public void patchReproducesTargetByteForByte() throws Exception {
        File dir = testDir();
        File oldApk = new File(dir, "v1.0.0.apk");
        File newApk = new File(dir, "v1.0.1.apk");
        File patch = new File(dir, "patch-1.0.0-to-1.0.1.zst");
        Assume.assumeTrue("缺少真实补丁数据，跳过（见类注释）", oldApk.isFile() && newApk.isFile() && patch.isFile());

        File out = new File(Files.createTempDirectory("patched").toFile(), "out.apk");
        long expectedSize = newApk.length();
        String expectedSha = ApkPatcher.sha256(newApk);

        String actualSha = ApkPatcher.patch(oldApk, patch, out, expectedSize);

        assertEquals("补丁产物的 sha256 必须与目标 APK 一致", expectedSha, actualSha);
        assertEquals("大小也必须一致", expectedSize, out.length());
        assertTrue(
                "逐字节一致（不只哈希）",
                java.util.Arrays.equals(ApkPatcher.readAll(out), ApkPatcher.readAll(newApk))
        );
        assertTrue("补丁应远小于全量（这正是做增量的意义）", patch.length() * 10 < newApk.length());
    }

    @Test
    public void rejectsPatchAppliedToWrongBase() throws Exception {
        File dir = testDir();
        File newApk = new File(dir, "v1.0.1.apk");
        File patch = new File(dir, "patch-1.0.0-to-1.0.1.zst");
        Assume.assumeTrue("缺少真实补丁数据，跳过", newApk.isFile() && patch.isFile());

        // 用"目标版本"当字典去打"从旧版本生成"的补丁：属于用户装错版本的情况
        File out = new File(Files.createTempDirectory("wrongbase").toFile(), "out.apk");
        String expectedSha = ApkPatcher.sha256(newApk);
        try {
            String actual = ApkPatcher.patch(newApk, patch, out, newApk.length());
            // 有的情况 zstd 不报错但产物是错的 —— 必须被 sha 挡下
            assertNotEquals("补丁打错底包时，产物哈希绝不能等于目标", expectedSha, actual);
        } catch (Exception expected) {
            assertTrue("抛错属于预期（补丁与底包不匹配）", true);
        }
        assertTrue("打错底包的产物不应留下", !out.exists());
    }

    @Test
    public void emptyDictionaryIsRejected() {
        try {
            ApkPatcher.apply(new byte[0], new byte[]{1, 2, 3}, 3);
            assertTrue("空字典必须被拒绝", false);
        } catch (Exception expected) {
            assertTrue(String.valueOf(expected.getMessage()).contains("字典")
                    || expected.getMessage() != null);
        }
    }
}
