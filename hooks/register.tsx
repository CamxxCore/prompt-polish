import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register } from 'claude-code'

import type { EffortChange, Mode, Revealed, Rewrites } from '../types'
import { MODES, MODE_NAMES, PRAISE_NOTE, TONE_SECTION, applyMode, clarifyNote, isMode } from './modes'
import { BYPASS, clarify, polish, shouldPolish } from './polish'
import type { Clarity } from './polish'

const PERSON = new Set(['composer', 'bridge', 'sdk'])
const COMMAND = 'polish'

const rewrites = atom({ plugin: 'prompt-polish', key: 'rewrites' } as const, {} as Rewrites)
const revealed = atom({ plugin: 'prompt-polish', key: 'revealed' } as const, {} as Revealed)
const mode = atom({ plugin: 'prompt-polish', key: 'mode' } as const, 'standard' as Mode)
const effortChange = atom({ plugin: 'prompt-polish', key: 'effortChange' } as const, null as EffortChange)

const isPerson = (o: PromptOrigin | undefined) =>
  !o || PERSON.has(o.kind) || (o.kind === 'plugin' && o.asUser === true)

const pairFor = (all: Rewrites, text: string) => {
  if (all[text] !== undefined) return { original: text, polished: all[text] }
  const original = Object.keys(all).find(k => all[k] === text)
  return original === undefined ? undefined : { original, polished: text }
}

export const rowKey = (text: string) => {
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  return `polish-${(hash >>> 0).toString(36)}`
}

async function raiseEffort($: EngineInterface): Promise<string> {
  try {
    const row = (await $.config.list()).find(r => /effort/i.test(r.key) && r.options?.includes('max'))
    if (!row || row.isLocked || typeof row.value !== 'string' || row.value === 'max') return ''
    const { deny } = await $.config.set({ key: row.key, value: 'max' })
    if (deny) return ''
    await update($, effortChange, () => ({ key: row.key, previous: row.value as string }))
    return ` Effort raised from ${row.value} to max for this session.`
  } catch {
    return ''
  }
}

async function restoreEffort($: EngineInterface): Promise<string> {
  const change = await read($, effortChange)
  if (!change) return ''
  await update($, effortChange, () => null)
  try {
    const { deny } = await $.config.set({ key: change.key, value: change.previous })
    return deny ? '' : ` Effort restored to ${change.previous}.`
  } catch {
    return ''
  }
}

async function setMode($: EngineInterface, next: Mode): Promise<string> {
  const current = await read($, mode)
  if (current === next) return `Prompt polish is already in ${MODES[next].label.toLowerCase()} mode.`
  await update($, mode, () => next)
  const note = next === 'careful' ? await raiseEffort($) : current === 'careful' ? await restoreEffort($) : ''
  return `Prompt polish: ${MODES[next].label.toLowerCase()} mode. ${MODES[next].summary}${note}`
}

const STORE_KEY = 'rewrites'
const STORE_LIMIT = 300

const isRewrites = (value: unknown): value is Rewrites =>
  typeof value === 'object' && value !== null && Object.values(value).every(v => typeof v === 'string')

async function remember($: EngineInterface, original: string, polished: string) {
  await update($, rewrites, current => {
    const entries = Object.entries(current).filter(([k]) => k !== original)
    return Object.fromEntries([...entries, [original, polished]].slice(-STORE_LIMIT))
  })
  await $.store.set(STORE_KEY, await read($, rewrites)).catch(() => {})
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const saved = await $.store.get(STORE_KEY).catch(() => undefined)
    if (isRewrites(saved)) await update($, rewrites, () => saved)
    await $.command.register({
      name: COMMAND,
      description: 'Set the prompt polish mode: standard, supportive or careful',
      argumentHint: MODE_NAMES.join('|'),
    })
    $.ui.toast('Prompt polish is on')
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (isMode(arg)) return { text: await setMode($, arg) }
    const current = await read($, mode)
    const usage = `Usage: /${COMMAND} ${MODE_NAMES.join('|')}`
    const unknown = arg && arg !== 'status' ? `Unknown mode "${arg}". ` : ''
    return { text: `${unknown}Prompt polish is in ${MODES[current].label.toLowerCase()} mode. ${MODES[current].summary}\n${usage}` }
  })

  on('prompt.compose', async ($, e, next) => {
    const { sections } = await next(e)
    return { sections: [...sections, TONE_SECTION] }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || !isPerson(e.origin)) return next(e)

    const trimmed = e.text.trimStart()
    if (trimmed.startsWith(BYPASS)) {
      return next({ ...e, text: trimmed.slice(BYPASS.length).trimStart() })
    }

    const current = await read($, mode)
    let text = e.text
    let verdict = 'short'
    let clarity: Clarity = { outcome: 'skipped' }
    if (shouldPolish(e.text)) {
      $.ui.status('Polishing prompt...')
      // An attached image or file may hold the detail; the clarity model cannot see it.
      const attached = (e.attachments?.length ?? 0) > 0
      ;[{ text, verdict }, clarity] = await Promise.all([
        polish($, e.text),
        attached ? Promise.resolve<Clarity>({ outcome: 'skipped:attachment' }) : clarify($, e.text),
      ])
      $.ui.status(undefined)
    }
    const notes: string[] = []
    if (verdict === 'praise') notes.push(PRAISE_NOTE)
    if (clarity.question) notes.push(clarifyNote(clarity.question))
    text = applyMode(current, text, notes)
    if (text === e.text) return next(e)

    await remember($, e.text, text)
    return next({ ...e, text })
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const pair = pairFor(await read($, rewrites), e.props.text)
    if (pair === undefined) return next(e)

    const key = rowKey(pair.original)
    const isOpen = (await read($, revealed))[key] === true
    const toggle = () => update($, revealed, all => ({ ...all, [key]: !all[key] }))

    const row = await next({ ...e, props: { ...e.props, text: pair.original } })
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Button key={key} plain onPress={toggle}>
          <Text dimColor>{isOpen ? '[hide polished]' : '[polished]'}</Text>
        </Button>
        {isOpen && <Text dimColor>{pair.polished}</Text>}
        {row}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, mode)
    if (current === 'standard' || e.props.hasSurvey) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text dimColor>Prompt polish: {MODES[current].label.toLowerCase()} mode. {MODES[current].summary} </Text>
        <Button key="polish-standard" label="Back to standard" onPress={() => setMode($, 'standard')} />
      </Box>
    )
  })
}
