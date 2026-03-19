import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as http from '@actions/http-client'
import * as toolCache from '@actions/tool-cache'
import * as path from 'node:path'

type ApiResponse = {ok: true; url: string} | {ok: false; error: string}

const client = new http.HttpClient('depot-snapshot-action')

async function run() {
  const token = await resolveToken()
  const image = core.getInput('image', {required: true})
  const base = core.getInput('base')
  const upper = core.getInput('upper')
  const snapshot = core.getInput('snapshot')
  const version = core.getInput('version')

  core.setSecret(token)

  const snapshotPath = await core.group('Installing snapshot', () => installSnapshot(version))
  await exec.exec(snapshotPath, ['--version'])

  await core.group('Running snapshot compose', async () => {
    await exec.exec(
      snapshotPath,
      ['compose', '--fw-cfg', '--base', base, '--upper', upper, '--registry', image, '--snapshot', snapshot],
      {
        env: {
          ...process.env,
          REGISTRY_PASSWORD: token,
          REGISTRY_USERNAME: 'x-token',
        },
      },
    )
  })
}

async function resolveToken(): Promise<string> {
  const token = core.getInput('token')
  if (token) return token

  try {
    const oidcToken = await core.getIDToken('https://depot.dev')
    core.setSecret(oidcToken)
    const res = await client.postJson<{ok: boolean; token: string}>(
      'https://github.depot.dev/auth/oidc/github-actions',
      {token: oidcToken},
    )
    if (res.result?.token) {
      core.info('Exchanged GitHub Actions OIDC token for temporary Depot token')
      return res.result.token
    }
  } catch (err) {
    core.info(`Unable to exchange GitHub OIDC token for temporary Depot token: ${err}`)
  }

  throw new Error('No token provided and OIDC exchange failed. Set the token input or configure OIDC.')
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
