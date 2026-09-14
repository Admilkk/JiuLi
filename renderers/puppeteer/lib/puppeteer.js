/**
 * puppeteer 渲染后端
 * 与本机 Chrome/Edge 配合：优先连接已有实例（redis 缓存 ws 端点），否则本地启动
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import timers from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer'
import { ulid } from 'ulid'
import Renderer from '../../../lib/renderer/Renderer.js'
import cfg from '../../../lib/config/config.js'

let mac = ''

export default class Puppeteer extends Renderer {
  constructor(config) {
    super({
      id: 'puppeteer',
      type: 'image',
      render: 'screenshot',
    })
    this.browser = false
    this.lock = false
    this.browserInitPromise = null
    this.shoting = []
    /** 截图数达到时重启浏览器，避免生成速度越来越慢 */
    this.restartNum = config.restartNum || 100
    /** 截图次数 */
    this.renderNum = 0
    /** 空闲自动关闭浏览器时间 ms（0 为不自动关闭） */
    this.idleTime = (config.idleTime ?? 30) * 60000
    this.idleTimer = null
    this.config = {
      headless: 'new',
      args: ['--disable-gpu', '--disable-setuid-sandbox', '--no-sandbox', '--no-zygote'],
      ...config,
    }
    /** puppeteer >= 22：'new' 已等价于 true */
    if (this.config.headless === 'new') this.config.headless = true
    /** chromium 其他路径 */
    if (config.chromiumPath || cfg?.bot?.chromium_path)
      this.config.executablePath = config.chromiumPath || cfg?.bot?.chromium_path
    if (config.puppeteerWS || cfg?.bot?.puppeteer_ws)
      this.config.wsEndpoint = config.puppeteerWS || cfg?.bot?.puppeteer_ws
    this.puppeteerTimeout = config.puppeteerTimeout || cfg?.bot?.puppeteer_timeout || 0
    this.pageGotoParams = config.pageGotoParams || { timeout: 120000, waitUntil: 'networkidle2' }
  }

  /** 初始化 chromium（并发安全） */
  async browserInit() {
    if (this.browserInitPromise) return this.browserInitPromise
    if (this.browser) return this.browser
    this.lock = true
    this.browserInitPromise = this.createBrowser()
    try {
      return await this.browserInitPromise
    } finally {
      this.browserInitPromise = null
      this.lock = false
    }
  }

  async createBrowser() {
    logger.info('puppeteer Chromium 启动中...')

    let connectFlag = false
    try {
      if (!mac) {
        mac = this.getMac()
        this.browserMacKey = `Yz:chromium:browserWSEndpoint:${mac}`
      }
      const browserUrl = (await redis.get(this.browserMacKey)) || this.config.wsEndpoint
      if (browserUrl) {
        try {
          const browserWSEndpoint = await puppeteer.connect({ browserWSEndpoint: browserUrl })
          if (browserWSEndpoint) {
            this.browser = browserWSEndpoint
            connectFlag = true
          }
          logger.info(`puppeteer Chromium 连接成功 ${browserUrl}`)
        } catch {
          await redis.del(this.browserMacKey)
        }
      }
    } catch {}

    if (!this.browser || !connectFlag) {
      let config = this.config
      if (!config.userDataDir) {
        await fs.rm('temp/puppeteer', { force: true, recursive: true }).catch(() => {})
        config = { ...config, userDataDir: `temp/puppeteer/${ulid()}` }
      }
      this.browser = await puppeteer.launch(config).catch(err => {
        const errMsg = err.toString()
        logger.error(err)
        if (errMsg.includes('Could not find Chromium'))
          logger.error('没有正确安装 Chromium，可以尝试执行安装命令：node node_modules/puppeteer/install.js')
        else if (errMsg.includes('cannot open shared object file')) logger.error('没有正确安装 Chromium 运行库')
      })
    }

    if (!this.browser) {
      logger.error('puppeteer Chromium 启动失败')
      return false
    }

    if (!connectFlag) {
      logger.info(`puppeteer Chromium 启动成功 ${this.browser.wsEndpoint()}`)
      if (this.browserMacKey)
        await redis.set(this.browserMacKey, this.browser.wsEndpoint(), { EX: 60 * 60 * 24 * 30 }).catch(() => {})
    }

    this.browser.on('disconnected', this.onDisconnected)
    return this.browser
  }

  /** 获取本机 mac 地址（用于多进程共享浏览器实例） */
  getMac() {
    let value = '00:00:00:00:00:00'
    try {
      const network = os.networkInterfaces()
      for (const name in network)
        for (const i of network[name] || [])
          if (i.mac && i.mac !== '00:00:00:00:00:00') {
            value = i.mac
            return value.replace(/:/g, '')
          }
    } catch {}
    return value.replace(/:/g, '')
  }

  /**
   * 截图
   * @param name 保存目录名
   * @param data 模板参数
   * @param data.tplFile 模板路径，必传
   * @param data.saveId 生成 html 名称，为空用 name 代替
   * @param data.imgType 图片类型：jpeg/png
   * @param data.quality 图片质量 0-100（jpeg）
   * @param data.omitBackground 背景透明
   * @param data.path 截图保存路径（不传则不落盘）
   * @param data.multiPage 是否分页截图
   * @param data.multiPageHeight 分页高度，默认 4000
   * @param data.pageGotoParams 页面 goto 参数
   * @return Buffer | Buffer[]，不做 segment 包裹
   */
  async screenshot(name, data = {}) {
    if (!(await this.browserInit())) return false
    const pageHeight = data.multiPageHeight || 4000

    const savePath = this.dealTpl(name, data)
    if (!savePath) return false

    let buff = ''
    const start = Date.now()
    const ret = []
    let page
    this.shoting.push(name)

    const puppeteerTimeout = this.puppeteerTimeout
    let overtime
    if (puppeteerTimeout > 0)
      overtime = setTimeout(() => {
        if (this.shoting.length) {
          logger.error(`[图片生成][${name}] 截图超时，当前等待队列：${this.shoting.join(',')}`)
          this.restart(true)
          this.shoting = []
        }
      }, puppeteerTimeout)

    try {
      page = await this.browser.newPage()
      const pageGotoParams = { ...this.pageGotoParams, ...data.pageGotoParams }
      await page.goto(pathToFileURL(path.resolve(savePath)).href, pageGotoParams)
      const body = (await page.$('#container')) || (await page.$('body'))

      const boundingBox = await body.boundingBox()
      let num = 1

      const randData = {
        type: data.imgType || 'jpeg',
        omitBackground: data.omitBackground || false,
        quality: data.quality || 90,
        path: data.path || '',
      }

      if (data.multiPage) {
        randData.type = 'jpeg'
        num = Math.round(boundingBox.height / pageHeight) || 1
      }
      if (data.imgType === 'png') delete randData.quality

      if (!data.multiPage) {
        buff = await body.screenshot(randData)
        if (!Buffer.isBuffer(buff)) buff = Buffer.from(buff)
        this.renderNum++
        const kb = `${(buff.length / 1024).toFixed(2)}KB`
        logger.mark(`[图片生成][${name}][${this.renderNum}次] ${kb} ${logger.green(`${Date.now() - start}ms`)}`)
        ret.push(buff)
      } else {
        if (num > 1)
          await page.setViewport({
            width: boundingBox.width,
            height: pageHeight + 100,
          })
        for (let i = 1; i <= num; i++) {
          if (i !== 1 && i === num)
            await page.setViewport({
              width: boundingBox.width,
              height: parseInt(String(boundingBox.height), 10) - pageHeight * (num - 1),
            })
          if (i !== 1 && i <= num) await page.evaluate(h => window.scrollBy(0, h), pageHeight)

          if (num === 1) buff = await body.screenshot(randData)
          else buff = await page.screenshot(randData)
          if (!Buffer.isBuffer(buff)) buff = Buffer.from(buff)
          if (num > 2) await timers.setTimeout(200)

          this.renderNum++
          const kb = `${(buff.length / 1024).toFixed(2)}KB`
          logger.mark(`[图片生成][${name}][${i}/${num}] ${kb}`)
          ret.push(buff)
        }
        if (num > 1) logger.mark(`[图片生成][${name}] 处理完成`)
      }
    } catch (err) {
      logger.error(`[图片生成][${name}] 图片生成失败`, err)
      this.restart(true)
      return false
    } finally {
      if (overtime) clearTimeout(overtime)
      if (page) await page.close().catch(err => logger.error(err))
      const index = this.shoting.indexOf(name)
      if (index !== -1) this.shoting.splice(index, 1)
    }

    if (ret.length === 0 || !ret[0]) {
      logger.error(`[图片生成][${name}] 图片生成为空`)
      return false
    }

    this.restart()
    this.resetIdleTimer()
    return data.multiPage ? ret : ret[0]
  }

  /** 断开连接时重启浏览器 */
  onDisconnected = () => this.restart(true)

  /** 空闲超时自动关闭浏览器，下次截图时自动重启 */
  resetIdleTimer() {
    if (!this.idleTime) return
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.shoting.length || this.lock || this.config.wsEndpoint) return
      if (!this.browser?.close) return
      logger.info('puppeteer Chromium 空闲超时，自动关闭')
      const browser = this.browser
      this.browser = false
      browser.removeListener('disconnected', this.onDisconnected)
      this.stop(browser).then(() => this.browserMacKey && redis.del(this.browserMacKey).catch(() => {}))
    }, this.idleTime)
    this.idleTimer.unref?.()
  }

  /** 重启 */
  restart(force = false) {
    if (!this.browser?.close || this.lock) return
    if (!force) if (this.renderNum % this.restartNum !== 0 || this.shoting.length > 0) return
    logger.info(`puppeteer Chromium ${force ? '强制' : ''}关闭重启...`)
    const browser = this.browser
    this.browser = false
    return this.stop(browser).then(() => this.browserInit())
  }

  async stop(browser) {
    try {
      await browser.close()
    } catch (err) {
      logger.error('puppeteer Chromium 关闭错误', err)
    }
  }
}
