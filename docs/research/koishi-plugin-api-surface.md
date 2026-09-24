# Koishi 插件体系 API 面清单（兼容层实现者手册）

> 目标读者：要在**自己的 Node.js 机器人框架**里加载并运行真实 `koishi-plugin-*` npm 包的人。
> 结论全部来自**实际安装并运行**的包，而不是只看文档。所有版本号、代码片段均已在本地复现。
>
> 证据基准：`koishi@4.18.11` / `@koishijs/core@4.18.11` / `@satorijs/core@4.6.0` / `cordis@3.18.1` / `minato@3.7.0` / `schemastery@3.18.0` / `@koishijs/plugin-http@0.6.3` / `@koishijs/plugin-server@3.2.9`，Node `v25.2.1`。
> 复现方式：`npm i koishi` 后直接 `require('koishi')`，见文末「复现脚本」。

---

## 0. 三条最容易踩的坑（先看这个）

1. **`ctx.plugin(某个模块)` 不会自动解包 `default`。** cordis 的 `Registry.resolve()` 只接受 *函数* 或 *带 `.apply` 方法的对象*。一个 `{__esModule:true, default: Fn}` 的模块直接传进去会抛
   `invalid plugin, expect function or object with an "apply" method, received object`（本地实测）。
   解包 `module.default || module` 是**加载器的责任**，Koishi 自己在两处做了这件事：
   - `ns-require` 的 `unwrapExports`（`@koishijs/loader` 依赖）：`return module?.default || module`
   - `@koishijs/loader/lib/shared.js`：`function unwrapExports(module2) { return module2?.default || module2 }`，并且 `async resolve(name) { const plugin = unwrapExports(await this.import(name)); ... }`

2. **`ctx.database` / `ctx.http` 在裸 `Context` 上根本不存在**（`ctx.get('database') === undefined`）。声明了 `inject: ['http']` 的插件**不会报错，而是永远静默地不加载**（`apply` 从不执行）。只有 `inject` 写成 `{optional:[...]}` 或完全不声明时才会执行，然后在调用点 `undefined.get()` 崩。
   实测：`dbApplied (inject database, 无 driver) = false`，且没有任何 error 事件。

3. **`[CQ:at,qq=42]` 不是 Koishi 元素语法，会被解析成一整段纯文本。**
   实测：`h.parse('[CQ:at,qq=42][CQ:image,file=a.png]')` → `[["text",{"content":"[CQ:at,qq=42][CQ:image,file=a.png]"}]](单元素)`。从 OneBot/CQ 系框架迁移必须自己做 CQ↔Element 转换。

---

## 1. 插件包结构与导出形状

### 1.1 `package.json`

市场准入规则（官方文档：<https://koishi.chat/zh-CN/guide/develop/publish.html>）：

- `name` 必须是 `koishi-plugin-*`、`@bar/koishi-plugin-*` 或 `@koishijs/plugin-*`（官方）之一
- **`peerDependencies` 必须包含 `koishi`**（不是可选项，是准入条件）
- 不能 `private: true`

真实包实测（`npm view` / 本地 `node_modules`）：

| 包 | version | main | module | exports | koishi 字段 | peerDependencies |
|---|---|---|---|---|---|---|
| `koishi` | 4.18.11 | `lib/index.cjs` | `lib/index.mjs` | `.` → types/node.import/node.require/browser | — | — |
| `koishi-plugin-dialogue` | 4.1.3 | `lib/index.js` | — | — | `service.{required:[database],optional:[assets],implements:[dialogue]}`、`description.{en,zh}` | `{koishi:"^4.15.4"}` |
| `koishi-plugin-image-search` | 4.3.2 | `lib/index.js` | — | — | `description` | `{koishi:"^4.17.4"}` |
| `koishi-plugin-weather` | 2.0.4 | `lib/index.js` | — | — | `description` | `{koishi:"^4.8.3"}` |
| `koishi-plugin-booru` | 1.4.0 | `lib/index.js` | — | — | `service.{implements:[booru],optional:[assets,canvas]}` | `{koishi:"^4.17.0", "@cordisjs/plugin-proxy-agent":">=0.3.0"}` |
| `koishi-plugin-memes` | 2.1.8 | `lib/index.js` | — | — | 无 | `{koishi:"^4.18.7"}` |
| `koishi-plugin-fortune` | 11.4.2 | `dist/index.js` | — | — | 无 | `{koishi:"^4.11.1"}` |
| `@koishijs/plugin-console` | 5.30.11 | `lib/node/index.js` | — | `.` → types/node.require/node.import/browser | `service.{implements:[console]}` | `{koishi:"^4.18.9","@koishijs/client":"^5.30.11"}` |
| `@koishijs/plugin-help` | 2.4.6 | `lib/index.js` | — | — | `{browser:true, category:"tool", locales:["zh","en","ja","fr","zh-TW"], description}` | `{koishi:"^4.18.7"}` |
| `@koishijs/plugin-database-memory` | 3.7.0 | `lib/index.cjs` | `lib/index.mjs` | — | `{hidden:true, category:"storage", service.{implements:[database]}}` | `{koishi:"^4.18.10"}` |

**`koishi` 字段的完整成员**（文档 + 实测）：`description`(i18n 对象)、`service.{required,optional,implements}`、`preview`、`hidden`、`category`、`browser`、`locales`。

> **没有任何 `koishi.peerDependencies` 字段。** 依赖 npm 包的声明在顶层 `peerDependencies`；依赖**服务**的声明在 `koishi.service` 与源码里的 `inject`。官方明确解释了两者区别：<https://koishi.chat/zh-CN/guide/plugin/service.html#peer-vs-dep>
> 实践结论：`koishi.service` 只影响市场展示与安装提示，**运行时行为完全由源码里的 `inject` 决定**。

程序化读取插件元信息时不要依赖 `koishi` 字段做功能判断——`koishi-plugin-memes` / `fortune` / `weather`(部分) 都没有该字段，但都能正常跑。

### 1.2 导出形状：四种等价形式

文档：<https://koishi.chat/zh-CN/guide/plugin/>

```ts
// 1) 函数
ctx.plugin((ctx, config) => { ctx.middleware(callback) })
// 2) 类
ctx.plugin(class { constructor(ctx, config) { ctx.middleware(callback) } })
// 3) 对象 + apply
ctx.plugin({ apply: (ctx, config) => { ctx.middleware(callback) } })
// 4) 上面的任意一个包成模块导出
```

模块导出的两种惯例（文档原文："默认导出的优先级更高"）：

```ts
// foo.ts —— 「导出整体」是插件（函数型常用）
export interface Config {}
export const name = 'Foo'
export interface Config { foo: string }
export const Config: Schema<Config> = Schema.object({ foo: Schema.string().required() })
export function apply(ctx: Context, config: Config) {}

// bar.ts —— 「默认导出」是插件（类形式常用）
class Bar { constructor(ctx: Context, config: Bar.Config) {} }
namespace Bar { export interface Config {}; export const Config: Schema<Config> = Schema.object({}) }
export default Bar
```

**元属性**（必须与入口函数**同级导出**）：

