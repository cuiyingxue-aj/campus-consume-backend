// ============================================================================
// 商户端路由（全部需要 merchant 角色）
// ----------------------------------------------------------------------------
// 数据隔离：所有查询都以 ctx.merchant_id 为条件，商户只能看到本店数据。
// 退款权限：商户只能"提交退款申请"，不能审核；审核由管理端完成。
// ============================================================================
import express from 'express'
import { one, run, all } from '../db.js'
import { requireRole } from '../auth.js'
import { logAction } from '../audit.js'
import {
  merchantDashboard, merchantDishBrief, orderList, dishList, dishAnalysis, findDish, timeRange,
  studentLayer, investment, toCsv,
} from '../metrics.js'

const router = express.Router()
router.use(requireRole('merchant'))

const maskName = (n) => (!n ? '匿名学生' : n.length <= 1 ? n + '**' : n[0] + '*'.repeat(Math.max(1, n.length - 1)))
const myMerchantId = (req) => req.ctx.merchant_id

// ---------------------------------------------------------------------------
// 经营首页 KPI
// ---------------------------------------------------------------------------
router.get('/dashboard', (req, res) => {
  const range = req.query.range || 'today'
  const data = merchantDashboard(myMerchantId(req), range)
  if (!data) return res.status(404).json({ code: 404, message: '商户不存在', data: null })
  return res.json({ code: 0, message: 'ok', data: { ...data, dishBrief: merchantDishBrief(myMerchantId(req)) } })
})

// ---------------------------------------------------------------------------
// 订单列表（支持 全部 / 待退款申请 / 已退款 三种筛选 + 分页）
// ---------------------------------------------------------------------------
router.get('/orders', (req, res) => {
  const { filter = 'all', page = 1, pageSize = 10, keyword = '' } = req.query
  const data = orderList({ merchantIds: [myMerchantId(req)], filter, page, pageSize, keyword })
  // 商户端对学生姓名做脱敏（与桌面系统一致）
  return res.json({
    code: 0, message: 'ok',
    data: { ...data, list: data.list.map((o) => ({ ...o, student: maskName(o.student) })) },
  })
})

/** 订单详情 */
router.get('/orders/:transId', (req, res) => {
  const o = one('SELECT * FROM consume_record WHERE trans_id = ? AND merchant_id = ?', req.params.transId, myMerchantId(req))
  if (!o) return res.status(404).json({ code: 404, message: '订单不存在或无权限', data: null })
  const refund = one('SELECT * FROM refund WHERE trans_id = ? ORDER BY time DESC LIMIT 1', o.trans_id)
  return res.json({
    code: 0, message: 'ok',
    data: {
      transId: o.trans_id, studentNo: o.student_id, student: maskName(o.student_name),
      shopName: o.place, category: o.category, channel: o.channel,
      dishName: o.dish_name, quantity: o.quantity, amount: o.amount,
      time: o.consume_time, status: o.status,
      refund: refund ? { id: refund.id, reason: refund.reason, status: refund.status, time: refund.time } : null,
    },
  })
})

