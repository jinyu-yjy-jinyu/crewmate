// Offices: the teams this plugin keeps side by side. Every Office has its own Bots,
// groups, memory, keys and working folder, and the settings show one Office at a time.
// Switching opens the other Office; the sidebar, the chats and the settings then show
// that Office only.
import { createElement as h, useEffect, useState } from 'react'
import { ChevronRightIcon, OfficeIcon, PlusIcon } from './icons.js'
import { Card, InlineText, Row } from './bot-settings.js'
import { FolderMenu } from './folder-menu.js'
import { t } from './i18n.js'

// The Office list, with the one this window shows first. `onOpen` opens one; the
// current Office's name and folder are changed on its own page.
export function OfficesPage({ roster, actions, run }) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const offices = roster.offices ?? []
  const current = offices.find(office => office.current)
  const others = offices.filter(office => !office.current)
  const create = async () => {
    if (busy) return
    setBusy(true)
    const done = await run(actions.createOffice(name.trim()))
    setBusy(false)
    if (done) {
      setCreating(false)
      setName('')
    }
  }
  return [
    h(Card, { key: 'current', title: t('This window shows') },
      current ? h('button', { type: 'button', className: 'bt-set-row bt-off-row', onClick: () => actions.openSettings('offices', current.id) },
        h('span', { className: 'bt-off-mark', 'aria-hidden': true }, h(OfficeIcon)),
        h('span', { className: 'bt-set-copy' },
          h('span', { className: 'bt-bs-label' }, current.name),
          h('span', { className: 'bt-set-hint' }, current.workDir ?? current.dir)),
        h('span', { className: 'bt-chevron' }, h(ChevronRightIcon))) : null,
      h('div', { className: 'bt-set-row bt-off-note' },
        h('span', { className: 'bt-set-hint' }, t('Each Office has its own Bots, group chats, memory, keys and working folder. Nothing is shared between two Offices.')))),
    others.length === 0 ? null : h(Card, { key: 'others', title: t('Other Offices · {count}', { count: others.length }) },
      others.map(office => h('div', { key: office.id, className: 'bt-off-other' },
        h('button', { type: 'button', className: 'bt-set-row bt-off-row', onClick: () => actions.openSettings('offices', office.id) },
          h('span', { className: 'bt-off-mark', 'aria-hidden': true }, h(OfficeIcon)),
          h('span', { className: 'bt-set-copy' },
            h('span', { className: 'bt-bs-label' }, office.name),
            h('span', { className: 'bt-set-hint' }, office.workDir ?? office.dir)),
          h('span', { className: 'bt-chevron' }, h(ChevronRightIcon))),
        h('div', { className: 'bt-set-row bt-off-actions' },
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => void run(actions.switchOffice(office.id)) }, t('Switch to this Office')))))),
    creating
      ? h('div', { key: 'new', className: 'bt-set-card bt-off-new' },
          h('label', { className: 'bt-set-row' },
            h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Name'))),
            h('input', {
              className: 'bt-bs-input', autoFocus: true, value: name, maxLength: 40, placeholder: t('Work, Personal, Client A…'),
              onChange: event => setName(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) void create() },
            })),
          h('div', { className: 'bt-set-row bt-task-foot' },
            h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => { setCreating(false); setName('') } }, t('Cancel')),
            h('button', { type: 'button', className: 'bt-send bt-soft-sm', disabled: busy || name.trim() === '', onClick: () => void create() }, t('Create Office'))))
      : h('div', { key: 'add', className: 'bt-actions' },
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon', onClick: () => setCreating(true) }, h(PlusIcon), t('New Office'))),
  ]
}

// One Office's own page: its name, its working folder, and what removing it does.
export function OfficeSettingsForm({ office, roster, actions, run }) {
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    if (!confirming) return undefined
    const timer = setTimeout(() => setConfirming(false), 4000)
    return () => clearTimeout(timer)
  }, [confirming])
  const current = office.current === true
  const remove = () => {
    if (!confirming) {
      setConfirming(true)
      return
    }
    void run(actions.removeOffice(office.id))
  }
  return h('div', { className: 'bt-bs' },
    h('div', { className: 'bt-bs-hero' },
      h('span', { className: 'bt-off-mark bt-off-mark-lg', 'aria-hidden': true }, h(OfficeIcon)),
      h('div', { className: 'bt-bs-who' },
        h('span', { className: 'bt-bs-name' }, office.name),
        h('span', { className: 'bt-bs-sub' }, current ? t('Shown in this window') : t('Another Office')))),
    h(Card, { title: t('Profile') },
      h(Row, { label: t('Name'), hint: t('The folder of an Office keeps its first name, so renaming it moves nothing.') },
        h(InlineText, { label: t('Office name'), value: office.name, required: true, maxLength: 40, onSave: name => run(actions.renameOffice(office.id, name)) }))),
    h(Card, { title: t('Working folder') },
      h('div', { className: 'bt-set-row bt-bs-row' },
        h('span', { className: 'bt-set-copy' },
          h('span', { className: 'bt-bs-label' }, t('Folder')),
          h('span', { className: 'bt-set-hint' }, t('Where this Office starts its Bots and group chats. Its own folder holds its data: {dir}', { dir: office.dir }))),
        h(FolderMenu, { value: office.workDir ?? undefined, actions, run, onPick: workDir => run(actions.setOfficeWorkDir(office.id, workDir)) }))),
    current ? null : h(Card, { title: t('Open') },
      h('div', { className: 'bt-set-row bt-bs-row' },
        h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Switch to this Office')), h('span', { className: 'bt-set-hint' }, t('The window shows this Office after the switch.'))),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => void run(actions.switchOffice(office.id)) }, t('Switch')))),
    h(Card, { title: t('Manage') },
      h('button', {
        type: 'button', className: 'bt-set-row bt-bs-row bt-bs-danger', 'data-confirm': confirming || undefined,
        disabled: office.legacy === true || (roster.offices ?? []).length <= 1,
        onClick: remove,
      },
      h('span', { className: 'bt-set-copy' },
        h('span', { className: 'bt-bs-label' }, confirming ? t('Remove {name}?', { name: office.name }) : t('Remove Office')),
        h('span', { className: 'bt-set-hint' }, office.legacy === true
          ? t('The first Office stays; rename it instead.')
          : (roster.offices ?? []).length <= 1 ? t('The team needs at least one Office.')
            : confirming ? t('Click again to remove. Its folder moves beside the Office data; nothing is deleted.') : t('Takes this Office off the list. Its files stay on disk.'))),
      h('span', { className: 'bt-chevron' }, h(ChevronRightIcon)))))
}

export const OFFICE_CSS = `
.bt-off-row{gap:10px;align-items:center}
.bt-off-mark{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:8px;background:var(--bt-active);color:var(--bt-ink-2)}
.bt-off-mark svg{width:16px;height:16px}
.bt-off-mark-lg{width:52px;height:52px;border-radius:14px}
.bt-off-mark-lg svg{width:26px;height:26px}
.bt-off-other+.bt-off-other{border-top:.5px solid var(--bt-line)}
.bt-off-other .bt-off-row{border-radius:0}
.bt-off-actions{padding:0 12px 10px;justify-content:flex-end}
.bt-off-note{padding:0 12px 10px}
.bt-off-new .bt-bs-input{flex:1}
`
