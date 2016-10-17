var tape = require('tape')
var rpc = require('./')

wrapTest(tape, 'query + response', function(t, ipv6) {
  var server = rpc({ipv6: ipv6})
  var address = localHost(ipv6, true)
  var queried = false

  server.on('query', function (query, peer) {
    queried = true
    t.same(peer.address, address)
    t.same(query.q.toString(), 'hello_world')
    t.same(query.a, {hej: 10})
    server.response(peer, query, {hello: 42})
  })

  server.bind(0, function () {
    var port = server.address().port
    var client = rpc({ipv6: ipv6})
    t.same(client.inflight, 0)
    client.query({host: address, port: port}, {q: 'hello_world', a: {hej: 10}}, function (err, res) {
      t.same(client.inflight, 0)
      server.destroy()
      client.destroy()
      t.error(err)
      t.ok(queried)
      t.same(res.r, {hello: 42})
      t.end()
    })
    t.same(client.inflight, 1)
  })
})

wrapTest(tape, 'parallel query', function (t, ipv6) {
  var server = rpc({ipv6: ipv6})

  server.on('query', function (query, peer) {
    server.response(peer, query, {echo: query.a})
  })

  server.bind(0, function () {
    var port = server.address().port
    var client = rpc({ipv6: ipv6})
    var peer = {host: localHost(ipv6, true), port: port}

    client.query(peer, {q: 'echo', a: 1}, function (_, res) {
      t.same(res.r, {echo: 1})
      done()
    })
    client.query(peer, {q: 'echo', a: 2}, function (_, res) {
      t.same(res.r, {echo: 2})
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

wrapTest(tape, 'query + error', function (t, ipv6) {
  var server = rpc({ipv6: ipv6})

  server.on('query', function (query, peer) {
    server.error(peer, query, 'oh no')
  })

  server.bind(0, function () {
    var port = server.address().port
    var client = rpc({ipv6: ipv6})
    client.query({host: localHost(ipv6, true), port: port}, {q: 'hello_world', a: {hej: 10}}, function (err) {
      client.destroy()
      server.destroy()
      t.ok(err)
      t.same(err.message, 'oh no')
      t.end()
    })
  })
})

wrapTest(tape, 'timeout', function (t, ipv6) {
  var socket = rpc({timeout: 100, ipv6: ipv6})

  socket.query({host: 'example.com', port: 12345}, {q: 'timeout'}, function (err) {
    socket.destroy()
    t.ok(err)
    t.same(err.message, 'Query timed out')
    t.end()
  })
})

function localHost(ipv6, plainIpv6) {
  if (ipv6) {
    if (!plainIpv6) {
      return '[::1]'
    }
    return '::1'
  }
  return '127.0.0.1'
}

function wrapTest(test, str, func) {
  test('ipv4 ' + str, function (t) {
    func(t, false)
    if (t._plan) {
      t.plan(t._plan + 1)
    }

    t.test('ipv6 ' + str, function (newT) {
      func(newT, true)
    })
  })
}
