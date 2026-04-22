import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as http from '@actions/http-client'
import * as toolCache from '@actions/tool-cache'
import * as fs from 'node:fs'
import * as path from 'node:path'

type ApiResponse = {ok: true; url: string} | {ok: false; error: string}
type DiskMode = 'overlay' | 'block'

const FW_CFG_PATH = '/sys/firmware/qemu_fw_cfg/by_name/opt/dev.depot/config/raw'
const client = new http.HttpClient('depot-snapshot-action')

function detectDiskMode(): DiskMode {
  try {
    const raw = fs.readFileSync(FW_CFG_PATH, 'utf-8')
    const config = JSON.parse(raw)
    if (config.block_disk) return 'block'
    if (config.overlay) return 'overlay'
  } catch {
    // fw_cfg not readable — fall through to default
  }
  return 'overlay'
}

async function run() {
  const token = await resolveToken()
  const image = core.getInput('image', {required: true})
  const version = core.getInput('version')

  core.setSecret(token)

  const snapshotPath = await core.group('Installing snapshot tool', () => installSnapshot(version))
  await exec.exec(snapshotPath, ['--version'])

  const mode = detectDiskMode()
  core.info(`Detected disk mode: ${mode}`)

  if (mode === 'overlay') {
    const base = core.getInput('base')
    const upper = core.getInput('upper')
    const snapshot = core.getInput('snapshot')

    await core.group('Preparing /rw', async () => {
      if (fs.existsSync('/rw')) return

      await exec.exec('sudo', ['mkdir', '-p', '/rw'])
      await exec.exec('sudo', ['mount', '/dev/vda', '/rw'])
    })

    await core.group('Creating snapshot', async () => {
      await exec.exec(
        'sudo',
        ['-E', snapshotPath, 'compose', '--base', base, '--upper', upper, '--registry', image, '--snapshot', snapshot],
        {env: {...process.env, REGISTRY_PASSWORD: token, REGISTRY_USERNAME: 'x-token'}},
      )
    })
  } else {
    await core.group('Creating block snapshot', async () => {
      await exec.exec(
        'sudo',
        ['-E', snapshotPath, 'thin-compose', '--registry', image],
        {env: {...process.env, REGISTRY_PASSWORD: token, REGISTRY_USERNAME: 'x-token'}},
      )
    })
  }
}

async function resolveToken(): Promise<string> {
  const token = core.getInput('token') || process.env.DEPOT_SNAPSHOT_TOKEN || process.env.DEPOT_TOKEN
  if (token) return token
  throw new Error('No token provided. Set the token input or provide a Depot token in the environment.')
}

async function installSnapshot(version: string): Promise<string> {
  const {url, resolvedVersion} = await resolveVersion(version)

  const cached = toolCache.find('snapshot', resolvedVersion)
  if (cached) {
    core.info(`snapshot ${resolvedVersion} found in cache`)
    return path.join(cached, 'snapshot')
  }

  const tarPath = await toolCache.downloadTool(url)
  const extractedPath = await toolCache.extractTar(tarPath)
  const cachedDir = await toolCache.cacheDir(extractedPath, 'snapshot', resolvedVersion)
  core.info(`snapshot ${resolvedVersion} installed`)
  return path.join(cachedDir, 'snapshot')
}

async function resolveVersion(version: string) {
  const res = await client.get(`https://dl.depot.dev/snapshot/release/${process.platform}/${process.arch}/${version}`)
  const body = await res.readBody()
  if (res.message.statusCode !== 200) {
    throw new Error(`Failed to resolve snapshot version (HTTP ${res.message.statusCode}): ${body.slice(0, 200)}`)
  }
  const response: ApiResponse = JSON.parse(body)
  if (!response.ok) throw new Error(response.error)

  const matches = response.url.match(/snapshot\/v(\d+\.\d+\.\d+)/)
  const resolvedVersion = matches ? matches[1] : version
  return {url: response.url, resolvedVersion}
}

run().catch((error) => {
  if (error instanceof Error) core.setFailed(error.message)
  else core.setFailed(`${error}`)
})
