// Working folders: where a Bot's Sessions run. A group's folder holds for every member
// there, else a Bot works in its own folder, else in the folder of its Office (an
// Office's own `workspace/` unless the user set one in Settings). A Session's folder is
// fixed when it is made, so a change moves the conversation on to a fresh part (parts.js).
import { realpathSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import { unquote } from './text.js'

const PICK_TIMEOUT_MS = 10 * 60_000

export const within = (inner, outer) => inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep)

const expandHome = text => (text === '~' ? homedir() : /^~[\\/]/.test(text) ? join(homedir(), text.slice(2)) : text)

// Read as DSH reads it, so the plugin's data and the guarded folder are where DSH keeps
// its own: a blank value counts as unset. The value may carry the short form of a Windows
// user folder (C:\Users\ADMINI~1) and folders are compared by their real path, so it is
// resolved here; one that does not exist yet is kept as written.
export const dshHomeOf = (value) => {
  const path = resolve(expandHome(value?.trim() ? value : join(homedir(), '.dsh')))
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

export function install(rt) {
  const { ctx, state } = rt

  // The folder an Office works in: never a DSH workspace, so an Office's Sessions join
  // no DSH project list and the user's own projects stay as they are.
  const teamFolder = () => rt.officeWorkDir(rt.activeOffice())
  const workDirOf = ({ botId, roomId } = {}) => rt.roomOf(roomId)?.workDir ?? rt.botOf(botId)?.workDir
  const isFolder = path => stat(path).then(info => info.isDirectory(), () => false)
  const real = path => realpath(path).catch(() => resolve(path))
  // A Bot that could write where DSH or the plugin keeps its data could change its own
  // permissions or the team, so neither those folders nor one that holds them is
  // allowed. The working folder of another Office is out of reach as well.
  async function guarded(path) {
    const team = await teamFolder()
    for (const root of [rt.dshHome, rt.home]) {
      const data = await real(root)
      if (within(data, path)) return true
      if (within(path, data) && !(team !== undefined && within(path, team))) return true
    }
    for (const other of rt.offices.offices) {
      if (other.id === rt.activeOffice()?.id) continue
      const theirs = await real(other.workDir ?? join(other.dir, 'workspace'))
      if (within(path, theirs) || within(theirs, path)) return true
    }
    return false
  }

  // Saved as the real path, which is what a Session's cwd shows. Undefined means the
  // folder of the Office.
  async function cleanWorkDir(input) {
    const text = unquote(input)
    if (text === '') return undefined
    const expanded = expandHome(text)
    if (!isAbsolute(expanded)) throw new Error(`Give the full path of the folder, not ${text}`)
    let path
    try {
      path = await realpath(expanded)
    } catch {
      throw new Error(`There is no folder at ${text}`)
    }
    if (!(await isFolder(path))) throw new Error(`${text} is a file, not a folder`)
    if (await guarded(path)) throw new Error(`${path} holds DeepSeek Harness data, so Bots cannot work there`)
    const team = await teamFolder()
    return path === team ? undefined : path
  }

  // Every Session of a Bot: its own chat and its conversation in each of its groups.
  const sessionsOfBot = botId => [rt.chatOf(botId), ...Object.values(state.rooms)
    .filter(room => room.members.includes(botId)).map(room => room.sessions?.[botId])].filter(Boolean)

  // A folder outside the Office's folder widens where a Bot may write, so a Bot that
  // sets one for Bots whose writes are bounded by their folder asks the user first.
  // `sessions` are the Sessions that would work there; the default policy counts too,
  // since the Sessions made there later start under it. Throws when it is not allowed.
  async function approveFolder(exec, { path, sessions = [], who }) {
    const team = await teamFolder()
    const policy = ctx.get?.('sandboxPolicy')
    if (path === undefined || (team !== undefined && within(path, team)) || policy === undefined) return
    const agents = await Promise.all(sessions.map(id => rt.resolveAgent(id)))
    const modes = [policy.resolve(), ...agents.map(agent => policy.resolve({ session: agent.session }))].map(entry => entry.mode)
    if (!modes.includes('workspace-write')) return
    const approval = ctx.get?.('approval')
    const agent = exec.agent
    if (approval === undefined || agent?.session === undefined) throw new Error(`Working in ${path} needs the user's approval, and there is no way to ask for it here, so nothing changed. The user can make this change in the settings.`)
    const outcome = await approval.request({
      agent,
      toolName: exec.name,
      ...(exec.callId !== undefined ? { callId: exec.callId } : {}),
      reason: `Let ${who.en} work in ${path}? Files there can then be changed.`,
      displayReason: { en: `Let ${who.en} work in ${path}? Files there can then be changed.`, zh: `允许${who.zh}在 ${path} 中工作吗？之后可以修改这个文件夹里的文件。` },
      ...(exec.signal ? { signal: exec.signal } : {}),
    })
    if (outcome === 'allowed-once') return
    // An approval policy that never asks answers 'rejected' as well.
    throw new Error(outcome === 'rejected' ? `Working in ${path} was not allowed, so nothing changed. The user can make this change in the settings.`
      : outcome === 'cancelled' ? 'The approval was cancelled, so nothing changed.'
        : `Working in ${path} needs the user's approval, and no one could answer, so nothing changed. The user can make this change in the settings.`)
  }

  const picker = () => {
    try {
      return ctx.get?.('directoryPicker')?.capability()
    } catch {
      return undefined
    }
  }

  async function folderEndpoint(endpoint, body, signal) {
    switch (endpoint) {
      case 'folders': {
        const team = (await teamFolder()) ?? null
        const known = new Map()
        // The folders of Bots and groups here, then the other Offices' own folders,
        // which are handy to jump to but not to choose as this Office's.
        for (const entry of [...Object.values(state.bots), ...Object.values(state.rooms)]) {
          if (entry.workDir && !known.has(entry.workDir)) known.set(entry.workDir, basename(entry.workDir) || entry.workDir)
        }
        for (const office of rt.offices.offices) {
          const path = office.workDir ?? null
          if (path && !known.has(path)) known.set(path, office.name)
        }
        const present = await Promise.all([...known].map(async ([path, title]) => (await isFolder(path) ? { path, title } : undefined)))
        const kind = picker()?.kind
        return {
          team,
          picker: kind === 'native' || kind === 'browse' ? kind : null,
          folders: present.filter(Boolean),
        }
      }
      case 'folder-pick': {
        const native = picker()
        if (native?.kind !== 'native') throw new Error('This DeepSeek Harness has no folder chooser')
        return await native.pick(AbortSignal.any([signal, AbortSignal.timeout(PICK_TIMEOUT_MS)].filter(Boolean)))
      }
      case 'folder-list': {
        const browse = picker()
        if (browse?.kind !== 'browse') throw new Error('This DeepSeek Harness cannot list folders')
        const listing = await browse.list(typeof body.path === 'string' && body.path !== '' ? body.path : undefined, signal)
        return { path: listing.path, home: listing.home, crumbs: listing.crumbs, entries: listing.entries, truncated: listing.truncated }
      }
      default:
        throw new Error(`Unknown endpoint ${endpoint}`)
    }
  }

  Object.assign(rt, { teamFolder, workDirOf, isFolder, cleanWorkDir, sessionsOfBot, approveFolder, folderEndpoint })
}
