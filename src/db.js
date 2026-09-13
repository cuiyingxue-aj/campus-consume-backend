// ============================================================================
// SQLite 数据库层
// ----------------------------------------------------------------------------
// 使用 better-sqlite3（同步 API，写法接近原生 SQL，便于阅读）。
// 表结构、字段命名、统计口径与桌面系统
// 「校园消费数据同步与用户分层系统」保持一致：
//   consume_record / user_consume_stat / anomaly_record / sync_log 四张核心表沿用原字段，
//   另外为小程序业务补齐 merchant / dish / student / refund / user / audit_log 等表。
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { DATA_DIR, DB_FILE } from './config.js'

fs.mkdirSync(DATA_DIR, { recursive: true })

export const db = new Database(DB_FILE)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

// ----------------------------------------------------------------------------
// 建表语句：全部使用 IF NOT EXISTS，重复执行不会破坏已有数据
// ----------------------------------------------------------------------------
export const SCHEMA = `
-- 商户表
CREATE TABLE IF NOT EXISTS merchant (
  merchant_id   TEXT PRIMARY KEY,           -- 商户编号 M100...
  shop_name     TEXT NOT NULL,              -- 店铺名称
  category      TEXT,                       -- 经营类别
  campus        TEXT,                       -- 所属校区/食堂
  owner         TEXT,                       -- 负责人
  phone         TEXT,                       -- 联系电话
  audit_status  TEXT DEFAULT 'pending',     -- 审核状态 approved / pending / rejected
  window_count  INTEGER DEFAULT 1,          -- 窗口数量
  dish_count    INTEGER DEFAULT 0,          -- 菜品数量
  target        REAL DEFAULT 0,             -- 日营业额目标
  month_target  REAL DEFAULT 0,             -- 月营业额目标（月度目标完成率的分母）
  target_orders INTEGER DEFAULT 200,        -- 日订单目标
  week_growth   REAL DEFAULT 0,             -- 周增长率（%）
  best_seller   TEXT DEFAULT '—',           -- 招牌菜
  seeded        INTEGER DEFAULT 1,          -- 1=初始化种子数据 0=运行期新增
  created_at    TEXT
);

-- 菜品表
CREATE TABLE IF NOT EXISTS dish (
  id           TEXT PRIMARY KEY,            -- 菜品编号 D1001...
  name         TEXT NOT NULL,               -- 菜名
  merchant_id  TEXT NOT NULL,               -- 所属商户（外键）
  merchant     TEXT,                        -- 所属商户名称（冗余存储，列表查询免联表）
  category     TEXT,                        -- 所属类别
  price        REAL NOT NULL DEFAULT 0,     -- 售价
  stock        INTEGER NOT NULL DEFAULT 0,  -- 库存
  sales        INTEGER NOT NULL DEFAULT 0,  -- 累计销量
  revenue      REAL NOT NULL DEFAULT 0,     -- 累计营收
  status       TEXT DEFAULT 'on',           -- 在售状态 on / off
  month_growth REAL DEFAULT 0,              -- 月增长率（%）
  created_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_dish_merchant ON dish(merchant_id);

-- 学生表
CREATE TABLE IF NOT EXISTS student (
  student_no    TEXT PRIMARY KEY,           -- 学号
  name          TEXT,                       -- 姓名
  grade         TEXT,                       -- 年级
  college       TEXT,                       -- 学院
  gender        TEXT,                       -- 性别
  layer         TEXT,                       -- 消费分层（按累计有效消费金额）
  total_amount  REAL DEFAULT 0,             -- 累计消费金额
  consume_count INTEGER DEFAULT 0,          -- 消费次数
  avg_amount    REAL DEFAULT 0,             -- 平均每次消费
  peak_hour     INTEGER,                    -- 最常消费时段
  created_at    TEXT
);

-- 消费流水（订单）表：字段结构与桌面系统 biz.db 的 consume_record 对齐，并补充小程序下单相关字段
CREATE TABLE IF NOT EXISTS consume_record (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  trans_id      TEXT UNIQUE,                -- 交易号
  student_id    TEXT NOT NULL,              -- 学号
  student_name  TEXT,                       -- 学生姓名
  merchant_id   TEXT,                       -- 商户编号（新增，用于商户端数据隔离）
  place         TEXT,                       -- 消费地点/商户名称
  category      TEXT,                       -- 消费类别
  channel       TEXT,                       -- 支付渠道 刷卡/扫码/NFC
  dish_id       TEXT,                       -- 菜品编号（新增）
  dish_name     TEXT,                       -- 菜品名称（新增）
  quantity      INTEGER DEFAULT 1,          -- 份数（新增）
  amount        REAL NOT NULL,              -- 消费金额
  consume_time  TEXT NOT NULL,              -- 消费时间 'YYYY-MM-DD HH:MM:SS'
  status        TEXT NOT NULL DEFAULT '已支付', -- 已支付 / 退款审核中 / 已退款
  created_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_biz_student  ON consume_record(student_id);
CREATE INDEX IF NOT EXISTS idx_biz_time     ON consume_record(consume_time);
CREATE INDEX IF NOT EXISTS idx_biz_merchant ON consume_record(merchant_id);
CREATE INDEX IF NOT EXISTS idx_biz_status   ON consume_record(status);

-- 退款单表
CREATE TABLE IF NOT EXISTS refund (
  id          TEXT PRIMARY KEY,             -- 退款单号 R2000...
  trans_id    TEXT,                         -- 关联交易号
  student_id  TEXT,                         -- 申请学生学号
  student     TEXT,                         -- 申请学生（商户端脱敏展示）
  merchant_id TEXT,                         -- 商户编号
  merchant    TEXT,                         -- 商户名称
  amount      REAL,                         -- 退款金额
  reason      TEXT,                         -- 退款原因
  time        TEXT,                         -- 申请时间
  status      TEXT DEFAULT 'pending',       -- pending 待审批 / approved 已通过 / rejected 已驳回
  audit_by    TEXT,                         -- 审批人
  audit_time  TEXT                          -- 审批时间
);
CREATE INDEX IF NOT EXISTS idx_refund_merchant ON refund(merchant_id);

-- 账号表
CREATE TABLE IF NOT EXISTS user (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT UNIQUE,                  -- 登录账号（可与手机号相同）
  name        TEXT,                         -- 姓名
  phone       TEXT,                         -- 手机号
  password    TEXT NOT NULL,                -- 密码
  role        TEXT NOT NULL,                -- merchant 商户 / admin 管理员
  merchant_id TEXT,                         -- 商户账号绑定的商户编号
  shop_name   TEXT,                         -- 所属店铺 / 平台中心
  perm        TEXT,                         -- 管理员权限标记
  disabled    INTEGER DEFAULT 0,            -- 1=禁用
  openid      TEXT,                         -- 绑定的微信 openid
  created_at  TEXT
);

-- 微信绑定表：记录 openid 与账号的绑定关系（一键登录用）
CREATE TABLE IF NOT EXISTS wechat_bind (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  openid    TEXT NOT NULL,
  role      TEXT NOT NULL,
  user_id   INTEGER NOT NULL,
  bind_time TEXT
);
CREATE INDEX IF NOT EXISTS idx_bind_openid ON wechat_bind(openid);

-- 异常消费记录表（与桌面系统 analysis.db 的 anomaly_record 对齐并补充处置字段）
CREATE TABLE IF NOT EXISTS anomaly_record (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  anomaly_id      TEXT UNIQUE,              -- 异常编号 A3000...
  student_id      TEXT NOT NULL,            -- 学号
  student_name    TEXT,                     -- 学生姓名
  merchant_id     TEXT,                     -- 涉及商户
  amount          REAL,                     -- 异常金额
  expected_amount REAL,                     -- 正常消费参考值
  consume_time    TEXT,                     -- 异常发生时间
  anomaly_type    TEXT,                     -- 异常类型
  deviation       INTEGER,                  -- 偏离百分比
  sigma           REAL,                     -- 偏离倍数
  risk_score      INTEGER,                  -- 风险评分
  level           TEXT,                     -- 风险等级 高/中/低
  status          TEXT DEFAULT 'pending',   -- pending 待处理 / handled 已处理 / ignored 已忽略
  remark          TEXT,                     -- 处置备注
  disposition     TEXT,                     -- 处置分类 / 误报原因
  handled_by      TEXT,                     -- 处理人
  handled_at      TEXT,                     -- 处理时间
  detected_at     TEXT                      -- 检测时间
);
CREATE INDEX IF NOT EXISTS idx_anomaly_status ON anomaly_record(status);

-- 学生消费统计表（与桌面系统 analysis.db 的 user_consume_stat 完全对齐）
CREATE TABLE IF NOT EXISTS user_consume_stat (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id     TEXT NOT NULL UNIQUE,      -- 学号（唯一，重复同步不产生重复数据）
  student_name   TEXT,
  total_amount   REAL NOT NULL DEFAULT 0,   -- 累计消费金额
  consume_count  INTEGER NOT NULL DEFAULT 0,-- 消费次数
  peak_hour      INTEGER,                   -- 最常消费时段
  avg_amount     REAL,                      -- 平均每次消费
  std_dev        REAL,                      -- 标准差（3σ 检测用）
  layer          TEXT,                      -- 分层标签
  cluster        INTEGER,                   -- 聚类组号
  updated_at     TEXT
);

-- 同步日志表（与桌面系统 analysis.db 的 sync_log 对齐）
CREATE TABLE IF NOT EXISTS sync_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_time    TEXT NOT NULL,
  synced_count INTEGER NOT NULL DEFAULT 0,
  last_id      INTEGER,
  status       TEXT,
  message      TEXT
);

-- 审计日志表
CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  log_id        TEXT,
  operator      TEXT,
  operator_role TEXT,
  action        TEXT,
  target_type   TEXT,
  target        TEXT,
  detail        TEXT,
  result        TEXT,
  reason        TEXT,
  ip            TEXT,
  time          TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(time);

-- 系统配置表（存放全平台月度目标等全局参数）
CREATE TABLE IF NOT EXISTS sys_config (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`

/** 建表（幂等） */
export function ensureSchema() {
  db.exec(SCHEMA)
}

/** 查询辅助：取第一行 */
export const one = (sql, ...params) => db.prepare(sql).get(...params)
/** 查询辅助：取全部行 */
export const all = (sql, ...params) => db.prepare(sql).all(...params)
/** 写入辅助：执行一条语句 */
export const run = (sql, ...params) => db.prepare(sql).run(...params)
/** 事务辅助 */
export const tx = (fn) => db.transaction(fn)

/** 读取系统配置 */
export function getConfig(key, fallback = null) {
  const row = one('SELECT value FROM sys_config WHERE key = ?', key)
  return row ? row.value : fallback
}

/** 写入系统配置 */
export function setConfig(key, value) {
  run('INSERT INTO sys_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value))
}

/** 判断数据库是否已经初始化过（有账号即视为已初始化） */
export function isInitialized() {
  try {
    const row = one("SELECT name FROM sqlite_master WHERE type='table' AND name='user'")
    if (!row) return false
    return one('SELECT COUNT(*) AS c FROM user').c > 0
  } catch {
    return false
  }
}
