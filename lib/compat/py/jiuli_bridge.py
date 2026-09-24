"""
JiuLi 生态兼容桥：Python 侧传输层（生态无关）

职责：stdin/stdout 上的换行分隔 JSON 协议 + 事件分发 + 出站消息回传。
生态适配（gsuid_core / astrbot 的 API 仿制）在各自的 boot 脚本里，本文件不掺业务。

协议（Node ↔ Python 都是单行 JSON，UTF-8）：

  Node → Python
    {"t":"event","id":1,"event":{...通用事件...}}   派发一条消息
    {"t":"shutdown"}                                退出

  Python → Node
    {"t":"ready","plugins":["a","b"]}               插件加载完成
    {"t":"log","level":"info","msg":"..."}          日志
    {"t":"send","id":2,"elements":[...]}            回复当前事件
    {"t":"send","id":2,"eventId":1,"elements":[...]} 同上（显式带事件 id）
    {"t":"send","id":3,"target":{...},"elements":[...]}  主动发送（无事件上下文）
    {"t":"result","id":1,"handled":true}            事件处理完毕

线程/事件循环模型：
  stdin 由一个后台线程阻塞读；每条事件用 `asyncio.run_coroutine_threadsafe` 丢回主循环执行，
  并 `.result()` 等它跑完 —— 这样「插件处理完了」的顺序与 result 消息的顺序严格一致。
  插件的 async def 处理器于是可以正常 await。

为什么用 stdio 而不是 HTTP/WS：零端口、零鉴权、随 JiuLi 生命周期自动回收，
子进程死了 Node 侧能立刻从 'exit' 感知。代价是不能跨机器，本方案也只需要同机。
"""

import asyncio
import inspect
import json
import sys
import threading
import traceback

# 保证 stdout 只走协议；插件的 print 会被重定向到 stderr，避免污染 JSON 流
_REAL_STDOUT = sys.stdout


def _safe_write(obj):
    _REAL_STDOUT.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _REAL_STDOUT.flush()


class Bridge:
    def __init__(self, loop=None):
        self._seq = 0
        self._lock = threading.Lock()
        self._handlers = []
        self._events = {}
        self._closed = threading.Event()
        self._loop = loop
        self._reader = None
        self.plugins = []
        self.extra = {}
        # 出站计数：宿主据此判断「这条消息插件到底回没回」，决定要不要拦截 JiuLi 自身的规则
        self.sent = 0

    # 发送

    def _next_id(self):
        with self._lock:
            self._seq += 1
            return self._seq

    def emit(self, obj):
        try:
            _safe_write(obj)
        except Exception:
            pass

    def log(self, level, msg):
        self.emit({"t": "log", "level": level, "msg": str(msg)})

    def ready(self, plugins=None):
        self.emit({"t": "ready", "plugins": list(plugins if plugins is not None else self.plugins)})

    def send(self, elements, event_id=None, target=None):
        """往 JiuLi 发消息；event_id 给定则是回复该事件，否则按 target 主动发送"""
        payload = {"t": "send", "id": self._next_id(), "elements": list(elements or [])}
        if payload["elements"]:
            self.sent += 1
        if event_id is not None:
            payload["eventId"] = event_id
        if target:
            payload["target"] = target
        self.emit(payload)

    # 接收

    def on_event(self, fn):
        """注册事件处理器：fn(event_dict, bridge) -> 是否已处理；可以是 async def"""
        self._handlers.append(fn)
        return fn

    def current(self, event_id):
        return self._events.get(event_id)

    # 生命周期

    def run(self):
        """后台线程：阻塞读 stdin，直到 EOF / shutdown"""
        try:
            for line in sys.stdin:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except Exception as err:
                    self.log("error", f"协议解析失败：{err}｜原始内容：{line[:200]}")
                    continue
                t = msg.get("t")
                if t == "shutdown":
                    break
                if t == "event":
                    self._dispatch(msg)
        except Exception:
            self.log("error", "读循环异常退出：\n" + traceback.format_exc())
        finally:
            self._closed.set()

    def start_reader(self):
        self._reader = threading.Thread(target=self.run, name="jiuli-bridge-reader", daemon=True)
        self._reader.start()
        return self._reader

    async def serve(self):
        """主协程：起读线程并等它结束（Ctrl+C / shutdown 时返回）"""
        if self._loop is None:
            self._loop = asyncio.get_running_loop()
        self.start_reader()
        while not self._closed.is_set():
            await asyncio.sleep(0.2)
        return 0

    # 分发

    def _dispatch(self, msg):
        """
        读线程里调用。**不能阻塞读线程**：多步会话（receive_resp / session_waiter）会挂起处理器，
        读线程一并卡住的话，用户的下一条消息永远读不进来 —— 会话必然超时。
        所以这里把事件丢给主循环后立刻返回，result 用完成回调发。
        """
        event_id = msg.get("id")
        event = msg.get("event") or {}
        event["_id"] = event_id
        self._events[event_id] = event

        if self._loop is not None and self._loop.is_running():
            future = asyncio.run_coroutine_threadsafe(self._dispatch_async(event), self._loop)
            future.add_done_callback(lambda fut: self._finish(event_id, fut))
            return

        try:
            handled = _run_sync(self._dispatch_async(event))
            error = None
        except Exception:
            handled, error = False, traceback.format_exc()
        self._finish_sync(event_id, handled, error)

    def _finish(self, event_id, future):
        try:
            handled = future.result()
            error = None
        except Exception:
            handled, error = False, traceback.format_exc()
        self._finish_sync(event_id, handled, error)

    def _finish_sync(self, event_id, handled, error):
        self._events.pop(event_id, None)
        if error:
            self.log("error", "插件处理消息出错：\n" + error)
        self.emit({"t": "result", "id": event_id, "handled": bool(handled)})

    async def _dispatch_async(self, event):
        for fn in self._handlers:
            try:
                ret = fn(event, self)
                if inspect.isawaitable(ret):
                    ret = await ret
            except Exception:
                self.log("error", "插件处理消息出错：\n" + traceback.format_exc())
                continue
            if ret:
                return True
        return False


def _run_sync(coro):
    """没有事件循环时的兜底（同步自测用）"""
    try:
        loop = asyncio.new_event_loop()
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def install_stdout_guard():
    """把插件的 print 重定向到 stderr，防止破坏 stdout 上的 JSON 协议"""

    class _StderrProxy:
        def write(self, data):
            sys.stderr.write(data)
            return len(data)

        def flush(self):
            sys.stderr.flush()

        def isatty(self):
            return False

    sys.stdout = _StderrProxy()


async def spawn(load_plugins, name, loop=None):
    """
    通用启动流程：装 stdout 保护 → 加载插件 → 通知 ready → 进读循环。
    load_plugins(bridge) 返回插件名列表。
    """
    install_stdout_guard()
    loop = loop or asyncio.get_running_loop()
    bridge = Bridge(loop=loop)
    try:
        plugins = load_plugins(bridge)
        # 加载器可以是同步或异步的（生态不同）
        if inspect.isawaitable(plugins):
            plugins = await plugins
        plugins = plugins or []
    except Exception:
        bridge.log("error", f"{name} 插件加载失败：\n" + traceback.format_exc())
        plugins = []
    bridge.plugins = plugins
    bridge.ready()
    bridge.log("mark", f"{name} 兼容层就绪 · 插件 {len(plugins)} 个")
    try:
        return await bridge.serve()
    except KeyboardInterrupt:
        return 0
