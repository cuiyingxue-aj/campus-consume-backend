// ============================================================================
// 审计日志
// 记录"谁在什么时候做了什么"，与桌面系统的 auditLogs 结构保持一致。
// ============================================================================
import { run, all, one } from './db.js'

const pad = (n) => String(n).padStart(2, '0')
export const nowStr = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const ROLE_TEXT = { admin: '管理员', merchant: '商户' }

/**
 * 写一条审计日志
 * @param {object} ctx 当前登录用户（可为空）
 * @param {object} params { action, targetType, target, detail, result, reason, ip }
 */
export function logAction(ctx, params = {}) {
  const info = run(
    `INSERT INTO audit_log (log_id, operator, operator_role, action, target_type, target, detail, result, reason, ip, time)
     VALUES (@log_id, @operator, @operator_role, @action, @target_type, @target, @detail, @result, @reason, @ip, @time)`,
    {
      log_id: 'L' + Date.now() + String(Math.floor(Math.random() * 1000)).padStart(3, '0'),
      operator: ctx?.name || '未知',
      operator_role: ROLE_TEXT[ctx?.role] || '—',
      action: params.action || '',
      target_type: params.targetType || '',
      target: params.target || '',
      detail: params.detail || '',
      result: params.result || '成功',
      reason: params.reason || '',
      ip: params.ip || '127.0.0.1',
      time: nowStr(),
    },
  )
  return Number(info.lastInsertRowid)
}

/** 审计日志列表（分页 + 筛选） */
export function listAuditLogs({ keyword = '', action = '', result = '', page = 1, pageSize = 20 } = {}) {
  const conds = []
  const params = []
  if (keyword) {
    conds.push('(operator LIKE ? OR action LIKE ? OR target LIKE ? OR detail LIKE ?)')
    const kw = `%${keyword}%`
    params.push(kw, kw, kw, kw)
  }
  if (action) { conds.push('action = ?'); params.push(action) }
  if (result) { conds.push('result = ?'); params.push(result) }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const total = one(`SELECT COUNT(*) AS c FROM audit_log ${where}`, ...params).c
  const p = Math.max(1, Number(page) || 1)
  const ps = Math.min(100, Math.max(1, Number(pageSize) || 20))
  const list = all(
    `SELECT log_id AS id, operator, operator_role AS operatorRole, action, target_type AS targetType,
            target, detail, result, reason, ip, time
     FROM audit_log ${where} ORDER BY time DESC, id DESC LIMIT ? OFFSET ?`,
    ...params, ps, (p - 1) * ps,
  )
  return { list, total, page: p, pageSize: ps }
}
