# JiuLi 插件开发指南

JiuLi 支持三种插件形态，共用同一套内核与分发机制：

| 形态 | 写法 | 适用 |
|---|---|---|
| 旧插件（云崽） | `export class X extends plugin { ... rule/task ... }` | 直接从 TRSS-Yunzai 迁移，零改动 |
| JiuLi 类形态 | `import { JiuLiPlugin } from 'jiuli'` | 需要类型提示与渲染/数据目录辅助 |
| JiuLi DSL | `definePlugin({ apps: [command(...), task(...)] })` | 偏爱函数式、无 `this` 的写法 |

---

## 一、目录结构

```
plugins/jiuli-plugin-demo/
├─ package.json         # 可选；有依赖时提供（pnpm workspace 会自动安装）
├─ index.js             # 入口（存在时只加载此文件）
├─ apps/                # 拆分的命令文件（被 index.js import）
├─ model/               # 业务逻辑（可选）
├─ resources/           # 渲染模板与静态资源
│   └─ help/index.html
└─ defSet/              # 默认配置（可选，与云崽生态一致）
```

没有 `index.js` 时，内核会扫描目录下所有 `.js`（与云崽一致，支持热重载）。

---

## 二、类形态

```js
import { JiuLiPlugin } from 'jiuli'

export default class Demo extends JiuLiPlugin {
  constructor() {
    super({
      name: '演示',
      dsc: 'JiuLi 类形态示例',
      event: 'message',        // 默认 message；通知类事件如 notice.group.poke
      priority: 100,           // 数字越小越先执行，默认 5000
      rule: [
        { reg: '^#演示$', fnc: 'demo' },
        { reg: /^#演示\s+(.+)$/, fnc: 'demoArgs' },
        { reg: '^#管理$', fnc: 'admin', permission: 'master' },
        { reg: '^#静默$', fnc: 'quiet', log: false },
      ],
      task: [{ name: '每日任务', cron: '0 8 * * *', fnc: 'daily' }],
    })
  }

  /** @param {import('jiuli').JiuLiEvent} e */
  async demo(e) {
    await e.reply('你好')
    return true               // 返回 false 表示继续匹配后续规则
  }

  async demoArgs(e) {
    const match = /^#演示\s+(.+)$/.exec(e.msg)
    await e.reply(`参数：${match?.[1]}`)   // 或使用 handler 的第二个参数
  }

  async admin(e) {
    await e.reply('管理员指令')
  }

  async quiet(e) {
    await e.reply('静默执行（不打印开始/完成日志）')
  }

  /** 定时任务中 this.e 为空，不要调用 this.reply */
  async daily() {
    logger.mark('[演示] 每日任务执行')
  }
}
```

### 生命周期钩子

```js
async init() {
  // 加载插件时执行一次；返回 "return" 可跳过整个插件的加载
}

async accept(e) {
  // 每条事件都会调用（在 rule 之前）
  // 返回 "return" 终止分发；返回真值跳出 accept 循环（继续 rule 匹配）
}
```

### 上下文会话

```js
async start() {
  this.setContext('waiting')            // 等待用户下一条消息
  return this.reply('请发送内容')
}

async waiting() {
  this.finish('waiting')                // 结束上下文
  return this.reply(`收到：${this.e.msg}`)
}

// 也可用 Promise 形式：
async ask() {
  const next = await this.awaitContext()
  if (next) await this.reply(`收到：${next.msg}`)
}
```

上下文按 `插件名 + bot + 群/用户` 隔离，默认 120 秒超时（`setContext(type, isGroup, time, timeout)`）。

---

## 三、函数式 DSL

