export const recordsChangeKey = 'becoming-me:records-changed'
const noticeKey = 'becoming-me:maintenance-notice'

export function clearLegacyChatCache() {
  try { sessionStorage.removeItem('chat_session') } catch { /* optional browser cache */ }
}
export function maintenanceNotice() {
  try { return sessionStorage.getItem(noticeKey) ?? '' } catch { return '' }
}
export function forgetMaintenanceNotice() {
  try { sessionStorage.removeItem(noticeKey) } catch { /* unavailable storage */ }
}
export function reloadRecords(notice: string) {
  clearLegacyChatCache()
  try { sessionStorage.setItem(noticeKey, notice) } catch { /* unavailable storage */ }
  try { localStorage.setItem(recordsChangeKey, crypto.randomUUID()) } catch { /* other tabs may need a manual refresh */ }
  window.location.reload()
}
