import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'

export const controlHeader = 'x-jiuli-control'

function controlFile(port: number | string) {
  if (!/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535)
    throw new Error('无效的本机服务端口')
  return path.resolve('temp', `jiuli-control-${Number(port)}.token`)
}

/** 仅当前实例持有；成功监听后才写入，避免启动失败覆盖运行中实例的凭据。 */
export async function saveControlToken(port: number | string, token: string) {
  const file = controlFile(port)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, token, { mode: 0o600 })
  await fs.chmod(file, 0o600)
}

export async function readControlToken(port: number | string) {
  const token = await fs.readFile(controlFile(port), 'utf8')
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('本机服务控制凭据无效')
  return token
}

/** 固定直连回环地址，不向代理或重定向目标发送本机控制凭据。 */
export async function requestLocalStop(port: number | string, auth: Record<string, string> = {}) {
  const token = await readControlToken(port)
  return new Promise<void>((resolve, reject) => {
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port: Number(port),
        path: '/exit',
        method: 'GET',
        agent: false,
        headers: { ...auth, [controlHeader]: token },
      },
      response => {
        response.resume()
        if (response.statusCode !== 202)
          request.destroy(new Error(`服务拒绝停止请求（HTTP ${response.statusCode}）`))
        else response.once('end', resolve)
        response.once('error', reject)
      },
    )
    const timer = setTimeout(() => request.destroy(new Error('停止服务请求超时')), 5000)
    request.once('error', reject)
    request.once('close', () => clearTimeout(timer))
    request.end()
  })
}