```js
import { definePlugin, command, task, accept, handler } from 'jiuli'

export default definePlugin({
  name: '演示',
  priority: 100,
  apps: [
    // 命令：正则 → 处理函数（第二个参数是正则匹配结果）
    command(/^#演示$/, async e => e.reply('你好'), { name: '演示' }),
    command(/^#管理$/, async e => e.reply('ok'), { permission: 'master' }),
    command(/^#群限定$/, async e => e.reply('群消息'), { event: 'message.group' }),

    // 定时任务
    task('0 8 * * *', () => logger.mark('[演示] 早安'), { name: '早安' }),

    // 通知 / 请求事件
    accept('notice.group.poke', async e => e.reply('别戳了')),

    // 跨插件 handler（其他插件可用 e.runtime.handler.call('demo.hello', e, args) 调用）
    handler('demo.hello', (e, args) => `hello ${args ?? ''}`),
  ],
})
```

> `task` 中的函数没有 `this.e`；需要发消息请用 `Bot.sendGroupMsg / Bot.sendFriendMsg`。

---

## 四、事件对象 `e`

字段名与云崽完全一致（便于迁移），常用：

| 字段 | 说明 |
|---|---|
| `e.msg` | 文本消息（多段自动拼接，已做 `#`/`*` 归一化） |
| `e.raw_message` | 原始消息文本 |
| `e.message` | 消息段数组 |
| `e.img` | 图片 URL 数组 |
| `e.at` / `e.atBot` | 被 at 的用户 / 是否 at 机器人 |
| `e.user_id` / `e.group_id` / `e.self_id` | 用户 / 群 / 机器人账号 |
| `e.isGroup` / `e.isPrivate` / `e.isMaster` | 场景与权限 |
| `e.sender` | `{ user_id, nickname, card, role }` |
| `e.group` / `e.friend` / `e.member` | 群/好友/成员对象（`sendMsg`、`pickMember`、`makeForwardMsg`、`recallMsg`…） |
| `e.reply(msg, quote?, { recallMsg?, at? })` | 回复；返回 `{ message_id }` |
| `e.getReply()` | 获取引用消息 |
| `e.recall()` | 撤回本条消息 |
| `e.runtime` | 运行时（`render`、`handler`、`cfg`、`common`） |

发送消息的常见写法：

```js
await e.reply('纯文本')
await e.reply('带引用', true)
await e.reply([segment.at(e.user_id), '\n你好'])
await e.reply('5 秒后撤回', true, { recallMsg: 5 })
await e.reply('并 at 对方', false, { at: true })
await e.group.sendMsg('主动发群消息')
await Bot.sendGroupMsg(bot_id, group_id, '指定机器人发送')
```

---

## 五、渲染图片

### 1. 模板

`plugins/<插件名>/resources/<路径>.html`，语法为 art-template：

```html
<div id="container">
  <h1>{{ title }}</h1>
  <img src="{{ pluResPath }}img/logo.png" />
</div>
```

### 2. 调用

类形态（`JiuLiPlugin`）：

```js
const img = await this.render('help/index', { title: '标题' })   // 返回 base64:// 或 false
await this.reply(img || '渲染失败')
```

DSL / 通用：

```js
// 自动发送（返回 true / msgId）
await e.runtime.render('插件目录名', 'help/index', { title: '标题' })

// 只要 base64
const base64 = await e.runtime.render('插件目录名', 'help/index', data, { retType: 'base64' })
```

旧写法（兼容）：

```js
import puppeteer from '../../lib/puppeteer/puppeteer.js'
const img = await puppeteer.screenshot('插件目录名/help/index', {
  tplFile: './plugins/插件目录名/resources/help/index.html',
  saveId: 'index',
  pluResPath: './plugins/插件目录名/resources/',
  ...data,
})
await e.reply(img)
```

### 3. 渲染后端

内置 puppeteer（使用本机 Chrome/Edge）。配置 `renderers/puppeteer/config.yaml`：
`chromiumPath`、`headless`、`restartNum`（截图 N 次重启浏览器）、`idleTime`（空闲分钟数后关闭浏览器）。

自定义后端：新建 `renderers/<id>/index.js`：

```js
export default function (config) {
  return {
    id: 'my-renderer',
    type: 'image',
    support_script: true,
    async render(name, data) {
      // 返回 Buffer / Buffer[] / base64 字符串；返回 false 交给下一个后端
    },
  }
}
```

---

## 六、配置与数据

