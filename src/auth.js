// ============================================================================
// 鉴权模块
// ----------------------------------------------------------------------------
// 1. 令牌采用"自制 JWT"（base64url 载荷 + HMAC-SHA256 签名），不引入第三方库；
// 2. 令牌载荷里带 exp（过期时间），有效期 2 小时，过期后所有接口返回 401；
// 3. 角色隔离：token 里记录 role，路由层据此判断能否访问商户端 / 管理端接口；
//    商户账号登录不了管理端接口，管理员账号也登录不了商户端接口。
// ============================================================================
import crypto from 'node:crypto'
import { AUTH_SECRET, TOKEN_TTL } from './config.js'
import { one } from './db.js'

const b64url = (buf) => Buffer.from(buf).toString('base64url')

/** 令牌过期时间戳（前端用它做"过期退回登录页"的前置判断） */
export function tokenExpiry() {
  return Date.now() + TOKEN_TTL
}

/** 为用户签发令牌（有效期 2 小时） */
export function signToken(user) {
  const payload = {
    uid: user.id,
    username: user.username,
    role: user.role,
    merchantId: user.merchant_id || null,
    perm: user.perm || '',
    iat: Date.now(),
    exp: Date.now() + TOKEN_TTL,
  }
  const body = b64url(JSON.stringify(payload))
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url')
  return `${body}.${sig}`
}

/** 解析并校验令牌；失败返回 { error } */
export function verifyToken(token) {
  if (!token || typeof token !== 'string') return { error: '未登录或登录已失效' }
  const [body, sig] = token.split('.')
  if (!body || !sig) return { error: '令牌格式不正确' }
  const expect = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url')
  if (sig !== expect) return { error: '令牌签名校验失败' }
  let payload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return { error: '令牌内容无法解析' }
  }
  if (!payload.exp || Date.now() > payload.exp) return { error: '登录已过期，请重新登录', expired: true }
  return { payload }
}

/** Express 中间件：解析 Authorization，挂载 req.ctx（当前登录用户） */
export function authMiddleware(req, res, next) {
  const header = req.headers.authorization || ''
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ code: 401, message: '未登录或登录已失效', data: null })
  }
  const { payload, error, expired } = verifyToken(header.slice(7))
  if (error) {
    return res.status(401).json({ code: expired ? 4011 : 401, message: error, data: null })
  }
  // 二次确认账号仍然存在且未被禁用
  const user = one('SELECT * FROM user WHERE id = ?', payload.uid)
  if (!user) return res.status(401).json({ code: 401, message: '账号不存在', data: null })
  if (user.disabled) return res.status(403).json({ code: 4033, message: '该账号已被禁用，请联系管理员', data: null })
  req.ctx = user
  next()
}

/** 仅允许指定角色访问 */
export const requireRole = (role) => (req, res, next) => {
  if (!req.ctx || req.ctx.role !== role) {
    return res.status(403).json({ code: 403, message: role === 'admin' ? '无管理端权限' : '无商户端权限', data: null })
  }
  next()
}
