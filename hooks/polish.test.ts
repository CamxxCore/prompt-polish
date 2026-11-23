import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { MODES, PRAISE_NOTE, applyMode, clarifyNote } from './modes'
import { acceptRewrite, contextBlock, hasPraiseWords, isRequest, parseClarity, protectedTokens, rejection, shouldPolish, wordDiff } from './polish'
import { rowKey } from './register'

const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

const RUDE = 'this is still broken, fix src/app/main.ts and stop breaking `runLoop` already'
const NICE = 'This is still broken. Could you please fix src/app/main.ts and stop breaking `runLoop`? Thanks.'
const CALM = 'please add a cancel button to the settings dialog'
const KIND = 'that refactor came out really clean, nice work'
const VAGUE = 'add a button to the dialog'
const REMARK = "we've over corrected again"
const REPORT = "the plugin seems to still be injecting 'thanks' in inappropriate circumstances"
const QUESTION = 'Which dialog gets the button, and what should it do when pressed?'

const LABELS = {
  harsh: 'rude, dismissive or frustrated',
  praise: 'thankful, complimentary or encouraging about work already done',
  neutral: 'neutral or polite',
}

type Script = { tone: keyof typeof LABELS | 'fail'; rewrites: string[]; clarity?: string }

// Returns the rewrite and clarity prompts asked of the model; the classifier is answered from the script.
const model = (on: On, script: Script) => {
  const asked: string[] = []
  const clarified: string[] = []
  on('model.classify', () => {
    if (script.tone === 'fail') throw new Error('classifier unavailable')
    return { value: LABELS[script.tone] }
  })
  on('model.complete', ($, e) => {
    if (/soften the tone/.test(e.system ?? '')) {
      asked.push(e.prompt)
      const text = script.rewrites[Math.min(asked.length, script.rewrites.length) - 1] ?? ''
      return { value: { isAnswered: true, text, usage } }
    }
    clarified.push(e.prompt)
    return { value: { isAnswered: true, text: script.clarity ?? 'CLEAR', usage } }
  })
  return { asked, clarified }
}

const sent = (on: On) => {
  const seen: string[] = []
  on('prompt.submit', ($, e) => {
    seen.push(e.text)
    return { text: e.text }
  })
  return seen
}

const started = async ($: Engine, on: On, stored?: Record<string, string>) => {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('store.get', () => ({ value: stored }))
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
}

