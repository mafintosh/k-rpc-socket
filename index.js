import dgram from 'dgram'
import bencode from 'bencode'
import { isIP } from 'net'
import dns from 'dns'
import { EventEmitter } from 'events'
import { arr2text } from 'uint8-util'

const ETIMEDOUT = new Error('Query timed out')
ETIMEDOUT.code = 'ETIMEDOUT'

const EUNEXPECTEDNODE = new Error('Unexpected node id')
EUNEXPECTEDNODE.code = 'EUNEXPECTEDNODE'

export default class RPC extends EventEmitter {
  constructor (opts = {}) {
    super()
    const self = this

    this.timeout = opts.timeout || 2000
    this.inflight = 0
    this.destroyed = false
    this.isIP = opts.isIP || isIP
    this.socket = opts.socket || dgram.createSocket('udp4')
    this.socket.on('message', onmessage)
    this.socket.on('error', onerror)
    this.socket.on('listening', onlistening)

    this._tick = 0
    this._ids = []
    this._reqs = []
    this._timer = setInterval(check, Math.floor(this.timeout / 4))

    function check () {
      let missing = self.inflight
      if (!missing) return
      for (let i = 0; i < self._reqs.length; i++) {
        const req = self._reqs[i]
        if (!req) continue
        if (req.ttl) req.ttl--
        else self._cancel(i, ETIMEDOUT)
        if (!--missing) return
      }
    }

    function onlistening () {
      self.emit('listening')
    }

    function onerror (err) {
      if (err.code === 'EACCES' || err.code === 'EADDRINUSE') self.emit('error', err)
      else self.emit('warning', err)
    }

    function onmessage (buf, rinfo) {
      if (self.destroyed) return
      if (!rinfo.port) return // seems like a node bug that this is nessesary?

      let message = null
      try {
        message = bencode.decode(buf)
      } catch (e) {
        return self.emit('warning', e)
      }

      const type = message && message.y && arr2text(message.y)

      if (type === 'r' || type === 'e') {
        if (!ArrayBuffer.isView(message.t)) return

        let tid = null
        try {
          const view = new DataView(message.t.buffer)
          tid = view.getUint16(0)
        } catch (err) {
          return self.emit('warning', err)
        }

        const index = self._ids.indexOf(tid)
        if (index === -1 || tid === 0) {
          self.emit('response', message, rinfo)
          self.emit('warning', new Error('Unexpected transaction id: ' + tid))
          return
        }

        const req = self._reqs[index]
        if (req.peer.host !== rinfo.address) {
          self.emit('response', message, rinfo)
          self.emit('warning', new Error('Out of order response'))
          return
        }

        self._ids[index] = 0
        self._reqs[index] = null
        self.inflight--

        if (type === 'e') {
          const isArray = Array.isArray(message.e)
          if (isArray) message.e = message.e.map(e => ArrayBuffer.isView(e) ? arr2text(e) : e)
          const err = new Error(isArray ? message.e.join(' ') : 'Unknown error')
          err.code = isArray && message.e.length && typeof message.e[0] === 'number' ? message.e[0] : 0
          req.callback(err, message, rinfo, req.message)
          self.emit('update')
          self.emit('postupdate')
          return
        }

        const rid = message.r && message.r.id
        if (req.peer && req.peer.id && rid && !req.peer.id.equals(rid)) {
          req.callback(EUNEXPECTEDNODE, null, rinfo)
          self.emit('update')
          self.emit('postupdate')
          return
        }

        req.callback(null, message, rinfo, req.message)
        self.emit('update')
        self.emit('postupdate')
        self.emit('response', message, rinfo)
      } else if (type === 'q') {
        self.emit('query', message, rinfo)
      } else {
        self.emit('warning', new Error('Unknown type: ' + type))
      }
    }
  }

  address () {
    return this.socket.address()
  }

  response (peer, req, res, cb) {
    this.send(peer, { t: req.t, y: 'r', r: res }, cb)
  }

  error (peer, req, error, cb) {
    this.send(peer, { t: req.t, y: 'e', e: [].concat(error.message || error) }, cb)
  }

  send (peer, message, cb) {
    const buf = bencode.encode(message)
    this.socket.send(buf, 0, buf.length, peer.port, peer.address || peer.host, cb || noop)
  }

  // bind([port], [address], [callback])
  bind () {
    this.socket.bind.apply(this.socket, arguments)
  }

  destroy (cb) {
    this.destroyed = true
    clearInterval(this._timer)
    if (cb) this.socket.on('close', cb)
    for (let i = 0; i < this._ids.length; i++) this._cancel(i)
    this.socket.close()
  }

  query (peer, query, cb) {
    if (!cb) cb = noop
    if (!this.isIP(peer.host)) return this._resolveAndQuery(peer, query, cb)

    const message = {
      t: new Uint8Array(2),
      y: 'q',
      q: query.q,
      a: query.a
    }

    const req = {
      ttl: 4,
      peer,
      message,
      callback: cb
    }

    if (this._tick === 65535) this._tick = 0
    const tid = ++this._tick

    let free = this._ids.indexOf(0)
    if (free === -1) free = this._ids.push(0) - 1
    this._ids[free] = tid
    while (this._reqs.length < free) this._reqs.push(null)
    this._reqs[free] = req

    this.inflight++
    const view = new DataView(message.t.buffer)
    view.setUint16(0, tid)
    this.send(peer, message)
    return tid
  }

  cancel (tid, err) {
    const index = this._ids.indexOf(tid)
    if (index > -1) this._cancel(index, err)
  }

  _cancel (index, err) {
    const req = this._reqs[index]
    this._ids[index] = 0
    this._reqs[index] = null
    if (req) {
      this.inflight--
      req.callback(err || new Error('Query was cancelled'), null, req.peer)
      this.emit('update')
      this.emit('postupdate')
    }
  }

  _resolveAndQuery (peer, query, cb) {
    const self = this

    dns.lookup(peer.host, function (err, ip) {
      if (err) return cb(err)
      if (self.destroyed) return cb(new Error('k-rpc-socket is destroyed'))
      self.query({ host: ip, port: peer.port }, query, cb)
    })
  }
}

function noop () {}
