// ============================================================================
// 管理端路由（全部需要 admin 角色）
// ----------------------------------------------------------------------------
// 与商户端的区别：
//   · 可查看全平台/多门店数据；
//   · 可以审核退款申请（同意 / 驳回），商户只能提交申请；
//   · 额外提供学生分层速览、招商分析、数据导出、审计日志等能力。
// ============================================================================
import express from 'express'
import { one, run, all } from '../db.js'
import { requireRole } from '../auth.js'
import { logAction, listAuditLogs, nowStr } from '../audit.js'
import { adminDashboard, orderList, dishList, dishAnalysis, studentLayer, investment, listAnomalies, anomalyDetail, toCsv } from '../metrics.js'

const router = express.Router()
router.use(requireRole('admin'))

/** 解析门店筛选参数：支持 merchantId=M100 或 merchantIds=M100,M101 */
function parseMerchantIds(query) {
  const raw = query.merchantIds || query.merchantId || ''
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean)
}

// ---------------------------------------------------------------------------
// 平台经营首页 KPI
// ---------------------------------------------------------------------------
router.get('/dashboard', (req, res) => {
  const range = req.query.range || 'today'
  const merchantIds = parseMerchantIds(req.query)
  return res.json({ code: 0, message: 'ok', data: adminDashboard(range, merchantIds) })
})

/** 门店列表（用于门店筛选下拉） */
router.get('/merchants', (req, res) => {
  const rows = all(`SELECT merchant_id, shop_name, campus, category, audit_status, dish_count, month_target
                    FROM merchant ORDER BY shop_name`)
  return res.json({
    code: 0, message: 'ok',
    data: rows.map((m) => ({
      merchantId: m.merchant_id, shopName: m.shop_name, campus: m.campus, category: m.category,
      status: m.audit_status, statusText: m.audit_status === 'approved' ? '营业中' : m.audit_status === 'pending' ? '待审核' : '已驳回',
      dishCount: m.dish_count, monthTarget: m.month_target,
    })),
  })
})

// ---------------------------------------------------------------------------
// 订单列表 + 退款审核
// ---------------------------------------------------------------------------
router.get('/orders', (req, res) => {
  const { filter = 'all', page = 1, pageSize = 10, keyword = '' } = req.query
  const merchantIds = parseMerchantIds(req.query)
  const data = orderList({ merchantIds, filter, page, pageSize, keyword })
  return res.json({ code: 0, message: 'ok', data })
})

/** 订单详情 */
router.get('/orders/:transId', (req, res) => {
  const o = one('SELECT * FROM consume_record WHERE trans_id = ?', req.params.transId)
  if (!o) return res.status(404).json({ code: 404, message: '订单不存在', data: null })
  const refund = one('SELECT * FROM refund WHERE trans_id = ? ORDER BY time DESC LIMIT 1', o.trans_id)
  return res.json({
    code: 0, message: 'ok',
    data: {
      transId: o.trans_id, studentNo: o.student_id, student: o.student_name,
      merchantId: o.merchant_id, shopName: o.place, category: o.category, channel: o.channel,
      dishName: o.dish_name, quantity: o.quantity, amount: o.amount,
      time: o.consume_time, status: o.status,
      refund: refund ? { id: refund.id, reason: refund.reason, status: refund.status, time: refund.time, auditBy: refund.audit_by, auditTime: refund.audit_time } : null,
    },
  })
})

