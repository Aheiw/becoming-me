// Local single-process write barrier for snapshot, restore and purge. Streaming route
// handlers hold their own lease until all work (including post-reply writes) finishes.
let requests = 0
let running = false
export const maintenanceInProgress = () => running

export function trackLocalRequest() {
  requests++
  return () => { requests-- }
}

export function beginMaintenance() {
  if (running || requests) return undefined
  running = true
  return () => { running = false }
}
