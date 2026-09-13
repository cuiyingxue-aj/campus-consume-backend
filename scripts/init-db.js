// ============================================================================
// 数据库初始化脚本
// ----------------------------------------------------------------------------
// 用法：
//   npm run init          # 建表 + 生成测试账号与种子数据（已有数据时会跳过）
//   npm run reset         # 强制重建（删除旧库文件后重新生成）
// 说明：种子数据以"运行当天"为基准往前铺 45 天，因此今日/本周/本月筛选一定有数据。
// ============================================================================
import fs from 'node:fs'
import { DB_FILE } from '../src/config.js'

const force = process.argv.includes('--force') || process.argv.includes('-f')

if (force && fs.existsSync(DB_FILE)) {
  let removed = 0
  for (const suffix of ['', '-wal', '-shm']) {
    const f = DB_FILE + suffix
    if (!fs.existsSync(f)) continue
    try {
      fs.rmSync(f)
      removed++
    } catch (e) {
      // 文件被占用或系统回收站不可用时，退化为「清空业务表后重建」，不影响最终结果
      console.warn(`[init] 无法删除 ${f}（${e.message}），改为清空业务表后重建`)
    }
  }
  if (removed) console.log('[init] 已删除旧数据库文件，准备重建')
}

const { ensureSchema, isInitialized, one } = await import('../src/db.js')
const { seedAll } = await import('../src/seed.js')

ensureSchema()

if (isInitialized() && !force) {
  const users = one('SELECT COUNT(*) AS c FROM user').c
  console.log(`[init] 数据库已存在且已初始化（账号 ${users} 个），跳过种子数据生成。`)
  console.log('[init] 如需重建，请执行：npm run reset')
} else {
  if (force) {
    // 强制重建场景：清空业务表后再灌数据
    const { db } = await import('../src/db.js')
    db.exec(`
      DELETE FROM consume_record; DELETE FROM refund; DELETE FROM anomaly_record;
      DELETE FROM user_consume_stat; DELETE FROM sync_log; DELETE FROM audit_log;
      DELETE FROM dish; DELETE FROM student; DELETE FROM merchant;
      DELETE FROM wechat_bind; DELETE FROM user; DELETE FROM sys_config;
    `)
  }
  seedAll()
}

// 打印测试账号，方便直接复制使用
const { all } = await import('../src/db.js')
const accounts = all('SELECT username, password, role, shop_name, merchant_id, openid FROM user ORDER BY role, id')
console.log('')
console.log('================= 测试账号（可直接用于登录） =================')
for (const a of accounts) {
  const roleText = a.role === 'admin' ? '管理员端' : '商户端  '
  console.log(`  [${roleText}] 账号：${a.username}   密码：${a.password}   ${a.shop_name || ''}`)
}
console.log('------------------------------------------------------------')
console.log('  微信一键登录演示 openid（本地 mock，直接当 code 传给后端）：')
for (const a of accounts) {
  console.log(`    ${a.role === 'admin' ? '管理员' : '商户  '}  openid/code = ${a.openid}   → ${a.username}`)
}
console.log('============================================================')
console.log('')
