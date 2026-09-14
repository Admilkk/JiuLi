/**
 * JiuLi 启动入口
 * 启动模式：stop / daemon / pm2 / start / 默认(internal)
 */
switch (process.env.app_type || process.argv[2]) {
  case 'stop': {
    const cfg = (await import('./lib/core/config/index.js')).default
    await fetch(`http://localhost:${cfg.server.port}/exit`, {
      headers: cfg.server.auth || undefined,
    }).catch(() => {})
    process.exit()
  }
  case 'daemon': {
    console.log('守护进程正在启动主进程')
    const { spawnSync } = await import('node:child_process')
    while (
      spawnSync(process.argv[0], [process.argv[1], 'start', ...process.argv.slice(2)], {
        stdio: 'inherit',
      }).status !== 255
    ) {
      console.log('守护进程正在重启主进程')
    }
    console.log('守护进程已停止')
    process.exit()
  }
  case 'pm2':
    global.start_type = 'pm2'
    break
  case 'start':
    global.start_type = 'external'
    break
  default:
    global.start_type = 'internal'
}

const { start } = await import('./lib/core/start.js')
await start()
