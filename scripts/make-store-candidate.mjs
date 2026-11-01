/**
 * 生成 dbx-store 上架用的候选文件
 *
 * 商店（t8y2/dbx-store）要求插件作者在 PR 里提供：
 *   publishers/<publisher>.json   发布者记录（首次上架）
 *   candidates/<plugin-id>.json   候选版本元数据（含各平台包的 HTTPS 地址与 sha256/size）
 *
 * 这些字段不能凭手写：sha256 与 size 必须精确等于 Release 上那份未签名包的字节，
 * 一旦不一致，商店签名流程会直接拒绝。本脚本按以下来源生成，避免手抄出错：
 *   .dbx-store.json            商店展示信息（名称、简介、tags、许可、localizations…）
 *   release-candidates.json    Release 上由 CI 生成的身份信息与各平台产物清单
 *
 * 用法：
 *   # 1. 从 Release 下载 release-candidates.json 到 .tmp/
 *   # 2. 克隆商店仓库到 .tmp/dbx-store（首次）
 *   npm run store:candidate -- --validate
 *
 * 参数：
 *   --candidates <path>  release-candidates.json 路径（默认 .tmp/release-candidates.json）
 *   --store <dir>        商店仓库克隆路径（默认 .tmp/dbx-store）
 *   --validate           生成后调用商店自带校验脚本 scripts/validate.mjs
 *   --dry-run            只打印结果，不写文件
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(name)
  if (index === -1) return fallback
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} 缺少取值`)
  return value
}
const hasFlag = (name) => args.includes(name)

const ROOT = process.cwd()
const candidatesPath = resolve(ROOT, argOf('--candidates', '.tmp/release-candidates.json'))
const storeDir = resolve(ROOT, argOf('--store', '.tmp/dbx-store'))
const dryRun = hasFlag('--dry-run')

/** 读取 JSON 并给出可读报错 */
function readJson(path, label) {
  if (!existsSync(path)) throw new Error(`${label} 不存在：${path}`)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON：${error.message}`)
  }
}

const storeMeta = readJson(resolve(ROOT, '.dbx-store.json'), '.dbx-store.json')
const manifest = readJson(resolve(ROOT, 'manifest.json'), 'manifest.json')
const pkg = readJson(resolve(ROOT, 'package.json'), 'package.json')

if (!existsSync(candidatesPath)) {
  throw new Error(
    [
      `找不到 ${candidatesPath}`,
      '',
      '这个文件由发布工作流在 Release 上生成。请先：',
      `  1) 在 GitHub 上发布 Release（标签 v${manifest.version}），等 CI 完成`,
      `  2) 下载该 Release 上的 release-candidates.json 到 .tmp/`,
      '',
      `下载地址形如：https://github.com/<owner>/<repo>/releases/download/v${manifest.version}/release-candidates.json`,
    ].join('\n'),
  )
}

const release = readJson(candidatesPath, 'release-candidates.json')
const identity = release.plugin ?? {}
const artifacts = release.artifacts ?? []

/** 版本与身份必须处处一致，否则商店签名会拒绝 */
const problems = []
if (identity.id !== manifest.id) problems.push(`release 的插件 id=${identity.id} 与 manifest 的 ${manifest.id} 不一致`)
if (identity.version !== manifest.version) problems.push(`release 的版本 ${identity.version} 与 manifest 的 ${manifest.version} 不一致`)
if (identity.publisher !== manifest.publisher) problems.push(`release 的 publisher ${identity.publisher} 与 manifest 的 ${manifest.publisher} 不一致`)
if (pkg.version !== manifest.version) problems.push(`package.json 版本 ${pkg.version} 与 manifest 的 ${manifest.version} 不一致`)
if (!artifacts.length) problems.push('release-candidates.json 里没有任何平台产物')
if (problems.length) throw new Error(`校验失败：\n  - ${problems.join('\n  - ')}`)