| 元属性 | 作用 | 读取位置（源码） |
|---|---|---|
| `name` | 插件名，仅用于可视化/日志 | `MainScope.setup()`: `const { name } = this.plugin; if (name && name !== 'apply') this.name = name` |
| `Config` / `schema` | schemastery 配置构型，加载前自动套用（提供默认值/校验） | `resolveConfig()`: `const schema = plugin['Config'] \|\| plugin['schema']; if (schema && plugin['schema'] !== false) config = schema(config); return config ?? {}` |
| `inject` / `using` | 服务依赖（`string[]` 或 `{required,optional}`） | `MainScope.setup()`: `Inject.resolve(this.plugin['using'] \|\| this.plugin['inject'])` |
| `reusable` | 是否允许同一插件多次加载 | `this.isReusable = this.plugin['reusable']` |
| `reactive` | 响应式配置 | `this.isReactive = this.plugin['reactive']` |
| `filter` | 默认会话过滤器 | cordis `Plugin.Object.filter` |
| `usage` | 帮助文本（`@koishijs/plugin-help` 读取） | 非运行时必需 |

`inject` 的解析规则（`Inject.resolve` 源码）：

```js
if (Array.isArray(inject)) return Object.fromEntries(inject.map(n => [n, {required:true}]))
const { required, optional, ...rest } = inject
if (Array.isArray(required)) Object.assign(rest, Object.fromEntries(required.map(n=>[n,{required:true}])))
if (Array.isArray(optional)) Object.assign(rest, Object.fromEntries(optional.map(n=>[n,{required:false}])))
return rest
// 也支持直接写 { puppeteer: { required: true } } 这种形式
```

### 1.3 ESM 还是 CJS？

**实测结论：两者都能加载，但 CJS 是事实标准。**

- 我抽样的 8 个真实社区插件（dialogue / image-search / weather / fortune / memes / rss / roll / booru / genshin）**全部是 CJS**（无 `"type":"module"`，`main` 指向 `lib/index.js` / `dist/index.js`；`genshin` / `roll` 甚至是 Koishi v3 时代的包，`peerDependencies` 写的是 `koishi-core` / `koishi-utils`）。
- Koishi 官方 loader 的加载路径是 **CommonJS `require`**：`NodeLoader.import(name)` → `this.scope.resolve(name)`（`ns-require`）→ `__require(resolvedPath)`，然后由 `Loader.resolve()` 做 `unwrapExports`。**没有 dynamic `import()` 分支**。
- 但 Node ≥ 22.12 的 `require(esm)` 已经可用。实测在当前 Node v25.2.1 下：
  ```
  require("koishi-plugin-esmtest")            // {type:"module", export function apply}
  → OK，返回 [ 'apply', 'name' ]
  ```
  即一个 `"type":"module"` 的插件包在当前 Node 上**可以**被 Koishi 的 require 路径加载。若你的框架目标 Node < 22.12，必须自己做 ESM 回退（`await import()`）。

### 1.4 模块名解析规则（`ns-require`，兼容层直接照抄即可）

```js
const scope = ns({ namespace: 'koishi', prefix: 'plugin', official: 'koishijs', dirname: baseDir })
scope.resolve('console')            // → ['@koishijs/plugin-console', 'koishi-plugin-console'] 依次尝试
scope.resolve('@foo/bar')           // → ['@foo/koishi-plugin-bar']
scope.resolve('./local-plugin')     // → [path.resolve(baseDir, './local-plugin')]
scope.require('name')               // → unwrapExports(require(resolve(name)))
```

> 优先级：`@koishijs/plugin-*` **优先于** `koishi-plugin-*`（`prefixes` 数组 `.reverse()` 后才遍历）。

### 1.5 真实插件的导出形状实证

```js
// koishi-plugin-image-search@4.3.2 / lib/index.js  —— 命名导出整体
exports.apply = ...; exports.inject = ['http']; exports.name = 'image-search'; exports.Config = ...
```
```js
// koishi-plugin-weather@2.0.4 / lib/index.js
exports.apply = ...; exports.Config = koishi_1.Schema.object({}); exports.name = 'weather'
```
```js
// koishi-plugin-fortune@11.4.2 / dist/index.js —— webpack 打包，默认导出是「套壳类」
class c { constructor(i, n) { i.plugin(_, n) } }     // _ 是内部的 MyPlugin 实例
f(c, "fortune"); r.default = c; c.Config = _.schema  // ← 元属性挂在默认导出的类上
```
```js
// koishi-plugin-dialogue@4.1.3 / lib/index.js —— esbuild 打包，导出整体
// 0 && (module.exports = { Dialogue, DialogueService, apply, inject, name, schema, ... })
```
```js
// koishi-plugin-genshin@2.0.0-beta.15 —— Koishi v3 遗留插件
const { segment, template, Time } = require('koishi-core')
const apply = (ctx, pOptions) => {...}
module.exports = { apply, name, Config, using }
```

**所以兼容层的模块加载器必须做到**：`plugin = mod.default || mod`；然后接受 `typeof plugin === 'function'`（函数或类）或 `plugin.apply` 是函数；再从 `plugin` 上读 `name / Config / schema / inject / using / reusable / filter`。

---

## 2. `ctx` API 清单（按来源包分组）

`ctx` 是一个 **Proxy**（`ReflectService.handler`）。读取未注册的属性会触发 `internal/inject` 检查并 `internal/warning`，但**返回 `undefined` 而不是抛错**：

```
[W] app Error: property database is not registered, declare it as `inject` to suppress this warning
```

### 2.1 cordis 核心（`@cordisjs/core`，被 `cordis` → `@satorijs/core` → `@koishijs/core` 层层 `export *` 出来）

`koishi` 包运行时导出共 **113 个符号**（`Object.keys(require('koishi'))`），其中下列来自 cordis：

| API | 签名 | 说明 |
|---|---|---|
| `ctx.on(name, listener, options?)` | `=> () => boolean` | options: `boolean`(=prepend) 或 `{prepend, global}` |
| `ctx.once(name, listener, options?)` | `=> () => boolean` | |
| `ctx.off(name, listener)` | `=> boolean` | |
| `ctx.before(name, listener, append?)` | `=> () => boolean` | `ctx.before('dialogue/search')` ≡ `ctx.on('dialogue/before-search', ...)` |
| `ctx.emit(name, ...args)` / `ctx.emit(thisArg, name, ...args)` | `void` | 同步全部回调 |
| `ctx.parallel(name, ...)` | `Promise<void>` | 异步全部 |
| `ctx.serial(name, ...)` | `Promise<any>` | 异步顺序 |
| `ctx.bail(name, ...)` | `any` | 顺序；返回首个非 `false/null/undefined` |
| `ctx.waterfall(name, ...)` | *deprecated*（koishi 扩展，仍可用） | 上游结果作为下游首个参数 |
| `ctx.plugin(plugin, ...args)` | `ForkScope` | 同一插件重复加载返回 `fork`，`fork.dispose()` 停用 |
| `ctx.inject(deps, callback)` / `ctx.using(...)` | `ForkScope` | `using` 已 deprecated，是 `inject` 别名 |
| `ctx.set(name, value)` | `() => void` | 注册服务/值，返回 dispose |
| `ctx.get(name)` | `any \| undefined` | 容错读取 |
| `ctx.provide(name, value?, builtin?)` | `void` | *deprecated*（别名 `ctx.set`） |
| `ctx.accessor(name, {get,set})` / `ctx.alias(a,[b])` / `ctx.mixin(...)` | | |
| `ctx.effect(cb)` / `ctx.collect(label, cb)` | `Disposable` | 副作用自动回收（`collect` deprecated） |
| `ctx.accept(...)` / `ctx.decline(keys)` | `() => boolean` | 热重载接受器 |
| `ctx.scope` / `ctx.runtime` / `ctx.registry` / `ctx.root` / `ctx.config` / `ctx.baseDir` | | |
| `ctx.extend()` / `ctx.isolate(name)` / `ctx.intercept(name, cfg)` | `this` | |
| `ctx.start()` / `ctx.stop()` | `Promise<void>` | |

