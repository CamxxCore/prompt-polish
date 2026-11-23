export type Rewrites = Record<string, string>
export type Revealed = Record<string, boolean>
export type Mode = 'standard' | 'supportive' | 'careful'
export type EffortChange = { key: string; previous: string } | null

declare module 'claude-code' {
  interface PluginState {
    'prompt-polish': { rewrites: Rewrites; revealed: Revealed; mode: Mode; effortChange: EffortChange }
  }
}
