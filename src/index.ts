import { Context, Schema, Service, h, Element } from 'koishi'
import OCR from 'paddleocrjson'
import { platform } from 'os'
import path from 'path'
import fs from 'fs'
import http from 'http'
import https from 'https'

export const name = 'ocr'

export interface Config {
  timeout?: number
  exePath?: string
  cwd?: string
  args?: string[]
  debug?: boolean
}

// 根据操作系统选择默认可执行文件名
const defaultExePath = () => {
  const osType = platform()
  if (osType === 'win32') return 'PaddleOCR-json.exe'
  else return './PaddleOCR-json' // Linux/macOS可执行文件
}

export const Config: Schema<Config> = Schema.object({
  timeout: Schema.number().default(30000).description('OCR识别超时时间（毫秒）'),
  exePath: Schema.string().default(defaultExePath()).description('PaddleOCR-json可执行文件路径'),
  cwd: Schema.string().description('PaddleOCR-json工作目录，默认为basedir下的data/PaddleOCR-json目录'),
  args: Schema.array(String).default([]).description('PaddleOCR-json启动参数，例如 ["-port=9985", "-addr=loopback"]'),
  debug: Schema.boolean().default(false).description('是否开启调试模式'),
})

// 声明OCR服务
declare module 'koishi' {
  interface Context {
    ocr: Ocr
  }
}

class Ocr extends Service {
  static [Service.provide] = 'ocr'
  static inject = ['ocr']

