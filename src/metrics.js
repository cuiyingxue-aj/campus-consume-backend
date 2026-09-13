// ============================================================================
// 业务统计口径模块
// ----------------------------------------------------------------------------
// 所有指标计算集中在此，保证"前端页面之间""商户端与管理端之间"口径完全一致，
// 并与桌面系统「校园消费数据同步与用户分层系统」的算法保持一致。
//
// 【核心口径】
//   有效订单   ：consume_record.status = '已支付'（退款审核中 / 已退款 一律剔除）
//   有效营业额 ：有效订单金额合计
//   消费分层   ：高 ≥2000 元，中 1000~2000 元，低 <1000 元（按周期内累计有效消费金额）
//   月目标完成率：周期内有效营业额 ÷ 月度目标
//   新增学生   ：该生历史首笔有效订单落在所选周期内
//   复购学生   ：所选周期内有效订单数 ≥ 2 的学生
// ============================================================================
import { all, one } from './db.js'
import { LAYER_THRESHOLDS } from './config.js'

const ST_PAID = '已支付'
const ST_REFUNDING = '退款审核中'
const ST_REFUNDED = '已退款'

const pad = (n) => String(n).padStart(2, '0')
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100
const fmtDateTime = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/**
 * 计算时间区间。
 * range: today 今日 / week 本周（周一起） / month 本月
 * 结束时间统一取"当天 23:59:59"，保证当天已生成的数据全部统计在内。
 */
export function timeRange(range = 'today') {
  const now = new Date()
  let start
  if (range === 'week') {
    const dow = now.getDay() === 0 ? 7 : now.getDay() // 周日按 7 处理，周一 = 1
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (dow - 1))
  } else if (range === 'month') {
    start = new Date(now.getFullYear(), now.getMonth(), 1)
  } else {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  }
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59)
  return { range, start: fmtDateTime(start), end: fmtDateTime(end), startDate: fmtDate(start), endDate: fmtDate(end) }
}

/** 拼装"商户筛选 + 时间筛选 + 有效订单"的公共 WHERE 片段 */
function validWhere({ range, merchantIds } = {}) {
  const tr = timeRange(range)
  const conds = ['status = ?', 'consume_time >= ?', 'consume_time <= ?']
  const params = [ST_PAID, tr.start, tr.end]
  const ids = (merchantIds || []).filter(Boolean)
  if (ids.length) {
    conds.push(`merchant_id IN (${ids.map(() => '?').join(',')})`)
    params.push(...ids)
  }
  return { tr, sql: conds.join(' AND '), params }
}

/** 近 N 天（含今天）的日期数组 */
function lastDays(n) {
  const out = []
  const now = new Date()
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    out.push({ date: fmtDate(d), label: `${pad(d.getMonth() + 1)}-${pad(d.getDate())}` })
  }
  return out
}

/** 周期内每天的日期数组（最多 31 天） */
function daysBetween(startDate, endDate) {
  const out = []
  const s = new Date(startDate + 'T00:00:00')
  const e = new Date(endDate + 'T00:00:00')
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    out.push({ date: fmtDate(d), label: `${pad(d.getMonth() + 1)}-${pad(d.getDate())}` })
  }
  return out.slice(-31)
}

// ---------------------------------------------------------------------------
// 通用：按天聚合有效营业额
// ---------------------------------------------------------------------------
function dailyRevenue(days, w) {
  const rows = all(
    `SELECT substr(consume_time, 1, 10) AS day, SUM(amount) AS amount, COUNT(*) AS orders
     FROM consume_record WHERE ${w.sql} GROUP BY day`,
    ...w.params,
  )
  const map = new Map(rows.map((r) => [r.day, r]))
  return days.map((d) => {
    const r = map.get(d.date)
    return { day: d.label, date: d.date, revenue: round2(r ? r.amount : 0), orders: r ? r.orders : 0 }
  })
}