/** 从 homepage / source 推出 owner、repo、tag，用于把包内图标路径转成 HTTPS 地址 */
function parseRepo(homepage) {
  const matched = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(homepage ?? '')
  if (!matched) throw new Error(`homepage 不是 https://github.com/<owner>/<repo> 形式：${homepage}`)
  return { owner: matched[1], repo: matched[2] }
}

const { owner, repo } = parseRepo(storeMeta.homepage)
const tagMatch = /\/tree\/([^/]+)\/?$/.exec(storeMeta.source ?? '')
const tag = tagMatch ? tagMatch[1] : `v${manifest.version}`

/** 图标：包内相对路径 → 源码 Tag 下的 raw 地址（与官方自动同步的转换规则一致） */
const icon = /^https?:\/\//.test(storeMeta.icon ?? '')
  ? storeMeta.icon
  : `https://raw.githubusercontent.com/${owner}/${repo}/${tag}/${storeMeta.icon}`

const candidate = {
  schemaVersion: 1,
  id: manifest.id,
  publisher: manifest.publisher,
  version: manifest.version,
  name: storeMeta.name,
  description: storeMeta.description,
  icon,
  tags: storeMeta.tags ?? [],
  permissions: storeMeta.permissions ?? manifest.permissions ?? [],
  source: storeMeta.source ?? `https://github.com/${owner}/${repo}/tree/${tag}`,
  homepage: storeMeta.homepage,
  license: storeMeta.license,
  releaseNotes: storeMeta.releaseNotes ?? '',
  localizations: storeMeta.localizations ?? {},
  targets: artifacts.map((artifact) => ({
    target: artifact.target,
    url: artifact.url,
    sha256: artifact.sha256,
    size: artifact.size,
  })),
}

const publisherRecord = {
  id: manifest.publisher,
  name: storeMeta.publisherName ?? manifest.publisher,
  status: 'unverified',
}

console.log(`插件：${candidate.id}@${candidate.version}（publisher ${candidate.publisher}）`)
console.log(`源码：${candidate.source}`)
console.log(`图标：${candidate.icon}`)
console.log(`平台：${candidate.targets.map((entry) => entry.target).join(', ')}`)
console.table(candidate.targets.map((entry) => ({ target: entry.target, size: entry.size, sha256: entry.sha256.slice(0, 12) + '…' })))

if (dryRun) {
  console.log('\n--dry-run：以下内容未写入')
  console.log(JSON.stringify({ candidate, publisherRecord }, null, 2))
  process.exit(0)
}

if (!existsSync(storeDir)) throw new Error(`商店仓库不存在：${storeDir}\n请先 git clone --depth 1 https://github.com/t8y2/dbx-store.git .tmp/dbx-store`)

const candidateFile = join(storeDir, 'candidates', `${candidate.id}.json`)
const publisherFile = join(storeDir, 'publishers', `${publisherRecord.id}.json`)
mkdirSync(join(storeDir, 'candidates'), { recursive: true })
mkdirSync(join(storeDir, 'publishers'), { recursive: true })
writeFileSync(candidateFile, `${JSON.stringify(candidate, null, 2)}\n`)
console.log(`\n已写入 ${candidateFile}`)

if (existsSync(publisherFile)) {
  console.log(`发布者记录已存在，保持不动：${publisherFile}`)
} else {
  writeFileSync(publisherFile, `${JSON.stringify(publisherRecord, null, 2)}\n`)
  console.log(`已写入 ${publisherFile}`)
}

if (hasFlag('--validate')) {
  console.log('\n运行商店自带校验（scripts/validate.mjs）…')
  try {
    const output = execFileSync(process.execPath, ['scripts/validate.mjs'], { cwd: storeDir, encoding: 'utf8' })
    console.log(output.trim() || '校验通过')
  } catch (error) {
    // 候选未被签名前 CI 会刻意保持失败状态，这里把原因原样打出来
    const detail = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim() || error.message
    console.error('校验未通过：')
    console.error(detail)
    if (/awaiting DBX Store signing/i.test(detail)) {
      console.error('\n上面这条是预期的：候选文件已通过结构校验，只等维护者签名。可以提 PR。')
      process.exit(0)
    }
    process.exit(1)
  }
}
