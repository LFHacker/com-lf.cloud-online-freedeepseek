package com.example.dsclient.update;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

import java.io.File;
import java.nio.file.Files;
import java.util.Base64;
import java.util.Random;

/**
 * 分块落盘的行为测试。
 *
 * 这条链路是给"原生 TLS 被网络打断"准备的兜底通道：JS 用 WebView 取字节，
 * 一块块交给原生拼。最容易出的错是**半截文件被当成下好了**，
 * 所以这里重点测"不完整/哈希不符必须失败并删除残片"。
 */
public class ChunkAssemblerTest {

    private static byte[] randomBytes(int size, long seed) {
        byte[] data = new byte[size];
        new Random(seed).nextBytes(data);
        return data;
    }

    @Test
    public void assemblesChunksAndVerifies() throws Exception {
        byte[] body = randomBytes(700 * 1024, 5);
        String sha = ApkPatcher.sha256(body);
        File dir = Files.createTempDirectory("chunks").toFile();
        File part = new File(dir, "app.apk.part");
        File target = new File(dir, "app.apk");

        // 按 512KB 一块喂进去（和 JS 侧 CHUNK_BYTES 一致）
        int chunk = 512 * 1024;
        for (int offset = 0; offset < body.length; offset += chunk) {
            int end = Math.min(offset + chunk, body.length);
            byte[] slice = java.util.Arrays.copyOfRange(body, offset, end);
            // 顺便验证 base64 往返（JS 那边就是发 base64）
            byte[] decoded = Base64.getDecoder().decode(Base64.getEncoder().encodeToString(slice));
            ChunkAssembler.append(part, decoded);
        }

        ChunkAssembler.Result result = ChunkAssembler.finish(part, target, sha, body.length);
        assertEquals("大小应一致", body.length, result.size);
        assertEquals("sha256 应一致", sha, result.sha256);
        assertArrayEquals("内容应逐字节一致", body, ApkPatcher.readAll(target));
        assertFalse("临时文件应被移走", part.exists());
    }

    @Test
    public void resumesFromExistingPart() throws Exception {
        byte[] body = randomBytes(400 * 1024, 9);
        String sha = ApkPatcher.sha256(body);
        File dir = Files.createTempDirectory("resume-chunks").toFile();
        File part = new File(dir, "app.apk.part");
        File target = new File(dir, "app.apk");

        int half = 200 * 1024;
        ChunkAssembler.append(part, java.util.Arrays.copyOf(body, half));
        assertEquals("残片长度应被读到", half, ChunkAssembler.partSize(part));
        ChunkAssembler.append(part, java.util.Arrays.copyOfRange(body, half, body.length));

        ChunkAssembler.Result result = ChunkAssembler.finish(part, target, sha, body.length);
        assertEquals(sha, result.sha256);
    }

    @Test
    public void rejectsIncompleteFile() throws Exception {
        byte[] body = randomBytes(200 * 1024, 13);
        File dir = Files.createTempDirectory("incomplete").toFile();
        File part = new File(dir, "app.apk.part");
        File target = new File(dir, "app.apk");
        ChunkAssembler.append(part, java.util.Arrays.copyOf(body, 100 * 1024));

        try {
            ChunkAssembler.finish(part, target, ApkPatcher.sha256(body), body.length);
            fail("少了一半必须失败");
        } catch (Exception expected) {
            assertTrue(String.valueOf(expected.getMessage()).contains("不完整"));
        }
        assertFalse("残片必须删掉（否则下次会拼出坏包）", part.exists());
        assertFalse("不能产出正式文件", target.exists());
    }

    @Test
    public void rejectsHashMismatch() throws Exception {
        byte[] body = randomBytes(64 * 1024, 17);
        File dir = Files.createTempDirectory("mismatch").toFile();
        File part = new File(dir, "app.apk.part");
        File target = new File(dir, "app.apk");
        ChunkAssembler.append(part, body);

        try {
            ChunkAssembler.finish(part, target, "deadbeef", body.length);
            fail("哈希不符必须失败");
        } catch (Exception expected) {
            assertTrue(String.valueOf(expected.getMessage()).contains("校验"));
        }
        assertFalse(part.exists());
        assertFalse(target.exists());
    }

    @Test
    public void failsWhenNothingDownloaded() throws Exception {
        File dir = Files.createTempDirectory("empty").toFile();
        try {
            ChunkAssembler.finish(new File(dir, "x.part"), new File(dir, "x"), null, -1);
            fail("没有任何数据时必须失败");
        } catch (Exception expected) {
            assertTrue(String.valueOf(expected.getMessage()).contains("没有下到"));
        }
    }
}
