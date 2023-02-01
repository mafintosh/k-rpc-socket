import tape from 'tape'
import RPC from './index.js'
import dgram from 'dgram'

tape('query + response', function (t) {
  const server = new RPC()
  let queried = false

  server.on('query', function (query, peer) {
    queried = true
    t.same(peer.address, '127.0.0.1')
    t.same(Buffer.from(query.q).toString(), 'hello_world')
    t.same(query.a, { hej: 10 })
    server.response(peer, query, { hello: 42 })
  })

  server.bind(0, function (a) {
    const port = server.address().port
    const client = new RPC()
    t.same(client.inflight, 0)
    client.query({ host: '127.0.0.1', port }, { q: 'hello_world', a: { hej: 10 } }, function (err, res) {
      t.same(client.inflight, 0)
      server.destroy()
      client.destroy()
      t.error(err)
      t.ok(queried)
      t.same(res.r, { hello: 42 })
      t.end()
    })
    t.same(client.inflight, 1)
  })
})

tape('parallel query', function (t) {
  const server = new RPC()

  server.on('query', function (query, peer) {
    server.response(peer, query, { echo: query.a })
  })

  server.bind(0, function () {
    const port = server.address().port
    const client = new RPC()
    const peer = { host: '127.0.0.1', port }

    client.query(peer, { q: 'echo', a: 1 }, function (_, res) {
      t.same(res.r, { echo: 1 })
      done()
    })
    client.query(peer, { q: 'echo', a: 2 }, function (_, res) {
      t.same(res.r, { echo: 2 })
      done()
    })

    t.same(client.inflight, 2)

    function done () {
      if (client.inflight) return
      client.destroy()
      server.destroy()
      t.end()
    }
  })
})

tape('query + error', function (t) {
  const server = new RPC()

  server.on('query', function (query, peer) {
    server.error(peer, query, 'oh no')
  })

  server.bind(0, function () {
    const port = server.address().port
    const client = new RPC()
    client.query({ host: '127.0.0.1', port }, { q: 'hello_world', a: { hej: 10 } }, function (err) {
      client.destroy()
      server.destroy()
      t.ok(err)
      t.same(err.message, 'oh no')
      t.end()
    })
  })
})

tape('timeout', function (t) {
  const socket = new RPC({ timeout: 100 })

  socket.query({ host: 'example.com', port: 12345 }, { q: 'timeout' }, function (err) {
    socket.destroy()
    t.ok(err)
    t.same(err.message, 'Query timed out')
    t.end()
  })
})

tape('do not crash on empty string', function (t) {
  if (/^v0\.10\./.test(process.version)) {
    // Sending a zero length udp message does not work on Node 0.10
    t.pass('skipping test on Node 0.10')
    t.end()
    return
  }
  const server = new RPC()
  const socket = dgram.createSocket('udp4')

  server.on('query', function (query, peer) {
    t.fail('should not get a query')
  })

  server.on('warning', function (err) {
    t.ok(err instanceof Error, 'got expected warning')
    server.destroy()
    socket.close()
    t.end()
  })

  server.bind(0, function () {
    const port = server.address().port
    socket.send('' /* invalid bencoded data */, 0, 0, port, '127.0.0.1')
  })
})
