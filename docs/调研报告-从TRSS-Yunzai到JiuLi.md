# JiuLi 重构调研报告

> 调研时间：2026-09-14
> 调研对象：
> - `D:\yunzaibot\TRSS\Yunzai`（TRSS-Yunzai v3.1.3，待重构对象）
> - `D:\yunzaibot\kan\karin-project` + `node_modules/node-karin@1.17.0`（参考对象）
> - `D:\yunzaibot\JiuLi\jiuli`（新框架，当前为空仓库）
>
> 本报告只做"现状 + 可改点 + 方案选项"的收集，不涉及具体实现。结论供决策，不代表最终设计。

---

## 0. 核心结论（TL;DR）

1. **"兼容全部旧插件"的本质，是兼容一份非常具体的 API 契约**，而不是兼容"Yunzai 这个名字"。这份契约有四个组成部分，缺一不可：
   - **物理路径**：插件里写死的 `import ... from '../../lib/plugins/plugin.js'`、`lib/config/config.js`、`lib/puppeteer/puppeteer.js` 等相对路径。新框架必须在**同样的相对位置**提供同名文件（哪怕是薄 shim）。
   - **全局变量**：`Bot`、`logger`、`redis`、`segment`、`Renderer`、`plugin`、`start_type`。
   - **`e` 事件对象契约**：约 40 个字段/方法（`e.reply/e.msg/e.group_id/e.isSr/e.runtime/...`）。
   - **`Bot` 的隐式语义**：Proxy 属性回落、`Bot.uin` 特化数组（随机 `toJSON`）、`Bot.adapter` 去重 push、`Bot.wsf`/`Bot.express` 扩展点等。

2. **TRSS-Yunzai 的核心其实很小**：`lib/` 只有 36 个文件、3404 行。所谓"臃肿"主要来自三处：
   - 内核里**内嵌了游戏/插件专属逻辑**（`runtime.js` 直接 import genshin 的 model 和 miao 的 `#miao`；`loader.js` 写死星铁/绝区零命令前缀正则）。
   - 插件生态本身巨大（`plugins/` 下 30 个目录、517 个 js 文件）。
   - 为兼容历史插件长出的补丁层（例如 TRSS-Plugin 反过来给 `Bot` 打 `??=` 补丁、适配器被插件劫持 `makeMsg`）。

3. **性能问题集中在少数几个可量化的点上**（见第 4 节），最大的三个：每条消息都 `await Runtime.init(e)`（内部做 redis 查询 + 建 DB 对象）、每条消息发 16~32 次 redis 计数命令、accept 阶段对约 25 个插件**串行实例化并 await**（一个慢插件拖慢整条分发链）。

4. **Karin 值得借鉴的是工程化，不是 API 设计**。它的类型系统、插件清单（package.json 的 `karin` 字段）、每插件独立数据目录、AdapterBase 统一抽象、hooks 分段、DB 层、伪 Redis 降级都值得学；但它的 DSL 命名、事件模型、远程渲染路线**不能照抄**——照抄就是缝合怪，而且它没有云崽兼容层，路线与 JiuLi 目标不同。

5. **建议架构：三层物理隔离**——现代内核（纯 TS、无全局、类型完备）+ 云崽兼容层（复刻上述契约的薄 shim）+ JiuLi 原生插件体系（专属 DSL/类 + 类型包）。旧插件走兼容层，新插件走原生层，二者互不污染。

6. JiuLi 专属插件结构提案见第 6 节。

---

## 1. 三个项目现状

### 1.1 TRSS-Yunzai（待重构）

```
app.js                    启动入口（switch 启动模式：internal/pm2/external/daemon）
lib/
  bot.js            688行  Bot 单例（Proxy + EventEmitter + HTTP/WS 服务 + 多账号）
  util.js           472行  工具集合（日志/文件/Buffer/exec/Map存储/sleep/debounce）
  plugins/
    loader.js       799行  插件加载 + 消息分发（最大最核心）
    plugin.js       133行  插件基类（rule 定义、上下文、renderImg）
    runtime.js      259行  每条消息注入 e.runtime
    handler.js       61行  跨插件 keyed 调用总线
    config.js        62行  插件配置生成（makeConfig）
  config/
    config.js       185行  YAML 配置中心（Proxy 属性回落 + chokidar 热更）
    init.js          64行  启动初始化（时区/Promise polyfill/错误捕获）
    log.js           91行  log4js + chalk 全局 logger
    redis.js        114行  redis 客户端（连不上则自动拉起本地 redis-server）
  renderer/loader.js+Renderer.js   渲染后端注册表 + art-template
  puppeteer/puppeteer.js           旧式截图入口（兼容层）
  listener/loader.js 53行  加载 lib/events/*.js 与 Bot.adapter
  events/*.js               message/notice/request/connect/online 监听器
  common/common.js          common 工具（downFile/makeForwardMsg/sleep）
  tools/web.js              Web 控制台
  modules/                  依赖替换层：lodash→es-toolkit/compat、md5→node:crypto、
                            node-fetch→global fetch、oicq→43行 segment shim
renderers/puppeteer/        puppeteer 渲染后端（带 idle 自动关闭/截图数重启）
plugins/                    30 个插件目录 / 517 个 js（含 system、adapter、example 内置插件）
config/{config,default_config}/*.yaml   含 group.yaml（群级配置）
```

