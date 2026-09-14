# JiuLi

> A next-generation bot framework compatible with the TRSS-Yunzai plugin ecosystem · TypeScript kernel · three-layer architecture

JiuLi is a refactor of [TRSS-Yunzai](https://gitee.com/TimeRainStarSky/Yunzai).
Goal: **high performance, fully typed, while running all legacy Yunzai plugins without modification.**

> The full documentation is currently in Chinese: see [README.md](README.md),
> [docs/architecture.md](docs/architecture.md) and [docs/plugin-guide.md](docs/plugin-guide.md).

## Highlights

- **Zero-change legacy plugin support** — physical `lib/**` shims, global variables (`Bot / logger / redis / segment / Renderer / plugin`),
  the `e` event contract and `Bot` implicit semantics are all preserved.
- **TypeScript kernel** (`src/**` → `lib/core/**`) with `pnpm typecheck`; plugin authors get the
  `jiuli` package (`JiuLiPlugin`, `definePlugin`, `command`, `task`, `accept`, `handler`).
- **Performance work over TRSS-Yunzai**: lazy `e.runtime`, event-type indexed dispatch,
  single-instance dispatch, batched message counters (same Redis key layout), slow-plugin metrics.
- **Pluggable renderers** — scans `renderers/<name>/`; built-in puppeteer backend with lazy browser start and idle shutdown.
- **Optional Redis** — falls back to an in-memory implementation when a local Redis is unavailable.

## Quick start

```bash
pnpm install
pnpm build      # compile TypeScript kernel (src → lib/core)
node .          # start
node test/smoke.mjs   # smoke test (legacy plugins + native plugins + render pipeline)
```

Debug without a protocol backend: `plugins/jiuli-adapter-mock` logs every outgoing message;
set `JIULI_MOCK_STDIN=1` and feed one JSON event per line on stdin.

## License

AGPL-3.0, same as TRSS-Yunzai. Original copyright (TimeRainStarSky, Yoimiya-Kokomi, Le-niao and others) is retained.
