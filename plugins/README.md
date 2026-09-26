# plugins/ 目录说明

这里是插件目录。内核只扫描本目录下的**一级子目录**（一个子目录 = 一个插件来源），
子目录里的 `node_modules`、`resources`、`apps` 不会被当成独立插件。

## 各目录是谁的

| 目录 | 归属 | 内容 | 能否删 |
|---|---|---|---|
| `example/` | **你的** | 自己写的插件，一个 `.js` 一个功能，增删改即时热重载 | 随意 |
| `system/` | 框架 | 内置功能：状态 / 帮助 / 设置主人（新增·删除主人）/ 词条 / 诊断 / 重载 / 重启 / 更新 / 日志 / 版本 / 云崽 ck 文件兼容（`data/MysCookie`） … | 不要整删 |
| `adapter/` | 框架 | `stdin.js` 终端交互、`mock.js` 调试 | 不要删 |
| `demo/` | 框架 | 三种写法的示例 + 渲染自检（`#渲染测试`） | 可删 |
| `<第三方>/` | 别人 | clone 来的插件，**不入 git**，依赖由 `pnpm install` 装 | 随意 |

第三方插件必须放在 `plugins/` **里面**：放在项目根目录既扫不到，pnpm 也不会装它的依赖。
推荐用 `pnpm jiuli add <git地址>` 安装（克隆 + 自动装依赖），装好后约 2 秒自动加载。

自己的代码只放 `example/`，升级时不会被覆盖，也不会和框架文件混在一起。

## 加载规则

1. 目录里有 `index.js` → **只加载它**（适合把功能拆到 `apps/`、`model/`）
2. 没有 `index.js` → 加载该目录下所有 `.js`（`example/`、`system/`、`adapter/` 都是这种）
3. 热重载（`bot.yaml → file_watch: true`）：新增 / 修改 / 删除 js（含 `index.js` 与深层 `apps/`）自动生效；
   模板与图片改动由渲染层自动失效缓存，无需重载
4. 手动重载：`#重载`（补漏）或 `#重载 关键词`（强制刷新）

## 写自己的插件

```bash
pnpm jiuli create my-plugin          # plugins/example/my-plugin.js（类形态）
pnpm jiuli create my-plugin --dsl    # 函数式 DSL
pnpm jiuli create my-plugin --dir    # 独立目录（含 resources/ 与 package.json）
```

最小可用插件：

```js
import { JiuLiPlugin } from 'jiuli'

export default class MyPlugin extends JiuLiPlugin {
  constructor() {
    super({
      name: '我的插件',                    // #插件列表、群配置 enable/disable 用这个名字
      dsc: '演示',
      event: 'message',                   // 通知类事件写 notice.group.poke
      priority: 5000,                     // 数字越小越先执行
      rule: [
        { reg: '^#你好$', fnc: 'hello' },
        { reg: /^#戳我\s+(.+)$/, fnc: 'poke' },
      ],
    })
  }

  async hello(e) {
    await e.reply('你好呀')
    return true          // 返回 false 表示继续匹配后面的规则
  }

  async poke(e, match) {
    await e.reply(`你说了：${match?.[1]}`)
  }
}
```

常用能力速查：

- 发消息：`e.reply('文本')` / `e.reply('带引用', true)` / `e.reply([segment.at(e.user_id), '\n你好'])`
- 发图片：`await e.reply(await this.render('我的模板/index', { title: '标题' }))`
  （模板放 `<插件目录>/resources/我的模板/index.html`）
- 定时任务：`task: [{ name: '每日', cron: '0 8 * * *', fnc: 'daily' }]`
- 会话（等用户回复）：`this.setContext('waiting')` + 写一个 `waiting()` 方法
- 存储：`this.dataDir`（插件私有目录）、全局 `redis`、`Bot.getMap('data/xxx')`
- 排查：`#诊断`，日志里的 `[  Plugin ]` 与 `[   Msg   ]` 行

完整说明见 [docs/plugin-guide.md](../docs/plugin-guide.md)。
