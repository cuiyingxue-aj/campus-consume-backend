// ============================================================================
// 种子数据生成器
// ----------------------------------------------------------------------------
// 目标：一次性生成"像真实运营了 45 天"的全套数据，覆盖桌面系统的业务字典与生成口径。
// 特点：
//   1. 使用 mulberry32(20260909) 确定性随机数 —— 每次初始化得到的数据完全一致，便于演示复现；
//   2. 订单时间以"运行当天"为基准往前铺 45 天，因此无论哪天初始化，
//      「今日 / 本周 / 本月」三个时间筛选都一定有数据；
//   3. 有效订单口径：status = '已支付'；退款审核中、已退款均视为无效订单被剔除。
// ============================================================================
import { db, run, one, all, setConfig } from './db.js'

// ---------------------------------------------------------------------------
// 随机数工具（与桌面系统同一套写法，保证数据风格一致）
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = mulberry32(20260909)
const rnd = (n) => Math.floor(rand() * n)
const pick = (arr) => arr[rnd(arr.length)]
/** 洗牌（不改原数组）：用于同一门店菜品去重取名 */
const shuffle = (arr) => {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = rnd(i + 1)
    const t = a[i]
    a[i] = a[j]
    a[j] = t
  }
  return a
}
const round2 = (n) => Math.round(n * 100) / 100
const pad = (n) => String(n).padStart(2, '0')

// ---------------------------------------------------------------------------
// 业务字典（与桌面系统 backend/index.js 完全一致）
// ---------------------------------------------------------------------------
const CAMPUSES = ['一食堂', '二食堂', '三食堂', '南苑食堂', '校园超市']
const CATEGORIES = ['中式快餐', '面食', '麻辣香锅', '奶茶饮品', '西式简餐', '超市便利', '盖浇饭', '水饺馄饨']
// 门店名部件（用于保证门店名唯一，避免出现两家同名门店）
const SHOP_FLAVORS = ['川味', '广式', '东北', '兰州', '湘情', '粤味', '家常', '精品']
const SHOP_SUFFIXES = ['餐厅', '档口', '小厨', '面馆']
const DISH_BY_CATEGORY = {
  中式快餐: ['红烧肉盖饭', '黄焖鸡米饭', '照烧鸡排饭', '可乐鸡翅饭', '土豆牛肉饭', '扬州炒饭', '麻婆豆腐饭'],
  面食: ['番茄鸡蛋面', '兰州拉面', '红烧牛肉面', '牛肉水饺', '鸡蛋灌饼', '小笼包'],
  麻辣香锅: ['麻辣香锅', '酸辣粉', '螺蛳粉', '关东煮', '烤冷面'],
  奶茶饮品: ['珍珠奶茶', '芒果冰沙', '豆浆', '鲜榨橙汁', '酸梅汤'],
  西式简餐: ['照烧鸡排饭', '鸡排饭', '三明治', '意面', '焗饭'],
  超市便利: ['烤肠', '矿泉水', '酸奶', '薯片', '方便面', '茶叶蛋'],
  盖浇饭: ['红烧肉盖饭', '麻婆豆腐饭', '土豆牛肉饭', '卤肉饭', '青椒肉丝饭', '宫保鸡丁饭'],
  水饺馄饨: ['牛肉水饺', '三鲜水饺', '皮蛋瘦肉粥', '小笼包', '馄饨汤'],
}
const CHANNELS = ['刷卡', '扫码', 'NFC']
const GRADES = ['大一', '大二', '大三', '大四', '研究生']
const COLLEGES = ['计算机学院', '经管学院', '外国语学院', '机械学院', '艺术学院', '数学学院']
const SURNAMES = '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜'
const GIVEN = '伟芳娜敏静丽强磊军洋勇艳杰娟涛明超秀兰霞平刚桂英华红玉梅浩宇欣怡子轩雨桐'
const cname = () => SURNAMES[rnd(SURNAMES.length)] + GIVEN[rnd(GIVEN.length)] + (rand() > 0.5 ? GIVEN[rnd(GIVEN.length)] : '')
const ATYPES = ['单笔金额异常', '短时高频消费', '深夜消费', '退款频率异常', '异地消费']

/** 脱敏姓名：商户端不展示学生完整姓名 */
const maskName = (n) => (!n ? '匿名学生' : n.length <= 1 ? n + '**' : n[0] + '*'.repeat(Math.max(1, n.length - 1)))

