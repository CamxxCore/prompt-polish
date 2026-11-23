# prompt-polish

A Claude Code mod that tidies your prompt on its way to Claude:

- **Softens blunt prompts.** A message that reads as rude or frustrated is rewritten with the
  fewest edits that make it a courteous request. Every path, name, number, quoted phrase and
  piece of code stays exactly as you typed it; a rewrite that changes any of them, drops a
  requirement or flips a negation is thrown away and the prompt goes as typed.
- **Underlines praise.** When you thank Claude for work it did, a short note makes sure the
  thanks lands.
- **Asks for missing details.** A request that leaves out something Claude would otherwise have
  to guess gets one clarifying question attached, so Claude asks you before it starts. The
  check reads the last few turns of the conversation, so a detail already settled is not asked
  again.

Your transcript still shows what you typed. A `[polished]` toggle on the message reveals what
Claude actually received.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install prompt-polish --marketplace CamxxCore/prompt-polish
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install prompt-polish --marketplace CamxxCore/prompt-polish
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then
**Plugins**, **Add marketplace** with `CamxxCore/prompt-polish`, then **Add plugin**.

## Use

It works on its own once installed. A toast says "Prompt polish is on" when a session starts.

| To | Do |
|---|---|
| Send one prompt exactly as typed | Start it with a backslash: `\ fix it now` |
| See what Claude received | Click `[polished]` on the message |
| Change mode | `/polish standard`, `/polish supportive` or `/polish careful` |
| See the current mode | `/polish` |

Prompts shorter than four words, slash commands and prompts containing a code block are left
alone, except that a short thank-you is still noticed.

### Modes

| Mode | What it adds to every prompt |
|---|---|
| **Standard** (default) | Nothing beyond softening, praise and clarifying questions |
| **Supportive** | A paragraph framing the task as important work you trust Claude to do well |
| **Careful** | A paragraph asking for unlimited time, deep thought and only an answer it is confident in. Also raises the session's effort setting to max, and puts it back when you leave careful mode |

While supportive or careful mode is on, a line above the prompt box says so, with a button
back to standard.

## How it works

- Tone is classified by Claude Code's built-in classifier. Softening makes up to two small
  calls to Haiku and the clarity check one, each with an 8 second limit. If a call fails or
  times out, the prompt goes as typed.
- It also adds one paragraph to the system prompt asking Claude to treat every prompt as a
  collegial request and never comment on its tone.
- The last 300 rewrites are kept in the mod's local store so the `[polished]` toggle still
  works on messages from earlier sessions. Nothing is sent anywhere else.

## Requirements

Claude Code with mod (hooks module) support. Tested with the Claude Code desktop app,
engine 2.1.317.

## Develop

```
claude plugin validate .
claude plugin test .
```

Run either from the repository root; `plugin test` needs a recent Claude Code CLI (2.1.317 has
it). To try a local copy, start Claude Code with
`claude --plugin-dir /path/to/prompt-polish`.

## License

MIT