const command = ($: Engine, args: string) =>
  $.command.run({ command: 'polish', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as never)

describe('guards', () => {
  test('skips short replies, bypassed prompts and code fences', () => {
    expect(shouldPolish('yes go')).toBe(false)
    expect(shouldPolish('\\ just do the thing already now')).toBe(false)
    expect(shouldPolish('fix this:\n```\nx\n```\nnow please')).toBe(false)
    expect(shouldPolish(RUDE)).toBe(true)
  })

  test('a short prompt with a word of praise is still classified', () => {
    expect(hasPraiseWords('nice work')).toBe(true)
    expect(hasPraiseWords('yes go')).toBe(false)
    expect(shouldPolish('nice work')).toBe(true)
    expect(shouldPolish('thanks!')).toBe(true)
    expect(shouldPolish('\\ nice work')).toBe(false)
  })

  test('takes only a one-line question from the clarity check', () => {
    expect(parseClarity('CLEAR')).toEqual({ outcome: 'clear' })
    expect(parseClarity(' clear. ')).toEqual({ outcome: 'clear' })
    expect(parseClarity('')).toEqual({ outcome: 'clear' })
    expect(parseClarity(` ${QUESTION} `)).toEqual({ question: QUESTION, outcome: 'asked' })
    expect(parseClarity('CLEAR\n\nThe request names the file and the change.')).toEqual({ outcome: 'clear' })
    expect(parseClarity(`Here is the missing detail:\n\n"${QUESTION}"`)).toEqual({ question: QUESTION, outcome: 'asked' })
    expect(parseClarity(`- ${QUESTION}\n- What color should it be?`)).toEqual({ question: QUESTION, outcome: 'asked' })
    expect(parseClarity('Sure! Here is what is missing: the dialog.').outcome).toBe('malformed:"Sure! Here is what is missing: the dialog."')
    expect(parseClarity('x'.repeat(300) + '?').outcome).toMatch(/^malformed:/)
  })

  test('collects paths, inline code and identifiers', () => {
    const tokens = protectedTokens(RUDE)
    expect(tokens).toContain('src/app/main.ts')
    expect(tokens).toContain('`runLoop`')
  })

  test('rejects a rewrite that drops a protected token', () => {
    expect(acceptRewrite(RUDE, NICE)).toBe(true)
    expect(acceptRewrite(RUDE, 'Could you please fix the main file?')).toBe(false)
    expect(acceptRewrite(RUDE, '')).toBe(false)
  })

  test('tells a request from a remark', () => {
    expect(isRequest(RUDE)).toBe(true)
    expect(isRequest(CALM)).toBe(true)
    expect(isRequest('what does it mean?')).toBe(true)
    expect(isRequest(REMARK)).toBe(false)
    expect(isRequest(REPORT)).toBe(false)
  })

  test('rejects courtesy added to a remark and names the words', () => {
    expect(rejection(REMARK, "We've over corrected again. Thanks.")?.drop).toEqual(['thanks'])
    expect(rejection(REPORT, `${REPORT.replace(/^t/, 'T')}. Could you please take a look?`)?.drop).toEqual(['could', 'you', 'please', 'take', 'look'])
    expect(acceptRewrite(REMARK, "We've over corrected again.")).toBe(true)
    expect(acceptRewrite(RUDE, NICE)).toBe(true)
  })

  test('rejects a synonym swap and names both words', () => {
    const typed = "keep 'box type' in the unexpanded view."
    const r = rejection(typed, "Please keep 'box type' in the collapsed view.")
    expect(r?.keep).toEqual(['unexpanded'])
    expect(r?.drop).toEqual(['collapsed'])
    expect(acceptRewrite(typed, "Could you please keep 'box type' in the unexpanded view? Thanks!")).toBe(true)
  })

  test('rejects a dropped or added negation', () => {
    expect(rejection('this is not working, fix it', 'This is working, could you fix it please?')?.reason).toBe('negation')
    expect(rejection('do break the cache on save', 'Please do not break the cache on save.')?.reason).toBe('negation')
    expect(acceptRewrite('dont break the cache on save', "Please don't break the cache on save.")).toBe(true)
  })

  test('accepts spelling fixes, profanity removal and courtesy', () => {
    expect(wordDiff('keep the unexpnaded view', 'Keep the unexpanded view.')).toEqual({ removed: [], added: [] })
    expect(acceptRewrite('ugh this is horrible, fix the unexpanded view', 'Could you please fix the unexpanded view?')).toBe(true)
    expect(acceptRewrite("rename 'box type' now please", 'Please rename the box type now.')).toBe(false)
  })

  test('rejects an added content word', () => {
    expect(rejection('fix the build', 'Please quickly fix the build.')?.drop).toEqual(['quickly'])
  })

  test('checks the words inside quotes, not the quote marks', () => {
    const typed = "I saw a pop up often... 'prompt-polish: Prompt sent as typed' what does it mean?"
    expect(acceptRewrite(typed, 'I saw a pop up often: \u201cprompt-polish: Prompt sent as typed\u201d. What does it mean?')).toBe(true)
  })
})

describe('gated polishing', () => {
  test('leaves a neutral prompt untouched without asking for a rewrite', async ($, on) => {
    const seen = sent(on)
    const { asked } = model(on, { tone: 'neutral', rewrites: [NICE] })
    await $.prompt.submit({ text: CALM, asUser: true })
    expect(seen).toEqual([CALM])
    expect(asked.length).toBe(0)
  })

  test('softens a harsh prompt', async ($, on) => {
    const seen = sent(on)
    model(on, { tone: 'harsh', rewrites: [NICE] })
    await $.prompt.submit({ text: RUDE, asUser: true })
    expect(seen).toEqual([NICE])
  })

  test('retries once naming the words, then sends as typed', async ($, on) => {
    const seen = sent(on)
    const { asked } = model(on, { tone: 'harsh', rewrites: ['Could you please fix the main file?', 'Please fix the main file now.'] })
    await $.prompt.submit({ text: RUDE, asUser: true })
    expect(seen).toEqual([RUDE])
    expect(asked.length).toBe(1)
  })

  test('retries a remark without the added thanks', async ($, on) => {
    const seen = sent(on)
    const { asked } = model(on, { tone: 'harsh', rewrites: ["We've over corrected again. Thanks.", "We've over corrected again."] })
    await $.prompt.submit({ text: REMARK, asUser: true })
    expect(seen).toEqual(["We've over corrected again."])
    expect(asked.length).toBe(2)
    expect(asked[1]).toContain('do not add these words: thanks')
  })

  test('retries a synonym swap with the words to keep', async ($, on) => {
    const seen = sent(on)
    const typed = "keep 'box type' in the unexpanded view, this is garbage"
    const kept = "Please keep 'box type' in the unexpanded view."
    const { asked } = model(on, { tone: 'harsh', rewrites: ["Please keep 'box type' in the collapsed view.", kept] })
    await $.prompt.submit({ text: typed, asUser: true })
    expect(seen).toEqual([kept])
    expect(asked[1]).toContain('unexpanded')
    expect(asked[1]).toContain('collapsed')
  })

  test('falls through to the guarded rewrite when the classifier fails', async ($, on) => {
    const seen = sent(on)
    const { asked } = model(on, { tone: 'fail', rewrites: [NICE] })
    await $.prompt.submit({ text: RUDE, asUser: true })
    expect(seen).toEqual([NICE])
    expect(asked.length).toBe(1)
  })

  test('sends as typed when the model is unavailable', async ($, on) => {
    const seen = sent(on)
    on('model.classify', () => ({ value: LABELS.harsh }))
    on('model.complete', () => ({ value: { isAnswered: false, reason: 'aborted', usage } }))
    await $.prompt.submit({ text: RUDE, asUser: true })
    expect(seen).toEqual([RUDE])
  })

  test('strips the bypass prefix and skips the model', async ($, on) => {
    const seen = sent(on)
    const { asked, clarified } = model(on, { tone: 'harsh', rewrites: [NICE], clarity: QUESTION })
    await $.prompt.submit({ text: '\\ ' + RUDE, asUser: true })
    expect(seen).toEqual([RUDE])
    expect(asked.length).toBe(0)
    expect(clarified.length).toBe(0)
  })
})

describe('praise', () => {
  test('underlines praise without rewriting it', async ($, on) => {
    const seen = sent(on)
    const { asked } = model(on, { tone: 'praise', rewrites: [NICE] })
    await $.prompt.submit({ text: KIND, asUser: true })
    expect(seen).toEqual([`${KIND}\n\n${PRAISE_NOTE}`])
    expect(asked.length).toBe(0)
  })

  test('a two-word thank-you reaches the classifier', async ($, on) => {
    const seen = sent(on)
    model(on, { tone: 'praise', rewrites: [] })
    await $.prompt.submit({ text: 'nice work', asUser: true })
    expect(seen).toEqual([`nice work\n\n${PRAISE_NOTE}`])
  })

  test('a courteous request the classifier calls neutral is not underlined', async ($, on) => {
    const seen = sent(on)
    model(on, { tone: 'neutral', rewrites: [] })
    await $.prompt.submit({ text: CALM + ', thanks', asUser: true })
    expect(seen).toEqual([CALM + ', thanks'])
  })
})

describe('clarity', () => {
  test('asks the model to check every polished prompt for missing details', async ($, on) => {
    sent(on)
    const { clarified } = model(on, { tone: 'neutral', rewrites: [] })
    await $.prompt.submit({ text: CALM, asUser: true })
    await $.prompt.submit({ text: 'go on', asUser: true })
    expect(clarified.length).toBe(1)
    expect(clarified[0]).toContain(CALM)
    expect(clarified[0]).not.toContain('<conversation>')
  })

  test('skips the clarity check when the prompt carries an attachment', async ($, on) => {
    const seen = sent(on)
    const { clarified } = model(on, { tone: 'neutral', rewrites: [], clarity: QUESTION })
    await $.prompt.submit({ text: VAGUE, asUser: true, attachments: [{ type: 'image', mediaType: 'image/png' }] } as never)
    expect(seen).toEqual([VAGUE])
    expect(clarified.length).toBe(0)
  })

  test('builds the conversation block from recent turns', () => {
    const long = 'word '.repeat(200).trim()
    const turns = [
      { role: 'user' as const, text: 'rebuild the overlay', toolUses: [] },
      { role: 'assistant' as const, text: '', toolUses: [{ tool: 'Bash' }, { tool: 'Read' }, { tool: 'Bash' }] },
      { role: 'assistant' as const, text: long, toolUses: [] },
      { role: 'user' as const, text: 'why is this build taking so long?', toolUses: [] },
    ]
    const block = contextBlock(turns, 'why is this build taking so long?')
    expect(block.startsWith('<conversation>\n')).toBe(true)
    expect(block).toContain('user: rebuild the overlay')
    expect(block).toContain('assistant: [used Bash, Read]')
    expect(block).toContain(`${long.slice(0, 500)} ...`)
    expect(block).not.toContain('why is this build taking so long?')
    expect(contextBlock([], CALM)).toBe('')
    expect(contextBlock(turns.map((t, i) => ({ ...t, text: `turn ${i}` })).concat(Array.from({ length: 10 }, (_, i) => ({ role: 'user' as const, text: `late ${i}`, toolUses: [] }))), CALM)).not.toContain('turn 0')
  })

  test('shows the clarity check the recent conversation', async ($, on) => {
    sent(on)
    on('session.messages', () => ({
      value: [
        { role: 'user', text: 'rebuild the overlay and recapture', toolUses: [] },
        { role: 'assistant', text: 'Rebuilding now.', toolUses: [{ tool_use_id: '1', tool: 'Bash', input: {} }] },
      ],
    }))
    const { clarified } = model(on, { tone: 'neutral', rewrites: [] })
    await $.prompt.submit({ text: 'whats wrong, why is this build taking so long?', asUser: true })
    const prompt = clarified[0] ?? ''
    expect(prompt.indexOf('<conversation>')).toBe(0)
    expect(prompt).toContain('user: rebuild the overlay and recapture')
    expect(prompt).toContain('assistant: Rebuilding now.')
    expect(prompt.indexOf('</conversation>')).toBeLessThan(prompt.indexOf('<message>'))
  })

  test('injects the question for an underspecified request', async ($, on) => {
    const seen = sent(on)
    model(on, { tone: 'neutral', rewrites: [], clarity: QUESTION })
    await $.prompt.submit({ text: VAGUE, asUser: true })
    expect(seen).toEqual([`${VAGUE}\n\n${clarifyNote(QUESTION)}`])
    expect(seen[0]).toContain('AskUserQuestion')
  })

  test('sends as typed when the reply is not a one-line question', async ($, on) => {
    const seen = sent(on)
    model(on, { tone: 'neutral', rewrites: [], clarity: 'The request is missing the dialog name.' })
    await $.prompt.submit({ text: VAGUE, asUser: true })
    expect(seen).toEqual([VAGUE])
  })

  test('sends as typed when the clarity check is unavailable', async ($, on) => {
    const seen = sent(on)
    on('model.classify', () => ({ value: LABELS.neutral }))
    on('model.complete', () => ({ value: { isAnswered: false, reason: 'aborted', usage } }))
    await $.prompt.submit({ text: VAGUE, asUser: true })
    expect(seen).toEqual([VAGUE])
  })

  test('a softened prompt still gets its question', async ($, on) => {
    const seen = sent(on)
    model(on, { tone: 'harsh', rewrites: [NICE], clarity: QUESTION })
    await $.prompt.submit({ text: RUDE, asUser: true })
    expect(seen).toEqual([`${NICE}\n\n${clarifyNote(QUESTION)}`])
  })
})

describe('system prompt', () => {
  test('adds the tone section after the engine sections', async ($, on) => {
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'engine', scope: 'shared' as const }] }))
    const { sections } = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['desktop'], tools: [], outputStyle: { name: 'default', isKeepingCodingInstructions: true }, traits: [] } as never)
    expect(sections.map(s => s.id)).toEqual(['intro', 'prompt-polish:tone'])
    expect(sections[1].scope).toBe('session')
  })
})

