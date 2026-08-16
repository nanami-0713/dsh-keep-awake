import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_CONFIG,
  normalizeConfig,
  normalizeState,
} from '../lib/shared.js'

test('normalizeConfig keeps valid booleans and repairs invalid input', () => {
  assert.deepEqual(normalizeConfig(null), DEFAULT_CONFIG)
  assert.deepEqual(normalizeConfig({ enabled: true }), { version: 1, enabled: true })
  assert.deepEqual(normalizeConfig({ enabled: 'yes', extra: 1 }), DEFAULT_CONFIG)
})

test('normalizeState repairs broken API payloads', () => {
  const state = normalizeState({
    platform: 'darwin',
    supported: true,
    enabled: true,
    actual: true,
    updating: false,
    privilege: { root: false, passwordlessSudo: true, osascript: true },
    battery: { source: 'ac', percent: 100 },
    message: 'ok',
  })
  assert.equal(state.platform, 'darwin')
  assert.equal(state.supported, true)
  assert.equal(state.enabled, true)
  assert.equal(state.actual, true)
  assert.equal(state.privilege.passwordlessSudo, true)
  assert.equal(state.battery.source, 'ac')
  assert.equal(state.battery.percent, 100)

  const broken = normalizeState(undefined)
  assert.equal(broken.supported, false)
  assert.equal(broken.enabled, false)
  assert.equal(broken.actual, null)
})
