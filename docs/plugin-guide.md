# JiuLi 插件开发

三种形态共用同一套内核与分发流程：

| 形态 | 写法 | 场景 |
|---|---|---|
| 云崽插件 | `export class X extends plugin` | 从 TRSS-Yunzai 迁移，零改动 |
| JiuLi 类形态 | `import { JiuLiPlugin } from 'jiuli'` | 新插件，想要类型提示与渲染 / 数据目录辅助 |
| JiuLi DSL | `definePlugin({ apps: [command(...)] })` | 函数式，不用 `this` |

```bash
node jiuli c my-plugin          # 生成插件骨架（--dsl 函数式 / --dir 独立目录）
```

## 目录与加载规则

```
plugins/my-plugin/
├─ package.json     有依赖时才需要（记得 "jiuli": "link:../.."）
├─ index.js         入口
├─ apps/            拆分的命令文件
├─ model/           业务逻辑
├─ resources/       渲染模板与静态资源
└─ defSet/          默认配置
```

- 只扫描 `plugins/` 下的**目录**（根下的散文件不加载）
- 目录里有 `index.js` → 只加载它；没有 → 加载该目录下所有 `.js`（不递归）
- 一个文件可以导出多个插件类，都会被注册

## 云崽风格

```js
export class Demo extends plugin {
  constructor() {
    super({
      name: '演示', dsc: '描述', event: 'message', priority: 5000,
      rule: [
        { reg: '^#演示$', fnc: 'demo' },
        { reg: '^#管理$', fnc: 'admin', permission: 'master' },
        { reg: '^#静默$', fnc: 'quiet', log: false },
      ],
      task: [{ name: '每日', cron: '0 8 * * *', fnc: 'daily' }],
    })
  }

  async demo(e) { return e.reply('你好') }

  async init() { /* 加载时一次；返回 "return" 跳过整个插件 */ }

  async accept(e) { /* 每条事件都跑，在 rule 之前 */ }

  async daily() { /* 定时任务里没有 this.e */ }
}
```

`rule` 字段：`reg`（字符串/正则，预编译）、`fnc`、`event`（三段通配）、`permission`（master/owner/admin）、`log`。

上下文会话：

```js
async start() { this.setContext('waiting'); return this.reply('请发送内容') }
async waiting() { this.finish('waiting'); return this.reply(`收到：${this.e.msg}`) }
// Promise 形式：const next = await this.awaitContext()   // 超时返回 false
```

会话按「插件名 + bot + 群/用户」隔离，默认 120 秒超时。

## JiuLi 原生

```js
import { JiuLiPlugin } from 'jiuli'

export default class Demo extends JiuLiPlugin {
  constructor() {
    super({ name: '演示', priority: 100, rule: [{ reg: '^#渲染$', fnc: 'render' }] })
  }
  async render() {
    const img = await this.render('hello/index', { title: '你好' })   // 失败返回 false
    return this.reply(img || '渲染失败')
  }
}
```

DSL 形态：

```js
import { definePlugin, command, task, accept, handler } from 'jiuli'

export default definePlugin({
  name: '演示',
  apps: [
    command(/^#演示$/, async (e, match) => e.reply('你好'), { name: '演示' }),
    command(/^#管理$/, async e => e.reply('ok'), { permission: 'master' }),
    task('0 8 * * *', () => logger.mark('早安')),
    accept('notice.group.poke', async e => e.reply('别戳了')),
    handler('demo.hello', (e, args) => `hello ${args}`),
  ],
})
```

分发钩子（旧体系没有）：

```js
beforeMessage(async e => {
  if (e.msg === '#禁止') return false      // 返回 false 拦截本次分发
})
afterMessage(e => logger.mark(`[审计] ${e.user_id}: ${e.msg}`))
```

类形态需显式声明方法名：`super({ hooks: { beforeMessage: 'onBefore', afterMessage: 'onAfter' } })`。
钩子不会因为插件里恰好有同名方法就被调用。

生命周期与配置：

```js
async onLoad() { this.timer = setInterval(() => {}, 60_000) }
async onUnload() { clearInterval(this.timer) }        // 卸载 / 热重载前清理
async init() {
  const { config, configSave } = await this.useConfig({ enable: true })
  await configSave()                                   // → config/<插件名>.yaml
}
```

实例属性：`this.e`、`this.dataDir`（`data/plugins/<插件名>/`）、`this.resDir`、
`this.render` / `this.renderBase64`、`this.reply`。

## 事件对象 `e`

