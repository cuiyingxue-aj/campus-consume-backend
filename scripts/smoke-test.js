// ============================================================================
// 接口冒烟测试
// 用法：先 npm start 启动服务，另开终端执行  node scripts/smoke-test.js
// 作用：一次性校验登录、角色隔离、商户端/管理端全部核心接口是否正常。
// ============================================================================
const BASE = process.env.BASE || 'http://localhost:3100/api'
let pass = 0, fail = 0

const log = (ok, msg, extra = '') => {
  console.log(`${ok ? '✅' : '❌'} ${msg}${extra ? '  →  ' + extra : ''}`)
  ok ? pass++ : fail++
}

async function req(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, json, text }
}

const M = (v) => (typeof v === 'number' ? v.toLocaleString('zh-CN') : v)

;(async () => {
  console.log(`\n开始冒烟测试：${BASE}\n${'─'.repeat(60)}`)

  // ---------- 健康检查 ----------
  const health = await req('GET', '/health')
  log(health.status === 200 && health.json?.data?.status === 'running', '健康检查 /api/health')

  // ---------- 账号密码登录 ----------
  const mLogin = await req('POST', '/auth/login', { body: { account: 'm100', password: '123456', client: 'merchant' } })
  log(mLogin.status === 200 && mLogin.json?.data?.user?.role === 'merchant', '商户账号登录', mLogin.json?.data?.user?.shopName)
  const mToken = mLogin.json?.data?.token

  const aLogin = await req('POST', '/auth/login', { body: { account: 'admin', password: 'admin123', client: 'admin' } })
  log(aLogin.status === 200 && aLogin.json?.data?.user?.role === 'admin', '管理员账号登录', aLogin.json?.data?.user?.name)
  const aToken = aLogin.json?.data?.token

  // ---------- 角色隔离 ----------
  const bad1 = await req('POST', '/auth/login', { body: { account: 'm100', password: '123456', client: 'admin' } })
  log(bad1.status === 403, '商户账号登录管理端被拦截')
  const bad2 = await req('POST', '/auth/login', { body: { account: 'admin', password: 'admin123', client: 'merchant' } })
  log(bad2.status === 403, '管理员账号登录商户端被拦截')
  const bad3 = await req('GET', '/admin/dashboard', { token: mToken })
  log(bad3.status === 403, '商户令牌访问管理端接口被拦截')
  const bad4 = await req('GET', '/merchant/dashboard', { token: aToken })
  log(bad4.status === 403, '管理员令牌访问商户端接口被拦截')

  // ---------- 微信一键登录 ----------
  const wxOk = await req('POST', '/auth/wechat-login', { body: { code: 'wx_merchant_demo', role: 'merchant' } })
  log(wxOk.status === 200 && wxOk.json?.data?.user?.role === 'merchant', '微信一键登录（已绑定商户）', wxOk.json?.data?.user?.name)
  const wxNo = await req('POST', '/auth/wechat-login', { body: { code: 'wx_not_bound', role: 'merchant' } })
  log(wxNo.status === 403, '微信一键登录（未绑定）被拒绝', wxNo.json?.message)
  const wxCross = await req('POST', '/auth/wechat-login', { body: { code: 'wx_admin_sys', role: 'merchant' } })
  log(wxCross.status === 403, '管理员微信登录商户端被拒绝')

  // ---------- 商户端 ----------
  for (const r of ['today', 'week', 'month']) {
    const d = await req('GET', `/merchant/dashboard?range=${r}`, { token: mToken })
    const t = d.json?.data
    log(d.status === 200 && t && Array.isArray(t.trend), `商户经营首页 KPI（${r}）`,
      `营业额 ¥${M(t?.revenue)} / 订单 ${M(t?.orders)} / 月目标完成率 ${t?.monthTargetRate}%`)
  }
  const mo = await req('GET', '/merchant/orders?filter=pending&pageSize=5', { token: mToken })
  log(mo.status === 200, '商户订单列表（待退款申请）', `待退款 ${mo.json?.data?.stats?.pending} / 全部 ${M(mo.json?.data?.stats?.all)}`)
  const md = await req('GET', '/merchant/dishes', { token: mToken })
  log(md.status === 200, '商户菜品管理', `共 ${md.json?.data?.total} 道 / 在售 ${md.json?.data?.stats?.on} 道`)
  const mda = await req('GET', '/merchant/dish-analysis?range=month', { token: mToken })
  log(mda.status === 200, '商户菜品分析（本月）',
    `销量 ${M(mda.json?.data?.totalSales)} / 金额 ¥${M(mda.json?.data?.totalRevenue)} / 热销TOP ${mda.json?.data?.hot?.[0]?.name}`)

  // 越权访问其他门店订单
  const otherDish = md.json?.data?.list?.[0]
  const crossDish = await req('POST', `/merchant/dishes/D1999/toggle`, { token: mToken })
  log(crossDish.status === 404, '商户操作非本店菜品被拒绝', otherDish ? `本店菜品 ${otherDish.id}` : '')

  // 退款申请：找一笔本店"已支付"订单
  const paid = await req('GET', '/merchant/orders?filter=all&pageSize=50', { token: mToken })
  const target = paid.json?.data?.list?.find((o) => o.status === '已支付')
  if (target) {
    const apply = await req('POST', `/merchant/orders/${target.transId}/refund`, { token: mToken, body: { reason: '冒烟测试-申请退款' } })
    log(apply.status === 200 && apply.json?.data?.status === 'pending', '商户提交退款申请（仅申请不可审核）', `订单 ${target.transId}`)
    const approveBlocked = await req('POST', `/admin/refunds/${apply.json?.data?.refundId}/approve`, { token: mToken })
    log(approveBlocked.status === 403, '商户尝试审核退款被拦截')
  } else {
    log(false, '商户提交退款申请（未找到可退款订单）')
  }

  // ---------- 管理端 ----------
  for (const r of ['today', 'week', 'month']) {
    const d = await req('GET', `/admin/dashboard?range=${r}`, { token: aToken })
    const t = d.json?.data
    log(d.status === 200, `平台经营首页 KPI（${r}）`,
      `营业额 ¥${M(t?.revenue)} / 订单 ${M(t?.orders)} / 学生 ${t?.students} / 完成率 ${t?.monthTargetRate}%`)
  }
  const ao = await req('GET', '/admin/orders?filter=pending&pageSize=5', { token: aToken })
  log(ao.status === 200, '平台订单列表（待退款申请）', `待退款 ${ao.json?.data?.stats?.pending}`)

  const rf = await req('GET', '/admin/refunds?status=pending', { token: aToken })
  const firstRefund = rf.json?.data?.[0]
  if (firstRefund) {
    const ap = await req('POST', `/admin/refunds/${firstRefund.id}/approve`, { token: aToken, body: {} })
    log(ap.status === 200 && ap.json?.data?.status === 'approved', '管理员同意退款', `${firstRefund.id} ¥${firstRefund.amount}`)
    const rf2 = await req('GET', '/admin/refunds?status=pending', { token: aToken })
    const second = rf2.json?.data?.[0]
    if (second) {
      const rj = await req('POST', `/admin/refunds/${second.id}/reject`, { token: aToken, body: { reason: '冒烟测试-驳回' } })
      log(rj.status === 200 && rj.json?.data?.status === 'rejected', '管理员驳回退款', `${second.id} ¥${second.amount}`)
    }
  }

  for (const r of ['today', 'week', 'month']) {
    const sl = await req('GET', `/admin/student-layer?range=${r}&tab=high`, { token: aToken })
    const c = sl.json?.data?.counts
    log(sl.status === 200 && c, `学生分层速览（${r}）`, `高 ${c?.high} / 中 ${c?.mid} / 低 ${c?.low}｜异常 ${sl.json?.data?.anomalies?.length} 条`)
  }
  const sl2 = await req('GET', '/admin/student-layer?range=month&tab=mid', { token: aToken })
  log(sl2.status === 200 && Array.isArray(sl2.json?.data?.meal), '学生就餐偏好占比', (sl2.json?.data?.meal || []).map((m) => `${m.name}${m.ratio}%`).join(' '))

  const inv = await req('GET', '/admin/investment?range=month', { token: aToken })
  log(inv.status === 200, '招商分析（本月）',
    `新增 ${inv.json?.data?.metrics?.newStudents} / 新占比 ${inv.json?.data?.metrics?.newStudentRatio}% / 复购率 ${inv.json?.data?.metrics?.repeatRate}% / 门店标签 ${inv.json?.data?.storeTags?.length} 个`)

  const exp = await fetch(`${BASE}/admin/investment/export?range=month`, { headers: { Authorization: `Bearer ${aToken}` } })
  const csv = await exp.text()
  log(exp.status === 200 && csv.includes('门店价值标签'), '招商分析数据导出（CSV）', `${csv.split('\r\n').length - 1} 行数据`)

  const lg = await req('GET', '/admin/audit-logs?pageSize=5', { token: aToken })
  log(lg.status === 200 && lg.json?.data?.total > 0, '审计日志', `共 ${lg.json?.data?.total} 条，最新：${lg.json?.data?.list?.[0]?.action}`)

  // ==========================================================================
  // 页面级流程：图表数据源 → 分页翻页 → 表单提交（退款/改价/上下架）
  //   与前端页面实际发起的请求一一对应，用于替代人工逐页点击验证
  // ==========================================================================
  console.log('\n【页面级流程验证】')

  // 微信一键登录（管理员 mock code）
  const wxAdmin = await req('POST', '/auth/wechat-login', { body: { code: 'wx_admin_sys', role: 'admin' } })
  log(wxAdmin.status === 200 && wxAdmin.json?.data?.user?.role === 'admin', '微信一键登录（管理员 mock code）', wxAdmin.json?.data?.user?.name)

  // 1) 折线图数据源：两端首页近 7 日趋势
  const mTrend = await req('GET', '/merchant/dashboard?range=week', { token: mToken })
  log(mTrend.json?.data?.trend?.length === 7, '商户首页折线图数据源', `近 7 日 ${mTrend.json?.data?.trend?.length} 个点`)
  const aTrend = await req('GET', '/admin/dashboard?range=week', { token: aToken })
  log(aTrend.json?.data?.trend?.length === 7, '管理端首页折线图数据源', `近 7 日 ${aTrend.json?.data?.trend?.length} 个点`)

  // 2) 分页翻页：第 1/2 页数据不重复，分页字段正确
  const pg1 = await req('GET', '/merchant/orders?filter=all&page=1&pageSize=10', { token: mToken })
  const pg2 = await req('GET', '/merchant/orders?filter=all&page=2&pageSize=10', { token: mToken })
  const p1First = pg1.json?.data?.list?.[0]?.transId
  const p2First = pg2.json?.data?.list?.[0]?.transId
  log(
    pg2.status === 200 && pg2.json?.data?.page === 2 && p2First && p1First !== p2First,
    '商户订单分页翻页（第 2 页）',
    `${p1First} → ${p2First}，共 ${pg1.json?.data?.total} 条`,
  )
  const apg2 = await req('GET', '/admin/orders?filter=all&page=2&pageSize=10', { token: aToken })
  log(apg2.status === 200 && apg2.json?.data?.page === 2, '管理端订单分页翻页（第 2 页）', `共 ${apg2.json?.data?.total} 条`)

  // 3) 菜品改价表单提交（改完立即改回原价，保持种子数据不变）
  const dishRes = await req('GET', '/merchant/dishes', { token: mToken })
  const dish = dishRes.json?.data?.list?.[0]
  if (dish) {
    const originPrice = Number(dish.price)
    const newPrice = Number((originPrice + 1).toFixed(2))
    const up = await req('POST', `/merchant/dishes/${dish.id}/price`, { token: mToken, body: { price: newPrice } })
    const afterUp = await req('GET', '/merchant/dishes', { token: mToken })
    const priceNow = afterUp.json?.data?.list?.find((d) => d.id === dish.id)?.price
    await req('POST', `/merchant/dishes/${dish.id}/price`, { token: mToken, body: { price: originPrice } })
    const afterBack = await req('GET', '/merchant/dishes', { token: mToken })
    const priceBack = afterBack.json?.data?.list?.find((d) => d.id === dish.id)?.price
    log(
      up.status === 200 && Number(priceNow) === newPrice && Number(priceBack) === originPrice,
      '菜品改价表单提交（含还原）',
      `#${dish.id} ${originPrice} → ${newPrice} → ${priceBack}`,
    )

    // 4) 菜品上下架表单提交（改完立即还原）
    const originStatus = dish.status
    const tg1 = await req('POST', `/merchant/dishes/${dish.id}/toggle`, { token: mToken })
    const afterTg1 = await req('GET', '/merchant/dishes', { token: mToken })
    const status1 = afterTg1.json?.data?.list?.find((d) => d.id === dish.id)?.status
    await req('POST', `/merchant/dishes/${dish.id}/toggle`, { token: mToken })
    const afterTg2 = await req('GET', '/merchant/dishes', { token: mToken })
    const status2 = afterTg2.json?.data?.list?.find((d) => d.id === dish.id)?.status
    log(
      tg1.status === 200 && status1 !== originStatus && status2 === originStatus,
      '菜品上下架表单提交（含还原）',
      `#${dish.id} ${originStatus} → ${status1} → ${status2}`,
    )
  } else {
    log(false, '菜品改价 / 上下架表单提交（未获取到菜品列表）')
  }

  // 5) 管理端订单详情弹窗（列表页不返回退款单，详情接口补充）
  const aList = await req('GET', '/admin/orders?filter=all&pageSize=10', { token: aToken })
  const firstOrder = aList.json?.data?.list?.[0]
  if (firstOrder) {
    const detail = await req('GET', `/admin/orders/${firstOrder.transId}`, { token: aToken })
    log(
      detail.status === 200 && detail.json?.data?.transId === firstOrder.transId,
      '管理端订单详情弹窗数据',
      `${firstOrder.transId} / 退款单 ${detail.json?.data?.refund?.id || '无'}`,
    )
  } else {
    log(false, '管理端订单详情弹窗数据（订单列表为空）')
  }

  // 6) 管理端门店多选筛选（结果数应为全平台的子集）
  const allMerchants = await req('GET', '/admin/merchants', { token: aToken })
  const firstMerchant = allMerchants.json?.data?.[0]?.merchantId
  if (firstMerchant) {
    const scoped = await req('GET', `/admin/orders?filter=all&pageSize=10&merchantIds=${firstMerchant}`, { token: aToken })
    log(
      scoped.status === 200 && scoped.json?.data?.stats?.all <= aList.json?.data?.stats?.all,
      '管理端门店多选筛选',
      `${firstMerchant}：${scoped.json?.data?.stats?.all} 笔 ≤ 全平台 ${aList.json?.data?.stats?.all} 笔`,
    )
  }

  // 7) 商户端扩展页：本店分层速览 / 本店招商分析 / 本店导出
  const msl = await req('GET', '/merchant/student-layer?range=month&tab=high', { token: mToken })
  log(msl.status === 200 && !!msl.json?.data?.counts, '商户端本店学生分层速览',
    `高 ${msl.json?.data?.counts?.high} / 中 ${msl.json?.data?.counts?.mid} / 低 ${msl.json?.data?.counts?.low}`)
  const minv = await req('GET', '/merchant/investment?range=month', { token: mToken })
  log(minv.status === 200 && !!minv.json?.data?.metrics, '商户端本店招商分析',
    `新增 ${minv.json?.data?.metrics?.newStudents} / 复购率 ${minv.json?.data?.metrics?.repeatRate}%`)
  const mExp = await fetch(`${BASE}/merchant/investment/export?range=month`, { headers: { Authorization: `Bearer ${mToken}` } })
  const mCsv = await mExp.text()
  log(mExp.status === 200 && mCsv.includes('门店价值标签'), '商户端招商分析导出（本店数据）', `${mCsv.split('\r\n').length - 1} 行`)

  // 8) 本店隔离量化校验：本店分层人数必须 ≤ 全平台人数
  const adminLayer = await req('GET', '/admin/student-layer?range=month&tab=high', { token: aToken })
  const sum = (c) => (c ? Number(c.high || 0) + Number(c.mid || 0) + Number(c.low || 0) : 0)
  const adminTotal = sum(adminLayer.json?.data?.counts)
  const merchantTotal = sum(msl.json?.data?.counts)
  log(merchantTotal <= adminTotal && merchantTotal > 0, '本店隔离量化校验（本店人数 ≤ 全平台）',
    `本店 ${merchantTotal} ≤ 全平台 ${adminTotal}`)

  // ---------- 令牌过期 ----------
  const badToken = await req('GET', '/merchant/dashboard', { token: 'invalid.token' })
  log(badToken.status === 401, '非法/过期令牌被拒绝')

  console.log('─'.repeat(60))
  console.log(`测试完成：通过 ${pass} 项，失败 ${fail} 项\n`)
  process.exit(fail > 0 ? 1 : 0)
})().catch((e) => {
  console.error('冒烟测试异常：', e.message)
  process.exit(1)
})
