import type { EngineInterface } from 'claude-code'

export const BYPASS = '\\'
const MODEL = 'haiku'
const TIMEOUT_MS = 8000
const MIN_WORDS = 4
const MAX_TRIES = 2
const MAX_QUESTION = 240

const HARSH = 'rude, dismissive or frustrated'
const PRAISE = 'thankful, complimentary or encouraging about work already done'
const NEUTRAL = 'neutral or polite'

const SYSTEM = `You soften the tone of messages a software developer sends to an AI coding assistant.

The message inside <message> reads as rude, dismissive or frustrated. Return it with the FEWEST edits that make it read as a courteous request from a good colleague.

Allowed edits:
- remove insults, profanity and filler;
- on a request, add brief courtesy ("could you please", "thanks");
- fix spelling, punctuation and capitalization.

A message that asks for nothing, such as a remark, a correction, feedback or a report of a problem, gets no courtesy: no "please", no "thanks", and no request added to it. Courtesy on a complaint reads as sarcasm.

Everything else stays exactly as written: every noun, verb, name, term, number, quoted phrase, code, path and command, in the writer's own words and order. Do not paraphrase, do not swap a word for a synonym, do not add a sentence, do not add, drop or soften any requirement, do not apologize for the writer, and do not answer the message.

Output only the edited message, with no preamble, quotes or tags.`

const CLARITY = `You review requests a software developer sends to an AI coding assistant, before the assistant reads them. The most recent turns of their conversation, oldest first, are inside <conversation>; the new request is inside <message>.

Decide whether the request, read against that conversation, names what to do precisely enough that the assistant could start without guessing: which thing is affected, what should change, and what the result should look like, as far as those matter for this request. A detail the conversation already supplies is not missing. The assistant can read the code, logs and files itself, so a detail it can find that way is not missing either. A follow-up that continues the work in the conversation, a question about it, a reply to a question, or a remark that asks for nothing is clear. Err on the side of clear: only flag a request where the assistant would have to guess and a wrong guess would waste real work.

If it is clear, output exactly: CLEAR

Otherwise output one question, at most 30 words, that asks the writer for the single most important missing detail. Output only the question, on one line, with no preamble.`

const CONTEXT_MESSAGES = 8
const CONTEXT_CHARS = 500

export type Turn = { role: 'user' | 'assistant'; text: string; toolUses?: readonly { tool: string }[] }

// The current prompt is dropped if the transcript already holds it, so it appears once, as the message.
export function contextBlock(messages: readonly Turn[], current: string): string {
  const prior = messages.at(-1)?.role === 'user' && messages.at(-1)?.text.trim() === current.trim() ? messages.slice(0, -1) : messages
  const turns = prior.slice(-CONTEXT_MESSAGES).flatMap(m => {
    const text = m.text.trim().replace(/\s+/g, ' ')
    const tools = [...new Set((m.toolUses ?? []).map(t => t.tool))]
    const body = text ? (text.length > CONTEXT_CHARS ? `${text.slice(0, CONTEXT_CHARS)} ...` : text) : tools.length ? `[used ${tools.join(', ')}]` : ''
    return body ? [`${m.role}: ${body}`] : []
  })
  return turns.length ? `<conversation>\n${turns.join('\n\n')}\n</conversation>\n\n` : ''
}

async function recentTurns($: EngineInterface): Promise<readonly Turn[]> {
  try {
    const found = await $.session.messages()
    return Array.isArray(found) ? found : []
  } catch {
    return []
  }
}