/** 退款申请列表（待审批 / 已处理） */
router.get('/refunds', (req, res) => {
  const status = req.query.status || 'pending'
  const merchantIds = parseMerchantIds(req.query)
  const conds = []
  const params = []
  if (status === 'pending') conds.push("status = 'pending'")
  else if (status === 'done') conds.push("status IN ('approved','rejected')")
  if (merchantIds.length) { conds.push(`merchant_id IN (${merchantIds.map(() => '?').join(',')})`); params.push(...merchantIds) }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const rows = all(`SELECT * FROM refund ${where} ORDER BY time DESC LIMIT 200`, ...params)
  return res.json({
    code: 0, message: 'ok',
    data: rows.map((r) => ({
      id: r.id, transId: r.trans_id, student: r.student, studentNo: r.student_id,
      merchantId: r.merchant_id, merchant: r.merchant, amount: r.amount, reason: r.reason,
      time: r.time, status: r.status,
      statusText: r.status === 'pending' ? '待审批' : r.status === 'approved' ? '已通过' : '已驳回',
      auditBy: r.audit_by, auditTime: r.audit_time,
    })),
  })
})

/** 同意退款 */
router.post('/refunds/:id/approve', (req, res) => {
  const r = one('SELECT * FROM refund WHERE id = ?', req.params.id)
  if (!r) return res.status(404).json({ code: 404, message: '退款单不存在', data: null })
  if (r.status !== 'pending') return res.status(400).json({ code: 400, message: '该退款单已处理完毕，无法重复审核', data: null })
  run("UPDATE refund SET status = 'approved', audit_by = ?, audit_time = ? WHERE id = ?", req.ctx.name, nowStr(), r.id)
  run("UPDATE consume_record SET status = '已退款' WHERE trans_id = ?", r.trans_id)
  logAction(req.ctx, {
    action: '同意退款', targetType: '退款单', target: `退款单：${r.id}（¥${r.amount}）`,
    detail: `同意退款申请，退款金额 ¥${r.amount}（订单 ${r.trans_id}，门店 ${r.merchant}）`,
    result: '成功', ip: (req.ip || '').replace('::ffff:', ''),
  })
  return res.json({ code: 0, message: 'ok', data: { id: r.id, status: 'approved' } })
})

/** 驳回退款 */
router.post('/refunds/:id/reject', (req, res) => {
  const r = one('SELECT * FROM refund WHERE id = ?', req.params.id)
  if (!r) return res.status(404).json({ code: 404, message: '退款单不存在', data: null })
  if (r.status !== 'pending') return res.status(400).json({ code: 400, message: '该退款单已处理完毕，无法重复审核', data: null })
  const reason = String(req.body?.reason || '不符合退款条件').slice(0, 80)
  run("UPDATE refund SET status = 'rejected', audit_by = ?, audit_time = ? WHERE id = ?", req.ctx.name, nowStr(), r.id)
  run("UPDATE consume_record SET status = '已支付' WHERE trans_id = ?", r.trans_id)
  logAction(req.ctx, {
    action: '驳回退款', targetType: '退款单', target: `退款单：${r.id}（¥${r.amount}）`,
    detail: `驳回退款申请（订单 ${r.trans_id}，门店 ${r.merchant}）`, result: '成功', reason,
    ip: (req.ip || '').replace('::ffff:', ''),
  })
  return res.json({ code: 0, message: 'ok', data: { id: r.id, status: 'rejected', reason } })
})

// ---------------------------------------------------------------------------
// 学生分层速览
// ---------------------------------------------------------------------------
router.get('/student-layer', (req, res) => {
  const { range = 'today', tab = 'high' } = req.query
  const merchantIds = parseMerchantIds(req.query)
  return res.json({ code: 0, message: 'ok', data: studentLayer({ range, merchantIds, tab }) })
})

// ---------------------------------------------------------------------------
// 异常消费处理
// ---------------------------------------------------------------------------
router.get('/anomalies', (req, res) => {
  const { status = 'pending', range = 'all', keyword = '', page = 1, pageSize = 20 } = req.query
  const merchantIds = parseMerchantIds(req.query)
  return res.json({ code: 0, message: 'ok', data: listAnomalies({ status, range, merchantIds, keyword, page, pageSize }) })
})

