# 你自己的插件放这里

这个目录是留给**你自己写的插件**的：往里丢一个 `.js` 就会被加载，改动即时热重载，不用重启。

```bash
# 1. 生成骨架（默认就生成到这个目录）
pnpm jiuli create my-plugin

# 2. 或者手动新建，比如 plugins/example/天气.js
#    然后终端发 #重载 或直接等 2 秒（内核会自动检测新增文件）
```

目录里的 `qqbot图床.js` 是自行加入的第三方文件（已在 `.gitignore` 中排除，不入库）。

## 相关约定

- 一个 `.js` = 一个插件；也可以建子目录（子目录里放 `index.js`，或者直接平铺多个 js）
- 渲染模板放在 `resources/<模板名>/index.html`（例如 `resources/天气/index.html`），
  插件里用 `await this.render('天气/index', data)` 引用
- 想放自己的数据：`this.dataDir`（`data/plugins/<插件目录名>/`）
- 完整说明见 [`../README.md`](../README.md) 与 [`../../docs/plugin-guide.md`](../../docs/plugin-guide.md)

> 内置功能在 `../system/`，示例在 `../demo/`，适配器在 `../adapter/`——这三个目录随框架更新，建议不要往里放自己的代码。
