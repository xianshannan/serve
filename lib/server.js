// Native
const path = require('path')
const { parse, format } = require('url')

// Packages
const micro = require('micro')
const auth = require('basic-auth')
const { red } = require('chalk')
const fs = require('fs-extra')
const pathType = require('path-type')
const mime = require('mime-types')
const stream = require('send')
const { coroutine } = require('bluebird')
const urlParser = require('url-parse')

// Utilities
const renderDirectory = require('./render')

module.exports = coroutine(function*(req, res, flags, current, ignoredFiles) {
  /**
   * Express 正则匹配mock
   * @param { string } mockContainerPath mock文件夹容器
   * @param { string } notFoundResponse 404 reponse text
   * @param { string } mockRule mock规则，可以使正则表达式
   * eg. '/common-api/(.*)'
   * @param { string } moackTarget mock目标路径，相对于`paths.publicPath`。
   * eg. '/mock/$1.json'
   * @return true返回404状态，false返回正常
   */
  function mock(mockContainerPath, notFoundResponse, mockRule, mockTarget) {
    const mock = new RegExp(mockRule)
    const matchStatusReg = /\|(.*)$/
    let target = mockTarget
    target = target.replace(matchStatusReg, '')
    let status = 200
    const { query: { __status__ } } = urlParser(req.url, true)
    if (__status__) {
      status = __status__
    }
    let targetPath = target
    const match = req.url.match(mock)
    if (!match) {
      // True返回404
      return true
    }
    // eslint-disable-next-line no-unused-expressions
    match &&
      match.forEach((v, k) => {
        targetPath = targetPath.replace(`$${k}`, v)
      })
    try {
      // Mock文件路径
      const mockFilePath = path.join(mockContainerPath, targetPath)
      const mockJsFilePath = mockFilePath.replace('.json', '.js')
      if (fs.existsSync(mockFilePath)) {
        let mockContents
        if (/\.js$/.test(mockFilePath)) {
          mockContents = require(mockFilePath)
        } else {
          mockContents = fs.readFileSync(mockFilePath, {
            encoding: 'utf-8'
          })
        }
        if (
          Object.prototype.toString.apply(mockContents) === '[object Function]'
        ) {
          mockContents = mockContents(req, res)
        }
        micro.send(res, status, mockContents)
      } else if (fs.existsSync(mockJsFilePath)) {
        // 如果找不到.json的文件（规则中配置了.json），读取.js文件
        let mockContents = require(mockJsFilePath)
        if (
          Object.prototype.toString.apply(mockContents) === '[object Function]'
        ) {
          mockContents = mockContents(req, res)
          micro.send(res, status, mockContents)
        } else {
          console.log(new Error('mock js文件的需要exports函数！'))
        }
      } else {
        // True返回404
        return true
      }
    } catch (err) {
      console.error(new Error(err))
    }
    // False返回正常数据
    return false
  }

  function pathnameAdapter(pathname) {
    if (!pathname) {
      return ''
    }
    if (Object.prototype.toString.apply(pathname) !== '[object String]') {
      console.error('Please input string！')
      return
    }
    // Pathname first char must be '/'.
    if (pathname[0] !== '/') {
      pathname = '/' + pathname
    }
    // Pathname last char can not be '/'.
    if (pathname[pathname.length - 1] === '/') {
      pathname = pathname.slice(0, pathname.length - 1)
    }
    return pathname
  }
  const headers = {}
  let basename = ''
  // Mock配置
  let mockConfig = flags.mockConfig
  if (mockConfig) {
    mockConfig = JSON.parse(mockConfig)
  }
  if (flags.single) {
    // Basename only work with single.
    basename = pathnameAdapter(flags.basename)
  }

  if (flags.cors) {
    headers['Access-Control-Allow-Origin'] = '*'
    headers['Access-Control-Allow-Headers'] =
      'Origin, X-Requested-With, Content-Type, Accept, Range'
  }

  for (const header in headers) {
    if (!{}.hasOwnProperty.call(headers, header)) {
      continue
    }

    res.setHeader(header, headers[header])
  }

  if (flags.auth) {
    const credentials = auth(req)

    if (!process.env.SERVE_USER || !process.env.SERVE_PASSWORD) {
      const error =
        'The environment variables "SERVE_USER" ' +
        'and/or "SERVE_PASSWORD" are missing!'
      console.error(red(error))

      // eslint-disable-next-line unicorn/no-process-exit
      process.exit(1)
    }

    if (
      !credentials ||
      credentials.name !== process.env.SERVE_USER ||
      credentials.pass !== process.env.SERVE_PASSWORD
    ) {
      res.statusCode = 401
      res.setHeader('WWW-Authenticate', 'Basic realm="User Visible Realm"')
      return micro.send(res, 401, 'Access Denied')
    }
  }

  const { pathname } = parse(req.url)
  const assetDir = path.normalize(process.env.ASSET_DIR)

  let related = path.parse(path.join(current, pathname))
  let assetRequest = false

  if (related.dir.indexOf(assetDir) > -1) {
    assetRequest = true
    const relative = path.relative(assetDir, pathname)
    related = path.parse(path.join(__dirname, '/../assets', relative))
  }

  related = decodeURIComponent(path.format(related))
  let notFoundResponse = 'Not Found'

  try {
    const custom404Path = path.join(current, '/404.html')
    notFoundResponse = yield fs.readFile(custom404Path, 'utf-8')
  } catch (err) {}

  // Don't allow rendering ignored files
  const ignored = !ignoredFiles.every(item => {
    return !pathname.includes(item)
  })
  // Mock 服务
  function mockService() {
    let isNotFound = true
    if (mockConfig) {
      // eslint-disable-next-line guard-for-in
      for (const k in mockConfig) {
        const mockTarget = mockConfig[k]
        const match = req.url.match(new RegExp(k))
        if (match) {
          isNotFound = mock(
            path.resolve(flags.mockDir || './'),
            notFoundResponse,
            k,
            mockTarget
          )
        }
      }
    }
    return isNotFound
  }
  function notFound() {
    if (mockConfig) {
      const isNotFound = mockService()
      // eslint-disable-next-line no-negated-condition
      if (!isNotFound) {
        return false
        // eslint-disable-next-line no-else-return
      } else {
        return micro.send(res, 404, notFoundResponse)
      }
      // eslint-disable-next-line no-else-return
    } else {
      return micro.send(res, 404, notFoundResponse)
    }
  }
  if (ignored || (!assetRequest && related.indexOf(current) !== 0)) {
    // 检查是否有mock，原来这里是返回404的
    return notFound()
  }

  const relatedExists = yield fs.exists(related)

  if (!relatedExists && !flags.single) {
    return notFound()
  }

  const streamOptions = {}

  if (flags.cache) {
    streamOptions.maxAge = flags.cache
  } else if (flags.cache === 0) {
    // Disable the cache control by `send`, as there's no support for `no-cache`.
    // Set header manually.
    streamOptions.cacheControl = false
    res.setHeader('Cache-Control', 'no-cache')
  } else if (flags.single) {
    // Cache assets of single page applications for a day.
    // Later in the code, we'll define that `index.html` never
    // Gets cached!
    // StreamOptions.maxAge = 86400000
    // No cached
    streamOptions.maxAge = 0
  }

  // Check if directory
  if (relatedExists && (yield pathType.dir(related))) {
    // Normalize path to trailing slash
    // Otherwise problems like #70 will occur
    const url = parse(req.url)

    if (url.pathname.substr(-1) !== '/') {
      url.pathname += '/'
      const newPath = format(url)

      res.writeHead(302, {
        Location: newPath
      })

      res.end()
      return
    }

    let indexPath = path.join(related, '/index.html')
    if (related === current) {
      indexPath = path.join(related, `${basename}/index.html`)
    }
    res.setHeader('Content-Type', mime.contentType(path.extname(indexPath)))

    if (!(yield fs.exists(indexPath))) {
      // Try to render the current directory's content
      const port = flags.port || req.socket.localPort
      const renderedDir = yield renderDirectory(
        port,
        current,
        related,
        ignoredFiles
      )

      // If it works, send the directory listing to the user
      if (renderedDir) {
        return micro.send(res, 200, renderedDir)
      }

      // And if it doesn't, see if it's a single page application
      // If that's not true either, send an error
      if (!flags.single) {
        return notFound()
      }

      // But IF IT IS true, load the SPA's root index file
      indexPath = path.join(current, `${basename}/index.html`)
    }
    return stream(req, indexPath, streamOptions).pipe(res)
  }

  if (!(yield fs.exists(related)) && flags.single) {
    // Don't cache the `index.html` file for single page applications
    streamOptions.maxAge = 0

    // Load `index.html` and send it to the client
    const indexPath = path.join(current, `${basename}/index.html`)
    const flag = mockService()
    if (flag) {
      return stream(req, indexPath, streamOptions).pipe(res)
      // eslint-disable-next-line no-else-return
    } else {
      return flag
    }
  }

  // Serve files without a mime type as html for SPA, and text for non SPA
  // eslint-disable-next-line camelcase
  stream.mime.default_type = flags.single ? 'text/html' : 'text/plain'
  return stream(
    req,
    related,
    Object.assign(
      {
        dotfiles: 'allow'
      },
      streamOptions
    )
  ).pipe(res)
})