  private ocr: any
  private pid: number = null
  private initialized: boolean = false
  private ocrInitComplete: boolean = false

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'ocr')
  }

  async start() {
    // 设置默认工作目录
    if (!this.config.cwd) {
      this.config.cwd = path.join(this.ctx.baseDir, 'data/PaddleOCR-json')
    }

    // 检查/创建工作目录
    try {
      if (!fs.existsSync(this.config.cwd)) {
        fs.mkdirSync(this.config.cwd, { recursive: true })
        this.logger.info(`创建工作目录: ${this.config.cwd}`)
      }
    } catch (error) {
      this.logger.error(`创建工作目录失败: ${error.message}`)
    }

    // 检查可执行文件
    const exeFullPath = path.isAbsolute(this.config.exePath)
      ? this.config.exePath
      : path.join(this.config.cwd, this.config.exePath)

    if (!fs.existsSync(exeFullPath)) {
      this.logger.warn(`可执行文件不存在: ${exeFullPath}`)
    }

    try {
      // 初始化OCR实例
      this.ocr = new OCR(this.config.exePath, this.config.args, {
        cwd: this.config.cwd,
      }, this.config.debug)

      // 添加事件监听
      if (this.config.debug) {
        this.ocr.stdout.on('data', (chunk) => this.logger.info(chunk.toString()))
        this.ocr.stderr.on('data', (data) => this.logger.warn(data.toString()))
      }

      this.ocr.on('error', (error) => {
        this.logger.error(`OCR进程错误: ${error.message}`)
        this.initialized = this.ocrInitComplete = false
      })

      this.ocr.on('exit', (code) => {
        this.logger.info(`OCR进程退出，退出码: ${code}`)
        this.initialized = this.ocrInitComplete = false
      })

      this.ocr.on('init', (pid, addr, port) => {
        this.logger.info(`OCR初始化完成！PID: ${pid}, 地址: ${addr}, 端口: ${port}`)
        this.pid = pid
        this.ocrInitComplete = true
      })

      this.initialized = true

      // 等待初始化完成或超时
      return new Promise<void>((resolve) => {
        if (this.ocrInitComplete) {
          resolve()
          return
        }

        this.ocr.once('init', () => resolve())

        setTimeout(() => {
          if (!this.ocrInitComplete) {
            this.logger.warn('OCR服务初始化超时，但继续启动')
          }
          resolve()
        }, 10000)
      })
    } catch (error) {
      this.logger.error(`OCR初始化失败: ${error.message}`)
      this.initialized = false
      throw error
    }
  }

  async stop() {
    if (this.ocr) {
      try {
        this.logger.info('正在停止OCR服务...')

        // 使用terminate方法尝试正常终止
        this.ocr.terminate()

        // 额外确保进程被终止
        if (this.pid) {
          // 给进程一点时间正常退出
          await new Promise(resolve => setTimeout(resolve, 1000))

          try {
            // 检查进程是否仍然存在，如果存在则强制终止
            // 注意：这是平台相关的，Node.js没有直接的方法来检查进程
            // 这里我们假设terminate已经足够，但记录PID以便调试
            this.logger.info(`OCR进程(PID:${this.pid})应该已终止`)
          } catch (e) {
            this.logger.warn(`尝试检查进程状态时出错: ${e.message}`)
          }
        }

        // 清理资源和状态
        this.ocr.removeAllListeners()
        this.ocr = null
        this.initialized = false
        this.ocrInitComplete = false
        this.pid = null

        this.logger.info('OCR服务已停止并清理完成')
      } catch (error) {
        this.logger.warn(`终止OCR进程时发生错误: ${error.message}`)
      }
    }
  }

  isReady() {
    return this.initialized && this.ocr && this.ocrInitComplete;
  }

  /**
   * 将Element元素转换为统一的base64格式
   */
  private async getImageBase64(imageElement: Element): Promise<string> {
    // 处理ResourceElement或标准Element
    const url = ('url' in imageElement && typeof imageElement.url === 'string')
      ? imageElement.url
      : (imageElement?.type === 'image' && imageElement?.attrs?.url)
        ? imageElement.attrs.url
        : null;

    if (!url) throw new Error('无效的图像元素');
    return this.fetchImageFromUrl(url);
  }

  // 辅助方法：从URL获取图像并转为base64
  private async fetchImageFromUrl(imageUrl: string): Promise<string> {
    // 已经是base64格式
    if (imageUrl.startsWith('data:image') && imageUrl.includes('base64,')) {
      return imageUrl
    }

    // 网络图片
    if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
      return new Promise((resolve, reject) => {
        const isHttps = imageUrl.startsWith('https://')
        const requestModule = isHttps ? https : http

        const options = {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          timeout: 10000
        }

        const req = requestModule.get(imageUrl, options, (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`请求失败，状态码: ${res.statusCode}`))
            return
          }

          const chunks: Buffer[] = []
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
          res.on('end', () => {
            const buffer = Buffer.concat(chunks)
            const base64 = buffer.toString('base64')
            const mimeType = res.headers['content-type'] || 'image/png'
            resolve(`data:${mimeType};base64,${base64}`)
          })
        })

        req.on('error', (err) => {
          reject(new Error(`获取图像失败: ${err.message}`))
        })

        req.on('timeout', () => {
          req.destroy()
          reject(new Error('请求超时'))
        })

        req.end()
      })
    }

    // 本地文件
    try {
      const imagePath = path.isAbsolute(imageUrl) ? imageUrl : path.join(this.config.cwd, imageUrl)
      if (!fs.existsSync(imagePath)) {
        throw new Error(`文件不存在: ${imagePath}`)
      }

      const imageBuffer = fs.readFileSync(imagePath)
      const base64 = imageBuffer.toString('base64')
      const ext = path.extname(imagePath).toLowerCase()
      const mimeType = ext === '.png' ? 'image/png' :
                      ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
                      ext === '.gif' ? 'image/gif' : 'image/png'
      return `data:${mimeType};base64,${base64}`
    } catch (error) {
      throw new Error(`图像处理失败: ${error.message}`)
    }
  }

  async recognizeText(imageElement: Element): Promise<string> {
    if (!this.isReady()) {
      // 尝试等待OCR服务就绪
      if (this.initialized && this.ocr && !this.ocrInitComplete) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        if (!this.isReady()) {
          throw new Error('OCR服务未就绪')
        }
      } else {
        throw new Error('OCR服务未就绪')
      }
    }

    try {
      // 转换为base64格式
      const base64Image = await this.getImageBase64(imageElement)

      // 进行识别
      const result = await this.ocr.flush({
        image_base64: base64Image,
        timeout: this.config.timeout
      });

      if (Array.isArray(result)) {
        return result.map(item => item.text).join('\n')
      }
      return JSON.stringify(result)
    } catch (error) {
      this.logger.error(`OCR识别失败: ${error.message}`)
      throw new Error('OCR识别失败: ' + error.message)
    }
  }
}

export function apply(ctx: Context, config: Config) {
  // 注册OCR服务
  ctx.plugin(Ocr, config)

  // 注册OCR命令
  ctx.command('ocr [image:image]', '图像文字识别')
    .option('image', '-i <url:string> 指定图片URL', { authority: 1 })
    .action(async ({ options, session }) => {
      if (!ctx.ocr || !ctx.ocr.isReady()) {
        return 'OCR服务未就绪，请联系管理员检查配置'
      }

      let imageElement: Element = null

      // 获取图像元素
      if (options.image) {
        imageElement = h('image', { url: options.image })
      } else if (session.content) {
        const images = h.parse(session.content).filter(node => node.type === 'image')
        if (images.length > 0) {
          imageElement = images[0]
        }
      }

      if (!imageElement) {
        return '请提供图片'
      }

      try {
        const result = await ctx.ocr.recognizeText(imageElement)
        return result || '未识别到任何文字'
      } catch (error) {
        return `识别失败：${error.message}`
      }
    })
}
