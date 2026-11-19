package com.example.dsclient.update;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 测试用的极简 HTTP 服务（自己写，不用 com.sun.net.httpserver）。
 *
 * 为什么不用 JDK 自带的 HttpServer：Android 单测编译时用的是 **android.jar**，
 * 里面没有 `com.sun.net.httpserver` 这个 JDK 专有包 —— 会直接编译不过。
 *
 * 能力刚好够测续传：能按 Range 回 206，也能故意忽略 Range 只回 200。
 */
final class RangeTestServer implements AutoCloseable {
    private final ServerSocket serverSocket;
    private final Thread thread;
    private volatile boolean closed = false;

    final byte[] body;
    /** false 时忽略 Range，一律回 200（模拟不支持续传的服务端） */
    final boolean supportsRange;
    final AtomicLong servedBytes = new AtomicLong();
    final AtomicInteger requests = new AtomicInteger();
    final AtomicLong rangedRequests = new AtomicLong();

    RangeTestServer(byte[] body, boolean supportsRange) throws IOException {
        this.body = body;
        this.supportsRange = supportsRange;
        this.serverSocket = new ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"));
        this.thread = new Thread(this::serveLoop, "range-test-server");
        this.thread.setDaemon(true);
        this.thread.start();
    }

    String url() {
        return "http://127.0.0.1:" + serverSocket.getLocalPort() + "/file";
    }

    private void serveLoop() {
        while (!closed) {
            try (Socket socket = serverSocket.accept()) {
                handle(socket);
            } catch (IOException error) {
                if (!closed) {
                    // 测试服务器：忽略单次连接错误
                }
            }
        }
    }

    private void handle(Socket socket) throws IOException {
        requests.incrementAndGet();
        InputStream in = socket.getInputStream();
        String requestLine = readLine(in);
        int start = 0;
        String rangeLine = null;
        String line;
        while ((line = readLine(in)) != null && !line.isEmpty()) {
            String lower = line.toLowerCase(Locale.ROOT);
            if (lower.startsWith("range:")) {
                // ⚠️ 取冒号后的值：整行是 "Range: bytes=100-"，直接看前缀永远匹配不上
                rangeLine = line.substring(line.indexOf(':') + 1).trim();
            }
        }
        if (supportsRange && rangeLine != null && rangeLine.startsWith("bytes=")) {
            rangedRequests.incrementAndGet();
            String spec = rangeLine.substring("bytes=".length()).split(";")[0].trim();
            String startText = spec.split("-")[0];
            start = startText.isEmpty() ? 0 : Integer.parseInt(startText);
        }

        OutputStream out = socket.getOutputStream();
        if (start >= body.length) {
            writeHead(out, "416 Requested Range Not Satisfiable", 0, null, true);
            out.flush();
            return;
        }
        int length = body.length - start;
        boolean partial = start > 0;
        writeHead(
                out,
                partial ? "206 Partial Content" : "200 OK",
                length,
                partial ? "bytes " + start + "-" + (body.length - 1) + "/" + body.length : null,
                false
        );
        out.write(body, start, length);
        out.flush();
        servedBytes.addAndGet(length);
    }

    private static void writeHead(OutputStream out, String status, int length, String contentRange, boolean empty)
            throws IOException {
        StringBuilder builder = new StringBuilder();
        builder.append("HTTP/1.1 ").append(status).append("\r\n");
        builder.append("Content-Type: application/octet-stream\r\n");
        builder.append("Content-Length: ").append(empty ? 0 : length).append("\r\n");
        builder.append("Accept-Ranges: bytes\r\n");
        if (contentRange != null) {
            builder.append("Content-Range: ").append(contentRange).append("\r\n");
        }
        builder.append("Connection: close\r\n\r\n");
        out.write(builder.toString().getBytes("UTF-8"));
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        int read;
        while ((read = in.read()) != -1) {
            if (read == '\n') {
                break;
            }
            if (read != '\r') {
                buffer.write(read);
            }
        }
        if (read == -1 && buffer.size() == 0) {
            return null;
        }
        return new String(buffer.toByteArray(), "UTF-8");
    }

    @Override
    public void close() {
        closed = true;
        try {
            serverSocket.close();
        } catch (IOException ignored) {
            // 关不掉也无所谓
        }
    }
}