describe('modes', () => {
  test('framing is appended as its own paragraph', () => {
    expect(applyMode('standard', CALM)).toBe(CALM)
    expect(applyMode('careful', CALM)).toBe(`${CALM}\n\n${MODES.careful.framing}`)
    expect(applyMode('supportive', CALM + '\n')).toBe(`${CALM}\n\n${MODES.supportive.framing}`)
  })

  test('/polish reports the mode and rejects unknown ones', async ($, on) => {
    await started($, on)
    expect((await command($, '')).text).toContain('standard mode')
    expect((await command($, 'bold')).text).toContain('Unknown mode "bold"')
    expect((await command($, 'careful')).text).toContain('careful mode')
    expect((await command($, 'careful')).text).toContain('already')
  })

  for (const which of ['supportive', 'careful'] as const) {
    test(`${which} mode frames a neutral prompt and a short one`, async ($, on) => {
      const seen = sent(on)
      model(on, { tone: 'neutral', rewrites: [] })
      await started($, on)
      await command($, which)
      await $.prompt.submit({ text: CALM, asUser: true })
      await $.prompt.submit({ text: 'go on', asUser: true })
      expect(seen).toEqual([applyMode(which, CALM), applyMode(which, 'go on')])
    })
  }

  test('careful mode softens a harsh prompt and then frames it', async ($, on) => {
    const seen = sent(on)
    model(on, { tone: 'harsh', rewrites: [NICE] })
    await started($, on)
    await command($, 'careful')
    await $.prompt.submit({ text: RUDE, asUser: true })
    expect(seen).toEqual([applyMode('careful', NICE)])
  })

  test('praise, the question and the framing follow the prompt in that order', async ($, on) => {
    const seen = sent(on)
    model(on, { tone: 'praise', rewrites: [], clarity: QUESTION })
    await started($, on)
    await command($, 'supportive')
    await $.prompt.submit({ text: KIND, asUser: true })
    expect(seen).toEqual([[KIND, PRAISE_NOTE, clarifyNote(QUESTION), MODES.supportive.framing].join('\n\n')])
    expect(applyMode('standard', CALM, [PRAISE_NOTE])).toBe(`${CALM}\n\n${PRAISE_NOTE}`)
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`the band shows the mode and its button returns to standard on ${surface}`, async ($, on) => {
      on('ui.render', ($, e) => {
        const { Text } = $.ui.resolve(e)
        return h(Text, null, 'engine band')
      })
      await started($, on)
      const props = { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 80, scroll: { offset: 0, bodyRows: 4 } }
      const quiet = await $.ui.mount({ plugin: 'prompt-polish', surface, component: 'AbovePrompt', props })
      expect(await quiet.find({ type: 'Text', text: /mode/ })).toBeFalsy()

      await command($, 'supportive')
      const band = await $.ui.mount({ plugin: 'prompt-polish', surface, component: 'AbovePrompt', props })
      expect(await band.find({ type: 'Text', text: /supportive mode/ })).toBeTruthy()
      await band.press({ key: 'polish-standard' })
      expect((await command($, 'status')).text).toContain('standard mode')
    })
  }
})

