// Preload for the streaming engine: force every TCP listener onto loopback.
// server.js calls server.listen(port) with no host, which binds all interfaces.
'use strict';
const net = require('node:net');
const HOST = process.env.ENGINE_BIND_HOST || '127.0.0.1';
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const a = args[0];
  if (typeof a === 'number' || (typeof a === 'string' && /^\d+$/.test(a))) {
    const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : undefined;
    const backlog = typeof args[1] === 'number' ? args[1] : typeof args[2] === 'number' ? args[2] : undefined;
    return listen.call(this, { port: Number(a), host: HOST, backlog }, cb);
  }
  if (a && typeof a === 'object' && !a.path && !a.fd && !a.handle) {
    return listen.call(this, { ...a, host: HOST }, ...args.slice(1));
  }
  return listen.apply(this, args);
};