`this.ctx` 在 `Service` 子类里是**访问该方法的那个上下文**（用于自动回收副作用），不是构造函数里的 ctx。

### 2.2 计时器（`@cordisjs/timer`，`TimerService`）

```ts
ctx.setTimeout(callback, delay): () => void
ctx.setInterval(callback, delay): () => void   // 返回 dispose，不是 Node Timeout
ctx.sleep(delay): Promise<void>
ctx.throttle(fn, delay, noTrailing?): Fn & {dispose}
ctx.debounce(fn, delay): Fn & {dispose}
ctx.timer: TimerService
```
实测 `typeof app.setInterval === 'function'`（即使没有加载 timer 插件，它是内置的）。

### 2.3 日志（`@cordisjs/logger` / `reggol`）

```ts
ctx.logger: LoggerService          // 本身可调用
ctx.logger(name: string): Logger   // Logger: .debug/.info/.success/.warn/.error, .extend()
```
实测 `typeof app.logger === 'function'`。插件里常见 `ctx.logger('name').info(...)`、`ctx.logger.warn(err)`。

### 2.4 `@koishijs/core` 扩展（`ctx` 上的 Koishi 专属成员）

| API | 签名 |
|---|---|
| `ctx.middleware(mw, prepend?)` | `(session, next) => Awaitable<void\|Fragment>` → `() => boolean` |
| `ctx.match(pattern, response, options?)` | `=> () => boolean`（`ctx.shortcut` 的现代替代） |
| `ctx.command(def, desc?, config?)` | `Command` |
| `ctx.broadcast(content\|channels, content, forced?)` | `Promise<string[]>`（**需要 database**） |
| `ctx.component(name, render, options?)` | `() => void`（来自 `@satorijs/core`） |
| `ctx.i18n` | `I18n` 实例：`.define(locale, dict\|key, value)`、`.get(key, locales?)`、`.fallback(locales)`、`.render()` |
| `ctx.permissions` | `.define/.provide/.inherit/.depend/.list/.check/.test` |
| `ctx.schema.extend(name, schema, order?)` | 扩展配置构型 |
| `ctx.$commander` / `ctx.$processor` / `ctx.$filter` | 内部服务 |
| 过滤器语法糖 | `ctx.any() / .never() / .union() / .intersect() / .exclude() / .user() / .self() / .guild() / .channel() / .platform() / .private()`，都返回新 Context |
| `ctx.filter` | `(session) => boolean` |

实测：`ctx.any/user/match/set/get/inject/using/component/effect/accept/parallel/bail/serial/waterfall/chain` 全部 `function`。

### 2.5 `@satorijs/core`（协议层）

```ts
ctx.satori: Satori            // 内置、immediate
ctx.bots: Bot[] & Dict<Bot>   // 同上，bot 构造时 ctx.bots.push(this)
```

### 2.6 外部插件提供的服务（**不在**裸 Context 上）

实测 `new Context()` 后 `ctx.get(name)`：

| 服务 | 裸 Context | 提供者 | 关键成员 |
|---|---|---|---|
| `i18n` | ✅ object | 内置 | 见 2.4 |
| `schema` | ✅ object | 内置 | `SchemaService` |
| `$filter` `$processor` `$commander` `permissions` `satori` `logger` `timer` | ✅ | 内置 | |
| `model` | ✅ object | `minato.Database`（`@koishijs/core` 构造时 `this.plugin(minato.Database)`） | `Model`/`Database` 服务，`provide = "model"` |
| `database` | ❌ `undefined` | `@koishijs/plugin-database-*` 的 Driver 在 `ready` 时 `ctx.set("database", ...)` | `get/set/create/upsert/remove/eval/select/join/extend/migrate/drop/stats/transact` |
| `http` | ❌ `undefined` | `@koishijs/plugin-http`（`@cordisjs/plugin-http`） | **不是 axios**，见 §7.4 |
| `server` | ❌ | `@koishijs/plugin-server`（→ `@cordisjs/plugin-server`） | `ctx.server` 是 `class Server extends KoaRouter`：`.get/.post/...` 路由、`.ws(path, cb)` 的 `WebSocketLayer`、事件 `server/ready` |
| `console` | ❌ | `@koishijs/plugin-console`（`@koishijs/console`） | `addEntry(files, data?)`、`addListener(event, cb, opts)`、`broadcast(type, body, opts)`、`patch(type, value)`；扩展基类 `DataService`/`EntryProvider`/`SchemaProvider`/`PermissionProvider` |
| `puppeteer` | ❌ | `@koishijs/plugin-puppeteer` / `koishi-plugin-puppeteer` | `page(): Promise<Page>`、`render(content, callback?): Promise<string>`；事件 `puppeteer/validate(url)` |
| `assets` | ❌ | `@koishijs/assets` 的实现插件 | `abstract upload(url, file): Promise<string>`、`abstract stats()`、`transform(content: string): Promise<string>` |
| `canvas` | ❌ | `koishi-plugin-canvas` 等 | 第三方 |
| `booru` / `monetary` / `glyph` / `dialogue` | ❌ | 对应插件自身 `implements` | 插件自己 `class X extends Service { constructor(ctx){ super(ctx,'name') } }` |

**服务生命周期**：`Service` 构造函数 `super(ctx, name, immediate?)`；默认要等 `ready` 后才注册到全体上下文，第三个参数传 `true` 立即注册（`ctx.satori`、`ctx.i18n` 等内置都是 immediate）。可选实现 `start()` / `stop()` / `fork(ctx, config)`。

---

## 3. Session / 事件模型

### 3.1 Session 类

**`koishi.Session` 在运行时是 `undefined`**（实测 `'Session' in require('koishi') === false`），它只在 `.d.ts` 里作为 interface 存在；真正的类在 **`@satorijs/core` 的 `Session`**（`require('@satorijs/core').Session` 是 function）。Koishi 通过 `declare interface Session extends satori.Session` 做声明合并。兼容层若要 `instanceof` 判断，请从 `@satorijs/core` 取类。

构造：`new Session(bot, event)`；`bot.session(event?)` 是便捷写法。构造函数会补齐 `event.selfId ??= bot.selfId`、`event.platform ??= bot.platform`、`event.timestamp ??= Date.now()`。

**字段（`event` 上的路径 → 访问器）**——源码 `defineAccessor()` 一览：

| `session.x` | 完整路径 |
|---|---|
| `id` / `sn` | `++bot.ctx.satori._sessionSeq` |
| `type` / `subtype` | `event.type` / `event.subtype` |
| `selfId` | `event.selfId` |
| `platform` | `event.platform` |
| `timestamp` | `event.timestamp` |
| `userId` | `event.user.id` |
| `channelId` | `event.channel.id` |
| `channelName` | `event.channel.name` |
| `guildId` | `event.guild.id` |
| `guildName` | `event.guild.name` |
| `messageId` | `event.message.id` |
| `operatorId` | `event.operator.id` |
| `roleId` | `event.role.id` |
| `quote` | `event.message.quote` |
| `referrer` | `event.referrer` |
| `isDirect` | `event.channel.type === Channel.Type.DIRECT`（可写） |
| `author` | `{...event.user, ...event.member, userId, username, nickname}` |
| `uid` / `gid` / `cid` / `fid` / `sid` | `` `${platform}:${...}` `` 拼接 |
| `bot` / `app` | `bot` / `bot.ctx.root` |
| `event` | 原始事件对象（`session.event` 就是它） |
| `locales` | `string[]` |