关键事实：
- **协议实现全在插件里**：`plugins/adapter/`（OneBotv11、stdin、Milky、Satori、ComWeChat、OPQBot、GSUIDCore）+ `ICQQ-Plugin`（自带 `icqq` 依赖）。框架本体只定义"适配器契约"（`Bot.adapter.push({id,name,path,load()})`）。
- js 文件 517 个，但其中大部分是生态插件（genshin/miao/Guoba 等）自带的业务代码。
- 依赖用 pnpm workspace（`plugins/**` 都是 workspace 包），插件可以有自己的 `node_modules`。

### 1.2 Karin（参考）

- `node-karin` 发布物只有 `dist/`（tsdown 打包）+ `default/` 默认配置；类型集中在单文件 `dist/index.d.ts`（523KB）。**没有云崽兼容层**（全量 grep `yunzai|Yz|trss` 无命中）。
- 插件模型：注册函数 DSL（`karin.command(reg, fnc, opts)` 返回描述对象 → 全局数组缓存），另有 `accept/task/button/handler/ctx/render`。
- TS 支持方式：`exports` 三条件（`types`→d.ts、`development`→src/*.ts、`default`→dist/*.mjs）+ 外部 `tsx` loader，框架自身不带编译器；非 tsx 环境只扫 `.js`。
- 适配器：`AdapterBase` 单类抽象（约 60 个标准方法 + `super/raw` 逃生口），`registerBot()` 注册。
- 渲染：不内置 puppeteer，走"渲染器注册表 + 远程渲染服务（HTTP/WS/snapka）"。
- 配置：JSON（非 YAML），场景 key 逐级合并（`Bot:selfId:groupId → Bot:selfId → groupId → global → default`）。
- 其它工程化：每插件独立数据目录 `@karinjs/<插件名>/{config,data,resources}`、`package.json` 的 `karin` 字段声明入口/静态目录/环境变量、engines 版本门禁、sqlite KV + 任务库、REDIS_ENABLE=false 时降级为纯 JS 伪 Redis、hooks 四段（消息前/插件前/无命中/发送前后）、`store: Map` 链内传数据、`ctx()` 会话、CLI(ki)+pm2+WebUI。
- 已知缺陷（新框架应避免）：`pkgSort()` 按 `rank` 排序但工厂只写 `priority`，优先级实际接近加载顺序；`use` 中间件只有类型残留未实现；sort 字段不统一。

### 1.3 JiuLi（当前）

空仓库（只有 Gitee 模板 README，一次 Initial commit）。技术选型完全开放。

---

## 2. 兼容契约全集（重构的"A 面"，最重要）

> 这一节是"兼容全部旧插件"的验收清单，来自对 30 个插件、517 个 js 的全量使用统计。
> 实现方式建议：全部做成"薄 shim"，内部转发到新内核；shim 文件放在与 TRSS 相同的物理路径。

### P0（缺了插件直接崩）

| # | 契约 | 说明 / 证据 |
|---|---|---|
| 1 | 全局 `Bot`（Proxy） | 属性回落链 `Bot.x → Util.x → bots[x] → Bot[uin].x`（bot.js:82-94）；同时是 EventEmitter（`Bot.on/once/emit/off`） |
| 2 | `Bot.uin` 特化数组 | `toJSON()` 60 秒内随机返回一个 uin、`toString(raw)`、额外 `includes()`；插件用 `Bot.uin[0]`、`for...of Bot.uin`、`.push/.splice/.includes`（bot.js:19-43） |
| 3 | `Bot.adapter` 特化数组 | push 按 `path` 去重（bot.js:44-53）；适配器契约 `{id,name,path,load()}` + `Bot[uin]={adapter,sdk,uin,nickname,version,pickFriend,pickGroup,pickMember,fl,gl,gml,stat}` + `connect.<id>` 事件 |
| 4 | `Bot` 方法面 | `makeLog(level,msg,id)`(417处)、`pickGroup/pickFriend/pickUser/pickMember`、`makeForwardMsg/makeForwardArray`、`String/Loging`、`Buffer/fileType/fileToUrl/download/mkdir/fsStat/glob/rm/exec`、`sleep/getTimeDiff/makeError`、`sendFriendMsg/sendGroupMsg/sendMasterMsg`、`em/prepareEvent`、`restart/exit`、`stat/url/fs/wsf/express/server/bots` |
| 5 | 全局 `logger` | log4js 三通道（default/command/error）+ `mark` 等级 + chalk 颜色函数（`logger.red/green/...`）+ `logger.logger.<level>` 直通（plugins 用 1314 次 debug / 849 error / 603 info / 484 warn / 283 mark） |
| 6 | 全局 `redis` | **原生 node-redis v4 客户端语义**（get/set/del/zRange/zAdd/hGetAll/scan/incr/multi...），不是封装；key 前缀事实标准 `Yz:`（`Yz:count:*` 等） |
| 7 | 全局 `segment`（包名 `oicq`） | 必须有一个**可解析的 `oicq` 包**，导出 `segment.*` 元素工厂。TRSS 的实现本身就是 43 行 shim（custom/raw/button/markdown/image/at/record/video/file/reply + 动态借用 ICQQ-Plugin 的 icqq segment） |
| 8 | `lib/plugins/plugin.js` 基类 | 相对路径 import（如 `../../lib/plugins/plugin.js`）；字段 `name/dsc/event/priority(默认5000)/rule/task/handler/namespace`；方法 `reply/conKey/setContext/getContext/finish/awaitContext/resolveContext/renderImg`；`this.e` 由 loader 注入 |
| 9 | `lib/config/config.js` | Proxy 属性回落（`cfg.ICQQ` 这类"属性式读配置"）；`getGroup/getOther/getConfig/getdefSet/getYaml/getAllCfg/master/masterQQ/uin/package/bot` |
| 10 | `lib/plugins/loader.js` | 默认导出单例；插件用到的内部状态/方法：`dealText/srReg/zzzReg/priority/filtEvent/checkDisable/dealEvent/load_time/changePlugin` |
| 11 | `lib/common/common.js` | `{relpyPrivate, sleep, downFile, mkdirs, makeForwardMsg}` |
| 12 | `e` 对象契约 | 字段：`msg/img/at/atBot/atAll?/reply_id/getReply/file/logText/logFnc/isPrivate/isGroup/isMaster/recall/only_reply_at/hasAlias/isSr/isGs/game/sender.nickname/sender.card/message_id/raw_message/post_type/message_type/sub_type/notice_type/target_id/operator_id/original_msg`；方法：`e.reply(msg, quote, {recallMsg, at})`（返回 `{message_id}`）；子对象 `e.group/e.friend/e.member/e.bot` 的方法面（getChatHistory/makeForwardMsg/getForwardMsg/getFileUrl/recallMsg/sendFile/pickMember/pokeMember/kick/mute/...） |
| 13 | 渲染双通道 | 新：`e.runtime.render(plugin, path, data, cfg)`（固定 `plugins/<plugin>/resources/<path>.html`、`pluResPath`、`retType: base64/msgId`、`beforeRender`）；旧：`lib/puppeteer/puppeteer.js` 的 `screenshot/screenshots`（要求 data 自带 `tplFile/saveId/pluResPath/_res_path`）+ `temp/html` 落盘约定 |
| 14 | 其余 lib 内部模块 | `lib/plugins/handler.js`（Handler.has/call + handler 配置 `{key,fn}`）、`lib/plugins/runtime.js`（Runtime 类）、`lib/plugins/config.js`（makeConfig）、`lib/renderer/loader.js`（getRenderer）+ 全局 `Renderer` |
| 15 | 框架探测兼容 | 插件靠 `Array.isArray(global.Bot?.uin)`（steam）、`package.json.name === 'trss-yunzai'` 与版本号首段（miao/genshin）判断框架；根 `package.json#imports` 的 `#miao`/`#miao.models` 别名 |
| 16 | 插件加载约定 | 目录有 `index.js` 只加载它、否则平铺扫描全部 `.js`；模块导出对象全部视为插件类；支持 `export {apps}`；`init()` 返回 `"return"` 跳过加载；`accept(e)` 在 rule 之前执行（返回 `"return"` 终止） |
| 17 | 事件/规则语义 | `rule.reg` 支持字符串与正则（字符串 `new RegExp(reg)` 不带 flags）；`rule.event` 三段通配匹配（`message.group.normal`）；`rule.permission`（实际只有 `master` 在用）；`rule.log:false`；`priority` 数字越小越先；`task.cron`（5/6 段）+ `task.fnc` 需同时支持"函数"与"方法名字符串"（老 miao 风格） |
| 18 | `Promise.withResolvers` | 插件大量直接用（Node 22+ 原生有；框架仍做 polyfill） |
| 19 | 全局 `start_type` | `pm2/external/internal`，影响 `Bot.exit/restart` 行为 |

### P1（缺了大面积回归）

- `Bot.wsf[path]`（WS 处理器注册，18 处）+ `Bot.express`（当 express app 用，可改 `quiet`/`skip_auth` 数组，132 处）+ `Bot.server`；WS 连接对象上的 `conn.sendMsg`。
- 适配器被"查找 + monkey-patch"：`Bot.adapter.find(i => i.name === 'ICQQ')` 后替换 `makeMsg/makeMarkdownMsg/sendMsg`（heike/example 在用）。
- 只关注 at 模式：`onlyReplyAt`、`botAlias` 前缀剥离、`hasAlias`。
- 冷却（groupCD/singleCD/msgThrottle 1 秒去重）、黑白名单（`other.blackUser/whiteUser/blackGroup/whiteGroup`）、群级插件开关（`groupCfg.enable/disable`）、`Yz:count:*` 统计（`system/status.js`、yenai 读它）。
- `Bot.em(name, data)` 逐级 emit（`message.group.normal → message.group → message`）与 `prepareEvent` 补全（bot/friend/group/member/sender/reply/adapter_id/adapter_name）。
- 游戏前缀标准化：`#星铁`/`%绝区零` 替换 + `e.isSr/isGs/game`（注意：这是内核里的游戏逻辑，新框架建议做成"可插拔文本预处理器"）。
- `e.runtime` 自动注入；`e.user`（NoteUser 代理）与 `e.uid`（142 处，实际是 genshin 生态的运行时注入）。
- `cfg.bot.file_watch === false` 时把 `fs.watch`/`chokidar.watch` 换成空实现（插件自建 watcher 也会受影响）。
- 插件加载超时 `cfg.bot.plugin_load_timeout`、加载期就可用全局（插件顶层代码直接 `logger`/`Bot`）。
- Guoba 生态：`guoba.support.js` 自动扫描、`defSet/*.yaml` + `config/*.yaml`（11 个插件在用）。
- `global.plugin`（steam 兼容层/Guoba loadClasses）、插件自设全局（`global.Guoba`、`global.xiaofei_plugin`、`global.ReplyError`）。
- 插件自带 `node_modules`（example 里有 @zxing/jimp/jsqr/sharp）与 pnpm workspace link 依赖，模块解析不能被破坏。

### P2（小范围但真实存在）

- `Bot.on('message')` 原始事件流（不经过 deal）：`example/水群统计.js` 等依赖 `raw_message/sender/message` 完整。
- `Bot.uin.toJSON()` 随机、`Bot.uin.now` 字段（Satori 用）。
- `Bot.fs.timeout`（过期文件占位）、`Bot.fileTimers`。
- `lib/util.js` 细节：`String/Loging/Buffer/fileType/makeMap/getMap` 的磁盘持久化 Map 语义。
- `cfg.bot.log_align/log_object/log_length` 日志格式配置。
- 日志控制字符转义补丁（log4js.patch）、body-parser zstd 补丁。

---

## 3. 现有设计问题清单（不是性能，是"该不该这样"）

1. **内核依赖插件（反向依赖）**：`lib/plugins/runtime.js` 顶层 import genshin 的 gsCfg/MysApi/MysInfo/NoteUser/MysUser 与 miao 的 Version；`lib/plugins/plugin.js` 顶层 `await import("#miao")`。框架核心被具体插件绑死，换生态就崩。
2. **游戏逻辑写进内核**：`loader.js` 的 `srReg/zzzReg`（星铁/绝区零前缀）。
3. **配置体系魔法**：`cfg` 是 Proxy，未定义属性回落 `getAllCfg(prop)` 返回 `{...default, ...user}`；`getGroup` 每次 4 层对象展开无缓存；YAML + 每文件 chokidar。
4. **`Bot` 是"上帝对象"**：HTTP/WS 服务、多账号路由、文件托管、工具函数、事件总线、日志入口全在一个 688 行的类 + Proxy 上。
5. **全局注入与 import 混用**：`Bot/logger/redis/segment/Renderer/plugin` 是 global，但 `cfg/common/Handler/Runtime/puppeteer` 要 import——插件作者必须记住哪套是哪套，这是历史包袱，不能改（兼容），但原生层不该再这样。
6. **共享插件实例被写 `e`**：分发时 `Object.assign(i.plugin, { e })` 把事件挂到全局共享的插件实例上（loader.js:230），造成每个插件实例长期持有"最后一个事件对象"（内存滞留，且状态语义混乱）。
7. **分发链串行 await**：accept 阶段对每个插件 `await` 串行执行（loader.js:275-279），任一插件慢（redis/网络）会阻塞后面所有插件。
8. **插件给框架打补丁**：TRSS-Plugin `index.js:9-84` 给 `Bot` 打 `??=` 补丁、Guoba 给 `Bot.rm/fsStat/exec` 兜底——说明内核 API 不够稳定/不完整。新框架应把这些能力做进内核，补丁层保留为 no-op。
9. **适配器可被劫持**：heike 等插件直接替换 `Bot.adapter` 里适配器的 `makeMsg/sendMsg`。这是生态事实标准（做消息格式魔改），兼容层要允许。
10. **热重载不完整**：只有"无 index.js 的平铺插件"被 chokidar 监听（loader.js:745-797）；有 index.js 的目录、`resources`、`model` 改动不热更。
11. **渲染先落盘再截图**：art-template 渲染产物写到 `temp/html` 再交给 puppeteer 读（因为模板里要相对引用资源），可优化为直接 setContent，但会破坏 `_res_path` 相对路径语义——需权衡。

---

## 4. 性能热点清单（按性价比排序）

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| 1 | `loader.deal` → `await Runtime.init(e)`（loader.js:224） | **每条消息**都执行 `MysInfo.initCache()`（redis/文件缓存）+ `NoteUser.create(e)`（redis.get + DB 对象构造），在**分发之前**阻塞，即使这条消息最终没有插件处理 | 改成懒加载：`e.runtime`/`e.user` 用 getter 首次访问时才创建（注意：插件有直接 `this.e.runtime` 读的场景，getter 可无缝兼容） |
| 2 | `loader.count`（loader.js:495-527） | 每条消息对 day/month/year/total × (total/bot/user/group) 组合做 16~32 次 `incrBy`（未 await，后台跑）；高频群聊下 redis 与事件循环开销可观 | 内存聚合 + 定时 flush（write-behind，如 1s 一批用 pipeline）；或按需开启统计 |
| 3 | `loader.deal` accept 循环（loader.js:275-279） | 对约 25 个"事件类型匹配"的插件**串行** `new i.class(e)` + `await accept(e)`，每个实例化一次；一个慢 accept 拖慢整链 | 先做"纯函数预筛"（大多数 accept 只看 `e.user_id/e.self_id`），只对可能命中的实例化；或并行 accept + 结果合并（注意语义：现有语义是顺序 short-circuit，需谨慎） |
| 4 | 每条消息 `new i.class(e)`（rule 命中时再建一个实例） | 每插件每消息至少 1~2 次对象构造 + `Object.assign` | 原生层改为"规则描述对象 + 无状态 handler"；兼容层保留类语义但可复用实例池（`this.e` 每次覆盖） |
| 5 | `filtEvent` 每消息对全量插件跑（loader.js:320-331） | 每插件构造 `mappedEvent` 数组 | 预编译：按 `post_type` 建索引表，加载期就把插件分组到事件桶里 |
| 6 | `loader.dealEvent` + `logText` 构造 | 每条消息都拼 logText（含 lodash.truncate + chalk 颜色码）；`dealText` 对每段文本跑 3 个正则 | 日志字符串**惰性构造**（只在确定要打日志时拼）；`dealText` 正则合并 |
| 7 | `Bot` Proxy（bot.js:82-94） | 每次访问不存在的属性都走回落链 + 可能打 trace 日志 + 每次新建数组 `[this.uin.toString(), ...this.uin]` | 缓存"属性→目标对象"的解析结果（失效点明确：bots 增删时清空） |
| 8 | lodash/moment | 内核与插件大量 lodash（es-toolkit/compat 已部分替换）、moment 全量引入 | 内核自身零 lodash（用 es-toolkit 原生 API）；兼容层继续提供 lodash shim；moment 保留为插件依赖 |
| 9 | 启动 | `renderers/puppeteer` 在 import 期就初始化（`RendererLoader.init()` 顶层 await）；puppeteer 常驻（有 idleTime 缓解） | 渲染后端懒加载；首次渲染才启动浏览器 |
| 10 | 插件加载 | 517 个 js 全量 import；单个插件 `init()` 串行 await（在文件级并行内） | 并行 + 依赖预检（缺依赖的插件直接跳过并打表）、`init()` 加超时（现有超时只覆盖 import 阶段） |
| 11 | 统计/日志等级判断 | `Bot.makeLog` 每次都查 `isLevelEnabled`（已有短路，OK） | 保持；原生层用"level 检查 → 惰性求值"模式 |

> 结论：**真正影响消息延迟的是 #1、#3、#6**；影响吞吐/稳定的是 #2、#5、#7。其余是锦上添花。重构时建议先加"每条消息耗时打点 + 慢插件排行"，用数据驱动优化，而不是一次性全改。

---

## 5. Karin 借鉴 / 不借鉴

### 值得借鉴（工程化）
1. **类型系统**：单文件/分模块 `.d.ts` + 完整 JSDoc，插件作者开箱有补全。
2. **插件清单**：`package.json` 的框架专属字段（`karin.apps/ts-apps/web/static/files/env/engines`）声明入口与元数据，替代"按目录猜"。
3. **每插件独立数据目录**：`@karinjs/<插件名>/{config,data,resources}` 自动创建——解决"插件数据散落一坨"的老问题；JiuLi 可设计为 `data/plugins/<插件名>/`。
4. **engines 版本门禁**：插件声明兼容的框架版本，不满足拒绝加载并打表。
5. **适配器抽象**：一个 `AdapterBase`（标准方法面 + `super/raw` 逃生口）+ `standard/protocol/communication` 元信息。
6. **hooks 分段**：消息前/插件调用前/无命中/发送前后，四段可插拔（比 Yunzai 的 Handler 单总线更细）。
7. **`store: Map`**：事件对象上挂链内数据传递容器。
8. **DB 层**：内建 sqlite KV + 任务库（长任务状态可查）；Redis 可选，缺省降级纯 JS 伪 Redis（零依赖部署）。
9. **配置合并模型**：场景 key 逐级合并（bot → 群 → 用户），天然支持多账号。
10. **CLI / pm2 / WebUI 分离**：CLI 只驱动外部 pm2，不内嵌 SDK；WebUI 独立 SPA。
11. **依赖全部 alias 到 fork**（`art-template→@karinjs/art-template` 等），便于统一修 bug。TRSS 用 `lib/modules` 自实现 + pnpm patch，思路一致，JiuLi 可择一或混用。
12. **热重载**：`?t=timestamp` 重新 import + cron cancel + 配置 chokidar 广播 `file:change`。

### 不该照抄
1. **插件 DSL 命名与形状**（`karin.command/accept/task/button/...`）——直接抄 = 缝合怪。
2. **事件模型**（强类型类实例 + camelCase）——与云崽的普通对象 + snake_case 冲突，JiuLi 的兼容层必须保留云崽形状，原生层可另立。
3. **远程渲染专用**——旧插件依赖本地 puppeteer + 模板相对路径，JiuLi 必须内置本地渲染（可同时支持远程后端）。
4. **TS 运行完全依赖 tsx**、条件导出里 `development` 指向未发布的 `src`——JiuLi 应做"可选 tsx + 预编译 dist"两条路。
5. **其已知 bug**（`rank`/`priority` 不统一、`use` 未实现）不要复制。
6. **WebUI 13MB 全家桶**作为一期目标——太重，二期再说。

---

## 6. JiuLi 建议架构

### 6.1 三层结构（物理隔离）

```
jiuli/
├─ core/                    ① 现代内核（纯 TS，零全局，类型完备）
│   ├─ event/               事件总线（类型化、优先级、可中断、hook 分段）
│   ├─ plugin/              插件注册表（描述对象 + 缓存索引，类/DSL 双形态）
│   ├─ adapter/             AdapterBase + 注册中心 + 通信层（ws_server/ws_client/http）
│   ├─ message/             消息元素类型 + segment 工厂（与 oicq shim 同形状）
│   ├─ render/              渲染协议（本地 puppeteer 后端 + 可插拔远程后端）
│   ├─ config/              配置中心（快照缓存 + 版本号失效 + 多账号合并）
│   ├─ store/               DB（sqlite KV）+ 缓存（Redis 可选，内存降级）
│   ├─ scheduler/           cron + 长任务
│   └─ log/                 日志（等级短路、惰性求值、结构化）
│
├─ compat/                  ② 云崽兼容层（薄 shim，物理路径与 TRSS 一致）
│   ├─ lib/                 ← 插件写死的相对路径全部在这里落地
│   │   ├─ plugins/{plugin,loader,handler,runtime,config}.js
│   │   ├─ config/{config,init,log,redis}.js
│   │   ├─ common/common.js
│   │   ├─ puppeteer/puppeteer.js
│   │   ├─ renderer/{loader,Renderer}.js
│   │   ├─ modules/{lodash,md5,node-fetch,oicq}/
│   │   ├─ events/*.js  listener/*.js  util.js
│   └─ globals.ts           注入 Bot/logger/redis/segment/Renderer/plugin/start_type
│
├─ apps/                    ③ JiuLi 原生插件（内置：system/config/adapter/help/update…）
├─ plugins/                 第三方插件目录（旧插件原样放这里即可）
├─ types/                   发布的类型包（@jiuli/types）
└─ index.ts / app.ts        入口（CLI 启动、进程管理）
```

**关键点**：
- 旧插件 → 通过 `compat/lib/**` 的物理路径直接 import 到 shim，shim 转发 `core`。插件零改动。
- 新插件 → 只依赖 `@jiuli/types` + `jiuli` 包（原生 API），不碰 compat。
- `core` 永不 import `apps`/`plugins`（解决 TRSS 的反向依赖问题）；渲染、游戏前缀、`e.user` 之类全部改成**可插拔扩展点**，由内置插件注册。

### 6.2 需要你拍板的关键决策

| 决策 | 选项 | 倾向 |
|---|---|---|
| 语言/构建 | A. 全 TS + tsdown/tsup 构建发布 dist+d.ts（同 Karin）<br>B. JS + JSDoc + 手写 d.ts<br>C. TS 源码直接用 tsx 跑（不构建） | A 为主，保留 C 作为开发模式 |
| 包名/框架探测 | 插件靠 `package.json.name==='trss-yunzai'` 判断框架 | `cfg.package.name` 伪装 `trss-yunzai`（或提供 `compat.trssPackageName` 配置），否则 miao/genshin 会走错分支 |
| 配置格式 | 旧插件读写 `config/config/*.yaml`、`defSet/*.yaml` | 兼容层保留 YAML；内核新配置用 JSON/TOML 自选 |
| Redis | 旧插件当原生客户端用 | 保留真实 Redis；内核提供内存降级（仅原生层用），compat 层仍暴露 redis 客户端 API |
| 渲染 | 旧插件强依赖本地 puppeteer + 模板相对路径 | 内核内置本地 puppeteer 后端（兼容 `temp/html` 约定）+ 支持远程后端 |
| 进程模型 | TRSS：单进程多号 + pm2/daemon 自管 | 一期保持单进程多号，别动 |
| 目录 | 沿用 `plugins/`（旧插件直接拷入） | 沿用；JiuLi 原生插件也用 `plugins/`，靠清单字段区分新旧 |

---

## 7. JiuLi 专属插件结构（提案）

> 目标：TS/JS 双支持、类型完备、与旧插件物理共存但不混淆、比 Karin 清爽。

### 7.1 目录约定

```
plugins/jiuli-plugin-xxx/
├─ package.json           # 清单：jiuli 字段（见下）
├─ src/                   # TS 源码（开发态，tsx 直接跑）
│   ├─ index.ts           # 入口：export default definePlugin(...)
│   ├─ apps/              # 一个文件 = 一个/多个 app
│   ├─ model/             # 业务逻辑
│   ├─ config/            # 配置 schema + 默认值
│   └─ web/               # （可选）配置页描述
├─ lib/                   # 构建产物（JS，生产态；与 src 二选一）
├─ resources/             # 模板/图片（与云崽插件同名，渲染层复用）
├─ defSet/                # 默认配置（与云崽一致，Guoba 生态兼容）
└─ data/                  # 插件私有数据（运行时生成；内核负责提供路径 API）
```

`package.json` 清单（借鉴 Karin 但换体系，避免雷同）：

```jsonc
{
  "name": "jiuli-plugin-xxx",
  "jiuli": {
    "apps": ["lib"],              // JS 入口目录/文件
    "tsApps": ["src"],            // tsx 模式优先
    "engine": ">=1.0.0",          // 版本门禁
    "config": "defSet",           // 默认配置目录
    "static": "resources",
    "web": "lib/web.config.js"    // 可选配置页
  }
}
```

### 7.2 插件定义：**类与 DSL 双形态**（这是与 Karin 的核心差异点之一）

形态 A：类（云崽作者平滑迁移，DSL 内聚、IDE 友好）

```ts
import { JiuLiPlugin, type MessageEvent } from 'jiuli'

export default class Help extends JiuLiPlugin {
  name = '帮助'
  rule = [
    { reg: /^#帮助$/, fnc: 'help' as const },
    { reg: /^#帮助\s+(.+)$/, fnc: 'helpDetail' as const, event: 'message.group' },
  ]
  task = [{ cron: '0 8 * * *', fnc: 'dailyReport' as const }]

  async help(e: MessageEvent) {
    await e.reply(await this.render('help/index', { list: this.apps }))
  }
  async helpDetail(e: MessageEvent, [, key]: RegExpMatchArray) { /* 带正则捕获组 */ }
  async dailyReport() { /* cron */ }
}
```

形态 B：函数 DSL（新作者，链式、类型推断强、无 this）

```ts
import { definePlugin, command, task, accept } from 'jiuli'

