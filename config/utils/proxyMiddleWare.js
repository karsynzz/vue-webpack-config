/**
 * Created by liuzhengdong on 2017/9/6.
 */
const path = require('path')
const urlUtils = require('url')
const koaHttpProxy = require('koa-better-http-proxy')
const compose = require('koa-compose')
const appConfig = require('./../../app.config')
const { IS_DEBUG, IS_SERVER_PRODUCTION } = require('./env')

const needToken = !!appConfig.token
let tokenManager
if (needToken) {
  tokenManager = require('./token')(appConfig.token)
}

/**
 * 获取代理配置
 * @return {*} 代理配置
 */
function getProxyConfig () {
  // 开发模式每次重新读取
  if (!IS_DEBUG) {
    return appConfig.proxy
  }
  // 生产环境读取
  const serverConfig = require(path.join(process.cwd(), 'server.config.js'))
  return serverConfig.proxy
}

/**
 * 代理处理中间件
 * @return {Function} koa middleware
 */
module.exports = function () {
  async function preProxyMiddleware (ctx, next) {
    const url = ctx.url
    let proxyTarget
    let proxyConfig = getProxyConfig()
    // 在appConfig.proxy中寻找匹配前缀的代理
    for (const [prefix, target] of Object.entries(proxyConfig)) {
      if (url.startsWith(prefix)) {
        // 匹配替换
        if (!IS_DEBUG) {
          ctx.url = url.replace(prefix, '')
        }
        proxyTarget = target
        ctx._proxyTarget = proxyTarget

        console.log(`Match to proxy: '${prefix}' => '${proxyTarget}'`)
        break
      }
    }
    if (!proxyTarget) {
      console.log('Proxy not found, skipped')
      return Promise.resolve()
    }
    console.log(`Request '${url}' will be proxied to '${proxyTarget + ctx.url}'`)
    return next()
  }

  return compose([
    preProxyMiddleware,
    koaHttpProxy('0', {
      // 不解析body，不限制body大小
      parseReqBody: false,
      /**
       * 发出代理请求前的回调
       * @param {Object} proxyReqOpts - 代理请求选项
       * @param {ctx} ctx - koa ctx
       * @return {Promise.<*>} *
       */
      async proxyReqOptDecorator(proxyReqOpts, ctx) {
        const parsedTarget = urlUtils.parse(ctx._proxyTarget, true)
        proxyReqOpts.host = parsedTarget.hostname
        proxyReqOpts.port = parsedTarget.port
        proxyReqOpts.https = parsedTarget.protocol === 'https:'

        // 去掉Referer头，否则可能会造成CSRF问题，影响开发
        if (IS_DEBUG) {
          delete proxyReqOpts.headers.Referer
          delete proxyReqOpts.headers.Origin
        }
        // 计时开始
        ctx._proxyStartTimestamp = Date.now()
        if (!needToken) {
          return proxyReqOpts
        }
        return await tokenManager.handleRequest(ctx)
          .then((additionalHeaders) => {
            Object.assign(proxyReqOpts.headers, additionalHeaders)
          })
          .then(() => {
            return proxyReqOpts
          })
      },
      /**
       * 代理请求被响应后的回调
       * @param {Response} proxyRes - 代理请求选项
       * @param {Object} proxyResData - 响应数据
       * @param {ctx} ctx - koa ctx
       * @return {Promise.<*>} *
       */
      async userResDecorator(proxyRes, proxyResData, ctx) {
        console.log('ProxyRes headers:', JSON.stringify(ctx.response.headers))
        const location = `${ctx._proxyTarget}${ctx.url}`
        console.log(`Proxy request '${location}' completed(${proxyRes.statusCode}), costing ${Date.now() - ctx._proxyStartTimestamp}ms.`)
        if (!needToken) {
          return proxyResData
        }
        return await tokenManager.handleResponse(ctx)
          .then(() => {
            return proxyResData
          })
      },
    }),
  ])
}