describe('rewrites kept across sessions', () => {
  test('a polished prompt is written to the store', async ($, on) => {
    const written: unknown[] = []
    on('store.set', ($, e) => {
      written.push(e.value)
      return { value: undefined }
    })
    model(on, { tone: 'harsh', rewrites: [NICE] })
    on('prompt.submit', ($, e) => ({ text: e.text }))
    await $.prompt.submit({ text: RUDE, asUser: true })
    expect(written).toEqual([{ [RUDE]: NICE }])
  })

  test('a row from an earlier session gets its button back from the store', async ($, on) => {
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return h(Text, null, 'engine row')
    })
    await started($, on, { [RUDE]: NICE })
    const row = await $.ui.mount({
      plugin: 'prompt-polish',
      surface: 'desktop',
      component: 'UserMessage',
      props: { text: NICE, origin: { kind: 'composer' }, isExpanded: true },
    })
    await row.press({ key: rowKey(RUDE) })
    expect(await row.find({ type: 'Text', text: NICE })).toBeTruthy()
  })
})

describe('transcript row', () => {
  for (const surface of ['terminal', 'desktop'] as const)
  for (const shown of [RUDE, NICE]) {
    test(`shows the engine row with a toggle for the rewrite on ${surface}, row ${shown === RUDE ? 'typed' : 'polished'}`, async ($, on) => {
      on('ui.render', ($, e) => {
        const { Text } = $.ui.resolve(e)
        return h(Text, null, 'engine row with screenshots')
      })
      model(on, { tone: 'harsh', rewrites: [NICE] })
      on('prompt.submit', ($, e) => ({ text: e.text }))
      await $.prompt.submit({ text: RUDE, asUser: true })

      const row = await $.ui.mount({
        plugin: 'prompt-polish',
        surface,
        component: 'UserMessage',
        props: { text: shown, origin: { kind: 'composer' }, isExpanded: true },
      })
      expect(await row.find({ type: 'Text', text: 'engine row with screenshots' })).toBeTruthy()
      expect(await row.find({ type: 'Text', text: NICE })).toBeFalsy()
      await row.press({ key: rowKey(RUDE) })
      expect(await row.find({ type: 'Text', text: NICE })).toBeTruthy()
      expect(await row.find({ type: 'Text', text: 'engine row with screenshots' })).toBeTruthy()
      await row.press({ key: rowKey(RUDE) })
      expect(await row.find({ type: 'Text', text: NICE })).toBeFalsy()
    })
  }
})
