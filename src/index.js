// ============================================================================
// 校园消费小程序 · 独立后端服务入口
// ----------------------------------------------------------------------------
// 技术栈：Node.js + Express + SQLite(better-sqlite3)
// 启动：npm install && npm run init && npm start   （端口默认 3100）
// 说明：本服务完全独立，不依赖桌面系统「校园消费数据同步与用户分层系统」，
//       仅数据表结构与统计口径与其保持一致。
// ============================================================================
import express from 'express'
import cors from 'cors'
import { PORT, HOST, DB_FILE, MOCK_WECHAT, TOKEN_TTL } from './config.js'
import { ensureSchema, isInitialized, one } from './db.js'
import { seedAll } from './seed.js'
import { authMiddleware } from './auth.js'
import authRouter from './routes/auth.js'
import merchantRouter from './routes/merchant.js'
import adminRouter from './routes/admin.js'

const app = express()
app.use(cors())
app.use(express.json({ limit: '1mb' }))

// 简易访问日志
app.use((req, _res, next) => {
  if (!req.path.startsWith('/api/health')) {
    console.log(`[${new Date().toLocaleTimeString('zh-CN')}] ${req.method} ${req.originalUrl}`)
  }
  next()
})

// ---------------------------------------------------------------------------
// 1. 首次启动自动建表 + 生成测试账号与种子数据
// ---------------------------------------------------------------------------
ensureSchema()
if (!isInitialized()) {
  console.log('[init] 检测到数据库为空，开始自动初始化（建表 + 测试账号 + 种子数据）...')
  seedAll()
} else {
  const users = one('SELECT COUNT(*) AS c FROM user').c
  console.log(`[init] 数据库已就绪：${DB_FILE}（账号 ${users} 个）`)
}

// ---------------------------------------------------------------------------
// 2. 健康检查 / 服务元信息（前端用它判断后端是否可用）
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({
    code: 0, message: 'ok',
    data: {
      service: 'campus-consume-mp-backend',
      status: 'running',
      time: new Date().toISOString(),
      tokenTtlHours: TOKEN_TTL / 3600000,
      mockWechat: MOCK_WECHAT,
      db: DB_FILE,
      baseUrl: `http://${req.headers.host || `localhost:${PORT}`}`,
    },
  })
})

// ---------------------------------------------------------------------------
// 3. 业务路由
// ---------------------------------------------------------------------------
// 认证：/login、/wechat-login 为公开接口，其余需要令牌
app.use('/api/auth', (req, res, next) => {
  const isPublic = req.path === '/login' || req.path === '/wechat-login' || req.path === '/wechat-bind'
  if (isPublic) return next()
  return authMiddleware(req, res, next)
}, authRouter)

app.use('/api/merchant', authMiddleware, merchantRouter)
app.use('/api/admin', authMiddleware, adminRouter)

// ---------------------------------------------------------------------------
// 4. 兜底处理
// ---------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ code: 404, message: `接口不存在：${req.method} ${req.originalUrl}`, data: null })
})
app.use((err, _req, res, _next) => {
  console.error('[error]', err)
  res.status(500).json({ code: 500, message: err?.message || '服务器内部错误', data: null })
})

app.listen(PORT, HOST, () => {
  console.log('')
  console.log('==========================================================')
  console.log('  校园消费小程序 · 独立后端已启动')
  console.log(`  本机访问：http://localhost:${PORT}`)
  console.log(`  局域网访问：http://<本机局域网IP>:${PORT}`)
  console.log(`  健康检查：http://localhost:${PORT}/api/health`)
  console.log(`  数据库文件：${DB_FILE}`)
  console.log(`  令牌有效期：${TOKEN_TTL / 3600000} 小时`)
  console.log('==========================================================')
  console.log('')
})
