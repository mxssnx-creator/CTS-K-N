// Fail closed before any actual external socket can be opened by this test run.
// Fixture mocks remain available; only loopback listeners used by local tests
// are reachable. No production credentials or remote Redis are loaded here.
const net = require('node:net')
const tls = require('node:tls')
const http = require('node:http')
const https = require('node:https')
const loopback = host => ['localhost','127.0.0.1','::1','[::1]'].includes(String(host || 'localhost').toLowerCase())
const proxyEndpoints = new Set()
for (const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy']) {
  try { const u = new URL(process.env[key]); proxyEndpoints.add(`${u.hostname}:${u.port || (u.protocol === 'https:' ? 443 : 80)}`) } catch {}
}
function checkOrigin(input) {
  if (typeof input === 'string' || input instanceof URL) {
    if (!loopback(new URL(input).hostname)) throw new Error('Test isolation blocks external HTTP origins')
  } else if (input?.url) checkOrigin(input.url)
  else if (input) {
    if (!loopback(input.hostname || input.host)) throw new Error('Test isolation blocks external HTTP origins')
    if (/^https?:\/\//.test(input.path || '')) checkOrigin(input.path)
  }
}
const nativeFetch = globalThis.fetch
globalThis.fetch = async function(input, ...args) { checkOrigin(input); return nativeFetch.call(this, input, ...args) }
for (const transport of [http, https]) for (const method of ['request','get']) {
  const original = transport[method]
  transport[method] = function(...args) { checkOrigin(args[0]); return original.apply(this, args) }
}
function check(args) {
  let host, port
  if (args[0] && typeof args[0] === 'object') {
    if (Array.isArray(args[0])) return check(args[0])
    if (args[0].path) throw new Error('Test isolation blocks Unix socket access')
    host = args[0].hostname || args[0].host
    port = args[0].port
  } else if (typeof args[0] === 'string' && !/^\d+$/.test(args[0])) {
    throw new Error('Test isolation blocks Unix socket access')
  } else { port = args[0]; if (typeof args[1] === 'string') host = args[1] }
  if (!loopback(host)) throw new Error('Test isolation blocks external network access')
  if (proxyEndpoints.has(`${host || 'localhost'}:${port}`)) throw new Error('Test isolation blocks proxy access')
}
const socketConnect=net.Socket.prototype.connect
net.Socket.prototype.connect=function(...args){try{check(args)}catch(error){this.destroy();throw error}return socketConnect.apply(this,args)}
const tlsConnect=tls.connect
tls.connect=function(...args){check(args);return tlsConnect.apply(this,args)}
