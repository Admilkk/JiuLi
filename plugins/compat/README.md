# 生态兼容（plugins/compat）

让 JiuLi 除了云崽插件，还能加载 **Koishi / GsCore（早苗）/ AstrBot** 的插件。
完整说明（可行性、覆盖范围、缺口）见 [`docs/compat-ecosystems.md`](../../docs/compat-ecosystems.md)。

## 目录

```
plugins/compat/
  index.js       接入 JiuLi 分发的一个云崽插件（beforeMessage 钩子，priority -1e9）
  package.json   Koishi 桥接依赖与外来 npm 插件的安装位置
  hosts/         可放 <生态>.js 覆盖内置宿主
  pkgs/
    koishi/      Koishi 插件（手动放的目录；也可 cd plugins/compat && pnpm add koishi-plugin-x）
    gscore/      GsCore 插件（<插件名>/__init__.py 或 <插件名>.py）
    astrbot/     AstrBot 插件（含 main.py 的目录，可带 metadata.yaml / _conf_schema.json）
```

> 这个目录有自己的 `package.json`，所以里面的文件**不能** `import 'jiuli'`（模块解析会被它截断）。
> 需要框架能力就用全局变量（`Bot` / `logger` / `segment`）或相对路径 `../../lib/...`。

## 开关

`config/config/compat.yaml`：

```yaml
enabled: true
timeout_ms: 15000     # 单个外来插件处理一条消息的上限，超时交回 JiuLi
intercept: true       # 外来插件回了消息就不再走云崽插件
ecosystems:
  koishi:
    enabled: true
    plugins: []       # 额外加载的包名；不写则扫描 pkgs/koishi/
    database: ''      # 需要数据库时填 @koishijs/plugin-database-sqlite（自行 pnpm add）
  gscore:
    enabled: true
    python: ''        # 留空自动探测
    env: {}
  astrbot:
    enabled: true
```

## 装插件

```bash
# Koishi
cd plugins/compat && pnpm add koishi-plugin-xxx

# Python 生态：放目录 + 用 pip 装插件自己声明的依赖
python -m pip install -r pkgs/astrbot/<插件名>/requirements.txt
```

## 回归测试用的真实插件样本

`pkgs/` 下有三个**上游原样下载、未改一行**的插件，用于证明"真实生态插件零改动可跑"：

| 路径 | 来源 | 许可 |
|---|---|---|
| `pkgs/koishi/koishi-plugin-jiuli-test/` | 本仓库自写（模仿真实 koishi-plugin 的 CJS 形状） | AGPL-3.0 |
| `pkgs/astrbot/helloworld/` | <https://github.com/Soulter/helloworld>（AstrBot 官方模板，v1.3.0） | AGPL-3.0 |
| `pkgs/gscore/gs_test.py` | `gsuid_core/buildin_plugins/gs_test.py`（GsCore 官方回归插件） | GPL-3.0 |

另外 `pkgs/astrbot/astrbot_plugin_jiuli_test/` 是本仓库自写的 AstrBot 夹具插件（覆盖各种 filter 与消息组件）。

## 已知边界

- GsCore/AstrBot 的插件必须是 Python，跑在边车进程里；PIL 绘图、SQLModel 真实表、
  WebUI、LLM Provider 等重运行时未实现，用到就会明确报错（不会静默失败）
- Koishi 的 `ctx.database` / `console` / `puppeteer` / `assets` 默认没有：插件 `inject` 这些服务时
  cordis 会**静默不加载**，宿主已加依赖预检并在日志里告警
- 插件靠 `ev.user_id` / `ev.group_id` 做绑定查询时，字段映射错了会静默查不到 ——
  对应的映射已有回归测试（`test/compat-gscore.mjs` 的"身份测试"）
