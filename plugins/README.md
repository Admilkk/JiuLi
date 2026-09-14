# plugins/ 目录说明

这里放**机器人插件**。内核只扫描本目录下的**一级子目录**（一个子目录 = 一个插件来源），
子目录里的 `node_modules`、`resources`、`apps` 等不会被单独当成插件。

## 目录结构

| 目录 | 是谁的 | 放什么 | 能删吗 |
|---|---|---|---|
| `example/` | **你的** | 你自己写的插件，一个 `.js` 一个插件，新增 / 修改 / 删除**即时热重载** | 文件可随意增删 |
| `system/` | 框架 | 内置基础功能：`status.js`(#状态) `help.js`(#帮助) `master.js`(#设置主人) `add.js`(#添加 词条) `diagnose.js`(#诊断) `reload.js`(#重载) `restart.js`(#重启) `update.js`(#更新) `sendLog.js`(#日志) `version.js`(#版本) 等 | 不要整删 |
| `adapter/` | 框架 | 适配器：`stdin.js`（终端交互）、`mock.js`（调试用，日志打印发出的消息） | 不要删 |
| `demo/` | 框架 | 示例插件：`demo-class.js`（类形态） `demo-dsl.js`（DSL 形态） `render-demo.js`（渲染自检：`#渲染测试` `#渲染列表` `#渲染图片` `#渲染长图`），模板在 `demo/resources/` | 可删（删了就没有示例参考） |
| `<第三方插件>/` | 别人 | 从网上 clone / 下载的插件，例如 `Yunzai-QQBot-Plugin`、`miao-plugin`。**不入 git**，依赖由 `pnpm install` 自动装 | 随意 |

> 内置、示例、适配器都随框架更新；自己的代码只放 `example/`，升级时不会被覆盖，也不会和框架文件混在一起。

## 加载规则

1. 目录里有 `index.js` → **只加载它**（适合把功能拆到 `apps/`、`model/`）。
2. 目录里没有 `index.js` → 加载该目录下**所有 `.js`**（`example/`、`system/`、`adapter/` 都是这种）。
3. 热重载（`config/config/bot.yaml → file_watch: true` 时）：
   - 新增 js 文件 / 新增插件目录里的 js → 自动加载
   - 修改 js（含 `index.js` 与 `apps/` 等深层文件）→ 自动重载
   - 删除 js → 自动卸载
   - 资源（html/图片）不触发重载——模板改动由渲染层自动失效缓存，直接生效
4. 手动重载：`#重载`（全部）或 `#重载 状态`（按关键词）——不过通常改完等 2 秒就自动生效了。

## 怎么写自己的插件（三步）

**第 1 步：生成骨架**（默认生成到 `example/`，直接就是热重载状态）

```bash
pnpm jiuli create my-plugin          # 类形态 → plugins/example/my-plugin.js
pnpm jiuli create my-plugin --dsl    # 函数式 DSL 形态
pnpm jiuli create my-plugin --dir    # 想要独立目录（plugins/my-plugin/index.js + resources/）
```

也可以手动在 `example/` 里新建一个 `.js`，内核会自动加载。

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
- 发图片：`await e.reply(await this.render('我的模板/index', { title: '标题' }))`
  （模板放 `example/resources/我的模板/index.html`；若是独立目录插件则放 `插件目录/resources/...`）
- 定时任务：`task: [{ name: '每日', cron: '0 8 * * *', fnc: 'daily' }]`
- 会话（等用户下一条消息）：`this.setContext('waiting')` → 再写一个 `waiting()` 方法接收
- 数据存储：`this.dataDir`（插件私有目录）、`redis`（全局）、`Bot.getMap('data/xxx')`
- 排查问题：`#诊断`（适配器/在线账号/最近收发）、日志里的 `[  Plugin ]` / `[   Msg   ]` 行

**完整说明**：见 [`docs/plugin-guide.md`](../docs/plugin-guide.md)。
