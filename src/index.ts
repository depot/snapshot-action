import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as http from '@actions/http-client'
import * as toolCache from '@actions/tool-cache'
import * as fs from 'node:fs'
import * as path from 'node:path'

type ApiResponse = {ok: true; url: string} | {ok: false; error: string}
type DiskMode = 'overlay' | 'block'
type UploadMode = 'default' | 'oci-out-of-order' | 'oci-x-depot'
type ImageRef = {scheme: string; host: string; repository: string; reference: string}

const FW_CFG_PATH = '/sys/firmware/qemu_fw_cfg/by_name/opt/dev.depot/config/raw'
const client = new http.HttpClient('depot-snapshot-action')

async function detectDiskMode(): Promise<DiskMode> {
  try {
    let raw = ''
    await exec.exec('sudo', ['cat', FW_CFG_PATH], {
      listeners: {stdout: (data) => (raw += data.toString())},
      silent: true,
    })
    const config = JSON.parse(raw)
    if (config.block_disk) return 'block'
    if (config.overlay) return 'overlay'
  } catch (error) {
    core.error(`Failed to detect disk mode, assuming overlay: ${error}`)
  }
  return 'overlay'
}

async function run() {
  const token = await resolveToken()
  const images = resolveImages()
  const registryArgs = images.flatMap((image) => ['--registry', image])
  const version = core.getInput('version')
  const uploadMode = resolveUploadMode()
  const maxAge = core.getInput('max-age')
  const maskArgs = core.getMultilineInput('env-mask').flatMap((mask) => ['--mask', mask])

  core.setSecret(token)

  const snapshotPath = await core.group('Installing snapshot tool', () => installSnapshot(version))
  await exec.exec(snapshotPath, ['--version'])

  const mode = await core.group('Detecting disk mode', async () => {
    const m = await detectDiskMode()
    core.info(`Detected disk mode: ${m}`)
    return m
  })

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
      const args = [
        '-E',
        snapshotPath,
        'compose',
        '--base',
        base,
        '--upper',
        upper,
        ...registryArgs,
        '--snapshot',
        snapshot,
      ]
      if (uploadMode !== 'default') args.push('--upload-mode', uploadMode)
      if (maxAge) args.push('--max-age', maxAge)
      await exec.exec('sudo', args, {
        env: {...process.env, REGISTRY_PASSWORD: token, REGISTRY_USERNAME: 'x-token'},
      })
    })
  } else {
    await core.group('Creating block snapshot', async () => {
      const args = [
        '-E',
        '/usr/bin/env',
        `PATH=${process.env.PATH ?? ''}`,
        snapshotPath,
        'thin-compose',
        ...registryArgs,
        ...maskArgs,
      ]
      if (uploadMode !== 'default') args.push('--upload-mode', uploadMode)
      if (maxAge) args.push('--max-age', maxAge)
      await exec.exec('sudo', args, {
        env: {...process.env, REGISTRY_PASSWORD: token, REGISTRY_USERNAME: 'x-token'},
      })
    })
  }
}

function resolveImages(): string[] {
  const images = core
    .getMultilineInput('image', {required: true})
    .map((image) => image.trim())
    .filter(Boolean)
  if (images.length === 0) throw new Error('No image provided. Set the image input to one or more image references.')

  const refs = images.map(parseImageRef)
  const first = refs[0]
  for (const ref of refs.slice(1)) {
    if (ref.scheme !== first.scheme || ref.host !== first.host || ref.repository !== first.repository) {
      throw new Error(
        `The image input supports multi-tag publishing only. All image refs must use the same registry repository; got ${formatImageRepository(
          first,
        )} and ${formatImageRepository(ref)}.`,
      )
    }
  }
  if (refs.length > 1) core.info(`Publishing snapshot to ${refs.length} tags in ${formatImageRepository(first)}`)

  return images
}

function parseImageRef(image: string): ImageRef {
  const scheme = image.startsWith('http://') ? 'http' : image.startsWith('https://') ? 'https' : 'https'
  const rest = image.replace(/^https?:\/\//, '')
  const slashIndex = rest.indexOf('/')
  if (slashIndex === -1) throw new Error(`Invalid image ref "${image}": expected registry/repository:tag`)

  const host = rest.slice(0, slashIndex)
  const path = rest.slice(slashIndex + 1)
  if (!path) throw new Error(`Invalid image ref "${image}": repository is empty`)

  const lastSlash = path.lastIndexOf('/')
  const lastColon = path.lastIndexOf(':')
  const repository = lastColon > lastSlash ? path.slice(0, lastColon) : path
  const reference = lastColon > lastSlash ? path.slice(lastColon + 1) : 'latest'
  if (!repository) throw new Error(`Invalid image ref "${image}": repository is empty`)
  if (!reference) throw new Error(`Invalid image ref "${image}": tag is empty`)

  return {scheme, host, repository, reference}
}

function formatImageRepository(ref: ImageRef): string {
  return `${ref.scheme}://${ref.host}/${ref.repository}`
}

function resolveUploadMode(): UploadMode {
  const uploadMode = core.getInput('upload-mode') || 'default'

  if (uploadMode === 'default' || uploadMode === 'oci-out-of-order' || uploadMode === 'oci-x-depot') {
    return uploadMode
  }

  throw new Error(`Invalid upload-mode "${uploadMode}". Expected default, oci-out-of-order, or oci-x-depot.`)
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

  const matches = response.url.match(/snapshot\/v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\/|$)/)
  const resolvedVersion = matches ? matches[1] : version
  return {url: response.url, resolvedVersion}
}

run().catch((error) => {
  if (error instanceof Error) core.setFailed(error.message)
  else core.setFailed(`${error}`)
})
