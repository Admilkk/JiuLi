# plugins/ 目录说明

这里放**机器人插件**。内核只扫描本目录下的**一级子目录**（一个子目录 = 一个插件来源），
子目录里的 `node_modules`、`resources`、`apps` 等不会被单独当成插件。

## 目录结构（只有两个内置目录 + 你的插件）

| 目录 | 是什么 | 能删吗 |
|---|---|---|
| `example/` | **内置基础功能 + 示例 + 你自己写的插件**。里面每个 `.js` 是一个独立插件（`status.js` = `#状态`，`master.js` = `#设置主人`…），**新增/修改/删除 js 会立即热重载** | 不要整删；里面单个文件可以删 |
| `adapter/` | **适配器**：`stdin.js`（终端交互）、`mock.js`（调试用，日志打印发出的消息） | 不要删 |
| `<第三方插件>/` | 从网上 clone / 下载的插件，例如 `Yunzai-QQBot-Plugin`、`miao-plugin`。**不入 git**，依赖由 `pnpm install` 自动装 | 随意 |

> `example/` 里的文件分了这几类（都放在同一个目录，按名字区分）：
> - 基础功能：`status.js` `help.js` `master.js` `add.js`（词条） `recallReply.js` `diagnose.js` `disablePrivate.js` `friend.js` `invite.js` `quit.js` `botOperate.js`
> - 进程与维护：`restart.js` `reload.js` `update.js` `sendLog.js` `version.js`
> - 示例：`demo-class.js`（类形态） `demo-dsl.js`（DSL 形态） `render-demo.js`（渲染：`#渲染测试` `#渲染列表` `#渲染图片` `#渲染长图`）
> - 渲染模板统一放在 `example/resources/`（`card/` `list/` `long/` `image/` `hello/` `assets/`）

**自己写插件就放进 `example/`**（或在 `plugins/` 下新建自己的目录，两种都支持）：

```bash
pnpm jiuli create my-plugin        # 生成 plugins/my-plugin/index.js（也可手动在 example/ 里写个 js）
```

## 加载规则

1. 目录里有 `index.js` → **只加载它**（适合把功能拆到 `apps/`、`model/`）。
2. 目录里没有 `index.js` → 加载该目录下**所有 `.js`**（内置 `example/`、`adapter/` 就是这种）。
3. 热重载（`file_watch: true` 时）：
   - 新增 js 文件 / 新增目录里的 js → 自动加载
   - 修改 js（含 `index.js` 与 `apps/` 等深层文件）→ 自动重载
   - 删除 js → 自动卸载
   - 资源（html/图片）不触发重载——模板改动由渲染层自己失效缓存，直接生效
4. 手动重载：`#重载`（全部）或 `#重载 状态`（按关键词），也可以只改文件等 2 秒。

## 怎么写自己的插件（三步）

**第 1 步：生成骨架**

```bash
pnpm jiuli create my-plugin          # 类形态模板
pnpm jiuli create my-plugin --dsl    # 函数式 DSL 模板
```

也可以直接在 `plugins/example/` 里新建一个 `.js`，内核会自动加载。

**第 2 步：改内容**

最小可用插件（类形态）：

```js
import { JiuLiPlugin } from 'jiuli'

export default class MyPlugin extends JiuLiPlugin {
  constructor() {
    super({
      name: '我的插件',                       // 插件名（#插件列表 / 群配置 enable/disable 用）
      dsc: '演示',
      event: 'message',                      // 通知类事件写 notice.group.poke 等
      priority: 5000,                        // 数字越小越先执行
      rule: [
        { reg: '^#你好$', fnc: 'hello' },     // 用户发送 #你好 → 调用 hello()
        { reg: /^#戳我\s+(.+)$/, fnc: 'poke' },
      ],
    })
  }

  async hello(e) {
    await e.reply('你好呀')
    return true        // 返回 false 表示继续匹配后面的规则
  }

  async poke(e, match) {
    await e.reply(`你说了：${match?.[1]}`)
  }
}
```

**第 3 步：写功能**

- 发消息：`e.reply('文本')` / `e.reply('带引用', true)` / `e.reply([segment.at(e.user_id), '\n你好'])`
- 发图片：`await e.reply(await this.render('卡片模板名/index', { title: '标题' }))`（模板放 `example/resources/<名字>/index.html`）
- 定时任务：`task: [{ name: '每日', cron: '0 8 * * *', fnc: 'daily' }]`
- 会话（等用户下一条消息）：`this.setContext('waiting')` → 再写一个 `waiting()` 方法接收
- 数据存储：`this.dataDir`（插件私有目录）、`redis`（全局）、`Bot.getMap('data/xxx')`
- 排查问题：`#诊断`（适配器/在线账号/最近收发）、日志里的 `[  Plugin ]` / `[   Msg   ]` 行

**完整说明**：见 [`docs/plugin-guide.md`](../docs/plugin-guide.md)。