// ---------------------------------------------------------------------------
// 商户端：经营首页 KPI
// ---------------------------------------------------------------------------
export function merchantDashboard(merchantId, range = 'today') {
  const merchant = one('SELECT * FROM merchant WHERE merchant_id = ?', merchantId)
  if (!merchant) return null

  const cur = validWhere({ range, merchantIds: [merchantId] })
  const agg = one(`SELECT SUM(amount) AS revenue, COUNT(*) AS orders FROM consume_record WHERE ${cur.sql}`, ...cur.params)
  const revenue = round2(agg.revenue)
  const orders = agg.orders || 0

  // 月度目标完成率：本月有效营业额 ÷ 月目标
  const monthW = validWhere({ range: 'month', merchantIds: [merchantId] })
  const monthAgg = one(`SELECT SUM(amount) AS revenue FROM consume_record WHERE ${monthW.sql}`, ...monthW.params)
  const monthRevenue = round2(monthAgg.revenue)
  const monthTarget = merchant.month_target || 0
  const monthTargetRate = monthTarget > 0 ? Math.round((monthRevenue / monthTarget) * 100) : 0

  // 退款相关计数（本店）
  const refundCount = one(
    `SELECT COUNT(*) AS c FROM consume_record WHERE merchant_id = ? AND status = ?`,
    merchantId, ST_REFUNDING,
  ).c

  // 近 7 日有效营业额趋势
  const trendDays = lastDays(7)
  const trendW = {
    sql: 'status = ? AND consume_time >= ? AND consume_time <= ? AND merchant_id = ?',
    params: [ST_PAID, `${trendDays[0].date} 00:00:00`, timeRange('today').end, merchantId],
  }

  return {
    merchantId: merchant.merchant_id,
    shopName: merchant.shop_name,
    category: merchant.category,
    campus: merchant.campus,
    range: cur.tr.range,
    revenue,
    orders,
    monthRevenue,
    monthTarget,
    monthTargetRate,
    refundCount,
    trend: dailyRevenue(trendDays, trendW),
    dishCount: merchant.dish_count,
    bestSeller: merchant.best_seller,
    windowCount: merchant.window_count,
  }
}