`msg` / `raw_message` / `message` / `img` / `at` / `atBot` / `user_id` / `group_id` / `self_id` /
`isGroup` / `isPrivate` / `isMaster` / `sender` / `e.group` / `e.friend` / `e.member` / `e.runtime`，
方法 `reply` / `getReply` / `recall` / `logText`。

```js
await e.reply('纯文本')
await e.reply('带引用', true)
await e.reply([segment.at(e.user_id), '\n你好'])
await e.reply('10 秒后撤回', true, { recallMsg: 10 })
await e.group.sendMsg('主动发群消息')
await Bot.sendGroupMsg(bot_id, group_id, '指定机器人发送')
```

## 事件总线（Bot.on）

`Bot` 是 EventEmitter，`on` / `once` / `emit` / `off` / `listenerCount` / `eventNames` 等全部可用：

```js
Bot.on('message', e => logger.debug(`${e.group_id ?? e.user_id}: ${e.raw_message}`))
Bot.on('notice.group.poke', e => { /* ... */ })
Bot.on('connect.' + Bot.uin[0], ({ bot }) => logger.mark(`账号 ${bot.uin} 已连接`))
```

- `Bot.on('message')` 收到的是**原始事件**，不经过 accept / rule，也没有权限与冷却
- `Bot.em(name, data)` 逐级 emit（`message.group.normal` → `message.group` → `message`），
  且仅在 `data.self_id` 是已注册账号时才补全 `bot` / `friend` / `group` / `member`
- 监听器按注册顺序触发；插件先于 `lib/events/*` 加载，所以插件顶层注册的监听器先收到事件
- 需要权限与指令匹配的用 `rule` / `accept`，不要在 `Bot.on` 里自己解析文本

## 渲染

模板放 `plugins/<插件>/resources/<路径>.html`（art-template）：

```js
const img = await this.render('help/index', { title: '标题' })      // 可直接回复
const b64 = await this.renderBase64('help/index', data)             // base64:// 字符串
await e.runtime.render('插件目录名', 'help/index', data)             // 直接发送
```

长图分页与旧写法：

```js
import puppeteer from '../../lib/puppeteer/puppeteer.js'

const imgs = await puppeteer.screenshots('插件名/long/index', {
  tplFile: './plugins/插件名/resources/long/index.html',
  saveId: 'index',
  pluResPath: '../../../plugins/插件名/resources/',
  pageHeight: 4000, ...data,
})
for (const img of imgs) await e.reply(img)
```

模板里可用 `pluResPath` / `_res_path`（资源目录）。后端配置在 `renderers/puppeteer/config.yaml`
（`chromiumPath`、`headless`、`restartNum`、`idleTime`），浏览器懒启动、空闲自动关闭。
示例见 `plugins/demo/render-demo.js`。

## 配置与数据

```js
import makeConfig from '../../lib/plugins/config.js'          // 云崽写法
const { config, configSave } = await makeConfig('demo', { enable: true })
config.enable = false
await configSave()                                            // → config/demo.yaml
```

插件私有数据用 `this.dataDir`（`data/plugins/demo/`），或 `Bot.getMap('data/demo')`。

## 跨插件调用

```js
handler('a.hello', (e, args) => `hello ${args}`)               // 注册
const ret = await e.runtime.handler.call('a.hello', e, '参数')  // 调用
e.runtime.handler.has('a.hello')                               // 是否存在
```

类形态用 `super({ namespace: 'a', handler: [{ key: 'a.hello', fnc: 'hello' }] })`。
`reject()` 机制与云崽一致。

## 适配器

```js
Bot.adapter.push({
  id: 'QQ', name: 'MyAdapter', path: 'MyAdapter',   // path 唯一，用于去重
  async load() {
    Bot[uin] = { adapter: this, uin, fl: new Map(), gl: new Map(), gml: new Map(),
                 pickFriend: id => c, pickGroup: id => c, pickMember: (g, u) => c }
    Bot.uin.push(uin)
    Bot.em(`connect.${uin}`, { self_id: uin, bot: Bot[uin] })
  },
})
```

`Bot.em` 逐级派发（`message.group.normal` → `message.group` → `message`）并补全事件字段。
参考 `plugins/adapter/mock.js`。

## 调试

- `node .` 前台运行，终端直接敲指令；`plugins/adapter/mock.js` 打印机器人发出的消息
- `JIULI_MOCK_STDIN=1 node .` 后，stdin 每行一个 JSON 事件
- 日志等级：`config/config/bot.yaml → log_level: debug`
- `#玖璃性能`（示例插件提供）或 `import { metrics } from 'jiuli'` 看耗时排行
- 改文件等 2 秒自动热重载；没生效看 `file_watch` 是否为 false，或 `#重载`