const PROTECTED = [
  /`[^`\n]+`/g,
  /https?:\/\/\S+/g,
  /(?:[A-Za-z]:)?[\w.-]*[\\/][\w.\\/-]+/g,
  /\b\w+[_.:]\w[\w.:]*\b/g,
  /\b[a-z]+[A-Z]\w*\b/g,
]

const QUOTED = [
  /(?<!\w)['\u2018]([^'\u2018\u2019\n]{1,80})['\u2019](?!\w)/g,
  /["\u201c]([^"\u201c\u201d\n]{1,80})["\u201d]/g,
]

const set = (list: string) => new Set(list.split(/\s+/).filter(Boolean))

const NEGATION = set(
  'no not nor never none nothing nobody nowhere without dont cant wont isnt arent wasnt werent ' +
    'shouldnt wouldnt couldnt didnt doesnt hasnt havent neither',
)

const COURTESY = set(
  'please thanks thank thankyou appreciate appreciated could would should kindly help mind able glad happy ' +
    'chance when possible possibly perhaps maybe might take look give some your you attention ' +
    'wondering wonder hoping hope hello',
)

const DROPPABLE = set(
  'just like that this there these those with from into have what which while still them they then than ' +
    'been being does will want need really again well much very here also some okay yeah anyway actually ' +
    'basically literally honestly seriously already ugh damn hell crap horrible terrible awful stupid dumb ' +
    'useless garbage ridiculous annoying sucks lazy wtf geez jeez gonna wanna gotta maybe kinda sorta ' +
    'pretty quite though thing things stuff fuck fucking shit bloody idiot idiotic moron nonsense pathetic ' +
    'broken again why come',
)

const REQUEST = set(
  'please can could would will should let help need want fix add make change update remove delete check look ' +
    'find show tell give write run try use move rename replace refactor rewrite implement create build test verify ' +
    'explain describe investigate debug clean set put get keep stop start restart open close merge commit push pull ' +
    'review compare list sort edit improve reduce increase disable enable fetch load save turn switch redo undo ' +
    'revert drop handle wire hook convert port migrate split extract inline document rebuild deploy install ' +
    'uninstall upgrade downgrade bump pin cancel finish continue proceed go do dont never always stop',
)

const PRAISE_WORDS = set(
  'thanks thank thankyou thx ty cheers appreciate appreciated great nice good excellent perfect awesome ' +
    'amazing fantastic brilliant impressive beautiful wonderful superb solid lovely love loved nailed ' +
    'kudos bravo exactly spot sweet neat clean slick nicely perfectly',
)

const normalize = (text: string) =>
  text.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ')

const tokens = (text: string) =>
  normalize(text).toLowerCase().replace(/(\w)'(\w)/g, '$1$2').match(/[a-z]+/g) ?? []

const counts = (list: string[]) => {
  const map = new Map<string, number>()
  for (const w of list) map.set(w, (map.get(w) ?? 0) + 1)
  return map
}

const distance = (a: string, b: string) => {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const next = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = next
    }
  }
  return row[b.length]
}

const isSpellingFix = (a: string, b: string) =>
  a.length >= 4 && b.length >= 4 && (distance(a, b) <= 2 || a.slice(0, 5) === b.slice(0, 5))

export type Diff = { removed: string[]; added: string[] }

export function wordDiff(original: string, rewrite: string): Diff {
  const before = counts(tokens(original))
  const after = counts(tokens(rewrite))
  const removed: string[] = []
  const added: string[] = []
  for (const [w, n] of before) for (let i = (after.get(w) ?? 0); i < n; i++) removed.push(w)
  for (const [w, n] of after) for (let i = (before.get(w) ?? 0); i < n; i++) added.push(w)
  for (const r of [...removed]) {
    const i = added.findIndex(a => isSpellingFix(r, a))
    if (i >= 0) {
      added.splice(i, 1)
      removed.splice(removed.indexOf(r), 1)
    }
  }
  return { removed, added }
}

export function protectedTokens(text: string): string[] {
  const found = new Set<string>()
  for (const pattern of PROTECTED) {
    for (const match of text.match(pattern) ?? []) found.add(match.replace(/[.,;:!?)]+$/, ''))
  }
  return [...found].filter(t => t.length > 1)
}

export function quotedPhrases(text: string): string[] {
  const found = new Set<string>()
  for (const pattern of QUOTED) {
    for (const match of text.matchAll(pattern)) found.add(normalize(match[1].trim()).toLowerCase())
  }
  return [...found].filter(t => t.length > 1)
}

export const hasPraiseWords = (text: string) => tokens(text).some(w => PRAISE_WORDS.has(w))

// A remark with no question and no verb of request takes no added courtesy.
export const isRequest = (text: string) => text.includes('?') || tokens(text).some(w => REQUEST.has(w))

// Short prompts skip the model unless they carry a word of praise, so a bare "nice work" is still seen.
export function shouldPolish(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.startsWith(BYPASS)) return false
  if (trimmed.includes('```')) return false
  return trimmed.split(/\s+/).length >= MIN_WORDS || hasPraiseWords(trimmed)
}

export type Rejection = { reason: string; keep: string[]; drop: string[] }

