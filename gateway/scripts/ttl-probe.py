#!/usr/bin/env python3
"""
测量 DeepSeek 前缀缓存的实际存活时间（TTL）。

为什么这样设计：
  每次发请求都会把该前缀的缓存"续命"，所以不能拿同一个前缀反复测——
  那样测出来永远是"还活着"。
  做法：用 8 个**各不相同**的长前缀，t=0 全部种下，
  然后在预设时间点分别只碰对应那一个。每个前缀全程只被访问两次（种下 + 检查），
  互不影响，得到的就是纯粹的时间衰减。

结果写入 ttl-probe.log，每行一条 JSON，便于随时查看进度。
"""
import json
import os
import time
import urllib.request

BASE = "http://127.0.0.1:8787/anthropic/v1/messages"
LOG = "/opt/ds-gateway/ttl-probe.log"
SYSTEM = "该助手为DeepSeek，由深度求索公司创造。"
# 每条约 1500~2000 token，确保远超缓存最小长度
PAD = "这是一段用于测量缓存存活时间的固定填充文本，内容本身没有意义。" * 45

# (等待分钟数, 探针标记)
SCHEDULE = [(2, "a"), (5, "b"), (10, "c"), (15, "d"), (25, "e"), (40, "f"), (60, "g"), (90, "h")]


def token():
    for line in open("/etc/ds-gateway.env"):
        if line.startswith("GATEWAY_TOKEN="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("找不到 GATEWAY_TOKEN")


TOKEN = token()


def log(payload):
    line = json.dumps(payload, ensure_ascii=False)
    print(line, flush=True)
    with open(LOG, "a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def request_body(mark):
    """同一个 mark 生成的请求体必须逐字节一致，否则比对的就不是同一个前缀"""
    return json.dumps(
        {
            "model": "deepseek-flash",
            "stream": False,
            "max_tokens": 8,
            "thinking": {"type": "disabled"},
            "system": SYSTEM,
            "messages": [{"role": "user", "content": "缓存探针 %s：%s" % (mark, PAD)}],
        },
        ensure_ascii=False,
    ).encode("utf-8")


def call(mark):
    req = urllib.request.Request(
        BASE,
        data=request_body(mark),
        headers={
            "x-api-key": TOKEN,
            "Content-Type": "application/json",
            # local 模式：不触发记忆注入，保证请求体完全由本脚本决定
            "x-ds-session-id": "ttl-probe-%s" % mark,
            "x-ds-memory-scope": "local",
        },
    )
    data = json.loads(urllib.request.urlopen(req, timeout=180).read().decode())
    usage = data.get("usage", {})
    return usage.get("input_tokens", 0), usage.get("cache_read_input_tokens", 0)


def main():
    open(LOG, "w").close()
    log({"event": "start", "at": time.strftime("%Y-%m-%dT%H:%M:%S")})

    started = time.time()
    seeded = {}
    for minutes, mark in SCHEDULE:
        try:
            tokens_in, cache_read = call(mark)
            seeded[mark] = tokens_in
            log({"event": "seed", "mark": mark, "input": tokens_in, "cache_read": cache_read})
        except Exception as error:  # noqa: BLE001
            log({"event": "seed_error", "mark": mark, "error": str(error)})
        time.sleep(1.5)

    verdicts = []
    for minutes, mark in SCHEDULE:
        target = started + minutes * 60
        while time.time() < target:
            time.sleep(10)
        try:
            tokens_in, cache_read = call(mark)
            alive = cache_read > 0
            verdicts.append({"minutes": minutes, "alive": alive, "cache_read": cache_read})
            log(
                {
                    "event": "probe",
                    "mark": mark,
                    "minutes": minutes,
                    "input": tokens_in,
                    "cache_read": cache_read,
                    "alive": alive,
                }
            )
        except Exception as error:  # noqa: BLE001
            log({"event": "probe_error", "mark": mark, "minutes": minutes, "error": str(error)})

    alive_points = [v["minutes"] for v in verdicts if v["alive"]]
    dead_points = [v["minutes"] for v in verdicts if not v["alive"]]
    log(
        {
            "event": "summary",
            "alive_at_minutes": alive_points,
            "dead_at_minutes": dead_points,
            "max_alive": max(alive_points) if alive_points else None,
            "min_dead": min(dead_points) if dead_points else None,
        }
    )


if __name__ == "__main__":
    main()