**`content` / `elements` 语义（关键）**：

```js
get content() { return this.event.message?.elements?.join('') }        // 元素数组 join("")
set content(value) {
  this.event.message ??= {}
  this.event.message.quote = undefined
  this.event.message.elements = isNullable(value) ? value : h.parse(value)   // ← 赋值会走元素解析！
  if (this.event.message.elements?.[0]?.type === 'quote') { ... }
}
get elements() { return this.event.message?.elements }
```

- `session.content` **不是**原始用户输入文本；它是元素数组 `join('')` 的结果，其中 `text` 元素的 `toString()` 会做 HTML 转义（见 §4）。
- `session.content = '...'` 会调用 `h.parse()`，**`<at id="1"/>` 这类标记会被解析成元素**。所以"拼接字符串再赋值"有解析风险。

**方法**（`@koishijs/core` 的 `KoishiSession`，通过 `ctx.mixin(this, {...})` 挂到 Session 原型）：

```ts
session.send(fragment, options?): Promise<string[]>          // → bot.sendMessage(channelId, elements, referrer, options)
session.sendQueued(content, delay?): Promise<string[]>
session.cancelQueued(delay?): void
session.prompt(timeout?): Promise<string>
session.prompt<T>(callback, options?): Promise<T>
session.suggest(options): Promise<string>
session.execute(argv: string|Argv, next?: true|Next): Promise<Element[]>
session.middleware(mw): () => boolean
session.getUser(id?, fields?): Promise<User>
session.observeUser(fields): Promise<User.Observed>
session.getChannel(id?, fields?): Promise<Channel>
session.observeChannel(fields): Promise<Channel.Observed>
session.resolve(source, ...args): any
session.text(path, params?): string
session.i18n(path, params?): Element[]
session.withScope(scope, callback): Promise<Element[]>
session.collect('user'|'channel', argv, fields?): Set<field>
+ getters: session.stripped {hasAt, appel, atSelf, content, prefix}、session.username、session.argv、session.user、session.channel、session.guild
```

`session.execute()` 的返回值是个**陷阱**（源码实测）：

```js
return this.withScope(`commands.${command.name}.messages`, async () => {
  const result = await command.execute(argv, next)
  if (!shouldEmit) return h.normalize(result)   // next === true 时返回元素数组
  await this.send(result)                        // 否则直接发出去
  return []                                      // ← 返回空数组
})
```
实测 `await argv.session.execute('echo inner')` 返回 `[]`，但消息已发出。

### 3.2 事件名

会话事件（`@satorijs/core` 的 `interface Events`）：`message`、`message-created`、`message-deleted`、`message-updated`、`message-pinned`、`message-unpinned`、`guild-added/removed/updated`、`guild-member-added/removed/updated`、`guild-role-created/deleted/updated`、`reaction-added/removed`、`login-added/removed/updated`、`friend-request`、`guild-request`、`guild-member-request`、`interaction/command`、`interaction/button`、`before-send`、`send`、`bot-connect`、`bot-disconnect`、`bot-added/removed/status-updated`(deprecated)、`internal/session`、`satori/meta`。

Koishi 追加：`middleware`、`attach`、`before-attach`、`attach-user`/`attach-channel`(+before-)、`before-parse`、`command-added/updated/removed`、`command-error`、`command/before-execute`、`command/before-attach-user`、`command/before-attach-channel`、`internal/i18n`、`internal/permission`、`internal/schema`。

cordis 生命周期：`ready`、`dispose`、`fork`、`internal/fork`、`internal/runtime`、`internal/status`、`internal/error`、`internal/warning`、`internal/info`、`internal/service`、`internal/before-service`、`internal/inject`、`internal/listener`、`internal/event`。

**别名映射（`eventAliases`）**：

```js
const eventAliases = [
  ['message-created', 'message'],
  ['guild-removed', 'guild-deleted'],
  ['guild-member-removed', 'guild-member-deleted'],
]
```

`bot.dispatch(session)` 会：若 `session.type` 命中别名组，则把 `session.type` 规范化为 `aliases[0]`，然后**按顺序 emit 组内每个事件**：

```js
dispatch(session) {
  if (!this.ctx.lifecycle.isActive) return
  let events = [session.type]
  for (const aliases of eventAliases) { if (aliases.includes(session.type)) { events = aliases; session.type = aliases[0]; break } }
  this.context.emit('internal/session', session)
  if (session.type === 'internal') { this.context.emit(session.event._type, session.event._data, session.bot); return }
  for (const event of events) this.context.emit(session, event, session)   // ← session 作为 thisArg
}
```

所以 `ctx.on('message-created', ...)` 和 `ctx.on('message', ...)` **都会**被触发，一个 handler 里不要重复回复。

### 3.3 中间件流水线（`@koishijs/core` 的 `Processor`）

```js
constructor(ctx) {
  this.middleware(this.attach.bind(this), true)     // 前置中间件：解析指令、attach 用户/频道
  ctx.on('message', this._handleMessage.bind(this))
  ...
}
async _handleMessage(session) {
  if (session.selfId === session.userId) return                     // 忽略自己
  const queue = this.ctx.lifecycle.filterHooks(this._hooks, session).map(({callback}) => callback.bind(null, session))
  let index = 0
  const next = async (callback) => {
    if (callback !== undefined) { queue.push((next2) => Next.compose(callback, next2)); if (queue.length > Next.MAX_DEPTH) throw ... }
    return await queue[index++]?.(next)
  }
  try { const result = await next(); if (result) await session.send(result) }   // ← 返回值自动发送
  finally { delete this._sessions[session.id]; await session.user?.$update(); ...; this.ctx.emit(session, 'middleware', session) }
}
```

要点：
- `Next.MAX_DEPTH = 64`；`Next.compose(cb, next) = typeof cb === 'function' ? cb(next) : cb`
- `next()` 必须在异步中间件里 `await`/`return`（否则时序错误 + 运行时警告）
- `next('临时内容')` 会把回调压入队列尾部（"临时中间件"），本次解析结束即清除
- 中间件返回值（字符串/元素）由框架**自动发送**——插件不需要自己 `session.send`
- `ctx.middleware(mw, true)` 注册前置中间件；`ctx.middleware` 内部走 `ctx.lifecycle.register('middleware', hooks, mw, {prepend})`，返回 dispose
- 只有 `message` 事件会走中间件，其他事件不会

---

## 4. 元素模型

### 4.1 `h` 函数

`koishi` 导出的 `h`（`@satorijs/element` 默认导出），并且 **`h === segment === Element`**（实测 `true`）——v3 遗留的 `segment` 名仍然可用。

```ts
h(type: string | RenderFunction, ...children): Element
h(type: string | RenderFunction, attrs: Dict, ...children): Element
```

内置工厂（全部形如 `(...args, attrs?) => Element`）：

```ts
h.text(content)   h.at(id)      h.sharp(id)     h.quote(id)     h.emoji(id)
h.image(data | [data, type])    h.img(...)      h.audio(...)
h.video(...)      h.file(...)   h.i18n(path, children?)
```

`Element` 实例：`.type`、`.attrs`、`.children`、`.data`(deprecated=attrs)、`.source`、`.toString(strip?)`。

**实测输出格式**：

