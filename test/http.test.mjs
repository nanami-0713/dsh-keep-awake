import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isJsonRequest, isLoopbackRequest } from '../lib/index.js'

function fakeRequest(host, remoteAddress = '127.0.0.1', contentType) {
  return {
    headers: { host, ...(contentType === undefined ? {} : { 'content-type': contentType }) },
    socket: { remoteAddress },
  }
}

test('loopback guard accepts localhost hosts from loopback sockets', () => {
  for (const host of ['127.0.0.1', '127.0.0.1:56444', 'localhost', 'localhost:3000', '[::1]:3000']) {
    assert.equal(isLoopbackRequest(fakeRequest(host)), true, host)
  }
})

test('loopback guard rejects foreign hosts and foreign sockets', () => {
  assert.equal(isLoopbackRequest(fakeRequest('198.51.100.8')), false)
  assert.equal(isLoopbackRequest(fakeRequest('evil.example.com')), false)
  assert.equal(isLoopbackRequest(fakeRequest('127.0.0.1', '203.0.113.1')), false)
  assert.equal(isLoopbackRequest(fakeRequest('127.0.0.1', '::ffff:203.0.113.1')), false)
})

test('loopback guard accepts IPv4-mapped loopback socket', () => {
  assert.equal(isLoopbackRequest(fakeRequest('127.0.0.1', '::ffff:127.0.0.1')), true)
})

test('json guard accepts application/json with parameters but rejects lookalikes', () => {
  assert.equal(isJsonRequest(fakeRequest('127.0.0.1', '127.0.0.1', 'application/json')), true)
  assert.equal(isJsonRequest(fakeRequest('127.0.0.1', '127.0.0.1', 'application/json; charset=utf-8')), true)
  assert.equal(isJsonRequest(fakeRequest('127.0.0.1', '127.0.0.1', 'application/jsonp')), false)
  assert.equal(isJsonRequest(fakeRequest('127.0.0.1', '127.0.0.1', 'text/plain')), false)
  assert.equal(isJsonRequest(fakeRequest('127.0.0.1')), false)
})
