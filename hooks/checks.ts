import type { Io } from './io.ts'
import type { ContainerSample, Snapshot } from './snapshot.ts'

// Step 6: container attribution and the convention checks (design.md §
// Convention checks, 0001). Read-only: they report and suggest a fix and never
// edit project files. Pure except `runChecks`, which reads through `Io`.

const norm = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
const within = (inner: string, outer: string) => inner === outer || inner.startsWith(outer + '\\')

/**
 * Each container to the session whose folder holds its compose working_dir (or
 * sits inside it), the longest folder winning; no label or no match is unattributed.
 */
export const attributeContainers = (s: Snapshot) => {
  const bySession = new Map<string, ContainerSample[]>()
  const unattributed: ContainerSample[] = []
  for (const c of s.containers ?? []) {
    const dir = c.workingDir ? norm(c.workingDir) : undefined
    let best: { id: string; len: number } | undefined
    if (dir)
      for (const r of s.sessions) {
        const cwd = norm(r.cwd)
        if ((within(dir, cwd) || within(cwd, dir)) && (!best || cwd.length > best.len)) best = { id: r.sessionId, len: cwd.length }
      }
    if (best) bySession.set(best.id, [...(bySession.get(best.id) ?? []), c])
    else unattributed.push(c)
  }
  return { bySession, unattributed }
}

export type Finding = { check: string; where: string; detail: string; fix: string }

/** Supabase's `project_id` left as "supabase", or one id in two folders: their stacks collide (container names, ports, volumes). */
export const supabaseFindings = (configs: readonly { dir: string; projectId: string }[]): Finding[] => {
  const out: Finding[] = []
  for (const c of configs)
    if (c.projectId === 'supabase')
      out.push({ check: 'supabase project_id', where: c.dir, detail: 'project_id is the default "supabase"', fix: 'set a unique project_id in supabase/config.toml' })
  const byId = new Map<string, string[]>()
  for (const c of configs) byId.set(c.projectId, [...(byId.get(c.projectId) ?? []), c.dir])
  for (const [id, dirs] of byId)
    if (dirs.length > 1 && id !== 'supabase')
      out.push({ check: 'supabase project_id', where: dirs.join(', '), detail: `project_id "${id}" in ${dirs.length} folders`, fix: 'give each folder its own project_id' })
  return out
}

/** A running compose project with no working_dir label can't be attributed to a session. */
export const unlabeledFindings = (containers: readonly ContainerSample[]): Finding[] => {
  const projects = new Map<string, number>()
  for (const c of containers) if (c.project && !c.workingDir) projects.set(c.project, (projects.get(c.project) ?? 0) + 1)
  return [...projects].map(([project, n]) => ({
    check: 'unattributable stack',
    where: `compose project "${project}"`,
    detail: `${n} running containers without a com.docker.compose.project.working_dir label`,
    fix: 'start it with docker compose from its folder (the Supabase CLI omits the label: run it from the repo so the stack name says whose it is)',
  }))
}

/** `"5432:5432"` in a compose file: a host port fixed in the file, so two worktrees of it can't run at once. */
export const hardPortFindings = (files: readonly { path: string; text: string }[]): Finding[] => {
  const out: Finding[] = []
  for (const f of files) {
    const ports = new Set<string>()
    for (const m of f.text.matchAll(/^\s*-\s*["']?(?:[\d.]+:)?(\d{2,5}):\d{2,5}(?:\/\w+)?["']?\s*$/gm)) ports.add(m[1]!)
    if (ports.size)
      out.push({
        check: 'hard-coded host ports',
        where: f.path,
        detail: `host ports ${[...ports].join(', ')}`,
        fix: 'use env indirection ("${DB_PORT:-5432}:5432") so each worktree can pick its own',
      })
  }
  return out
}

/** Host ports a container publishes, from `docker ps`' Ports column. */
export const hostPorts = (ports: string | undefined) => [...new Set([...(ports ?? '').matchAll(/:(\d+)->/g)].map(m => m[1]!))]

/** Two running containers from different folders or projects on one host port, or one project name from two folders. */
export const collisionFindings = (containers: readonly ContainerSample[]): Finding[] => {
  const out: Finding[] = []
  const byPort = new Map<string, ContainerSample[]>()
  for (const c of containers) for (const p of hostPorts(c.ports)) byPort.set(p, [...(byPort.get(p) ?? []), c])
  for (const [port, cs] of byPort) {
    const owners = new Set(cs.map(c => c.workingDir ?? c.project ?? c.name))
    if (owners.size > 1)
      out.push({ check: 'port collision', where: `host port ${port}`, detail: cs.map(c => c.name).join(', '), fix: 'give one of them another host port' })
  }
  const dirsByProject = new Map<string, Set<string>>()
  for (const c of containers) if (c.project && c.workingDir) dirsByProject.set(c.project, (dirsByProject.get(c.project) ?? new Set()).add(norm(c.workingDir)))
  for (const [project, dirs] of dirsByProject)
    if (dirs.size > 1)
      out.push({ check: 'compose project name', where: `project "${project}"`, detail: `running from ${[...dirs].join(', ')}`, fix: 'set a distinct COMPOSE_PROJECT_NAME per worktree' })
  return out
}

const COMPOSE = /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/i

/** Reads each session folder's supabase/config.toml and compose files (the folder and one level down), then runs every check. */
export const runChecks = async (io: Io, s: Snapshot): Promise<Finding[]> => {
  const dirs = [...new Set(s.sessions.map(r => r.cwd))]
  const configs: { dir: string; projectId: string }[] = []
  const compose: { path: string; text: string }[] = []
  const tryRead = async (path: string) => {
    try {
      return await io.read(path)
    } catch {
      return undefined
    }
  }
  const tryList = async (dir: string) => {
    try {
      return await io.list(dir)
    } catch {
      return []
    }
  }
  for (const dir of dirs) {
    const toml = await tryRead(`${dir}\\supabase\\config.toml`)
    const id = toml && /^\s*project_id\s*=\s*"([^"]*)"/m.exec(toml)?.[1]
    if (id !== undefined && id !== null && toml) configs.push({ dir, projectId: id })
    const top = await tryList(dir)
    const candidates = top.filter(e => e.kind === 'file' && COMPOSE.test(e.name)).map(e => `${dir}\\${e.name}`)
    for (const sub of top.filter(e => e.kind === 'dir' && !e.name.startsWith('.') && e.name !== 'node_modules'))
      for (const e of await tryList(`${dir}\\${sub.name}`)) if (e.kind === 'file' && COMPOSE.test(e.name)) candidates.push(`${dir}\\${sub.name}\\${e.name}`)
    for (const path of candidates) {
      const text = await tryRead(path)
      if (text) compose.push({ path, text })
    }
  }
  const containers = s.containers ?? []
  return [...supabaseFindings(configs), ...unlabeledFindings(containers), ...hardPortFindings(compose), ...collisionFindings(containers)]
}

export const checksReport = (findings: readonly Finding[], containersSeen: boolean) => {
  const lines = ['clearance convention checks (read-only)']
  if (!containersSeen) lines.push('(no container sample yet: Docker isn’t running, or the first docker read is pending)')
  if (findings.length === 0) lines.push('no findings')
  for (const f of findings) lines.push(`- ${f.check}: ${f.where}: ${f.detail}. Fix: ${f.fix}.`)
  return lines.join('\n')
}
