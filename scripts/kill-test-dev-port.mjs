#!/usr/bin/env node
import { execSync } from 'node:child_process'

const self = process.pid
const parent = process.ppid
let output = ''
try {
  output = execSync('ps -eo pid,ppid,cmd', { encoding: 'utf8' })
} catch {
  process.exit(0)
}

const victims = []
for (const line of output.split('\n').slice(1)) {
  const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
  if (!match) continue
  const pid = Number(match[1])
  const ppid = Number(match[2])
  const cmd = match[3]
  if (!Number.isFinite(pid) || pid === self || pid === parent) continue
  const isNextDev3002 = /node .*node_modules\/\.bin\/next dev -p 3002/.test(cmd)
  const isNextServerChild = /next-server \(v/.test(cmd) && ppid !== self && ppid !== parent
  if (isNextDev3002 || isNextServerChild) victims.push(pid)
}

for (const pid of victims) {
  try { process.kill(pid, 'SIGTERM') } catch {}
}
setTimeout(() => {
  for (const pid of victims) {
    try { process.kill(pid, 0); process.kill(pid, 'SIGKILL') } catch {}
  }
}, 250)