const fmtTime = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

// 有效订单状态常量
const ST_PAID = '已支付'
const ST_REFUNDING = '退款审核中'
const ST_REFUNDED = '已退款'

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
export function seedAll() {
  console.log('[seed] 开始生成种子数据 ...')
  const now = new Date()

  // ============ 1. 商户 ============
  const insertMerchant = db.prepare(`INSERT INTO merchant
    (merchant_id, shop_name, category, campus, owner, phone, audit_status, window_count, dish_count,
     target, month_target, target_orders, week_growth, best_seller, seeded, created_at)
    VALUES (@merchant_id, @shop_name, @category, @campus, @owner, @phone, @audit_status, @window_count, @dish_count,
     @target, @month_target, @target_orders, @week_growth, @best_seller, 1, @created_at)`)

  const merchants = []
  for (let i = 0; i < 30; i++) {
    const campus = pick(CAMPUSES)
    const category = pick(CATEGORIES)
    const auditPool = ['approved', 'approved', 'approved', 'approved', 'pending', 'rejected']
    const target = round2(3000 + rand() * 4000)             // 日营业额目标 3000~7000
    merchants.push({
      merchantId: 'M' + String(100 + i),
      shopName: `${campus}-${pick(SHOP_FLAVORS)}${pick(SHOP_SUFFIXES)}`,
      category,
      campus,
      owner: cname(),
      phone: '138' + String(10000000 + rnd(89999999)),
      auditStatus: pick(auditPool),
      windowCount: 1 + rnd(4),
      dishCount: 4 + rnd(8),
      target,
      monthTarget: round2(target * (26 + rnd(6))),           // 月目标按日目标 × 26~31 天
      targetOrders: Math.round(target / 18),
      weekGrowth: round2(-20 + rand() * 120),
      bestSeller: '—',
    })
  }
  // 保证演示账号对应的商户一定处于营业状态，并保留几个特殊状态用于展示
  merchants[0].auditStatus = 'approved'
  merchants[1].auditStatus = 'approved'
  merchants[3].shopName = '三食堂-川味餐厅'
  merchants[3].auditStatus = 'pending'
  merchants[5].auditStatus = 'rejected'

  // 门店名去重：同名门店会让「平台门店概览 / 招商分析」看起来像重复数据
  const usedShopNames = new Set()
  for (const m of merchants) {
    if (!usedShopNames.has(m.shopName)) {
      usedShopNames.add(m.shopName)
      continue
    }
    let renamed = ''
    for (const flavor of SHOP_FLAVORS) {
      for (const suffix of SHOP_SUFFIXES) {
        const cand = `${m.campus}-${flavor}${suffix}`
        if (!usedShopNames.has(cand)) { renamed = cand; break }
      }
      if (renamed) break
    }
    m.shopName = renamed || `${m.shopName}（2店）`
    usedShopNames.add(m.shopName)
  }

  const createdAt = fmtDate(now)
  for (const m of merchants) {
    insertMerchant.run({
      merchant_id: m.merchantId, shop_name: m.shopName, category: m.category, campus: m.campus,
      owner: m.owner, phone: m.phone, audit_status: m.auditStatus, window_count: m.windowCount,
      dish_count: m.dishCount, target: m.target, month_target: m.monthTarget, target_orders: m.targetOrders,
      week_growth: m.weekGrowth, best_seller: m.bestSeller, created_at: createdAt,
    })
  }
  const approvedMerchants = merchants.filter((m) => m.auditStatus === 'approved')

  // ============ 2. 菜品 ============
  const insertDish = db.prepare(`INSERT INTO dish
    (id, name, merchant_id, merchant, category, price, stock, sales, revenue, status, month_growth, created_at)
    VALUES (@id, @name, @merchant_id, @merchant, @category, @price, @stock, @sales, @revenue, @status, @month_growth, @created_at)`)

  const dishes = []
  let dishSeq = 0
  for (const m of merchants) {
    // 同一门店内菜品不重名：从该品类候选名中不重复地取（避免出现「烤肠 ×3」这类重复数据）
    const pool = DISH_BY_CATEGORY[m.category] || DISH_BY_CATEGORY['中式快餐']
    const names = shuffle(pool).slice(0, Math.min(m.dishCount, pool.length))
    m.dishCount = names.length
    for (const name of names) {
      dishSeq++
      const price = round2(5 + rand() * 30)
      dishes.push({
        id: 'D' + String(1000 + dishSeq),
        name,
        merchantId: m.merchantId,
        merchant: m.shopName,
        category: m.category,
        price,
        stock: 20 + rnd(180),
        baseSales: rnd(400),
        status: rand() > 0.12 ? 'on' : 'off',
        monthGrowth: round2(-30 + rand() * 100),
      })
    }
  }
  // 去重后实际菜品数可能少于计划数，回填到门店表，保证列表展示一致
  for (const m of merchants) {
    run('UPDATE merchant SET dish_count = ? WHERE merchant_id = ?', m.dishCount, m.merchantId)
  }
  for (const d of dishes) {
    insertDish.run({
      id: d.id, name: d.name, merchant_id: d.merchantId, merchant: d.merchant, category: d.category,
      price: d.price, stock: d.stock, sales: d.baseSales, revenue: round2(d.baseSales * d.price),
      status: d.status, month_growth: d.monthGrowth, created_at: createdAt,
    })
  }
  const dishesByMerchant = new Map()
  for (const d of dishes) {
    if (!dishesByMerchant.has(d.merchantId)) dishesByMerchant.set(d.merchantId, [])
    dishesByMerchant.get(d.merchantId).push(d)
  }
  // 招牌菜 = 该店在售菜品中销量最高的那道
  for (const m of merchants) {
    const my = (dishesByMerchant.get(m.merchantId) || []).filter((d) => d.status === 'on')
    if (my.length) {
      const best = my.reduce((a, b) => (a.baseSales > b.baseSales ? a : b))
      m.bestSeller = best.name
      run('UPDATE merchant SET best_seller = ? WHERE merchant_id = ?', best.name, m.merchantId)
    }
  }

  // ============ 3. 学生 ============
  const insertStudent = db.prepare(`INSERT INTO student
    (student_no, name, grade, college, gender, layer, total_amount, consume_count, avg_amount, peak_hour, created_at)
    VALUES (@student_no, @name, @grade, @college, @gender, @layer, 0, 0, 0, @peak_hour, @created_at)`)

  const students = []
  for (let i = 0; i < 500; i++) {
    students.push({
      studentNo: '2026' + String(i + 1).padStart(4, '0'),
      name: cname(),
      grade: pick(GRADES),
      college: pick(COLLEGES),
      gender: rand() > 0.5 ? '男' : '女',
      peakHour: pick([7, 8, 11, 12, 12, 12, 17, 18, 19, 22]),
    })
  }
  for (const s of students) {
    insertStudent.run({
      student_no: s.studentNo, name: s.name, grade: s.grade, college: s.college, gender: s.gender,
      layer: '低消费', peak_hour: s.peakHour, created_at: createdAt,
    })
  }

  // ============ 4. 消费流水（订单）============
  const insertRecord = db.prepare(`INSERT INTO consume_record
    (trans_id, student_id, student_name, merchant_id, place, category, channel, dish_id, dish_name,
     quantity, amount, consume_time, status, created_at)
    VALUES (@trans_id, @student_id, @student_name, @merchant_id, @place, @category, @channel, @dish_id, @dish_name,
     @quantity, @amount, @consume_time, @status, @created_at)`)

  const HOURS = [7, 7, 8, 11, 12, 12, 12, 13, 17, 17, 18, 18, 19, 22]
  const DAYS = 45
  const orderRows = []
  let transSeq = 0

  for (const s of students) {
    // ---- 每个学生分配一个"首次消费日"：0 = 今天，44 = 44 天前 ----
    // 作用：一部分学生首次消费落在近几天/近几周，招商分析的"新增学生"才有数据。
    const firstDay = rnd(DAYS)
    // ---- 目标月消费额：均值约 3000 元、右偏分布，保证 高/中/低 三层都有足够样本 ----
    const bell = rand() + rand() + rand() - 1.5           // 均值 0，标准差约 0.5
    const monthlyTarget = Math.max(300, 2600 + bell * 2800 + Math.pow(rand(), 3) * 2000)
    const avgOrder = 40 + rand() * 25                     // 该生平均客单价 40~65 元
    // 只在 [0, firstDay] 这段"已入学时间"内产生订单
    const activeMonths = (firstDay + 1) / 30
    let count = Math.round((monthlyTarget / avgOrder) * activeMonths * (0.85 + rand() * 0.3))
    count = Math.min(260, Math.max(1, count))

    for (let k = 0; k < count; k++) {
      const m = pick(approvedMerchants)
      const pool = dishesByMerchant.get(m.merchantId) || []
      const onSale = pool.filter((d) => d.status === 'on')
      const usable = onSale.length ? onSale : pool
      const dish = usable.length ? pick(usable) : null
      const quantity = 1 + rnd(4)
      const price = dish ? dish.price : round2(6 + rand() * 20)
      const amount = round2(price * quantity * (rand() < 0.3 ? 0.9 : 1))
      // 第 1 单强制落在首次消费日，保证"历史首单时间"语义准确
      const dayOffset = k === 0 ? firstDay : rnd(firstDay + 1)
      const d = new Date(now)
      d.setDate(d.getDate() - dayOffset)
      d.setHours(pick(HOURS), rnd(60), rnd(60), 0)
      transSeq++
      orderRows.push({
        trans_id: 'T' + String(1000000 + transSeq),
        student_id: s.studentNo,
        student_name: s.name,
        merchant_id: m.merchantId,
        place: m.shopName,
        category: m.category,
        channel: pick(CHANNELS),
        dish_id: dish ? dish.id : null,
        dish_name: dish ? dish.name : '其他',
        quantity,
        amount,
        consume_time: fmtTime(d),
        status: ST_PAID,
        created_at: fmtTime(now),
      })
    }
  }
  const insertMany = db.transaction((rows) => { for (const r of rows) insertRecord.run(r) })
  insertMany(orderRows)
  console.log(`[seed] 已生成 ${orderRows.length} 条消费流水`)

  // ---- 4.1 抽取一部分订单变为退款状态，并生成对应退款单 ----
  const refundTargets = new Set()
  while (refundTargets.size < 42) refundTargets.add(rnd(orderRows.length))
  const refundedTargets = new Set()
  while (refundedTargets.size < 26) {
    const idx = rnd(orderRows.length)
    if (!refundTargets.has(idx)) refundedTargets.add(idx)
  }

  const insertRefund = db.prepare(`INSERT INTO refund
    (id, trans_id, student_id, student, merchant_id, merchant, amount, reason, time, status, audit_by, audit_time)
    VALUES (@id, @trans_id, @student_id, @student, @merchant_id, @merchant, @amount, @reason, @time, @status, @audit_by, @audit_time)`)
  const REASONS = ['菜品质量问题', '下错单', '重复扣款', '未收到餐品', '异物投诉']
  const updateStatus = db.prepare('UPDATE consume_record SET status = ? WHERE trans_id = ?')

  let refundSeq = 0
  for (const idx of refundedTargets) {
    const r = orderRows[idx]
    updateStatus.run(ST_REFUNDED, r.trans_id)
    refundSeq++
    insertRefund.run({
      id: 'R' + (2000 + refundSeq), trans_id: r.trans_id, student_id: r.student_id,
      student: maskName(r.student_name), merchant_id: r.merchant_id, merchant: r.place,
      amount: r.amount, reason: pick(REASONS), time: r.consume_time,
      status: 'approved', audit_by: '系统管理员', audit_time: r.consume_time,
    })
  }
  for (const idx of refundTargets) {
    const r = orderRows[idx]
    updateStatus.run(ST_REFUNDING, r.trans_id)
    refundSeq++
    insertRefund.run({
      id: 'R' + (2000 + refundSeq), trans_id: r.trans_id, student_id: r.student_id,
      student: maskName(r.student_name), merchant_id: r.merchant_id, merchant: r.place,
      amount: r.amount, reason: pick(REASONS), time: r.consume_time,
      status: 'pending', audit_by: null, audit_time: null,
    })
  }

  // ---- 4.2 回填菜品累计销量 / 营收（基准销量 + 近期真实订单）----
  const dishAgg = all(`SELECT dish_id, SUM(quantity) AS qty, SUM(amount) AS amt
                       FROM consume_record WHERE status = ? AND dish_id IS NOT NULL GROUP BY dish_id`, ST_PAID)
  const updDish = db.prepare('UPDATE dish SET sales = sales + ?, revenue = revenue + ? WHERE id = ?')
  for (const row of dishAgg) updDish.run(row.qty || 0, round2(row.amt || 0), row.dish_id)

  // ============ 5. 学生消费统计 + 分层回填 ============
  // 分层口径（与需求一致）：高 ≥2000 元，中 1000~2000 元，低 <1000 元；仅统计有效订单。
  const statRows = all(`SELECT student_id, student_name,
                               SUM(amount) AS total, COUNT(*) AS cnt, MAX(consume_time) AS last_time
                        FROM consume_record WHERE status = ? GROUP BY student_id`, ST_PAID)
  const updStudent = db.prepare('UPDATE student SET total_amount = ?, consume_count = ?, avg_amount = ?, layer = ? WHERE student_no = ?')
  const insertStat = db.prepare(`INSERT OR REPLACE INTO user_consume_stat
    (student_id, student_name, total_amount, consume_count, peak_hour, avg_amount, std_dev, layer, cluster, updated_at)
    VALUES (@student_id, @student_name, @total_amount, @consume_count, @peak_hour, @avg_amount, @std_dev, @layer, NULL, @updated_at)`)

  for (const row of statRows) {
    const layer = row.total >= 2000 ? '高消费' : row.total >= 1000 ? '中消费' : '低消费'
    const stu = students.find((s) => s.studentNo === row.student_id) || {}
    updStudent.run(round2(row.total), row.cnt, round2(row.total / row.cnt), layer, row.student_id)
    // 标准差：用于 3σ 异常检测，与桌面系统算法一致
    const amounts = all('SELECT amount FROM consume_record WHERE student_id = ? AND status = ?', row.student_id, ST_PAID).map((x) => x.amount)
    const mean = amounts.length ? amounts.reduce((a, b) => a + b, 0) / amounts.length : 0
    const variance = amounts.length ? amounts.reduce((t, v) => t + (v - mean) ** 2, 0) / amounts.length : 0
    // 最常消费时段：按订单数取众数
    const peak = one(`SELECT CAST(substr(consume_time, 12, 2) AS INTEGER) AS h, COUNT(*) AS c
                      FROM consume_record WHERE student_id = ? AND status = ?
                      GROUP BY h ORDER BY c DESC LIMIT 1`, row.student_id, ST_PAID)
    insertStat.run({
      student_id: row.student_id, student_name: row.student_name,
      total_amount: round2(row.total), consume_count: row.cnt,
      peak_hour: peak ? peak.h : (stu.peakHour || 12), avg_amount: round2(mean),
      std_dev: round2(Math.sqrt(variance)), layer,
      updated_at: fmtTime(now),
    })
    if (peak) run('UPDATE student SET peak_hour = ? WHERE student_no = ?', peak.h, row.student_id)
  }

  // ============ 6. 异常消费记录 ============
  const insertAnomaly = db.prepare(`INSERT INTO anomaly_record
    (anomaly_id, student_id, student_name, merchant_id, amount, expected_amount, consume_time,
     anomaly_type, deviation, sigma, risk_score, level, status, detected_at)
    VALUES (@anomaly_id, @student_id, @student_name, @merchant_id, @amount, @expected_amount, @consume_time,
     @anomaly_type, @deviation, @sigma, @risk_score, @level, @status, @detected_at)`)
  for (let i = 0; i < 26; i++) {
    const s = pick(students)
    const level = pick(['高', '中', '中', '低'])
    const score = level === '高' ? 80 + rnd(20) : level === '中' ? 60 + rnd(19) : 40 + rnd(19)
    const sigma = level === '高' ? round2(4 + rand() * 2) : level === '中' ? round2(3 + rand()) : round2(2 + rand())
    const amount = round2(80 + rand() * 400)
    const expected = round2(amount / (2 + rand() * 3))
    const m = pick(merchants)
    const d = new Date(now)
    d.setDate(d.getDate() - rnd(9))
    d.setHours(rnd(24), rnd(60), 0, 0)
    insertAnomaly.run({
      anomaly_id: 'A' + (3000 + i), student_id: s.studentNo, student_name: s.name,
      merchant_id: m.merchantId, amount, expected_amount: expected, consume_time: fmtTime(d),
      anomaly_type: pick(ATYPES), deviation: Math.round(((amount - expected) / expected) * 100),
      sigma, risk_score: score, level,
      status: pick(['pending', 'pending', 'handled', 'ignored']),
      detected_at: fmtTime(now),
    })
  }

  // ============ 7. 账号 + 微信绑定 ============
  const insertUser = db.prepare(`INSERT INTO user
    (username, name, phone, password, role, merchant_id, shop_name, perm, disabled, openid, created_at)
    VALUES (@username, @name, @phone, @password, @role, @merchant_id, @shop_name, @perm, @disabled, @openid, @created_at)`)
  const insertBind = db.prepare('INSERT INTO wechat_bind (openid, role, user_id, bind_time) VALUES (?, ?, ?, ?)')

  const m0 = merchants[0]
  const accounts = [
    // ---- 管理员账号 ----
    { username: 'admin', name: '系统管理员', phone: '13800000002', password: 'admin123', role: 'admin', merchantId: null, shopName: '平台管理中心', perm: 'sys', disabled: 0, openid: 'wx_admin_sys' },
    { username: 'finance', name: '财务审核员', phone: '13800000020', password: 'finance123', role: 'admin', merchantId: null, shopName: '平台管理中心', perm: 'finance', disabled: 0, openid: 'wx_admin_finance' },
    { username: 'food', name: '食安管理员', phone: '13800000004', password: 'food12345', role: 'admin', merchantId: null, shopName: '平台管理中心', perm: 'food', disabled: 0, openid: 'wx_admin_food' },
    // ---- 商户账号（M100，需求指定的主演示账号）----
    { username: 'm100', name: '崔映雪', phone: '13800000001', password: '123456', role: 'merchant', merchantId: m0.merchantId, shopName: m0.shopName, perm: null, disabled: 0, openid: 'wx_merchant_demo' },
  ]
  // 再补若干商户账号，绑定到不同门店，便于验证"只能看本店数据"
  for (let i = 1; i < 8; i++) {
    const m = approvedMerchants[i % approvedMerchants.length]
    accounts.push({
      username: 'm' + m.merchantId.slice(1),
      name: cname(), phone: '1380000' + String(1000 + i), password: '123456',
      role: 'merchant', merchantId: m.merchantId, shopName: m.shopName,
      perm: null, disabled: 0, openid: 'wx_merchant_' + i,
    })
  }
  for (const a of accounts) {
    const info = insertUser.run({
      username: a.username, name: a.name, phone: a.phone, password: a.password, role: a.role,
      merchant_id: a.merchantId, shop_name: a.shopName, perm: a.perm, disabled: a.disabled,
      openid: a.openid, created_at: createdAt,
    })
    insertBind.run(a.openid, a.role, Number(info.lastInsertRowid), fmtTime(now))
    // 同步 openid 到 user 表，便于按 openid 反查
    run('UPDATE user SET openid = ? WHERE id = ?', a.openid, Number(info.lastInsertRowid))
  }

  // ============ 8. 校准月度目标 ============
  // 月度目标如果凭空给一个数，"月度目标完成率"会失真。
  // 这里用真实生成的本月有效营业额反推目标，让完成率落在 65%~115% 的合理区间。
  const monthStart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01 00:00:00`
  let platformMonthTarget = 0
  for (const m of merchants) {
    if (m.auditStatus !== 'approved') continue
    const rev = one(
      'SELECT COALESCE(SUM(amount),0) AS r FROM consume_record WHERE merchant_id = ? AND status = ? AND consume_time >= ?',
      m.merchantId, ST_PAID, monthStart,
    ).r
    const base = rev > 0 ? rev : 8000
    const monthTarget = round2(base / (0.65 + rand() * 0.5))
    const dayTarget = round2(monthTarget / 30)
    run('UPDATE merchant SET month_target = ?, target = ? WHERE merchant_id = ?', monthTarget, dayTarget, m.merchantId)
    platformMonthTarget += monthTarget
  }
  setConfig('platform_month_target', round2(platformMonthTarget))

  // ============ 9. 同步日志 ============
  run(`INSERT INTO sync_log (sync_time, synced_count, last_id, status, message) VALUES (?, ?, ?, ?, ?)`,
    fmtTime(now), orderRows.length, orderRows.length, '成功', '首次全量同步（biz → analysis）')

  console.log('[seed] 种子数据生成完成 ✅')
  return { merchantCount: merchants.length, dishCount: dishes.length, studentCount: students.length, orderCount: orderRows.length }
}
