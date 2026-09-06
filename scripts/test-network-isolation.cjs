// Fail closed before any actual external socket can be opened by this test run.
// Fixture mocks remain available; only loopback listeners used by local tests
// are reachable. No production credentials or remote Redis are loaded here.
const net = require('node:net')
const tls = require('node:tls')
const loopback = host => ['localhost','127.0.0.1','::1','[::1]'].includes(String(host || 'localhost').toLowerCase())
function check(args) {
  let host
  if (args[0] && typeof args[0] === 'object') {
    if (Array.isArray(args[0])) return check(args[0])
    if (args[0].path) throw new Error('Test isolation blocks Unix socket access')
    host = args[0].hostname || args[0].host
  } else if (typeof args[0] === 'string' && !/^\d+$/.test(args[0])) {
    throw new Error('Test isolation blocks Unix socket access')
  } else if (typeof args[1] === 'string') host = args[1]
  if (!loopback(host)) throw new Error('Test isolation blocks external network access')
}
const socketConnect=net.Socket.prototype.connect
net.Socket.prototype.connect=function(...args){check(args);return socketConnect.apply(this,args)}
const tlsConnect=tls.connect
tls.connect=function(...args){check(args);return tlsConnect.apply(this,args)}
