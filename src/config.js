// ============================================================================
// 全局配置
// 说明：这里集中放置端口、密钥、令牌有效期、数据库路径等可调参数。
//       后面如果需要把小程序切到"桌面系统后端"，只需要改前端 config.js 里的 baseURL，
//       本文件是独立后端自己的配置。
// ============================================================================
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const PORT = Number(process.env.PORT || 3100)          // 后端监听端口
export const HOST = process.env.HOST || '0.0.0.0'            // 监听地址，0.0.0.0 便于手机真机访问
export const AUTH_SECRET = process.env.AUTH_SECRET || 'campus-consume-mp-secret-2026'  // 令牌签名密钥
export const TOKEN_TTL = 2 * 60 * 60 * 1000                  // 令牌有效期：2 小时（毫秒）

// 数据库文件放在 backend/data/campus.db
export const DATA_DIR = path.join(__dirname, '..', 'data')
export const DB_FILE = path.join(DATA_DIR, 'campus.db')

// 与桌面系统保持一致的分层口径（单位：元），按时间范围区分
//   今日：20 以下 / 20~30 / 30 以上
//   本周：140 以下 / 140~210 / 210 以上
//   月 / 季沿用原口径（如需调整在此补充对应 key）
export const LAYER_THRESHOLDS = {
  today: { high: 30, mid: 20 },
  week: { high: 210, mid: 140 },
  month: { high: 2000, mid: 1000 },
  quarter: { high: 2000, mid: 1000 },
}

// 有效订单口径：状态为「已支付」的订单才计入统计；退款审核中、已退款均剔除
export const VALID_ORDER_STATUS = '已支付'

// 微信一键登录演示配置：
//   本地没有真实小程序 AppID 时，前端 uni.login 拿到的 code 形如 "mock_xxx"，
//   后端在 MOCK_WECHAT 为 true 时允许用 code 直接换取绑定关系（方便本地联调）。
export const MOCK_WECHAT = String(process.env.MOCK_WECHAT ?? 'true') !== 'false'
