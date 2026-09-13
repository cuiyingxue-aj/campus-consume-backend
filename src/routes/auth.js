// ============================================================================
// 认证路由：账号密码登录 / 微信一键登录 / 当前登录信息
// ----------------------------------------------------------------------------
// 角色隔离规则：
//   · 商户账号只能进入商户端，管理员账号只能进入管理端；
//   · 请求体里可带 client = 'merchant' | 'admin' 声明"从哪个端登录"，
//     若与账号真实角色不一致，直接返回 403，实现"商户账号登录不了管理端"。
// ============================================================================
import express from 'express'
import { one, run } from '../db.js'
import { signToken, tokenExpiry } from '../auth.js'
import { logAction } from '../audit.js'
import { MOCK_WECHAT } from '../config.js'

const router = express.Router()

const publicUser = (u) => ({
  id: u.id,
  username: u.username,
  name: u.name,
  displayName: u.name,
  phone: u.phone,
  role: u.role,
  merchantId: u.merchant_id || null,
  shopName: u.shop_name || (u.role === 'admin' ? '平台管理中心' : ''),
  perm: u.perm || '',
})

/** 把微信 code 换成 openid。本地无小程序 AppID 时，用 code 本身作为 openid（演示用）。 */
function codeToOpenid(code) {
  const c = String(code || '').trim()
  if (!c) return null
  if (!MOCK_WECHAT) return c // 接入真实微信时，这里替换为调用 jscode2session 接口
  return c.startsWith('wx_') ? c : 'wx_' + c
}

// ---------------------------------------------------------------------------
// 账号密码登录
// ---------------------------------------------------------------------------
router.post('/login', (req, res) => {
  const { account, username, phone, password, client } = req.body || {}
  const acc = String(account || username || phone || '').trim()
  const ip = (req.ip || '127.0.0.1').replace('::ffff:', '')
  if (!acc || !password) {
    return res.status(400).json({ code: 400, message: '请输入账号和密码', data: null })
  }
  const user = one('SELECT * FROM user WHERE username = ? OR phone = ? LIMIT 1', acc, acc)
  if (!user) {
    logAction({ name: acc, role: '' }, { action: '登录失败', target: `账号：${acc}`, detail: '账号不存在，无法登录', result: '失败', reason: '账号不存在', ip })
    return res.status(400).json({ code: 400, message: '账号或密码错误', data: null })
  }
  if (user.disabled) {
    logAction({ name: user.name, role: user.role }, { action: '登录失败', target: `用户：${user.name}（${user.username}）`, detail: '账号已被禁用仍尝试登录', result: '失败', reason: '账号已禁用', ip })
    return res.status(403).json({ code: 403, message: '该账号已被禁用，请联系管理员', data: null })
  }
  if (user.password !== String(password)) {
    logAction({ name: user.name, role: user.role }, { action: '登录失败', target: `用户：${user.name}（${user.username}）`, detail: '账户密码错误', result: '失败', reason: '密码错误', ip })
    return res.status(400).json({ code: 400, message: '账号或密码错误', data: null })
  }
  // 客户端与角色不匹配 → 拒绝（商户账号登录不了管理端，管理员账号登录不了商户端）
  if (client && client !== user.role) {
    const targetText = client === 'admin' ? 'PC/管理端后台' : '商户端小程序'
    logAction({ name: user.name, role: user.role }, { action: '登录失败', target: `用户：${user.name}`, detail: `尝试登录${targetText}但角色不匹配`, result: '失败', reason: '角色与客户端不匹配', ip })
    return res.status(403).json({ code: 4031, message: `当前账号无权登录${targetText}`, data: null })
  }
  logAction({ name: user.name, role: user.role }, {
    action: '登录',
    target: `用户：${user.name}（${user.username}）`,
    detail: user.role === 'admin' ? '管理员登录成功' : '商户登录成功',
    result: '成功', ip,
  })
  return res.json({ code: 0, message: 'ok', data: { token: signToken(user), expiresAt: tokenExpiry(), user: publicUser(user) } })
})

// ---------------------------------------------------------------------------
// 微信一键登录
//   流程：微信 code → openid → 查询绑定关系 → 校验角色 → 下发 token
//   未绑定该角色 → 提示"无权限"
// ---------------------------------------------------------------------------
router.post('/wechat-login', (req, res) => {
  const { code, role } = req.body || {}
  const ip = (req.ip || '127.0.0.1').replace('::ffff:', '')
  const wantRole = role === 'admin' ? 'admin' : 'merchant'
  const openid = codeToOpenid(code)
  if (!openid) {
    return res.status(400).json({ code: 400, message: '微信授权失败，请重试', data: null })
  }
  const bind = one('SELECT * FROM wechat_bind WHERE openid = ?', openid)
  if (!bind) {
    logAction({ name: '微信用户', role: wantRole }, { action: '登录失败', detail: `微信一键登录：openid ${openid} 未绑定任何账号`, result: '失败', reason: '未绑定账号', ip })
    return res.status(403).json({ code: 4034, message: '当前微信未绑定商户/管理员账号，无访问权限', data: null })
  }
  if (bind.role !== wantRole) {
    const targetText = wantRole === 'admin' ? '管理端' : '商户端'
    logAction({ name: '微信用户', role: bind.role }, { action: '登录失败', detail: `微信一键登录：绑定角色为 ${bind.role}，尝试进入${targetText}`, result: '失败', reason: '角色不匹配', ip })
    return res.status(403).json({ code: 4032, message: `该微信绑定的不是${targetText}账号，无访问权限`, data: null })
  }
  const user = one('SELECT * FROM user WHERE id = ?', bind.user_id)
  if (!user || user.disabled) {
    return res.status(403).json({ code: 4033, message: '账号不存在或已被禁用，请联系管理员', data: null })
  }
  logAction({ name: user.name, role: user.role }, {
    action: '登录',
    target: `用户：${user.name}（${user.username}）`,
    detail: user.role === 'admin' ? '微信一键登录成功（管理员）' : '微信一键登录成功（商户）',
    result: '成功', ip,
  })
  return res.json({ code: 0, message: 'ok', data: { token: signToken(user), expiresAt: tokenExpiry(), user: publicUser(user) } })
})

// ---------------------------------------------------------------------------
// 微信绑定（演示用）：把当前微信与某个账号绑定，方便本地测试一键登录
//   正式环境应由管理端扫码绑定，这里只用于本地联调。
// ---------------------------------------------------------------------------
router.post('/wechat-bind', (req, res) => {
  const { code, account } = req.body || {}
  const openid = codeToOpenid(code)
  const user = one('SELECT * FROM user WHERE username = ? OR phone = ? LIMIT 1', String(account || ''), String(account || ''))
  if (!openid || !user) return res.status(400).json({ code: 400, message: '参数不完整或账号不存在', data: null })
  run('DELETE FROM wechat_bind WHERE openid = ?', openid)
  run('INSERT INTO wechat_bind (openid, role, user_id, bind_time) VALUES (?, ?, ?, datetime("now","localtime"))', openid, user.role, user.id)
  run('UPDATE user SET openid = ? WHERE id = ?', openid, user.id)
  return res.json({ code: 0, message: 'ok', data: { openid, role: user.role, name: user.name } })
})

// ---------------------------------------------------------------------------
// 当前登录用户信息
// ---------------------------------------------------------------------------
router.get('/profile', (req, res) => {
  if (!req.ctx) return res.status(401).json({ code: 401, message: '未登录', data: null })
  return res.json({ code: 0, message: 'ok', data: publicUser(req.ctx) })
})

export default router
