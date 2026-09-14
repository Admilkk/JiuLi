# plugins/ 目录说明

这里放**机器人插件**。内核只会扫描本目录下的**一级子目录**（每个子目录就是一个插件），
子目录内部的 `node_modules`、`resources`、`model` 等不会被当成插件。

## 这个目录里现在有什么

| 目录 | 是什么 | 能删吗 |
|---|---|---|
| `system/` | **内置基础功能**：`#帮助` `#状态` `#版本` `#设置主人` `#撤回` `#添加/#删除`（词条）等。一个 `.js` = 一个功能，不是"一个大插件" | 不要删，删了这些指令就没了 |
| `other/` | **内置管理功能**：`#重启` `#关机` `#开机` `#停止` `#日志` `#更新` | 不要删 |
| `adapter/` | **内置适配器**：`stdin.js` = 终端交互（启动后可直接在终端输入指令） | 不要删 |
| `dev-adapter-mock/` | **开发调试适配器**：不接协议端，只在日志里打印机器人发出的消息；测试脚本用它注入事件 | 可以删（删除后 `pnpm test` 会失败） |
| `example-class/` | **示例：类形态插件**（改个名字就能当自己的插件写） | 可以删 |
| `example-dsl/` | **示例：函数式 DSL 插件** | 可以删 |
| `<第三方插件>/` | 从网上 clone / 下载的插件，例如 `Yunzai-QQBot-Plugin`、`miao-plugin`。**不入 git**，依赖由 `pnpm install` 自动装 | 随意 |
| `_test-fixtures/` | 冒烟测试的临时夹具（`pnpm test` 自动生成、跑完自动删除） | 不用管，测试结束自己消失 |

> 为什么要区分：**随框架入库的只有 `system/`、`other/`、`adapter/`、`dev-adapter-mock/`、`example-*`**；
> 其他插件目录都被 `.gitignore` 忽略——这样你 clone 别人的插件进来不会被误提交，插件里的账号配置也不会上传。

## 加载规则（与云崽一致）

1. 目录里有 `index.js` → **只加载它**（推荐，方便拆分 `apps/`、`model/`）。
2. 目录里没有 `index.js` → 扫描该目录下**所有 `.js`**，每个文件里的类/描述对象都会注册（内置 `system/`、`other/` 就是这种）。
3. 热重载：只对第 2 种（平铺 js）生效，改完保存即自动重载；有 `index.js` 的目录改完需要重启。

## 怎么写自己的插件（三步）

**第 1 步：生成骨架**

```bash
pnpm jiuli create my-plugin          # 类形态模板
pnpm jiuli create my-plugin --dsl    # 函数式 DSL 模板
```

会生成 `plugins/my-plugin/index.js`（带注释），改完保存后重启（或让它作为平铺文件被热重载）。

**第 2 步：改内容**

最小可用插件长这样（类形态）：

```js
import { JiuLiPlugin } from 'jiuli'

export default class MyPlugin extends JiuLiPlugin {
  constructor() {
    super({
      name: '我的插件',
      dsc: '演示',
      event: 'message',                      // 监听消息；通知类事件写 notice.group.poke 等
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
- 发图片：`const img = await this.render('hello/index', { title: '标题' })`（模板放 `resources/hello/index.html`）
- 定时任务：`task: [{ name: '每日', cron: '0 8 * * *', fnc: 'daily' }]`
- 会话（等用户下一条消息）：`this.setContext('waiting')` → 再写一个 `waiting()` 方法接收
- 数据存储：`this.dataDir`（插件私有目录）、`redis`（全局）、`Bot.getMap('data/xxx')`

**完整说明**：见 [`docs/plugin-guide.md`](../docs/plugin-guide.md)（事件对象字段、权限、上下文、渲染、适配器等）。

## 插件命名建议

- 目录名用英文小写加连字符：`weather-plugin`、`my-bot-tools`。
- 如果插件要发布给别人，目录名加 `-plugin` 后缀、`package.json` 里补上依赖即可（例子见 `Yunzai-QQBot-Plugin/package.json`）。