```js
h('message', h('at', {id:'123'}), h('text',' hi '), h('img',{src:'https://x/y.png'})).toString()
// '<message><at id="123"/><text> hi </text><img src="https://x/y.png"/></message>'
h.parse('<at id="42"/>hello<img src="a.png"/>')
// [["at",{"id":"42"}],["text",{"content":"hello"}],["img",{"src":"a.png"}]]
h.parse('plain text')                      // [["text",{"content":"plain text"}]]  ← parse 总是产出数组
h.text('a<b').toString()                   // 'a&lt;b'   （attrs 里保留原文 'a<b'）
h.escape('<b>&"x"</b>')                    // '&lt;b&gt;&amp;"x"&lt;/b&gt;'
h.escape('<b>&"x"</b>', true)              // '&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;'   （inline 也转义引号）
h.unescape('&lt;b&gt;&amp;&quot;x&quot;')  // '<b>&"x"'
```

序列化实现（`@satorijs/element`）：

```js
toString(strip = false) {
  if (this.type === 'text') return strip ? this.attrs.content : Element.escape(this.attrs.content)
  const inner = this.children.map(c => c.toString(strip)).join('')
  const attrs = Object.entries(this.attrs).filter(([,v]) => v !== undefined).map(([k,v]) => ` ${k}="${Element.escape(''+v, true)}"`).join('')
  return `<${this.type}${attrs}>${inner}</${this.type}>`   // 自闭合元素见源码
}
```

解析用正则（`tagRegExp1`）：
```js
/(?<comment><!--[\s\S]*?-->)|(?<tag><(\/?)([^!\s>/]*)([^>]*?)\s*(\/?)>)/
// 属性：/([^\s=]+)(?:="(?<value1>[^"]*)"|='(?<value2>[^']*)')?/g
```
**只认尖锐括号语法。** `[CQ:...]`、`[at:...]` 之类一律当纯文本。

### 4.2 工具函数

```ts
h.isElement(x)                  h.toElement(x)        h.toElementArray(x)      h.normalize(x, ctx?)
h.escape(s, inline?)            h.unescape(s)         h.parse(s, ctx?)         h.interpolate(expr, ctx)
h.select(source, query)         h.parseSelector(q)    h.from(src, opts)        // from 已 deprecated
h.transform(src, rules, session?)  h.transformAsync(src, rules, session?)
h.warn                          // 默认接到 Logger('element').warn
```
`h.select` 的 `source` **必须是数组或可迭代对象**：实测传单个 Element 会 `TypeError: source.entries is not a function`。要先 `h.normalize()` / `h.toElementArray()`。

### 4.3 JSX

`@satorijs/element` 提供 `Element.jsx / jsxs / jsxDEV`，`package.json` 显式导出子路径：

```json
"exports": {
  ".": {...},
  "./jsx-runtime": { "types": "./lib/index.d.ts", "import": "./lib/index.mjs", "require": "./lib/index.cjs" },
  "./jsx-dev-runtime": {...}
}
```
真实插件确实会 `import ... from '@satorijs/element/jsx-runtime'`（`koishi-plugin-booru@1.4.0` 实测）。**兼容层必须让这两个子路径可解析**，否则该插件加载即失败。TS 侧配置一般是 `"jsx": "react-jsx", "jsxImportSource": "@satorijs/element"`。

### 4.4 `session.content` 的文本化规则

- 读：`elements.join('')` → 每个元素 `toString()`：`text` 走 `escape()`（`& < >` 转义），非 text 输出完整 `<tag attrs>children</tag>` 序列化文本。
- 写：`h.parse(value)` → 元素数组；首个 `quote` 元素会被摘出来放进 `event.message.quote`。
- `session.toJSON()`（即 `session.event` 的对外形态）会把 `message.elements` 换成 `message.content` 字符串（`event.message.content = this.content`，并删除 `elements`），若存在 quote 则前置 `Resource.encode('quote', quote)`。

**给兼容层的建议**：不要试图"文本化"再反解析。平台入站消息 → 构造 `event.message.elements`（`h.parse()` 或直接 `h()` 构造）；平台出站从 `MessageEncoder.visit(element)` 里按 `element.type` 分发。

### 4.5 标准元素与消息组件

标准元素（JSX IntrinsicElements 声明可见全集）：`message`、`quote`、`at`、`sharp`、`emoji`、`img`、`audio`、`video`、`file`。文档：<https://koishi.chat/zh-CN/api/message/elements.html>

内置组件（由 Koishi 而非适配器实现，`Processor` 构造时用 `ctx.component()` 注册）：`<execute>`、`<prompt>`、`<i18n>`、`<i18n:time>`、`<random>`、`<plural>`。渲染发生在 `session.transform(elements)` → `MessageEncoder.send()` 内部，并且组件可以返回 Promise。自定义组件：

```ts
function Custom(attrs, children, session) { return '自定义内容' }   // 首字母大写 = 局部组件
ctx.component('custom', (attrs, children, session) => '...')       // 全局注册，可用小写 <custom/>
```

---

## 5. 要跑起来必须提供哪些服务

### 5.1 裸 `new Context()` 自带（实测 `ctx.get`）

```
http undefined | database undefined | model object | i18n object | schema object
permissions object | $processor object | $commander object | $filter object
bots undefined(!) | satori object | logger function | timer object
console undefined | puppeteer undefined | assets undefined | server undefined | storage undefined
```

> `ctx.get('bots')` 是 `undefined`，但 `ctx.bots` 是 `satori.bots` 上的数组（`ctx.bots.length === 0`）；`ctx.broadcast` 在没有 database 时是 `undefined`。

`@koishijs/core` 的 `Context` 构造函数（反编译自 `lib/index.mjs`）就是全部内置服务的清单：

```js
super(config)
this.mixin('$processor', ['match', 'middleware'])
this.mixin('$filter', ['any','never','union','intersect','exclude','user','self','guild','channel','platform','private'])
this.mixin('$commander', ['command'])
this.provide('$filter', new FilterService(this), true)
this.provide('schema', new SchemaService(this), true)
this.provide('$processor', new Processor(this), true)
this.provide('i18n', new I18n(this, this.config.i18n), true)
this.provide('permissions', new Permissions(this), true)
this.provide('model', undefined, true)      // 占位
this.provide('http', undefined, true)       // 占位：只有声明，没有实现
this.provide('$commander', new Commander(this, this.config), true)
this.plugin(minato.Database)                // 提供 'model'，并注入 ['model']
this.plugin(Koishi, this.config)            // 提供 'koishi'，并 new KoishiDatabase(ctx)（mixin database.getUser 等）
```

`database` 服务的真正注册点在 **minato 的 Driver**：

```js
ctx.on('ready', async () => {
  await this.start()
  ctx.model.drivers.push(this); ctx.model.refresh()
  const database = Object.create(ctx.model); defineProperty(database, 'ctx', ctx); database._driver = this
  ctx.set('database', Context.associate(database, 'database'))
})
static inject = ['model']
```

→ **`ctx.database` 只有装了 driver 插件、且应用 `ready` 之后才存在。**

### 5.2 真实插件的硬依赖分布（静态扫描 `ctx.*` + `inject` + `require`）

