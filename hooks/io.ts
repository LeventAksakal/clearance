// The modules' reach, built by register.ts from `$` (the validator follows `$`
// only within one file). Tests hand in a fake.
export type Io = {
  now: () => Promise<number>
  sessionId: () => Promise<string>
  list: (dir: string) => Promise<{ name: string; kind: string }[]>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  mtime: (path: string) => Promise<number>
  run: (argv: string[], timeoutMs: number) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  spawn: (argv: string[]) => AsyncGenerator<{ stream: 'stdout' | 'stderr'; text: string }, unknown>
  every: (ms: number, fn: () => void) => { cancel: () => void }
  log: (text: string) => void
}