/** 提交退款申请（商户只能申请，不能审核） */
router.post('/orders/:transId/refund', (req, res) => {
  const { reason } = req.body || {}
  const o = one('SELECT * FROM consume_record WHERE trans_id = ? AND merchant_id = ?', req.params.transId, myMerchantId(req))
  if (!o) return res.status(404).json({ code: 404, message: '订单不存在或无权限', data: null })
  if (o.status === '退款审核中') return res.status(400).json({ code: 400, message: '该订单已提交退款申请，请等待管理端审核', data: null })
  if (o.status === '已退款') return res.status(400).json({ code: 400, message: '该订单已退款，无需重复申请', data: null })

  const refundId = 'R' + Date.now()
  const now = timeRange().end
  run(`INSERT INTO refund (id, trans_id, student_id, student, merchant_id, merchant, amount, reason, time, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    refundId, o.trans_id, o.student_id, maskName(o.student_name), o.merchant_id, o.place, o.amount,
    String(reason || '商户端发起退款申请').slice(0, 60), o.consume_time || now)
  run("UPDATE consume_record SET status = '退款审核中' WHERE trans_id = ?", o.trans_id)

  logAction(req.ctx, {
    action: '退款申请', targetType: '退款单', target: `退款单：${refundId}（¥${o.amount}）`,
    detail: `在线订单发起退款申请：${reason || '无'}（订单 ${o.trans_id}）`, result: '成功',
    ip: (req.ip || '').replace('::ffff:', ''),
  })
  return res.json({ code: 0, message: 'ok', data: { refundId, status: 'pending' } })
})

/** 本店退款申请列表 */
router.get('/refunds', (req, res) => {
  const status = req.query.status || ''
  const conds = ['merchant_id = ?']
  const params = [myMerchantId(req)]
  if (status === 'pending') { conds.push("status = 'pending'") }
  if (status === 'done') { conds.push("status IN ('approved','rejected')") }
  const rows = all(`SELECT * FROM refund WHERE ${conds.join(' AND ')} ORDER BY time DESC LIMIT 100`, ...params)
  return res.json({
    code: 0, message: 'ok',
    data: rows.map((r) => ({
      id: r.id, transId: r.trans_id, student: r.student, amount: r.amount, reason: r.reason,
      time: r.time, status: r.status, statusText: r.status === 'pending' ? '待审核' : r.status === 'approved' ? '已通过' : '已驳回',
    })),
  })
})

// ---------------------------------------------------------------------------
// 菜品管理（本店）
// ---------------------------------------------------------------------------
router.get('/dishes', (req, res) => {
  const { keyword = '', status = '' } = req.query
  const list = dishList({ merchantIds: [myMerchantId(req)], keyword, status })
  return res.json({
    code: 0, message: 'ok',
    data: {
      list, total: list.length,
      stats: {
        total: list.length,
        on: list.filter((d) => d.status === 'on').length,
        off: list.filter((d) => d.status === 'off').length,
        stock: list.reduce((s, d) => s + d.stock, 0),
      },
    },
  })
})

/** 菜品上下架 */
router.post('/dishes/:id/toggle', (req, res) => {
  const d = findDish(req.params.id, myMerchantId(req))
  if (!d) return res.status(404).json({ code: 404, message: '菜品不存在或无权限', data: null })
  const next = d.status === 'on' ? 'off' : 'on'
  run('UPDATE dish SET status = ? WHERE id = ?', next, d.id)
  logAction(req.ctx, {
    action: '菜品上下架', targetType: '菜品', target: `菜品：${d.name}（${d.id}）`,
    detail: next === 'on' ? '菜品上架' : '菜品下架', result: '成功', ip: (req.ip || '').replace('::ffff:', ''),
  })
  return res.json({ code: 0, message: 'ok', data: { id: d.id, status: next } })
})

/** 菜品改价 */
router.post('/dishes/:id/price', (req, res) => {
  const price = Number(req.body?.price)
  if (!price || price <= 0) return res.status(400).json({ code: 400, message: '请输入正确的价格', data: null })
  const d = findDish(req.params.id, myMerchantId(req))
  if (!d) return res.status(404).json({ code: 404, message: '菜品不存在或无权限', data: null })
  const old = d.price
  run('UPDATE dish SET price = ? WHERE id = ?', Math.round(price * 100) / 100, d.id)
  logAction(req.ctx, {
    action: '菜品改价', targetType: '菜品', target: `菜品：${d.name}（${d.id}）`,
    detail: `商户改价 ¥${old} → ¥${price}`, result: '成功', ip: (req.ip || '').replace('::ffff:', ''),
  })
  return res.json({ code: 0, message: 'ok', data: { id: d.id, price: Math.round(price * 100) / 100 } })
})

// ---------------------------------------------------------------------------
// 菜品分析（仅统计有效订单，剔除退款订单）
// ---------------------------------------------------------------------------
router.get('/dish-analysis', (req, res) => {
  const range = req.query.range || 'today'
  const data = dishAnalysis({ range, merchantIds: [myMerchantId(req)] })
  return res.json({ code: 0, message: 'ok', data })
})

// ---------------------------------------------------------------------------
// 本店学生分层速览（首页快捷入口）
//   口径与管理端一致，但数据范围严格限制为本商户
// ---------------------------------------------------------------------------
router.get('/student-layer', (req, res) => {
  const { range = 'today', tab = 'high' } = req.query
  const data = studentLayer({ range, merchantIds: [myMerchantId(req)], tab })
  // 商户端不展示学生完整姓名，统一做脱敏
  return res.json({ code: 0, message: 'ok', data })
})

// ---------------------------------------------------------------------------
// 本店招商分析（首页快捷入口）
// ---------------------------------------------------------------------------
router.get('/investment', (req, res) => {
  const range = req.query.range || 'today'
  const data = investment({ range, merchantIds: [myMerchantId(req)] })
  return res.json({ code: 0, message: 'ok', data })
})

/** 本店招商分析数据导出 */
router.get('/investment/export', (req, res) => {
  const range = req.query.range || 'today'
  const data = investment({ range, merchantIds: [myMerchantId(req)] })
  const csv = toCsv(
    ['门店编号', '门店名称', '所属食堂', '消费学生数', '新增学生数', '复购学生数', '复购率(%)', '有效营业额', '门店价值标签'],
    data.storeTags.map((s) => [s.merchantId, s.shopName, s.campus, s.students, s.newStudents, s.repeatStudents, s.repeatRate, s.amount, s.tag]),
  )
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="investment-${range}-${Date.now()}.csv"`)
  logAction(req.ctx, { action: '导出数据', targetType: '招商分析', target: `本店招商分析（${range}）`, detail: `导出 ${data.storeTags.length} 行数据`, result: '成功' })
  return res.send(csv)
})

export default router