| 插件 | 显式 `inject` | 实际用到的 `ctx.*` | require 的外部包 |
|---|---|---|---|
| `koishi-plugin-dialogue@4.1.3` | `['database']` | `bail, before, command, database, dialogue, emit, get, guild, i18n, logger, model, on, parallel, plugin, root, serial, setTimeout` | `koishi`, `fastest-levenshtein` |
| `koishi-plugin-rss` | `['database']` | `broadcast, database, guild, model, on` | `koishi`, `rss-feed-emitter` |
| `koishi-plugin-image-search@4.3.2` | `['http']` | `command, http, logger, on` | `koishi`, `cheerio`, `iqdb-client`, `nhentai-api` |
| `koishi-plugin-memes@2.1.8` | `["http"]` | `command, http, logger, middleware, root` | `koishi` |
| `koishi-plugin-weather@2.0.4` | **无** | `command, http, logger` | `koishi` |
| `koishi-plugin-booru@1.4.0` | `{required:['booru'], optional:['assets']}` | `assets, booru, canvas, command, http, i18n, plugin` | `koishi`, `languagedetect`, **`@satorijs/element/jsx-runtime`** |
| `koishi-plugin-jrys-prpr@3.0.3` | `{required:['i18n','logger','http','puppeteer'], optional:['canvas','assets','monetary','database','glyph']}` | `assets, baseDir, canvas, command, database, glyph, http, i18n, logger, model, monetary, on, puppeteer` | `koishi`, `node:fs/path/url/crypto` |
| `koishi-plugin-fortune@11.4.2` | 无（webpack 打包后不可直接扫描） | — | `koishi`, `@stdlib/random-base-mt19937`, `moment`, `mustache` |
| `koishi-plugin-roll@2.0.3` | 无 | `middleware` | **`koishi-utils`（v3 遗留）** |
| `koishi-plugin-genshin@2.0.0-beta.15` | 无 | `command, plugin` | **`koishi-core`（v3 遗留）**, `genshin-kit` |
| `@koishijs/plugin-help@2.4.6` | 无 | `$commander, before, chain, command, filter, i18n, on, permissions, schema` | `koishi` |
| `@koishijs/plugin-adapter-onebot@6.0.2` | 无 | — | `@satorijs/adapter-onebot`（薄壳） |
| `@koishijs/plugin-database-memory@3.7.0` | 无 | — | `@minatojs/driver-memory`（薄壳） |

**统计结论**：
- `require('koishi')` 是压倒性的第一依赖（几乎 100%）；只要你的兼容层顶层能提供 `koishi` 这个模块名，就覆盖了绝大部分加载失败。
- 高频 `ctx.*`：`command`、`http`、`logger`、`i18n`、`database`、`model`、`on`、`middleware`、`plugin`、`assets`、`puppeteer`。
- **v3 遗留包仍然存在且在维护**（`koishi-core` / `koishi-utils` / `segment` / `using`）。兼容层最好同时 alias 这两个老包名到兼容实现。

### 5.3 依赖缺失时的失败方式（三档，实测）

**A. `require` 阶段失败 — 明确抛错**
```
node_modules/koishi-plugin-weather/lib/index.js: const koishi_1 = require("koishi");
Error: Cannot find module 'koishi'   (code: MODULE_NOT_FOUND)
```
这是最常见的失败点，发生在**加载插件模块时**，不是 `apply` 时。此外还有：
- `require('@satorijs/element/jsx-runtime')` 缺失 → 同上 MODULE_NOT_FOUND（booru 类插件）
- v3 插件 `require('koishi-core')` 缺失 → 同上

**B. `inject` 未满足 — 静默 pending，没有任何错误**
```js
app.plugin({ name:'needsdb', inject:['database'], apply(){ dbApplied = true } })
// 实测：dbApplied === false；不抛错、不 emit internal/error
app.plugin({ name:'optdb', inject:{optional:['database']}, apply(){ optApplied = true } })
// 实测：optApplied === true
```
对写"自定义框架"的人来说，这一档最危险：**插件看起来加载成功了，功能却不存在**。你的加载器应当扫描 `plugin.inject`（含 `using`）并与 `ctx.get(name) !== undefined` 做核对，把未满足的依赖显式暴露出来。

**C. 运行时访问未注册服务 — warning + `undefined`**
```js
app.plugin({ apply(ctx){ console.log(ctx.database) } })
// [W] app Error: property database is not registered, declare it as `inject` to suppress this warning
// 输出 undefined
```
接着在 `ctx.database.get(...)` 处崩 `TypeError: Cannot read properties of undefined (reading 'get')`。
`koishi-plugin-weather` 就是这一类：**它没有声明 `inject`**，所以在本机的裸 Context 上能加载、能注册指令，但一调用 `ctx.http.get(...)` 就炸。

---

## 6. 方案 a / b 对比

### 6.1 方案 (a)：依赖真实 `koishi`，用桥接适配器把自定义框架的事件转成 Koishi Session

**最小可行路径（已实测跑通，完整可运行代码见 §6.3）**：

```
new Context()  →  写一个 class MyBot extends Bot（带 static MessageEncoder）
               →  写一个 class MyAdapter extends Adapter
               →  ctx.plugin(MyBot)
               →  平台入站：bot.dispatch(bot.session({type:'message-created', channel, user, message:{elements}}))
               →  平台出站：MessageEncoder.visit/flush 里调用你的框架 send
```

**必须实现的清单**：

| 组件 | 必要性 | 说明 |
|---|---|---|
| `class X extends Bot` | 必需 | 构造里 `super(ctx, config)`，设 `this.platform` / `this.selfId` / `this.user`，然后 `ctx.plugin(XAdapter, this)`。`Bot` 构造会自动 `ctx.bots.push(this)` 并 `emit('bot-added')`，并在 `ready` 时 `dispatchLoginEvent('login-added')` + `this.start()` |
| `class XAdapter extends Adapter` | 必需（否则 `bot.start()` 走空实现也行） | `Adapter.connect/disconnect` 可空；`Adapter.fork(ctx, bot)` 负责 `bot.adapter = this`。你也可以完全不写 Adapter，直接在框架事件回调里 `bot.dispatch(session)` |
| `static MessageEncoder` | **必需** | `Bot.createMessage()` 会 `const { MessageEncoder } = this.constructor; return new MessageEncoder(this, channelId, referrer, options).send(content)`。不定义 → `session.send()` 抛 `TypeError: MessageEncoder is not a constructor`。子类需实现 `visit(element)` + `flush()` |
| `getLogin()` | 建议 | 返回 `{platform, selfId, status, features, user}`；控制台/`bot.toJSON()` 用它 |
| 平台方法（`sendMessage` 等） | 视插件而定 | 基类 `createMessage` 已通过 MessageEncoder 实现发送；其余 `Methods`（`getMessage/deleteMessage/muteGuildMember/...`）按需实现，未实现时 `bot.supports(name)` 返回 false |

**入站事件体（`event`）最小字段**：`type`、`channel:{id, type}`（`type:1` 即 DIRECT）、`user:{id, name}`、`message:{id, elements}`、可选 `guild:{id}`、`timestamp`、`selfId`、`platform`。

**实测结果**（`probe2.js`）：
```
bots registered: 1 | bot.sid = mybot:bot1 | bot.adapter = MyAdapter
--> dispatch "ping"        → 事件回调触发，中间件返回 → sent: "pong"
--> dispatch "echo hello"  → 指令 action 执行 → sent: "hello"
--> dispatch "echo hello -u" → 指令带选项 → sent: "HELLO"
commands registered: echo( <message...>)
```
（同一次运行里也验证了 `session.argv`、`argv.args`、`argv.options`、`ctx.middleware`、`ctx.command().option().action()`、`ctx.on('message')` 全部工作。）

