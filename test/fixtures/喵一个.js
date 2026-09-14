

export class Example extends plugin {
  constructor() {
    super({
      name: '',
      dsc: '爱发电',
      event: 'message',
      priority: -11451111114,
      rule: [
        {
          reg: '^爱发电$',
          fnc: 'cs'
        },
        {
          reg: '^喵一个$',
          fnc: 'css'
        }
      ]
    })
  }

  async cs(e) {
    logger.info('[afd.js插件]')
    e.reply(`https://afdian.com/a/zhilaohu`)
    return true
  }

async css(e) {
    logger.info('[afd.js插件]')
    e.reply(`喵?`)
    return true
  }
}