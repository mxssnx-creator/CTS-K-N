#!/usr/bin/env node
import net from "node:net"
import process from "node:process"

const url = new URL(process.env.REDIS_URL || "redis://127.0.0.1:6379")
const host = url.hostname
const port = Number(url.port || 6379)
const token = `cts-install-${process.pid}-${Date.now()}`

function encode(parts) {
  return `*${parts.length}\r\n${parts.map((part) => {
    const value = String(part)
    return `$${Buffer.byteLength(value)}\r\n${value}\r\n`
  }).join("")}`
}

function readReply(socket) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const lineEnd = buffer.indexOf("\r\n")
      if (lineEnd < 0) return
      const prefix = String.fromCharCode(buffer[0])
      if (prefix === "$" || prefix === ":" || prefix === "+" || prefix === "-") {
        if (prefix === "$") {
          const length = Number.parseInt(buffer.subarray(1, lineEnd).toString(), 10)
          if (length >= 0 && buffer.length < lineEnd + 2 + length + 2) return
        }
        socket.off("data", onData); resolve(buffer.toString())
      }
    }
    socket.on("data", onData); socket.once("error", reject)
  })
}

function command(socket, ...parts) {
  return new Promise((resolve, reject) => {
    socket.write(encode(parts), (error) => {
      if (error) return reject(error)
      readReply(socket).then(resolve, reject)
    })
  })
}

const socket = net.createConnection({ host, port })
socket.setTimeout(5000, () => socket.destroy(new Error("Redis verification timed out")))
await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject) })
const ping = await command(socket, "PING")
if (!ping.startsWith("+PONG")) throw new Error(`Redis PING failed: ${ping.trim()}`)
const set = await command(socket, "SET", token, "ok", "EX", "60")
const get = await command(socket, "GET", token)
await command(socket, "DEL", token)
socket.end()
if (!set.startsWith("+OK") || !get.includes("ok")) throw new Error("Redis read/write verification failed")
console.log(JSON.stringify({ ok: true, url: `${url.protocol}//${host}:${port}`, ping: "PONG", readWrite: true }))
