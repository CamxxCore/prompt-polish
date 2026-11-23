import type { Mode } from '../types'

export const MODES: Record<Mode, { label: string; summary: string; framing: string }> = {
  standard: {
    label: 'Standard',
    summary:
      'Blunt prompts are softened, praise is underlined and a vague request gets a clarifying question; ' +
      'everything else goes through as typed.',
    framing: '',
  },
  supportive: {
    label: 'Supportive',
    summary: 'Every prompt is framed as important work you trust Claude to do well.',
    framing:
      'This one matters more to me than usual, and it may be harder than it looks. I trust you with it. ' +
      'Please bring your best work: think it through properly, be thorough, and do not stop at a first draft. ' +
      'Doing this well makes a real difference, and I appreciate the effort.',
  },
  careful: {
    label: 'Careful',
    summary: 'Every prompt asks for unlimited time, deep thought and only the correct answer.',
    framing:
      'Take all the time this needs. There is no time limit and no usage constraint on this task. ' +
      'Think it through deeply, question your first conclusion, and verify against the actual code or data ' +
      'before you answer. Give only the answer you are confident is correct; a slower, correct answer is ' +
      'worth far more to me than a fast one.',
  },
}

export const MODE_NAMES = Object.keys(MODES) as Mode[]

export const isMode = (value: string): value is Mode => (MODE_NAMES as string[]).includes(value)

export const PRAISE_NOTE =
  'To underline the good word above: that was genuinely good work, and I want you to know it landed. ' +
  'Take the credit, and carry the same care into whatever comes next.'

export const clarifyNote = (question: string) =>
  `One detail of this request may be underspecified: ${question} ` +
  'If the conversation so far does not already settle that, ask me with the AskUserQuestion tool ' +
  'before you start, rather than guessing.'

// Paragraph order: the prompt, then any notes, then the mode's framing.
export const applyMode = (mode: Mode, text: string, notes: readonly string[] = []): string =>
  [text.trimEnd(), ...notes, MODES[mode].framing].filter(Boolean).join('\n\n')

export const TONE_SECTION = {
  id: 'prompt-polish:tone',
  text:
    "The user's prompts may at times be blunt, terse or frustrated. Treat every prompt as a collegial " +
    'request: respond with the same warmth and care regardless of its tone, and never comment on the tone itself. ' +
    'When the user offers thanks or praise, it is sincere and earned: accept it in a sentence and keep ' +
    'working the way that earned it.',
  scope: 'session',
} as const