export default definePlugin({
  name: '状态',
  apps: [
    command(/^#状态$/, async e => e.reply(await statusText(e)), { permission: 'master' }),
    task('0 */6 * * *', syncStats, { name: '统计同步' }),
    accept('notice.group.poke', async e => e.reply('别戳了')),
  ],
})
```

两种形态产出**同一个描述对象**进入内核注册表；旧插件由 compat 层把"类 + rule"翻译成同一描述对象。→ 三套写法，一个内核。

### 7.3 事件对象（原生层）

- 保持**云崽字段名**（`e.msg/e.group_id/e.user_id/e.isMaster/e.reply`）以降低学习成本，但用 TS 类型固定下来，并补齐现代字段：
  - `e.store: Map<string, unknown>`（链内传数据）
  - `e.raw: unknown`（协议原始事件逃生口）
  - `e.contact: Contact`、`e.sender`、`e.replyId`（同时保留 snake_case 别名）
- `e.reply` 返回 `Promise<{ messageId: string }>`，`{ recallMsg, at }` 选项保留。
- 明确的生命周期：`created → filtered → matched → handled`，每段可被 hook 中断。

### 7.4 与 Karin 的差异（避免"缝合怪"的落点）

| 维度 | Karin | JiuLi 提案 |
|---|---|---|
| 插件形态 | 只有"注册函数返回对象" DSL | **类 / DSL 双形态**，同一描述对象 |
| 兼容旧生态 | 无 | compat 层复刻云崽契约（核心卖点） |
| 事件对象 | 强类型类 + camelCase | 云崽字段名 + 类型层补全（兼容原生态） |
| 渲染 | 只有远程 | 本地 puppeteer 内置 + 远程可插拔 |
| 配置 | JSON + `@karinjs` 数据目录 | YAML 兼容旧生态 + 内核 JSON 快照 |
| 扩展点 | hooks + handler | 事件 hook 分段 + **文本预处理器**（游戏前缀这类） + **适配器中间件**（makeMsg 劫持的正规化） |
| 优先级 | `rank`/`priority` 混用（bug） | 统一 `priority` + 显式 `stage` |
| 数据目录 | `@karinjs/<插件名>` | `data/plugins/<插件名>` + `resources/` 保持插件内 |

---

## 8. 重构路线图（建议）

**Phase 0：契约测试先行（1~2 天）**
把 `TRSS/Yunzai/plugins/` 整个目录作为"验收夹具"：写一个脚本启动新框架并断言 30 个插件全部加载成功、rule 全部注册。
> 这一步决定成败：兼容层没有测试夹具 = 无底洞。

**Phase 1：兼容层 P0（主战场）**
按第 2 节 P0 清单逐项实现：全局注入、`lib/**` 物理 shim、`Bot` Proxy 语义（uin/adapter 特化数组）、`e` 对象组装、plugin 基类、配置 YAML 中心、日志、redis、oicq/segment shim、渲染双通道。
验收：`example` + `system` + `miao-plugin` + `genshin` 四个代表插件零改动跑起来。

**Phase 2：适配器 + 内置插件移植**
把 `plugins/adapter/*`（OneBotv11/stdin 优先）与 `plugins/system/*` 作为 JiuLi 原生插件重写（同时它们也是 compat 层的第一批真实用户）。
验收：QQ 真实收发、多账号、群管指令全通。

**Phase 3：原生 API + 类型包 + 插件模板**
第 7 节的类/DSL 双形态、`@jiuli/types`、`create-jiuli-plugin` 脚手架、CLI。

**Phase 4：性能与工程化**
按第 4 节清单逐项优化（先打点后优化）、指标面板、热重载补全、WebUI（可选）、DB/任务库。

**Phase 5：生态收编**
`plugins/` 下其余 20+ 插件逐个实机验证，建立"已知不兼容列表"（例如直接 `import puppeteer from 'puppeteer'` 的、依赖 `renderers/puppeteer/lib/puppeteer.js` 的，需要额外 shim）。

---

## 9. 风险与坑（务必先看）

1. **相对路径 import 是硬约束**：`../../lib/plugins/plugin.js` 这类路径由插件文件位置决定，无法通过模块别名解决（除非给每个插件注入 import map）。兼容层的 `lib/` 必须放在与 `plugins/` 同级的位置。
2. **框架探测**：`package.json.name === 'trss-yunzai'` 影响 miao/genshin 行为分支，必须伪装或改造；`#miao`/`#miao.models` 别名必须继续指向 miao-plugin。
3. **`oicq` 包名**：插件 `import { segment } from "oicq"`，JiuLi 必须在 `node_modules/oicq` 放同形状 shim（含 button/markdown/ICQQ 动态借用）。
4. **`Bot.uin` 的随机语义**：`Bot.uin.toJSON()` 60 秒随机；`Bot.uin.now`；多号插件的假设。这个魔法必须原样复刻，否则多号生态出诡异 bug。
5. **redis key 约定**：`Yz:count:*` 等被 system/yenai 直接读，键名不能换。
6. **插件自带 node_modules / pnpm workspace**：模块解析链、`.npmrc` 的 hoist 设置、`sqlite3` 等原生模块的构建白名单（pnpm v10 需要 allow-build）。
7. **Windows 兼容**：当前开发机是 Windows（`process.execve` 不可用、路径分隔符、puppeteer 路径配置）。
8. **插件加载期就用全局**：顶层 `logger.mark(...)`、`Bot.xxx`——全局注入必须发生在任何插件 import 之前。
9. **`global.plugin` 与插件自定义全局**（Guoba/xiaofei/ReplyError）需要留位，不能清空 global 空间。
10. **`e.runtime` 在部分插件里被手工 `new Runtime(e)`**，compat 的 Runtime 类签名要兼容。
11. **热重载语义**：`changePlugin` 失败回滚（oldPriority 恢复）已被依赖，JiuLi 要做得更好而不是更差。
12. **调试信息**：`system/status.js` 读 `PluginsLoader.load_time`、`Bot.stat`，指标系统要保留这些读取路径。

---

## 10. 附带发现

- **Gitee token 泄漏**：`D:\yunzaibot\JiuLi\jiuli\.git\config` 的 remote URL 内嵌了 `fox-glaze:<token>` 形式的凭据。若该仓库目录被截图、打包或分享（包括推给他人），token 会一起泄漏。建议改用 Git 凭据管理器或 SSH，并轮换该 token。
- `D:\yunzaibot\` 根目录下还有 `plugins-yanjiu/GT-MYS`、`yunzai-web/yunzai-bot-web-master`、`测试/` 等目录，未纳入本次调研；如果其中有用例或自研插件，建议后续纳入 Phase 5 的夹具清单。
- 现有 Node 版本 v25.2.1、pnpm 8.14.0：Node 已原生支持 `Promise.withResolvers`/`fetch`/`fs.glob`，内核可去掉大量 polyfill。