/** 商户端：菜品快捷统计（用于首页小字提示） */
export function merchantDishBrief(merchantId) {
  const row = one(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'on' THEN 1 ELSE 0 END) AS onSale,
            COALESCE(SUM(stock), 0) AS stock FROM dish WHERE merchant_id = ?`,
    merchantId,
  )
  return { total: row.total || 0, onSale: row.onSale || 0, stock: row.stock || 0 }
}

// ---------------------------------------------------------------------------
// 管理端：平台经营首页 KPI
// ---------------------------------------------------------------------------
export function adminDashboard(range = 'today', merchantIds = []) {
  const cur = validWhere({ range, merchantIds })
  const agg = one(`SELECT SUM(amount) AS revenue, COUNT(*) AS orders, COUNT(DISTINCT student_id) AS students FROM consume_record WHERE ${cur.sql}`, ...cur.params)

  const monthW = validWhere({ range: 'month', merchantIds })
  const monthAgg = one(`SELECT SUM(amount) AS revenue FROM consume_record WHERE ${monthW.sql}`, ...monthW.params)
  const monthRevenue = round2(monthAgg.revenue)

  // 月度目标：未筛选门店时取全平台目标；筛选门店时取这些门店目标之和
  let monthTarget
  if (merchantIds && merchantIds.length) {
    monthTarget = round2(one(
      `SELECT SUM(month_target) AS t FROM merchant WHERE merchant_id IN (${merchantIds.map(() => '?').join(',')})`,
      ...merchantIds,
    ).t)
  } else {
    monthTarget = round2(one("SELECT value FROM sys_config WHERE key = 'platform_month_target'")?.value)
  }
  const monthTargetRate = monthTarget > 0 ? Math.round((monthRevenue / monthTarget) * 100) : 0

  const tr = cur.tr
  const trendDays = lastDays(7)
  const trend = dailyRevenue(trendDays, {
    sql: `status = ? AND consume_time >= ? AND consume_time <= ?${merchantIds.length ? ` AND merchant_id IN (${merchantIds.map(() => '?').join(',')})` : ''}`,
    params: [ST_PAID, trendDays[0].date + ' 00:00:00', tr.end, ...(merchantIds.length ? merchantIds : [])],
  })

  return {
    range: tr.range,
    revenue: round2(agg.revenue),
    orders: agg.orders || 0,
    students: agg.students || 0,
    monthRevenue,
    monthTarget,
    monthTargetRate,
    merchantCount: merchantIds.length || one("SELECT COUNT(*) AS c FROM merchant WHERE audit_status = 'approved'").c,
    pendingRefund: one('SELECT COUNT(*) AS c FROM refund WHERE status = ?', 'pending').c,
    trend,
  }
}

// ---------------------------------------------------------------------------
// 订单列表
// ---------------------------------------------------------------------------
const ORDER_FILTER_MAP = { all: null, pending: ST_REFUNDING, refunded: ST_REFUNDED }

export function orderList({ merchantIds = [], filter = 'all', page = 1, pageSize = 10, keyword = '' } = {}) {
  const conds = []
  const params = []
  const ids = (merchantIds || []).filter(Boolean)
  if (ids.length) {
    conds.push(`merchant_id IN (${ids.map(() => '?').join(',')})`)
    params.push(...ids)
  }
  const st = ORDER_FILTER_MAP[filter]
  if (st) { conds.push('status = ?'); params.push(st) }
  if (keyword) {
    conds.push('(trans_id LIKE ? OR dish_name LIKE ? OR student_name LIKE ? OR place LIKE ?)')
    const kw = `%${keyword}%`
    params.push(kw, kw, kw, kw)
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''

  const total = one(`SELECT COUNT(*) AS c FROM consume_record ${where}`, ...params).c
  const p = Math.max(1, Number(page) || 1)
  const ps = Math.min(50, Math.max(1, Number(pageSize) || 10))
  const rows = all(
    `SELECT trans_id, student_id, student_name, merchant_id, place, category, channel,
            dish_id, dish_name, quantity, amount, consume_time, status
     FROM consume_record ${where} ORDER BY consume_time DESC, id DESC LIMIT ? OFFSET ?`,
    ...params, ps, (p - 1) * ps,
  )

  const base = ids.length ? `merchant_id IN (${ids.map(() => '?').join(',')})` : '1=1'
  const stats = {
    all: one(`SELECT COUNT(*) AS c FROM consume_record WHERE ${base}`, ...ids).c,
    pending: one(`SELECT COUNT(*) AS c FROM consume_record WHERE ${base} AND status = ?`, ...ids, ST_REFUNDING).c,
    refunded: one(`SELECT COUNT(*) AS c FROM consume_record WHERE ${base} AND status = ?`, ...ids, ST_REFUNDED).c,
  }

  return {
    list: rows.map((r) => ({
      transId: r.trans_id,
      studentNo: r.student_id,
      student: r.student_name,
      merchantId: r.merchant_id,
      shopName: r.place,
      category: r.category,
      channel: r.channel,
      dishId: r.dish_id,
      dishName: r.dish_name,
      quantity: r.quantity,
      amount: round2(r.amount),
      time: r.consume_time,
      status: r.status,
    })),
    total, page: p, pageSize: ps, stats,
  }
}

// ---------------------------------------------------------------------------
// 菜品管理（本店 / 全平台）
// ---------------------------------------------------------------------------
export function dishList({ merchantIds = [], keyword = '', status = '' } = {}) {
  const conds = []
  const params = []
  const ids = (merchantIds || []).filter(Boolean)
  if (ids.length) {
    conds.push(`merchant_id IN (${ids.map(() => '?').join(',')})`)
    params.push(...ids)
  }
  if (status) { conds.push('status = ?'); params.push(status) }
  if (keyword) { conds.push('(name LIKE ? OR id LIKE ? OR category LIKE ?)'); const kw = `%${keyword}%`; params.push(kw, kw, kw) }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const rows = all(
    `SELECT id, name, merchant_id, merchant, category, price, stock, sales, revenue, status, month_growth
     FROM dish ${where} ORDER BY status DESC, sales DESC`,
    ...params,
  )
  return rows.map((d) => ({
    id: d.id, name: d.name, merchantId: d.merchant_id, merchant: d.merchant, category: d.category,
    price: round2(d.price), stock: d.stock, sales: d.sales, revenue: round2(d.revenue),
    status: d.status, statusText: d.status === 'on' ? '在售' : '已下架', monthGrowth: d.month_growth,
  }))
}

/** 取单个菜品（可附带商户归属校验，防止越权） */
export function findDish(dishId, merchantId = null) {
  return merchantId
    ? one('SELECT * FROM dish WHERE id = ? AND merchant_id = ?', dishId, merchantId)
    : one('SELECT * FROM dish WHERE id = ?', dishId)
}

// ---------------------------------------------------------------------------
// 菜品分析（商户端 / 管理端通用）
// ---------------------------------------------------------------------------
export function dishAnalysis({ range = 'today', merchantIds = [] } = {}) {
  const w = validWhere({ range, merchantIds })
  const rows = all(
    `SELECT dish_id, dish_name, SUM(quantity) AS qty, SUM(amount) AS amount, COUNT(*) AS orders
     FROM consume_record WHERE ${w.sql} AND dish_id IS NOT NULL
     GROUP BY dish_id, dish_name ORDER BY qty DESC`,
    ...w.params,
  )
  const totalSales = rows.reduce((s, r) => s + (r.qty || 0), 0)
  const totalRevenue = round2(rows.reduce((s, r) => s + (r.amount || 0), 0))

  const list = rows.map((r) => ({
    dishId: r.dish_id,
    name: r.dish_name,
    sales: r.qty || 0,
    revenue: round2(r.amount),
    orders: r.orders,
    revenueRatio: totalRevenue > 0 ? Math.round(((r.amount || 0) / totalRevenue) * 1000) / 10 : 0,
    salesRatio: totalSales > 0 ? Math.round(((r.qty || 0) / totalSales) * 1000) / 10 : 0,
  }))

  return {
    range: w.tr.range,
    totalSales,
    totalRevenue,
    hot: list.slice(0, 5),
    cold: list.slice(-5).reverse(),
    list,
    // 柱状图：销量排行（前 8）
    bar: list.slice(0, 8).map((d) => ({ name: d.name, value: d.sales })),
    // 饼图：营收占比（前 8 + 其他）
    pie: buildPie(list.map((d) => ({ name: d.name, value: d.revenue })), 8),
  }
}

/** 把长列表折叠为"前 N 项 + 其他"，用于饼图 */
function buildPie(items, n) {
  const sorted = [...items].filter((i) => i.value > 0).sort((a, b) => b.value - a.value)
  if (sorted.length <= n) return sorted.map((i) => ({ name: i.name, value: round2(i.value) }))
  const head = sorted.slice(0, n).map((i) => ({ name: i.name, value: round2(i.value) }))
  const rest = sorted.slice(n).reduce((s, i) => s + i.value, 0)
  if (rest > 0) head.push({ name: '其他', value: round2(rest) })
  return head
}

// ---------------------------------------------------------------------------
// 学生分层速览（管理端）
// ---------------------------------------------------------------------------
const MEAL_RANGES = [
  { name: '早餐', from: 5, to: 9 },
  { name: '午餐', from: 10, to: 14 },
  { name: '晚餐', from: 16, to: 20 },
  { name: '夜宵', from: 21, to: 28 }, // 21~23 与次日 0~4，用 24+ 表示次日
]

function mealOfHour(h) {
  const hour = h >= 0 && h < 5 ? h + 24 : h
  const hit = MEAL_RANGES.find((m) => hour >= m.from && hour <= m.to)
  return hit ? hit.name : '夜宵'
}

export function studentLayer({ range = 'today', merchantIds = [], tab = 'high' } = {}) {
  const w = validWhere({ range, merchantIds })
  const rows = all(
    `SELECT student_id, MAX(student_name) AS student_name,
            SUM(amount) AS total_amount, COUNT(*) AS orders, MAX(consume_time) AS last_time
     FROM consume_record WHERE ${w.sql} GROUP BY student_id`,
    ...w.params,
  )

  const layerT = LAYER_THRESHOLDS[range] || LAYER_THRESHOLDS.month
  const withLayer = rows.map((r) => {
    const amount = round2(r.total_amount)
    const layer = amount >= layerT.high ? '高消费' : amount >= layerT.mid ? '中消费' : '低消费'
    return {
      studentNo: r.student_id,
      name: r.student_name || '',
      layer,
      totalAmount: amount,
      orderCount: r.orders,
      lastTime: r.last_time,
    }
  })

  const counts = { high: 0, mid: 0, low: 0 }
  for (const s of withLayer) {
    if (s.layer === '高消费') counts.high++
    else if (s.layer === '中消费') counts.mid++
    else counts.low++
  }
  const totalStudents = withLayer.length

  const layerKey = tab === 'mid' ? '中消费' : tab === 'low' ? '低消费' : '高消费'
  const list = withLayer
    .filter((s) => s.layer === layerKey)
    .sort((a, b) => b.totalAmount - a.totalAmount)
    .map((s) => ({ ...s, name: s.name ? s.name[0] + (s.name.length > 1 ? '*' : '') : '匿名学生' }))

  // 就餐偏好：按金额占比
  const mealRows = all(
    `SELECT CAST(substr(consume_time, 12, 2) AS INTEGER) AS hour, SUM(amount) AS amount
     FROM consume_record WHERE ${w.sql} GROUP BY hour`,
    ...w.params,
  )
  const mealAgg = { 早餐: 0, 午餐: 0, 晚餐: 0, 夜宵: 0 }
  for (const r of mealRows) mealAgg[mealOfHour(r.hour)] += r.amount || 0
  const mealTotal = Object.values(mealAgg).reduce((a, b) => a + b, 0)
  const meal = Object.entries(mealAgg).map(([name, value]) => ({
    name,
    amount: round2(value),
    ratio: mealTotal > 0 ? Math.round((value / mealTotal) * 1000) / 10 : 0,
  }))

  // 异常消费 Tab：按门店筛选 + 周期起点过滤
  const anomalyConds = []
  const anomalyParams = []
  if (merchantIds.length) {
    anomalyConds.push(`merchant_id IN (${merchantIds.map(() => '?').join(',')})`)
    anomalyParams.push(...merchantIds)
  }
  anomalyConds.push('consume_time >= ?')
  anomalyParams.push(timeRange(range).start)
  const aWhere = `WHERE ${anomalyConds.join(' AND ')}`
  const anomalies = all(
    `SELECT anomaly_id, student_id, student_name, merchant_id, amount, expected_amount, consume_time,
            anomaly_type, deviation, sigma, risk_score, level, status
     FROM anomaly_record ${aWhere} ORDER BY risk_score DESC LIMIT 50`,
    ...anomalyParams,
  ).map((a) => ({
    anomalyId: a.anomaly_id,
    studentNo: a.student_id,
    name: a.student_name ? a.student_name[0] + '*' : '匿名学生',
    merchantId: a.merchant_id,
    amount: round2(a.amount),
    expectedAmount: round2(a.expected_amount),
    deviation: a.deviation,
    sigma: a.sigma,
    riskScore: a.risk_score,
    level: a.level,
    type: a.anomaly_type,
    time: a.consume_time,
    status: a.status,
  }))

  return {
    range: w.tr.range,
    counts,
    totalStudents,
    list,
    tab: tab === 'mid' ? 'mid' : tab === 'low' ? 'low' : 'high',
    meal,
    anomalies,
    thresholds: LAYER_THRESHOLDS[range] || LAYER_THRESHOLDS.month,
  }
}

/**
 * 异常消费处理列表（管理端）
 * 支持按 状态 / 时间范围 / 门店 / 关键字 过滤；返回列表 + 各状态计数（用于 Tab 角标）。
 *   status: pending 待处理 / handled 已处理 / ignored 已忽略 / all 全部
 *   range : all 全部 / today 今日 / week 本周
 */
export function listAnomalies({ range = 'all', status = 'pending', merchantIds = [], keyword = '', page = 1, pageSize = 20 } = {}) {
  const base = []
  const baseParams = []
  if (range && range !== 'all') {
    const tr = timeRange(range)
    base.push('consume_time >= ? AND consume_time <= ?')
    baseParams.push(tr.start, tr.end)
  }
  if (merchantIds && merchantIds.length) {
    base.push(`merchant_id IN (${merchantIds.map(() => '?').join(',')})`)
    baseParams.push(...merchantIds)
  }
  if (keyword) {
    const kw = `%${keyword}%`
    base.push('(student_id LIKE ? OR student_name LIKE ? OR merchant_id LIKE ? OR anomaly_type LIKE ?)')
    baseParams.push(kw, kw, kw, kw)
  }

  const statusCond = status && status !== 'all' ? 'status = ?' : null
  const listWhere = ['1=1', ...base, statusCond].filter(Boolean).join(' AND ')
  const listParams = [...baseParams]
  if (statusCond) listParams.push(status)

  const total = one(`SELECT COUNT(*) AS c FROM anomaly_record WHERE ${listWhere}`, ...listParams).c
  const rows = all(
    `SELECT anomaly_id, student_id, student_name, merchant_id, amount, expected_amount, consume_time,
            anomaly_type, deviation, sigma, risk_score, level, status, disposition, remark, handled_by, handled_at
     FROM anomaly_record WHERE ${listWhere}
     ORDER BY (status = 'pending') DESC, risk_score DESC
     LIMIT ? OFFSET ?`,
    ...listParams, Number(pageSize), (Number(page) - 1) * Number(pageSize),
  )

  // 各状态计数：沿用 base 过滤（门店/时间/关键字），忽略 status 过滤，便于 Tab 角标显示全量分布
  const countsWhere = ['1=1', ...base].join(' AND ')
  const countRows = all(`SELECT status, COUNT(*) AS c FROM anomaly_record WHERE ${countsWhere} GROUP BY status`, ...baseParams)
  const counts = { pending: 0, handled: 0, ignored: 0 }
  for (const r of countRows) counts[r.status] = r.c

  const list = rows.map((a) => ({
    anomalyId: a.anomaly_id,
    studentNo: a.student_id,
    name: a.student_name ? a.student_name[0] + (a.student_name.length > 1 ? '*' : '') : '匿名学生',
    merchantId: a.merchant_id,
    amount: round2(a.amount),
    expectedAmount: round2(a.expected_amount),
    deviation: a.deviation,
    sigma: a.sigma,
    riskScore: a.risk_score,
    level: a.level,
    type: a.anomaly_type,
    time: a.consume_time,
    status: a.status,
    disposition: a.disposition || '',
    remark: a.remark || '',
    handledBy: a.handled_by || '',
    handledAt: a.handled_at || '',
  }))
  return { total, list, page: Number(page), pageSize: Number(pageSize), counts }
}

/** 作息标签：按最常消费时段归类 */
function scheduleTagOf(hour) {
  if (hour == null) return '作息规律'
  if (hour >= 6 && hour < 10) return '早餐型'
  if (hour >= 10 && hour < 14) return '午餐型'
  if (hour >= 14 && hour < 17) return '下午茶型'
  if (hour >= 17 && hour < 21) return '晚餐型'
  return '夜宵型'
}

/**
 * 异常消费详情（管理端处置弹窗用）
 * 汇总学生画像：分层标签 / 作息标签 / 近 30 天消费趋势 / 常去商户 / 常去时段 / 均值·σ
 */
export function anomalyDetail(anomalyId) {
  const a = one('SELECT * FROM anomaly_record WHERE anomaly_id = ?', anomalyId)
  if (!a) return null
  const sid = a.student_id

  const stat = one('SELECT layer, avg_amount, std_dev, total_amount, consume_count, peak_hour FROM user_consume_stat WHERE student_id = ?', sid)
  const stu = one('SELECT layer, avg_amount, peak_hour FROM student WHERE student_no = ?', sid)
  const layer = (stat && stat.layer) || (stu && stu.layer) || '—'
  const peakHour = stat && stat.peak_hour != null ? stat.peak_hour : (stu && stu.peak_hour != null ? stu.peak_hour : null)
  const avgAmount = round2((stat && stat.avg_amount) || (stu && stu.avg_amount) || 0)
  const stdDev = round2((stat && stat.std_dev) || 0)

  // 近 30 天消费趋势（仅有效订单，缺失日期补 0）
  const days = lastDays(30)
  const since = days[0].date + ' 00:00:00'
  const dayMap = new Map(
    all(`SELECT substr(consume_time, 1, 10) AS day, SUM(amount) AS amount
         FROM consume_record WHERE student_id = ? AND status = ? GROUP BY day`, sid, ST_PAID)
      .map((r) => [r.day, r.amount]),
  )
  const trend = days.map((d) => ({ day: d.label, amount: round2(dayMap.get(d.date) || 0) }))

  // 常去商户（近 30 天，按消费次数）
  const merchants = all(
    `SELECT merchant_id, COALESCE(MAX(place), merchant_id) AS name, COUNT(*) AS cnt, SUM(amount) AS amount
     FROM consume_record WHERE student_id = ? AND status = ? AND consume_time >= ?
     GROUP BY merchant_id ORDER BY cnt DESC, amount DESC LIMIT 3`,
    sid, ST_PAID, since,
  ).map((r) => ({ merchantId: r.merchant_id, name: r.name, count: r.cnt, amount: round2(r.amount) }))

  // 常去时段分布（近 30 天）
  const slotDefs = [
    { label: '早餐', from: 6, to: 9 },
    { label: '午餐', from: 10, to: 13 },
    { label: '下午茶', from: 14, to: 16 },
    { label: '晚餐', from: 17, to: 20 },
    { label: '夜宵', from: 21, to: 5 },
  ]
  const hourRows = all(
    `SELECT CAST(substr(consume_time, 12, 2) AS INTEGER) AS h, COUNT(*) AS cnt
     FROM consume_record WHERE student_id = ? AND status = ? AND consume_time >= ? GROUP BY h`,
    sid, ST_PAID, since,
  )
  const totalCnt = hourRows.reduce((s, r) => s + r.cnt, 0)
  const slotCount = slotDefs.map((s) => ({ label: s.label, count: 0 }))
  const hit = (h, s) => (s.label === '夜宵' ? h >= 21 || h <= 5 : h >= s.from && h <= s.to)
  for (const r of hourRows) {
    const idx = slotDefs.findIndex((s) => hit(r.h, s))
    if (idx >= 0) slotCount[idx].count += r.cnt
  }
  const slots = slotCount
    .map((s) => ({ ...s, ratio: totalCnt > 0 ? Math.round((s.count / totalCnt) * 1000) / 10 : 0 }))
    .filter((s) => s.count > 0)
    .sort((x, y) => y.count - x.count)

  return {
    anomalyId: a.anomaly_id,
    studentNo: a.student_id,
    name: a.student_name ? a.student_name[0] + (a.student_name.length > 1 ? '*' : '') : '匿名学生',
    merchantId: a.merchant_id,
    level: a.level, type: a.anomaly_type,
    amount: round2(a.amount), expectedAmount: round2(a.expected_amount),
    deviation: a.deviation, sigma: a.sigma, riskScore: a.risk_score,
    time: a.consume_time,
    status: a.status, disposition: a.disposition || '', remark: a.remark || '',
    handledBy: a.handled_by || '', handledAt: a.handled_at || '',
    layer, scheduleTag: scheduleTagOf(peakHour), peakHour,
    avgAmount, stdDev,
    trend, merchants, slots,
  }
}

// ---------------------------------------------------------------------------
// 招商分析（管理端）
// ---------------------------------------------------------------------------
export function investment({ range = 'today', merchantIds = [] } = {}) {
  const w = validWhere({ range, merchantIds })
  const tr = w.tr

  // 周期内每个学生的汇总
  const rows = all(
    `SELECT student_id, MAX(student_name) AS student_name, SUM(amount) AS amount, COUNT(*) AS orders,
            MIN(consume_time) AS first_in_range, MAX(consume_time) AS last_time
     FROM consume_record WHERE ${w.sql} GROUP BY student_id`,
    ...w.params,
  )

  // 每个学生的历史首单时间（用于判断"新增"）
  const idConds = merchantIds.length ? `AND merchant_id IN (${merchantIds.map(() => '?').join(',')})` : ''
  const firstMap = new Map(
    all(`SELECT student_id, MIN(consume_time) AS first_time FROM consume_record WHERE status = ? ${idConds} GROUP BY student_id`,
      ST_PAID, ...(merchantIds.length ? merchantIds : [])).map((r) => [r.student_id, r.first_time]),
  )

  let newStudents = 0, newAmount = 0, newOrders = 0
  let oldStudents = 0, oldAmount = 0
  let repeatStudents = 0
  const studentMeta = []
  for (const r of rows) {
    const first = firstMap.get(r.student_id) || r.first_in_range
    const isNew = first >= tr.start && first <= tr.end
    if (isNew) { newStudents++; newAmount += r.amount; newOrders += r.orders } else { oldStudents++; oldAmount += r.amount }
    if (r.orders >= 2) repeatStudents++
    studentMeta.push({ studentNo: r.student_id, name: r.student_name, amount: r.amount, orders: r.orders, first, isNew })
  }

  const totalStudents = rows.length
  const newAvgOrderValue = newOrders > 0 ? round2(newAmount / newOrders) : 0

  // 每日新增 / 每日复购
  const days = daysBetween(tr.startDate, tr.endDate)
  const dayOrders = all(
    `SELECT student_id, substr(consume_time, 1, 10) AS day, COUNT(*) AS orders
     FROM consume_record WHERE ${w.sql} GROUP BY student_id, day`,
    ...w.params,
  )
  const firstDayMap = new Map([...firstMap].map(([k, v]) => [k, String(v).slice(0, 10)]))
  const dailyMap = new Map(days.map((d) => [d.date, { newCount: 0, repeatCount: 0 }]))
  const newSeen = new Set()
  for (const r of dayOrders) {
    const rec = dailyMap.get(r.day)
    if (!rec) continue
    const firstDay = firstDayMap.get(r.student_id) || r.day
    // 新增学生：历史首单日 = 当天（每个学生只计一次）
    if (firstDay === r.day && !newSeen.has(r.student_id)) { rec.newCount++; newSeen.add(r.student_id) }
    // 复购学生：当天消费且历史首单日早于当天
    if (firstDay < r.day) rec.repeatCount++
  }

  // 门店价值标签
  const merchants = all(
    `SELECT merchant_id, shop_name, campus, month_target FROM merchant WHERE audit_status = 'approved'`,
  )
  const filtered = merchantIds.length ? merchants.filter((m) => merchantIds.includes(m.merchant_id)) : merchants
  const storeTags = filtered.map((m) => {
    const sub = all(
      `SELECT student_id, SUM(amount) AS amount, COUNT(*) AS orders FROM consume_record
       WHERE ${w.sql} AND merchant_id = ? GROUP BY student_id`,
      ...w.params, m.merchant_id,
    )
    let n = 0, rep = 0, amt = 0
    for (const s of sub) {
      const first = firstMap.get(s.student_id) || ''
      if (first >= tr.start && first <= tr.end) n++
      if (s.orders >= 2) rep++
      amt += s.amount
    }
    const repeatRate = sub.length ? rep / sub.length : 0
    let tag = '待激活'
    if (n > 0 && repeatRate >= 0.5) tag = '高价值'
    else if (n > 0) tag = '成长型'
    else if (repeatRate >= 0.5 && sub.length > 0) tag = '稳定型'
    return {
      merchantId: m.merchant_id, shopName: m.shop_name, campus: m.campus,
      students: sub.length, newStudents: n, repeatStudents: rep,
      repeatRate: Math.round(repeatRate * 1000) / 10,
      amount: round2(amt), tag,
    }
  }).sort((a, b) => b.amount - a.amount)

  const repeatRate = totalStudents > 0 ? Math.round((repeatStudents / totalStudents) * 1000) / 10 : 0

  return {
    range: tr.range,
    metrics: {
      newStudents,
      newStudentRatio: totalStudents > 0 ? Math.round((newStudents / totalStudents) * 1000) / 10 : 0,
      newAvgOrderValue,
      repeatStudents,
      repeatRate,
      oldStudentAmount: round2(oldAmount),
      totalStudents,
    },
    pie: [
      { name: '新学生贡献', value: round2(newAmount) },
      { name: '老学生贡献', value: round2(oldAmount) },
    ].filter((x) => x.value > 0),
    daily: days.map((d) => ({ day: d.label, date: d.date, ...(dailyMap.get(d.date) || { newCount: 0, repeatCount: 0 }) })),
    storeTags,
  }
}

// ---------------------------------------------------------------------------
// 数据导出（CSV）
// ---------------------------------------------------------------------------
export function toCsv(headers, rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [headers.map(esc).join(',')]
  for (const r of rows) lines.push(r.map(esc).join(','))
  // 加 BOM，避免 Excel 打开中文乱码
  return '\uFEFF' + lines.join('\r\n')
}

export { ST_PAID, ST_REFUNDING, ST_REFUNDED }