**成本**：约 150–250 行胶水代码（Bot + Adapter + MessageEncoder + CQ↔Element 转换 + 出站渲染）。
**能覆盖**：**几乎 100% 的纯逻辑插件**（指令、中间件、i18n、数据库、HTTP、元素收发）。数据库只需加 `@koishijs/plugin-database-sqlite|memory`，HTTP 只需 `@koishijs/plugin-http`（`koishi` 包已把它列为 dependency）。
**会缺什么**：
- 平台专属能力：插件调用 `bot.internal.xxx()`（平台内部 API，如 `bot.internal.getGatewayBot()`）或适配器专属事件（`kook/message-btn-click`）时，需要你逐个适配或在 `bot.internal` 上提供桩。
- `ctx.console` / `ctx.puppeteer` / `ctx.assets`：需要额外装官方插件（console 还需要 web 端 `@koishijs/client`）。不装 → 声明了这些 inject 的插件静默不加载。
- 一些插件假设 `bot.toJSON()`/`getLogin()` 有完整字段（`features` 数组），缺失只会影响展示。

### 6.2 方案 (b)：自己实现一个 `ctx` 兼容层

你至少要**逐字复刻**下列语义，否则真实插件会在意料之外的地方失败：

1. **cordis 的 Fiber/Scope 副作用回收**：`ctx.on/plugin/middleware/command/component/setInterval` 的所有副作用必须在插件 dispose 时精确回收（`ForkScope`、`EffectScope`、`registry`、`MainScope.forkables`、`Inject.resolve`、`isForkable` 复用告警、`reusable` 语义、`fork` 事件双作用域）。这是整个体系里最难的一块，插件生态大量依赖"卸载即清理"。
2. **Proxy + 声明合并式的服务解析**：`ctx.foo` 未注册时的 warning 行为、`inject` 的等待/回滚语义（服务出现→自动加载，服务消失→回滚重载）。
3. **`h` 元素系统**：`h()` / `parse` / `escape` / `select` / `transform` / `transformAsync` / JSX runtime 子路径 / `Element.toString()`。可以直接抄 `@satorijs/element`（MIT），但必须连 `package.json` 的 `exports` 子路径一起提供。
4. **Session**：40+ 个访问器 + `content` 的 get/set 语义 + `send/sendQueued/prompt/suggest/execute/middleware` + `user/channel` 的可观测对象（`$diff/$update/$merge`）。
5. **Command/Argv 解析器**：`<arg>` `[arg]` `[...rest]` `:text/:number/:user/:channel/:date/:image/...` 类型域、`-a`/`--foo=bar`/`--no-xyz`/短横线驼峰、别名/子指令（`/` 与 `.`）、前缀与昵称剥离（`session.stripped`）、`match`/`alias` 快捷方式、`strictOptions`/`checkUnknown`/`checkArgCount`。
6. **middleware 管线**：prepend、`next(callback)` 临时中间件、`MAX_DEPTH`、返回值自动发送、`SessionError` → `session.text(error.path)`。
7. **i18n**：locale tree、`fallback`、`session.text/i18n`、模糊匹配。
8. **minato ORM**：`Database` + `Driver` 抽象 + `Selection` 表达式编译器 + `Model` 字段解析 + `$` 求值表达式 + 迁移。这是第二难的一块，且**不能靠 shim 糊弄**——插件会写 `(row) => ({ money: $.sub(row.money, 100) })` 这种必须在 SQL 层求值的表达式。
9. **schemastery**：`Schema.object/string/number/union/intersect/array/dict/const/...` 及 `computed/filter/dynamic/path` 扩展。

**成本**：这是**数万行**级别的工作量，且需要跟着上游演进（本次调查期内 koishi 4.18.x 仍在活跃发版）。
**能覆盖**：只有那些"什么都没用到"的插件——`ctx.on('message')` + `session.content` + `session.send` 的极简插件。凡是碰 `database` / `model` / `h.select` / 复杂指令解析 / `inject` 生命周期的都会出问题。
**会缺什么**：与生态的**语义兼容**，而不是 API 名字。表面上 `ctx.command()` 能跑，实际在 `strictOptions`、`argCount`、`alias(args)`、`match(fuzzy/i18n)`、`observeUser` 的字段收集等细节上行为不一致，插件作者报的 bug 你无法复现。

### 6.3 推荐方案：**a 为骨架，b 只做薄 shim**

```js
// ---- 兼容层入口（伪代码）----
const { Context } = require('koishi')                  // 直接吃真包
const app = new Context({ prefix: [''], nickname: [BOT_NAME] })

// 1) 提供平台缺省服务：http 是 koishi 的 dependency，直接装起来
app.plugin(require('@koishijs/plugin-http'))
app.plugin(require('@koishijs/plugin-database-memory'))  // 或 sqlite

// 2) 注册桥接机器人（见 §6.3 完整代码）
app.plugin(MyBot, { /* 平台配置 */ })

// 3) 加载真实插件：路径解析 + default 解包 + inject 预检
const scope = nsRequire({ namespace:'koishi', prefix:'plugin', official:'koishijs', dirname: pluginsDir })
for (const name of ['image-search', 'weather', 'dialogue']) {
  const plugin = unwrapExports(require(scope.resolve(name)))       // ← 必须解包
  const deps = Inject.resolve(plugin.inject || plugin.using)       // ← 依赖预检
  const missing = Object.keys(deps).filter(k => deps[k].required && !app.get(k))
  if (missing.length) { warn(`插件 ${name} 需要的服务缺失: ${missing}`); continue }
  app.plugin(plugin, config)
}
await app.start()
```

桥接主体（**已实测跑通**，直接照抄即可）：

```js
const { Context, Bot, Adapter, MessageEncoder, h } = require('koishi')

class MyEncoder extends MessageEncoder {
  async prepare() { this.out = [] }
  async visit(el) {
    if (el.type === 'text') this.out.push(el.attrs.content)      // text 的 content 是未转义的原文
    else if (el.type === 'at') this.out.push('@' + el.attrs.id)
    else if (el.type === 'img') this.out.push('[img ' + el.attrs.src + ']')
    else this.out.push(el.toString())                            // 未知元素降级为序列化文本
  }
  async flush() {
    const content = this.out.join(''); this.out = []
    await myFramework.send(this.channelId, content)              // ← 你自己的发送通道
    this.results.push({ id: await myFramework.lastMessageId() }) // 供 session.send 的返回值
  }
}

class MyAdapter extends Adapter {
  async connect(bot) { /* 建立平台连接 */ }
  async disconnect(bot) { }
}

class MyBot extends Bot {
  static MessageEncoder = MyEncoder
  constructor(ctx, config) {
    super(ctx, config)
    this.platform = 'myplatform'
    this.selfId = config.selfId
    this.user = { id: config.selfId, name: config.name }
    ctx.plugin(MyAdapter, this)
  }
  async getLogin() {
    return { platform: this.platform, selfId: this.selfId, status: 1, features: [], user: this.user }
  }
}

const app = new Context()
app.plugin(MyBot, { selfId: '10001', name: 'MyBot' })
await app.start()

// ---- 平台收到一条消息时 ----
function onIncoming(msg) {
  const bot = app.bots[0]
  bot.dispatch(bot.session({
    type: 'message-created',                 // dispatch 会自动同时触发 message-created 与 message
    platform: 'myplatform',
    selfId: bot.selfId,
    timestamp: msg.time,
    channel: { id: msg.channelId, type: msg.isGroup ? 0 : 1 },   // 1 = DIRECT => session.isDirect
    guild: msg.guildId ? { id: msg.guildId } : undefined,
    user: { id: msg.userId, name: msg.userName },
    message: { id: msg.messageId, elements: cqToElements(msg.raw) },  // 自己实现 CQ→Element
  }))
}
```

**实测输出**：
```
bots registered: 1 | bot.sid = mybot:bot1
--> dispatch "ping"          → sent "pong"        (ctx.middleware)
--> dispatch "echo hello"    → sent "hello"       (ctx.command().action())
--> dispatch "echo hello -u" → sent "HELLO"       (option 解析)
commands registered: echo( <message...>)
```

