const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const esbuild = require('esbuild')

async function check(prepareFails) {
  const calls = []
  const commands = []
  let descriptor
  const operation = await esbuild.build({
    entryPoints: ['src/host-snapshot.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['@actions/core', '@actions/exec'],
  })
  const sandbox = {
    module: {exports: {}},
    Buffer,
    process,
    AbortSignal,
    console,
    require(name) {
      if (name === '@actions/core')
        return {getInput: () => 'depot_cijob_' + 'a'.repeat(64), setSecret() {}, info() {}, warning() {}}
      if (name === '@actions/exec')
        return {
          async exec(command, args) {
            commands.push(args)
            if (args.includes('host-compose')) {
              descriptor = args[args.indexOf('--snapshot-metadata') + 1]
              assert.equal(fs.statSync(descriptor).mode & 0o777, 0o600)
              assert.deepEqual(JSON.parse(fs.readFileSync(descriptor)), {
                serial: 'a'.repeat(20),
                logical_bytes: 4096,
                chunk_bitmap: [1],
              })
            }
          },
        }
      return require(name)
    },
    async fetch(url, options) {
      assert.equal(url, 'https://api.depot.dev/depot.ci.v1.CIWorkerService/HostSnapshot')
      assert.equal(options.redirect, 'error')
      assert.match(options.headers.Authorization, /^Bearer depot_cijob_[a-f0-9]{64}$/)
      const body = JSON.parse(options.body)
      assert.match(body.operationId, /^[a-f0-9]{32}$/)
      if (calls.length) assert.equal(body.operationId, calls[0].operationId)
      calls.push(body)
      const released = calls.some((call) => call.action === 'release')
      return {
        ok: !(prepareFails && body.action === 'prepare'),
        status: 503,
        async json() {
          return {
            operationId: body.operationId,
            phase: released ? 'released' : 'ready',
            serial: 'a'.repeat(20),
            logicalBytes: '4096',
            chunkBitmap: 'AQ==',
          }
        },
      }
    },
  }
  vm.runInNewContext(operation.outputFiles[0].text, sandbox)
  const run = sandbox.module.exports.publishHostSnapshot('snapshot', [], [], 'registry-token')
  if (prepareFails) await assert.rejects(run, /HTTP 503/)
  else await run
  assert.deepEqual(
    calls.map((call) => call.action),
    prepareFails ? ['prepare', 'release', 'status'] : ['prepare', 'status', 'release', 'status'],
  )
  assert.equal(
    commands.some((args) => args.includes('host-compose')),
    !prepareFails,
  )
  if (descriptor) assert.equal(fs.existsSync(path.dirname(descriptor)), false)
}
process.env.TMPDIR = path.resolve('tmp')
check(false)
  .then(() => check(true))
  .then(() => console.log('host snapshot success and failed-prepare cleanup pass'))
