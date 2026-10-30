import * as core from '@actions/core'
import * as exec from '@actions/exec'
import {randomBytes} from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'

interface HostSnapshot {
  operationId: string
  phase: string
  serial?: string
  logicalBytes?: string
  chunkBitmap?: string
  captureNanoseconds?: string
  timingsNs?: Record<string, string>
}

const endpoint = 'https://api.depot.dev/depot.ci.v1.CIWorkerService/HostSnapshot'

async function request(jobToken: string, operationId: string, action: string): Promise<HostSnapshot> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', Authorization: `Bearer ${jobToken}`},
    body: JSON.stringify({operationId, action}),
    signal: AbortSignal.timeout(20_000),
    redirect: 'error',
  })
  if (!response.ok) throw new Error(`Host snapshot ${action} failed: HTTP ${response.status}`)
  const result = (await response.json()) as HostSnapshot
  if (result.operationId !== operationId) throw new Error('Host snapshot operation identity changed')
  return result
}

async function wait(jobToken: string, operationId: string, phase: string, timeoutMs: number): Promise<HostSnapshot> {
  const deadline = Date.now() + timeoutMs
  do {
    const status = await request(jobToken, operationId, 'status')
    if (status.phase === phase) return status
    if (status.phase === 'failed' || (phase === 'ready' && ['released', 'expired'].includes(status.phase)))
      throw new Error(`Host snapshot ended in ${status.phase}`)
    await delay(1000)
  } while (Date.now() < deadline)
  throw new Error(`Timed out waiting for host snapshot ${phase}`)
}

export async function publishHostSnapshot(
  binary: string,
  args: string[],
  maskArgs: string[],
  registryToken: string,
): Promise<void> {
  // Registry pull/push authority must never be interpreted as host-snapshot authority.
  const jobToken = core.getInput('job-token') || process.env.DEPOT_CI_JOB_TOKEN || ''
  if (!/^depot_cijob_[0-9a-f]{64}$/.test(jobToken))
    throw new Error('Host snapshots require a current CI job token in job-token')
  core.setSecret(jobToken)
  const operationId = randomBytes(16).toString('hex')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'depot-host-snapshot-'))
  try {
    await exec.exec('sudo', ['-E', binary, 'prepare-environment', ...maskArgs])
    await request(jobToken, operationId, 'prepare')
    const snapshot = await wait(jobToken, operationId, 'ready', 120_000)
    if (!snapshot.serial || !snapshot.logicalBytes || !snapshot.chunkBitmap)
      throw new Error('Host snapshot descriptor is incomplete')
    const descriptor = path.join(directory, 'snapshot.json')
    fs.writeFileSync(
      descriptor,
      JSON.stringify({
        serial: snapshot.serial,
        logical_bytes: Number(snapshot.logicalBytes),
        chunk_bitmap: Array.from(Buffer.from(snapshot.chunkBitmap, 'base64')),
      }),
      {mode: 0o600},
    )
    core.info(`Host root capture: ${Number(snapshot.captureNanoseconds ?? 0) / 1_000_000} ms (upload excluded)`)
    core.info(
      `Host snapshot phases (ms): ${JSON.stringify(Object.fromEntries(Object.entries(snapshot.timingsNs ?? {}).map(([name, ns]) => [name, Number(ns) / 1_000_000])))}`,
    )
    await exec.exec(
      'sudo',
      [
        '-E',
        '/usr/bin/env',
        `PATH=${process.env.PATH ?? ''}`,
        binary,
        'host-compose',
        '--snapshot-metadata',
        descriptor,
        ...args,
      ],
      {
        env: {...process.env, REGISTRY_USERNAME: 'x-token', REGISTRY_PASSWORD: registryToken},
      },
    )
  } finally {
    try {
      await request(jobToken, operationId, 'release')
      await wait(jobToken, operationId, 'released', 30_000)
    } catch {
      core.warning('Host snapshot cleanup was not acknowledged; the host lease and VM deletion provide cleanup')
    }
    fs.rmSync(directory, {recursive: true, force: true})
  }
}