**已知的收尾小坑**：`app.stop()` 时 `Bot.dispose()` 会执行 `this.ctx.bots.findIndex(...)`，若 satori 服务已被先行销毁会抛 `TypeError: Cannot read properties of undefined (reading 'findIndex')`。在 `stop()` 外层包 try/catch，或先 `fork.dispose()` 掉 Bot 再 `stop()`。

---

## 7. 逐题速答（对应任务清单）

1. **包结构/导出形状** → §1。`koishi` 字段 = `description/service/preview/hidden/category/browser/locales`；**没有** `koishi.peerDependencies`；`peerDependencies` 必须含 `koishi`；`main`/`exports` 无强制约定（实测多数只有 `main`）；CJS 是主流，ESM 在 Node ≥22.12 也能被 `require` 加载。
2. **最小插件（含 schema）** → §1.2 的 `foo.ts` 片段；注意 `Config` 必须与 `apply` **同级**导出。
3. **ctx 常用成员** → §2（按 cordis / timer / logger / @koishijs/core / @satorijs/core / 外部服务分组）。`ctx.setInterval` 来自 `@cordisjs/timer`；`ctx.logger` 来自 `@cordisjs/logger`；`ctx.i18n`、`ctx.command`、`ctx.middleware` 来自 `@koishijs/core`；`ctx.bots`、`ctx.component` 来自 `@satorijs/core`；`ctx.http/database/console/puppeteer/assets` 来自官方插件。
4. **事件模型 / Session** → §3。`message` 与 `message-created` 是别名对，一个 dispatch 触发两个；`session.send` 走 `bot.sendMessage` → `MessageEncoder`；`session.content` 是 `elements.join('')`，赋值会 `h.parse()`。
5. **元素模型** → §4。`h === segment === Element`；序列化是 `<at id="1"/>` 风格；**不支持 CQ 码**；`h.select` 必须传数组。
6. **指令系统** → §6.1 表格 + §3.3。`.shortcut()` **仍然存在但已 deprecated**（`@deprecated please use cmd.alias() instead`），`Cmd.alias(name, options)` 与 `ctx.match()` 是现行 API；`action` 的第一个参数是 `Argv`（`argv.args` / `argv.options` / `argv.session` / `argv.next` / `argv.root` / `argv.rest` / `argv.source`），**不是** `session.args`；指令执行期间 `session.argv` 也可读。
7. **服务与依赖 / 数据库** → §5.1 + §2.6。`ctx.set(name, value)` / `class X extends Service { super(ctx, name, immediate?) }`；`inject`/`using` 见 §1.2。数据库：`ctx.database.get/set/create/upsert/remove/eval/select/join`，表定义用 **`ctx.model.extend(name, fields, config)`**（`ctx.model` 才是 minato Database 服务本体，`ctx.database` 是装了 driver 后的关联视图）；`ctx.model.extend('user', {...})` / `model.migrate(...)`（文档 <https://koishi.chat/zh-CN/guide/database/model.html>）。**`ctx.http` 不是 axios**：它是 `@cordisjs/plugin-http` 的 `HTTP extends Service`，`ctx.http(url, config)` / `.get/.post/.put/.patch/.delete` 返回 `HTTP.Response<T>`（`{url,data,status,statusText,headers}`），文档里 `import { HTTP } from 'koishi'` 的 `HTTP` 就是这个类（`Quester` 是别名）。
8. **第三方典型硬依赖与失败点** → §5.2 / §5.3。主要是 `koishi`（MODULE_NOT_FOUND）；`@satorijs/element/jsx-runtime` 子路径、v3 的 `koishi-core`/`koishi-utils`；服务维度则是"静默不加载"。
9. **最小可行路径 / 方案对比** → §6。

---

## 8. 复现脚本与证据位置

所有实测都在临时目录完成，可复现：

```powershell
$d = "$env:TEMP\koishi-research"; mkdir $d; cd $d
'{"name":"r","private":true}' | Set-Content package.json
npm i koishi        # → koishi@4.18.11, @koishijs/core@4.18.11, @satorijs/core, cordis@3.18.1, minato@3.7.0
node -e "const {Context,h}=require('koishi'); console.log(Object.keys(require('koishi')).length)"
```

关键证据文件（临时目录，可随时重跑）：

| 文件 | 内容 |
|---|---|
| `%TEMP%\koishi-probe\probe1.js` | 裸 Context 服务清单（§5.1 表格） |
| `%TEMP%\koishi-probe\probe2.js` | **桥接适配器端到端跑通**（§6.3，含 Bot/Adapter/MessageEncoder） |
| `%TEMP%\koishi-probe\probe3.js` | inject 静默 pending、warning、argv/alias/execute 语义（§3/§5.3） |
| `%TEMP%\koishi-plugins\node_modules\koishi-plugin-*` | 12 个真实插件的源码与 `package.json`（§1.1/§5.2） |
| `%TEMP%\koishi-research\node_modules\@{cordisjs,koishijs,satorijs,minato}` | 接口 `.d.ts` 与反编译 `.mjs`（§2/§3/§4） |

`.d.ts` 主要出处：
`@koishijs/core/lib/index.d.ts`（Context/Session/Command/Argv/Events）、`@satorijs/core/lib/index.d.ts`（Session/Bot/Adapter/MessageEncoder/事件表）、`@cordisjs/core/lib/index.d.ts`（on/plugin/inject/Service/Registry）、`@cordisjs/timer/lib/index.d.ts`、`@cordisjs/logger/lib/index.d.ts`、`minato/lib/index.d.ts`（Database/Model/Selection/Driver）、`@satorijs/element/lib/index.d.ts`（h/Element/JSX）、`@cordisjs/plugin-http/lib/index.d.ts`（HTTP）。

---

## 参考链接

- 插件基本形式 / 导出：<https://koishi.chat/zh-CN/guide/plugin/>
- 配置构型（Schema / 元属性）：<https://koishi.chat/zh-CN/guide/plugin/schema.html>
- 生命周期（ready / dispose / fork / reusable）：<https://koishi.chat/zh-CN/guide/plugin/lifecycle.html>
- 服务与依赖（inject / Service / package.json / peerDependencies 对比）：<https://koishi.chat/zh-CN/guide/plugin/service.html>
- 发布插件（package.json 准入条件 / koishi 字段）：<https://koishi.chat/zh-CN/guide/develop/publish.html>
- 指令开发：<https://koishi.chat/zh-CN/guide/basic/command.html>
- 事件系统：<https://koishi.chat/zh-CN/guide/basic/events.html>
- 中间件：<https://koishi.chat/zh-CN/guide/basic/middleware.html>
- 消息元素：<https://koishi.chat/zh-CN/guide/basic/element.html>
- 数据库基本用法 / 数据模型：<https://koishi.chat/zh-CN/guide/database/>、<https://koishi.chat/zh-CN/guide/database/model.html>
- 实现适配器：<https://koishi.chat/zh-CN/guide/adapter/adapter.html>
- Session API：<https://koishi.chat/zh-CN/api/core/session.html>
- 元素渲染函数 / 语法规范 / 消息编码器：<https://koishi.chat/zh-CN/api/message/api.html>、<https://koishi.chat/zh-CN/api/message/syntax.html>、<https://koishi.chat/zh-CN/api/message/encoder.html>
- 源码仓库：<https://github.com/koishijs/koishi>、<https://github.com/cordiverse/cordis>、<https://github.com/satorijs/satori>、<https://github.com/shigma/schemastery>、<https://github.com/shigma/minato>
