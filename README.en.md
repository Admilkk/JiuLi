# JiuLi

Docs: <https://hlz7.com/jiuli/>

A bot framework compatible with the TRSS-Yunzai plugin ecosystem. TypeScript kernel.

- **Legacy plugins run unmodified** — `lib/**` physical-path shims, global variables
  (`Bot / logger / redis / segment / Renderer / plugin`), the `e` event contract and `Bot` implicit semantics are preserved
- **TypeScript kernel** — `src/**` compiled to `lib/core/**`, `pnpm typecheck` available;
  plugin authors import the `jiuli` package (`JiuLiPlugin`, `definePlugin`, `command`, `task`, `accept`, `handler`)
- **Small core** — no bundled game/AI features, only status / help / master / word-entries / restart
- **Swappable adapters** — protocol backends are plugins (`Bot.adapter.push`)
- Performance over TRSS-Yunzai: lazy `e.runtime`, event-type indexed dispatch, single-instance dispatch,
  batched message counters (same Redis key layout), lazy log strings

## Quick start

```bash
pnpm install && pnpm start     # install → build kernel → start with pm2
node .                         # foreground: type commands directly in the terminal
> #玖璃帮助
> #设置主人
```

CLI: `node jiuli <command>` (`s` start, `x` stop, `r` restart, `l` log, `st` status, `c` create plugin, `a` add plugin, `b` build).

```bash
node test/smoke.mjs   # smoke test (legacy + native plugins + render pipeline)
```

Debug without a protocol backend: `plugins/adapter/mock.js` logs every outgoing message;
with `JIULI_MOCK_STDIN=1` you can feed one JSON event per line on stdin.

## Documentation

Chinese only for now:

- [README.md](README.md) — install, CLI, config, compatibility
- [docs/architecture.md](docs/architecture.md) — layers, dispatch, startup cost analysis
- [docs/plugin-guide.md](docs/plugin-guide.md) — plugin development (legacy / native / DSL)

## License

AGPL-3.0, same as TRSS-Yunzai. Original copyright (TimeRainStarSky, Yoimiya-Kokomi, Le-niao and others) is retained.