### 插件配置（`makeConfig`，与云崽一致）

```js
import makeConfig from '../../lib/plugins/config.js'   // 旧路径
// 或：import { makeConfig } from 'jiuli'  （后续提供）

const { config, configSave } = await makeConfig('demo', { enable: true, tips: '你好' }, {}, { watch: true })
config.tips = '新值'
await configSave()
```

配置文件落在 `config/demo.yaml`。

### 插件私有数据（JiuLi 新增）

```js
import { JiuLiPlugin } from 'jiuli'
export default class Demo extends JiuLiPlugin {
  async save() {
    fs.writeFileSync(`${this.dataDir}/state.json`, '{}')   // data/plugins/demo/state.json
  }
}
```

或使用与云崽一致的 Map 持久化：`Bot.getMap('data/demo')`。

---

## 七、跨插件调用

```js
// 注册（类形态）
super({ name: 'A', handler: [{ key: 'a.hello', fnc: 'hello' }], namespace: 'a' })
async hello(e, args) { return `hello ${args}` }

// 注册（DSL）
handler('a.hello', (e, args) => `hello ${args}`)

// 调用（任意插件）
const ret = await e.runtime.handler.call('a.hello', e, '参数')
const exists = e.runtime.handler.has('a.hello')
```

handler 的 `reject()` 机制与云崽一致（`fn(e, args, reject)`，调用 reject 表示放弃结果）。

---

## 八、适配器插件

```js
Bot.adapter.push({
  id: 'QQ',                 // 平台
  name: 'MyAdapter',        // 适配器名
  path: 'MyAdapter',        // 唯一路径（去重）
  async load() {
    // 建立连接，然后注册机器人对象
    const bot = {
      adapter: this,
      uin, nickname, version,
      fl: new Map(), gl: new Map(), gml: new Map(),
      stat: { start_time: Date.now() / 1000 },
      pickFriend: id => contact,
      pickGroup: id => contact,
      pickMember: (g, u) => contact,
    }
    Bot[uin] = bot
    Bot.uin.push(uin)
    Bot.em(`connect.${uin}`, { self_id: uin, bot })

    // 收到事件时（OneBot11 示例）
    Bot.em('message.group.normal', {
      post_type: 'message', message_type: 'group', sub_type: 'normal',
      self_id, user_id, group_id, message_id, raw_message,
      message: [{ type: 'text', text: '#帮助' }],
      sender: { user_id, nickname, card },
    })
  },
})
```

`contact` 需提供 `sendMsg(msg)`、`recallMsg(id)`、`makeForwardMsg(msg)`、`getInfo()` 等。
`Bot.em` 会逐级 emit（`message.group.normal` → `message.group` → `message`），并自动补全事件字段。

调试用适配器见 `plugins/jiuli-adapter-mock/`。

---

## 九、调试与测试

- `node .` 直接启动；`plugins/jiuli-adapter-mock` 会打印机器人发出的消息
- `JIULI_MOCK_STDIN=1 node .` 后，stdin 每行一个 JSON 事件即可模拟收发
- 日志等级：`config/config/bot.yaml → log_level: debug`
- 性能指标：`#玖璃性能`（示例插件提供）或 `import { metrics } from 'jiuli'; metrics.summary()`
- 慢插件告警阈值：`config/jiuli.yaml → perf.slow_plugin_ms`

## 十、常见问题

**Q：插件加载报 `Cannot find package 'xxx'`？**
在插件目录执行 `pnpm add xxx`（或根目录 `pnpm i`）；JiuLi 会汇总缺失依赖并打印提示。

**Q：`this.e` 是 undefined？**
定时任务（`task.fnc`）与 `init()` 中没有事件对象，请不要在其中调用 `this.reply`。

**Q：修改插件没生效？**
只有平铺 `.js`（无 `index.js` 的目录）支持热重载，与云崽一致；有 `index.js` 时请重启。

**Q：`#状态` 等云崽内置指令没有？**
云崽的 `plugins/system`、`plugins/other` 是插件而非内核功能，把对应目录复制过来即可。
