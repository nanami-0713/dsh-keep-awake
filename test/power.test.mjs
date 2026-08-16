import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'
import {
  KeepAwakeError,
  PMSET,
  PowerManager,
  parseBattery,
  parseSleepDisabled,
} from '../lib/power.js'

const onDarwin = process.platform === 'darwin' && existsSync(PMSET)

function fakeRunner(transcript) {
  let index = 0
  return async (_file, _args) => {
    const entry = transcript[Math.min(index, transcript.length - 1)]
    index += 1
    return entry
  }
}

test('parseSleepDisabled reads the kernel flag from pmset -g output', () => {
  assert.equal(parseSleepDisabled('standby 1\nSleepDisabled 1\n'), 1)
  assert.equal(parseSleepDisabled(' SleepDisabled\t\t1\n'), 1)
  assert.equal(parseSleepDisabled('standby 1\nSleepDisabled 0\n'), 0)
  assert.equal(parseSleepDisabled('standby 1\n'), 0)
})

test('parseBattery reads AC source and percent', () => {
  const status = parseBattery("Now drawing from 'AC Power'\n -InternalBattery-0 74%; charging;")
  assert.deepEqual(status, { source: 'ac', percent: 74 })
})

test('parseBattery reads battery source without percent', () => {
  const status = parseBattery("Now drawing from 'Battery Power'\n")
  assert.deepEqual(status, { source: 'battery', percent: null })
})

test('parseBattery tolerates unknown output', () => {
  assert.deepEqual(parseBattery(''), { source: 'unknown', percent: null })
})

test('setSleepDisabled is a no-op when the system is already on target', async () => {
  const runner = fakeRunner([{ code: 0, stdout: 'SleepDisabled 1\n', stderr: '', timedOut: false }])
  const manager = new PowerManager('darwin', runner)
  const result = await manager.setSleepDisabled(true)
  assert.deepEqual(result, { changed: false, method: 'no-op' })
})

test('setSleepDisabled reports verification failure when pmset does not take effect', async () => {
  const runner = fakeRunner([
    { code: 0, stdout: 'SleepDisabled 0\n', stderr: '', timedOut: false },
    { code: 0, stdout: '', stderr: '', timedOut: false },
    { code: 0, stdout: 'SleepDisabled 0\n', stderr: '', timedOut: false },
  ])
  const manager = new PowerManager('darwin', runner)
  await assert.rejects(
    () => manager.setSleepDisabled(true),
    (error) => error instanceof KeepAwakeError && error.code === 'VERIFY_FAILED',
  )
})

test('scoped sudoers rule is recognized even though sudo -n /usr/bin/true is denied', async () => {
  const listing = [
    'Matching Defaults entries for user on host:',
    '    !tty_tickets',
    'User nanami may run the following commands on host:',
    '    (root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1',
  ].join('\n')
  const runner = fakeRunner([
    { code: 1, stdout: '', stderr: 'sudo: a password is required', timedOut: false },
    { code: 0, stdout: listing, stderr: '', timedOut: false },
  ])
  const manager = new PowerManager('darwin', runner)
  assert.equal(await manager.canUsePasswordlessSudo(), true)
})

test('broad passwordless sudo is recognized', async () => {
  const runner = fakeRunner([{ code: 0, stdout: '', stderr: '', timedOut: false }])
  const manager = new PowerManager('darwin', runner)
  assert.equal(await manager.canUsePasswordlessSudo(), true)
})

test('unsupported platforms are rejected before any command runs', async () => {
  const runner = fakeRunner([])
  const manager = new PowerManager('win32', runner)
  await assert.rejects(
    () => manager.setSleepDisabled(true),
    (error) => error instanceof KeepAwakeError && error.code === 'UNSUPPORTED_PLATFORM',
  )
  assert.equal(manager.isSupported(), false)
})

test('readSleepDisabled works against the real pmset on macOS', { skip: !onDarwin }, async () => {
  const manager = new PowerManager()
  const actual = await manager.readSleepDisabled()
  assert.equal(typeof actual, 'boolean')
  const battery = await manager.readBattery()
  assert.ok(['ac', 'battery', 'ups', 'unknown'].includes(battery.source))
})
