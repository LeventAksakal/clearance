// The shared layout under ~/.claude/clearance (design.md § Shared state).
// Every file there has exactly one writer, so nothing needs a lock.

export type Paths = {
  root: string
  scribe: string
  snapshot: string
  presence: string
  history: string
  /** The paging-pressure histogram (step 7): the scribe's to write. */
  pressure: string
  /** ~/.claude/sessions: the local session registry. Read only the *.json files; the *.key files are secrets. */
  registry: string
}

export const pathsFor = (home: string): Paths => {
  const claude = `${home}\\.claude`
  const root = `${claude}\\clearance`
  return {
    root,
    scribe: `${root}\\scribe`,
    snapshot: `${root}\\snapshot.json`,
    presence: `${root}\\sessions`,
    history: `${root}\\history`,
    pressure: `${root}\\pressure.json`,
    registry: `${claude}\\sessions`,
  }
}

export const epochFile = (p: Paths, n: number) => `${p.scribe}\\epoch-${n}`
export const resignedFile = (p: Paths, n: number) => `${p.scribe}\\resigned-${n}`
export const registryFile = (p: Paths, pid: number) => `${p.registry}\\${pid}.json`
