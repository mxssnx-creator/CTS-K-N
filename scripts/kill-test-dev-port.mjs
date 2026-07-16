#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

function readProcesses() {
  try {
    return execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
      .filter(Boolean)
      .map((match) => ({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        command: match[3],
      }))
  } catch {
    return []
  }
}

/**
 * Stop only the Next development server bound to the requested test port and
 * its descendants. Keeping this function importable prevents smoke runners
 * from terminating themselves and avoids touching unrelated Next processes.
 */
export async function killTestDevPort(port = 3002) {
  const processes = readProcesses()
  const escapedPort = String(port).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const nextDevOnPort = new RegExp(
    `(?:node_modules/(?:\\.bin/next|next/dist/bin/next)|\\bnext)\\s+dev(?:\\s|$).*?(?:-p|--port)(?:=|\\s+)${escapedPort}(?:\\s|$)`,
  )
  const roots = new Set(
    processes
      .filter(({ pid, command }) => pid !== process.pid && pid !== process.ppid && nextDevOnPort.test(command))
      .map(({ pid }) => pid),
  )

  const victims = new Set(roots)
  let changed = true
  while (changed) {
    changed = false
    for (const { pid, ppid } of processes) {
      if (!victims.has(pid) && victims.has(ppid)) {
        victims.add(pid)
        changed = true
      }
    }
  }

  const ordered = [...victims].sort((a, b) => b - a)
  for (const pid of ordered) {
    try { process.kill(pid, 'SIGTERM') } catch {}
  }
  if (ordered.length === 0) return 0

  await sleep(250)
  for (const pid of ordered) {
    try {
      process.kill(pid, 0)
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
  return ordered.length
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedDirectly) {
  await killTestDevPort(Number(process.env.PORT || 3002))
}