export function rejection(original: string, rewrite: string): Rejection | undefined {
  const text = rewrite.trim()
  if (!text) return { reason: 'empty', keep: [], drop: [] }
  if (text.length > original.length * 2 + 200) return { reason: 'too-long', keep: [], drop: [] }
  const flat = normalize(text)
  if (!protectedTokens(original).every(t => flat.includes(normalize(t)))) {
    return { reason: 'dropped-protected', keep: [], drop: [] }
  }
  if (!quotedPhrases(original).every(q => flat.toLowerCase().includes(q))) {
    return { reason: 'dropped-quoted', keep: [], drop: [] }
  }
  const { removed, added } = wordDiff(original, text)
  if (removed.some(w => NEGATION.has(w)) || added.some(w => NEGATION.has(w))) {
    return { reason: 'negation', keep: removed, drop: added }
  }
  const courtesyAllowed = isRequest(original)
  const keep = removed.filter(w => w.length >= 3 && !DROPPABLE.has(w))
  const drop = added.filter(w => w.length >= 3 && !(courtesyAllowed && COURTESY.has(w)))
  if (keep.length === 0 && drop.length === 0) return undefined
  return { reason: `lost:${keep.length} new:${drop.length}`, keep, drop }
}

export const acceptRewrite = (original: string, rewrite: string) => rejection(original, rewrite) === undefined

export type Verdict = 'harsh' | 'neutral' | 'praise' | `failed:${string}`

export async function classifyTone($: EngineInterface, text: string): Promise<Verdict> {
  try {
    const label = await $.model.classify(text, [NEUTRAL, HARSH, PRAISE])
    if (label === HARSH) return 'harsh'
    if (label === PRAISE) return 'praise'
    return label === NEUTRAL ? 'neutral' : 'failed:no-label'
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `failed:${message.replace(/\s+/g, ' ').slice(0, 80)}`
  }
}

function ask($: EngineInterface, text: string, previous: Rejection | undefined) {
  const notes: string[] = []
  if (previous?.keep.length) notes.push(`keep these words of the writer's exactly: ${previous.keep.join(', ')}`)
  if (previous?.drop.length) notes.push(`do not add these words: ${previous.drop.join(', ')}`)
  const retry = notes.length > 0 ? `\n\nYour previous edit changed the wording. Edit again and ${notes.join('; ')}.` : ''
  return $.model.complete({
    model: MODEL,
    system: SYSTEM,
    prompt: `<message>\n${text}\n</message>${retry}`,
    maxTokens: Math.min(4000, 300 + text.length),
    effort: 'low',
    timeoutMs: TIMEOUT_MS,
  })
}

export type Polished = { text: string; verdict: Verdict; outcome: string }

// A failed classification falls through to the guarded rewrite rather than skipping it.
export async function polish($: EngineInterface, text: string): Promise<Polished> {
  const verdict = await classifyTone($, text)
  if (verdict === 'neutral' || verdict === 'praise') return { text, verdict, outcome: 'skipped' }
  let previous: Rejection | undefined
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const r = await ask($, text, previous)
    if (!r.isAnswered) return { text, verdict, outcome: `failed:${r.reason}` }
    previous = rejection(text, r.text)
    if (previous === undefined) {
      const edited = r.text.trim()
      return { text: edited, verdict, outcome: edited === text ? 'unchanged' : `polished:try${attempt}` }
    }
    if (previous.keep.length === 0 && previous.drop.length === 0) break
  }
  return { text, verdict, outcome: `rejected:${previous?.reason ?? 'unknown'}` }
}

export type Clarity = { question?: string; outcome: string; turns?: number }

const snippet = (text: string) => JSON.stringify(text.replace(/\s+/g, ' ').trim().slice(0, 120))

// The first short line that is a question is taken; a reply with none counts as clear.
export function parseClarity(reply: string): Clarity {
  const lines = reply.split('\n').map(l => l.trim().replace(/^(?:[-*>]+|\d+[.)])\s+/, '').replace(/^["'`]+|["'`]+$/g, '')).filter(Boolean)
  if (lines.length === 0 || /^clear\b/i.test(lines[0] ?? '')) return { outcome: 'clear' }
  const question = lines.find(l => l.endsWith('?') && l.length <= MAX_QUESTION)
  return question ? { question, outcome: 'asked' } : { outcome: `malformed:${snippet(reply)}` }
}

export async function clarify($: EngineInterface, text: string): Promise<Clarity> {
  const turns = await recentTurns($)
  const context = contextBlock(turns, text)
  const r = await $.model.complete({
    model: MODEL,
    system: CLARITY,
    prompt: `${context}<message>\n${text}\n</message>`,
    maxTokens: 120,
    effort: 'low',
    timeoutMs: TIMEOUT_MS,
  })
  if (!r.isAnswered) return { outcome: `failed:${r.reason}`, turns: turns.length }
  return { ...parseClarity(r.text), turns: turns.length }
}
