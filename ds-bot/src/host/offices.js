// Offices: a team is a set of Offices, and each Office keeps its own Bots, group chats,
// memory, secrets, settings and working folder. Two Offices share nothing, so no Bot,
// chat or file in one can reach another.
//
// An Office is a folder under the plugin home: `state.json` (its team), `state.lock`,
// `memory/`, `secrets/` and `workspace/` (the folder its Sessions start in). The
// registry in `offices.json` lists them; the folder name never changes, so renaming an
// Office leaves its data where it is. This module owns the registry, the Office the
// window shows ("active"), and an Office's working folder. store.js reads and writes
// the active Office's team.
import { mkdirSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, sep } from 'node:path'
import { OFFICE_NAME_MAX, OFFICE_RESERVED, OFFICE_SLUG } from './constants.js'
import { homeLock } from './home-lock.js'
import { normalize, unquote } from './text.js'

const EMPTY_TEAM = { version: 1, mainBotIds: [], bots: {}, rooms: {}, agents: {}, capabilities: { items: {} }, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0 }
const expandHome = text => (text === '~' ? homedir() : /^~[\\/]/.test(text) ? join(homedir(), text.slice(2)) : text)
const inside = (inner, outer) => inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep)

// A folder name for an Office, from the name the user gave it. Names in a script
// without Latin letters still need one, so they fall back to `office`.
export function slugOf(text) {
  const slug = String(text ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
  return OFFICE_SLUG.test(slug) ? slug : 'office'
}

export function install(rt) {
  const { home, warn } = rt
  const registryPath = join(home, 'offices.json')

  /** @type {{version:1, active:string|null, offices:Array<{id:string,name:string,dir:string,workDir?:string,createdAt:number,legacy?:boolean}>}} */
  const registry = { version: 1, active: null, offices: [] }
  // The Office that was active when this host loaded the team; a difference means the
  // team in memory belongs to another Office (index.js reloads it).
  let loadedId
  let loading = null
  // Bumped on every switch, so a load that was under way finishes into the wrong team
  // and is dropped instead of shown.
  let generation = 0
  const changeListeners = new Set()
  // The process-lifetime locks this host holds, one per Office it opened.
  const locks = new Map()

  const record = id => (id === undefined || id === null ? undefined : registry.offices.find(office => office.id === id))
  const activeOffice = () => record(registry.active)
  // The folder an Office keeps its files in. An Office made from a team from before
  // Offices stays in the plugin home itself, so its `dir` wins over `<home>/<id>`.
  const dirOf = id => record(id)?.dir ?? join(home, String(id))
  const activeDir = () => dirOf(registry.active)
  const byName = name => registry.offices.find(office => normalize(office.name) === normalize(name))
  // An Office by id first, then by the name the user typed.
  const byRef = (ref) => {
    if (ref === undefined || ref === null) return undefined
    const found = record(ref)
    if (found !== undefined) return found
    return byName(unquote(ref).replace(/^@/, ''))
  }
  const isFolder = path => stat(path).then(info => info.isDirectory(), () => false)
  const real = path => rt.real(path)
  const exists = path => stat(path).then(() => true, () => false)

  const markLoaded = () => {
    loadedId = registry.active
    rt.statePath = join(activeDir(), 'state.json')
  }

  const save = async () => {
    await mkdir(home, { recursive: true })
    const temp = `${registryPath}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(registry, null, 2), 'utf8')
    await rename(temp, registryPath)
  }

  const read = async () => {
    let text
    try {
      text = await readFile(registryPath, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') warn('ds-bot: the office list %s cannot be read: %s', registryPath, error)
      return null
    }
    try {
      return JSON.parse(text)
    } catch (error) {
      warn('ds-bot: the office list %s cannot be read: %s', registryPath, error)
      return null
    }
  }

  const adopt = (parsed) => {
    if (parsed?.version === 1 && Array.isArray(parsed.offices)) {
      registry.active = typeof parsed.active === 'string' ? parsed.active : null
      registry.offices = parsed.offices
        .filter(office => office !== null && typeof office === 'object' && OFFICE_SLUG.test(String(office.id)))
        .map(office => ({
          id: office.id,
          name: String(office.name ?? titleOf(office.id)).slice(0, OFFICE_NAME_MAX),
          dir: typeof office.dir === 'string' && office.dir !== '' ? office.dir : join(home, office.id),
          ...(typeof office.workDir === 'string' && office.workDir !== '' ? { workDir: office.workDir } : {}),
          createdAt: Number(office.createdAt ?? Date.now()),
          ...(office.legacy === true ? { legacy: true } : {}),
        }))
    }
    if (record(registry.active) === undefined) registry.active = registry.offices[0]?.id ?? null
  }

  function titleOf(id) {
    const parts = String(id).split('-').filter(Boolean)
    return parts.map((part, index) => (index === 0 ? part[0].toUpperCase() + part.slice(1) : part)).join(' ')
  }

  // Every team from before Offices kept its data in the plugin home itself. It becomes
  // the first Office in place, so an updated team finds its Bots, chats and notes.
  const adoptLegacy = async () => {
    if (!(await exists(join(home, 'state.json')))) return
    registry.offices.push({ id: 'team', name: 'Team', dir: home, createdAt: Date.now(), legacy: true })
    if (record(registry.active) === undefined) registry.active = 'team'
  }

  // A team folder that the list lost (a copied home, a hand-edited list) is adopted
  // again, so its Bots do not silently vanish from Settings.
  const adoptStray = async () => {
    const skip = new Set(['logs', 'memory', 'workspace', 'secrets', ...registry.offices.map(office => office.id)])
    let entries
    try {
      entries = await readdir(home, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !OFFICE_SLUG.test(entry.name) || skip.has(entry.name)) continue
      if (!(await exists(join(home, entry.name, 'state.json')))) continue
      registry.offices.push({ id: entry.name, name: titleOf(entry.name), dir: join(home, entry.name), createdAt: Date.now() })
    }
  }

  const nextName = () => {
    for (let index = 1; ; index += 1) {
      const name = index === 1 ? 'Office' : `Office ${index}`
      if (byName(name) === undefined) return name
    }
  }

  const freeId = (base) => {
    if (record(base) === undefined) return base
    let index = 2
    while (record(`${base}-${index}`) !== undefined) index += 1
    return `${base}-${index}`
  }

  const load = () => loading ??= (async () => {
    adopt(await read())
    await adoptLegacy()
    await adoptStray()
    if (registry.offices.length === 0) await create({ silent: true, fromLoad: true })
    markLoaded()
    await save().catch(error => warn('ds-bot: saving the office list failed: %s', error))
  })().catch((error) => {
    loading = null
    throw error
  })

  // A new Office starts empty; its first window makes its Main Bot (roster.bootstrap).
  // The first Office keeps its team in the plugin home itself, where a team has always
  // lived, so an install that has none yet looks exactly like one from before Offices.
  // `fromLoad`: load() itself is making the first Office, so it must not wait on itself.
  async function create({ name, workDir, silent = false, fromLoad = false } = {}) {
    if (!fromLoad) await load()
    const label = String(name ?? '').trim().slice(0, OFFICE_NAME_MAX) || nextName()
    if (byName(label) !== undefined) throw new Error(`There is already an Office called ${label}`)
    if (OFFICE_RESERVED.includes(label.toLowerCase())) throw new Error(`${label} is a reserved name`)
    const first = registry.offices.length === 0
    const id = freeId(slugOf(label))
    const dir = first ? home : join(home, id)
    if (!first) await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'state.json'), JSON.stringify(EMPTY_TEAM, null, 2), 'utf8')
    // The team in the plugin home can never be archived: it is the home itself.
    const office = { id, name: label, dir, createdAt: Date.now(), ...(first ? { legacy: true } : {}) }
    if (workDir !== undefined && workDir !== '' && workDir !== null) office.workDir = await cleanWorkDir(workDir)
    registry.offices.push(office)
    registry.active ??= id
    await save()
    if (!silent) await switchTo(id)
    else markLoaded()
    return office
  }

  async function switchTo(id) {
    registry.active = id
    await save()
    generation += 1
    markLoaded()
    for (const listener of changeListeners) listener(id)
    // store.js drops the team it holds and reads the new Office's (index.js wires it).
    rt.reloadTeam?.()
  }

  async function activate(id) {
    await load()
    const office = record(id)
    if (office === undefined) throw new Error('Unknown Office')
    if (registry.active !== id) await switchTo(id)
    return office
  }

  // Named `renameOffice`, not `rename`: a function declaration would shadow the fs one
  // that save() moves the list with.
  async function renameOffice(id, name) {
    await load()
    const office = record(id)
    if (office === undefined) throw new Error('Unknown Office')
    const label = String(name ?? '').trim().slice(0, OFFICE_NAME_MAX)
    if (label === '') throw new Error('An Office needs a name')
    if (OFFICE_RESERVED.includes(label.toLowerCase())) throw new Error(`${label} is a reserved name`)
    const clash = byName(label)
    if (clash !== undefined && clash.id !== id) throw new Error(`There is already an Office called ${label}`)
    office.name = label
    await save()
    return office
  }

  // Archiving an Office takes it off the list and moves its folder out of the way, so a
  // new Office may take its name; nothing is deleted. Its files stay beside the home.
  async function remove(id) {
    await load()
    const office = record(id)
    if (office === undefined) throw new Error('Unknown Office')
    if (registry.offices.length <= 1) throw new Error('The team needs at least one Office')
    if (office.legacy === true) throw new Error('The first Office cannot be archived; rename it instead')
    const index = registry.offices.indexOf(office)
    const moved = `${office.dir}.archived-${Date.now()}`
    try {
      await rename(office.dir, moved)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error(`The folder of ${office.name} could not be moved out of the way: ${error?.message ?? error}`)
    }
    registry.offices.splice(index, 1)
    const current = registry.active === id
    if (current) registry.active = registry.offices[Math.min(index, registry.offices.length - 1)].id
    await save()
    if (current) await switchTo(registry.active)
    return { archived: moved }
  }

  async function cleanWorkDir(input) {
    const text = unquote(input)
    if (text === '') return undefined
    const expanded = expandHome(text)
    if (!isAbsolute(expanded)) throw new Error(`Give the full path of the folder, not ${text}`)
    let path
    try {
      path = await real(expanded)
    } catch {
      throw new Error(`There is no folder at ${text}`)
    }
    if (!(await isFolder(path))) throw new Error(`${text} is a file, not a folder`)
    return path
  }

  // Offices may not share a working folder, and none may hold plugin or DSH data: either
  // would put one Office's files inside another's reach.
  async function folderProblem(office, path) {
    if (path === undefined) return undefined
    const own = await real(office.dir)
    if (inside(path, own)) return 'An Office keeps its own data in that folder'
    for (const other of registry.offices) {
      if (other.id === office.id) continue
      const theirs = await real(other.workDir ?? join(other.dir, 'workspace'))
      if (path === theirs || inside(theirs, path) || inside(path, theirs)) return `That folder overlaps the working folder of ${other.name}`
    }
    for (const root of [rt.dshHome, home]) {
      const data = await real(root)
      if (inside(path, data) || inside(data, path)) return 'That folder holds the plugin or DeepSeek Harness data'
    }
    return undefined
  }

  // The folder's Sessions start in: the Office's own choice, else `workspace/` inside
  // the Office, made when first needed.
  // Folders whose `workspace/` this host has already made: the folder of an Office is
  // asked for on almost every path, and a mkdir per call shows up in every save.
  const madeWorkspaces = new Set()
  async function workDirOf(office = activeOffice()) {
    if (office === undefined) return undefined
    if (office.workDir !== undefined) return office.workDir
    const path = join(office.dir, 'workspace')
    if (madeWorkspaces.has(path)) return path
    try {
      mkdirSync(path, { recursive: true })
      madeWorkspaces.add(path)
    } catch (error) {
      warn('ds-bot: the workspace of %s cannot be made: %s', office.name, error)
      return undefined
    }
    return path
  }

  async function setWorkDir(id, workDir) {
    await load()
    const office = record(id)
    if (office === undefined) throw new Error('Unknown Office')
    const path = await cleanWorkDir(workDir ?? '')
    const problem = await folderProblem(office, path)
    if (problem !== undefined) throw new Error(problem)
    if (path === undefined) delete office.workDir
    else office.workDir = path
    await save()
    return office
  }

  const view = () => registry.offices.map(office => ({
    id: office.id,
    name: office.name,
    dir: office.dir,
    workDir: office.workDir ?? null,
    legacy: office.legacy === true,
    current: office.id === registry.active,
  }))

  // One lock per Office, kept for the life of this host: switching away from an Office
  // and back must not hand it to another dsh on the same data.
  const lockOf = (id) => {
    let lock = locks.get(id)
    if (lock === undefined) {
      lock = homeLock(join(dirOf(id), 'state.lock'))
      locks.set(id, lock)
    }
    return lock
  }
  const releaseLocks = () => {
    for (const lock of locks.values()) lock.release()
    locks.clear()
  }

  Object.assign(rt, {
    offices: registry,
    officeRegistryPath: registryPath,
    loadOffices: load,
    saveOffices: save,
    officesView: view,
    activeOffice,
    officeOf: record,
    officeByRef: byRef,
    officeDir: dirOf,
    officeWorkDir: workDirOf,
    officeCreate: create,
    officeActivate: activate,
    officeRename: renameOffice,
    officeRemove: remove,
    officeSetWorkDir: setWorkDir,
    officeCleanWorkDir: cleanWorkDir,
    officeTitle: titleOf,
    officeGeneration: () => generation,
    officeMarkLoaded: markLoaded,
    officeIsFolder: isFolder,
    officeLock: lockOf,
    onOfficeChange: (listener) => { changeListeners.add(listener); return () => changeListeners.delete(listener) },
    releaseOfficeLocks: releaseLocks,
    officeStale: () => loadedId !== registry.active,
  })
}