/** 异常消费详情（处置弹窗：学生画像 + 近 30 天趋势 + 常去商户/时段 + 均值σ） */
router.get('/anomalies/:id/detail', (req, res) => {
  const d = anomalyDetail(req.params.id)
  if (!d) return res.status(404).json({ code: 404, message: '异常记录不存在', data: null })
  return res.json({ code: 0, message: 'ok', data: d })
})

/** 异常消费处置（标记 已处理 / 已忽略 + 处置分类 + 备注） */
router.post('/anomalies/:id/handle', (req, res) => {
  const a = one('SELECT * FROM anomaly_record WHERE anomaly_id = ?', req.params.id)
  if (!a) return res.status(404).json({ code: 404, message: '异常记录不存在', data: null })
  const { status, disposition = '', remark = '' } = req.body || {}
  if (!['handled', 'ignored'].includes(status)) return res.status(400).json({ code: 400, message: '处理状态不合法', data: null })
  run(
    'UPDATE anomaly_record SET status = ?, disposition = ?, remark = ?, handled_by = ?, handled_at = ? WHERE anomaly_id = ?',
    status, String(disposition).slice(0, 50), String(remark).slice(0, 200), req.ctx.name, nowStr(), req.params.id,
  )
  logAction(req.ctx, {
    action: status === 'handled' ? '异常消费处理' : '异常消费忽略',
    targetType: '异常消费', target: `异常记录：${req.params.id}`,
    detail: `异常类型：${a.anomaly_type}；处置分类：${disposition || '无'}；备注：${remark || '无'}`,
    result: '成功', ip: (req.ip || '').replace('::ffff:', ''),
  })
  return res.json({ code: 0, message: 'ok', data: { id: req.params.id, status } })
})

// ---------------------------------------------------------------------------
// 招商分析
// ---------------------------------------------------------------------------
router.get('/investment', (req, res) => {
  const { range = 'today' } = req.query
  const merchantIds = parseMerchantIds(req.query)
  return res.json({ code: 0, message: 'ok', data: investment({ range, merchantIds }) })
})

/** 招商分析数据导出（CSV，Excel 可直接打开） */
router.get('/investment/export', (req, res) => {
  const { range = 'today' } = req.query
  const merchantIds = parseMerchantIds(req.query)
  const data = investment({ range, merchantIds })
  const csv = toCsv(
    ['门店编号', '门店名称', '所属食堂', '消费学生数', '新增学生数', '复购学生数', '复购率(%)', '有效营业额', '门店价值标签'],
    data.storeTags.map((s) => [s.merchantId, s.shopName, s.campus, s.students, s.newStudents, s.repeatStudents, s.repeatRate, s.amount, s.tag]),
  )
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="investment-${range}-${Date.now()}.csv"`)
  logAction(req.ctx, { action: '导出数据', targetType: '招商分析', target: `招商分析（${range}）`, detail: `导出 ${data.storeTags.length} 行门店数据`, result: '成功' })
  return res.send(csv)
})

// ---------------------------------------------------------------------------
// 菜品（管理端：可按门店查看，用于交叉核对）
// ---------------------------------------------------------------------------
router.get('/dishes', (req, res) => {
  const { keyword = '', status = '' } = req.query
  const merchantIds = parseMerchantIds(req.query)
  const list = dishList({ merchantIds, keyword, status })
  return res.json({ code: 0, message: 'ok', data: { list, total: list.length } })
})

/** 菜品分析（管理端可全平台/按门店） */
router.get('/dish-analysis', (req, res) => {
  const { range = 'today' } = req.query
  const merchantIds = parseMerchantIds(req.query)
  return res.json({ code: 0, message: 'ok', data: dishAnalysis({ range, merchantIds }) })
})

// ---------------------------------------------------------------------------
// 审计日志
// ---------------------------------------------------------------------------
router.get('/audit-logs', (req, res) => {
  const { keyword = '', action = '', result = '', page = 1, pageSize = 20 } = req.query
  return res.json({ code: 0, message: 'ok', data: listAuditLogs({ keyword, action, result, page, pageSize }) })
})

export default router
