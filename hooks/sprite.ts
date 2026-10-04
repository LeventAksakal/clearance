// The band's mascot: a pixel marshaller in the traffic-light color of what can
// start: green waves both paddles (a session fits), yellow waves one (only
// subagents fit), red crosses them overhead (nothing fits), grey dozes (no
// snapshot). Twelve frames per mood, drawn as one SVG
// whose SMIL animation flips the frames, so the surface animates it with no
// timer or redraw here. Pure: no `$` here.

export type Mood = 'green' | 'yellow' | 'red' | 'grey' | 'thrash'

export const W = 16
export const H = 13
export const FRAMES = 12

type Pose = 'down' | 'mid' | 'up' | 'high' | 'cross'
type Frame = { left: Pose; right: Pose; bob: 0 | 1; dx: -1 | 0 | 1; blink: boolean; lamp: 'on' | 'dim'; z: number }

/** Colors by role; `p` is the paddles, `l` the lamp lit, `m` the lamp dim. */
const PALETTE: Record<Mood, Record<string, string>> = {
  green: { b: '#4c6ef5', s: '#3b5bdb', e: '#0b1020', p: '#3fb950', l: '#7ee787', m: '#2ea043' },
  yellow: { b: '#4c6ef5', s: '#3b5bdb', e: '#0b1020', p: '#e3b341', l: '#f8d66d', m: '#9e6a03' },
  red: { b: '#4c6ef5', s: '#3b5bdb', e: '#0b1020', p: '#f85149', l: '#ff7b72', m: '#6e2a24' },
  grey: { b: '#64748b', s: '#475569', e: '#0b1020', p: '#94a3b8', l: '#94a3b8', m: '#475569', z: '#cbd5e1' },
  thrash: { b: '#4c6ef5', s: '#3b5bdb', e: '#0b1020', p: '#f85149', l: '#ffffff', m: '#f85149' },
}

/** Milliseconds per frame. */
const PACE: Record<Mood, number> = { green: 110, yellow: 150, red: 120, grey: 220, thrash: 60 }

const seq = <T>(xs: readonly T[]): T[] => {
  if (xs.length !== FRAMES) throw new Error(`a mood needs ${FRAMES} frames, got ${xs.length}`)
  return [...xs]
}

const SCRIPT: Record<Mood, Frame[]> = (() => {
  const cleared = () => {
    const L: Pose[] = seq(['up', 'high', 'up', 'mid', 'down', 'mid', 'up', 'high', 'up', 'mid', 'down', 'mid'])
    const R: Pose[] = seq(['down', 'mid', 'up', 'high', 'up', 'mid', 'down', 'mid', 'up', 'high', 'up', 'mid'])
    const bob = seq([0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0] as const)
    return L.map((left, i): Frame => ({ left, right: R[i]!, bob: bob[i]!, dx: 0, blink: i === 8, lamp: i % 6 < 3 ? 'on' : 'dim', z: -1 }))
  }
  const hold = () => {
    const dx = seq([0, 0, 1, 1, 0, 0, -1, -1, 0, 0, 0, 0] as const)
    return dx.map((d, i): Frame => ({ left: 'cross', right: 'cross', bob: 0, dx: d, blink: i === 10, lamp: i % 4 < 2 ? 'on' : 'dim', z: -1 }))
  }
  const oneArm = () => {
    const L: Pose[] = seq(['up', 'high', 'high', 'up', 'mid', 'mid', 'up', 'high', 'high', 'up', 'mid', 'mid'])
    const bob = seq([0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0] as const)
    return L.map((left, i): Frame => ({ left, right: 'down', bob: bob[i]!, dx: 0, blink: i === 5, lamp: i % 6 < 3 ? 'on' : 'dim', z: -1 }))
  }
  const waiting = () => {
    const bob = seq([0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 1, 1] as const)
    return bob.map((b, i): Frame => ({ left: 'down', right: 'down', bob: b, dx: 0, blink: true, lamp: 'dim', z: i < 8 ? i : -1 }))
  }
  const thrash = () => {
    const dx = seq([0, 1, 0, -1, 0, 1, 0, -1, 0, 1, 0, -1] as const)
    return dx.map((d, i): Frame => ({ left: 'cross', right: 'cross', bob: (i % 2) as 0 | 1, dx: d, blink: false, lamp: i % 2 ? 'on' : 'dim', z: -1 }))
  }
  return { green: cleared(), yellow: oneArm(), red: hold(), grey: waiting(), thrash: thrash() }
})()

/** One frame as rows of palette keys, `.` transparent. */
export const frame = (mood: Mood, i: number): string[] => {
  const f = SCRIPT[mood][i % FRAMES]!
  const g: string[][] = Array.from({ length: H }, () => Array<string>(W).fill('.'))
  const put = (x: number, y: number, c: string) => {
    const X = x + f.dx
    if (X >= 0 && X < W && y >= 0 && y < H) g[y]![X] = c
  }
  const rect = (x0: number, y0: number, x1: number, y1: number, c: string) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) put(x, y, c)
  }
  const b = f.bob

  // Legs reach the ground whatever the bob.
  rect(5, 11 + b, 6, 12, 's')
  rect(9, 11 + b, 10, 12, 's')
  // Body, with a darker belt so it reads as a body at 2 px a pixel.
  rect(4, 5 + b, 11, 10 + b, 'b')
  rect(4, 10 + b, 11, 10 + b, 's')
  // Lamp on the head: the signal.
  rect(7, 3 + b, 8, 4 + b, f.lamp === 'on' ? 'l' : 'm')
  // Eyes: two tall pixels, a line when blinking.
  if (f.blink) {
    put(6, 8 + b, 'e')
    put(9, 8 + b, 'e')
  } else {
    rect(6, 7 + b, 6, 8 + b, 'e')
    rect(9, 7 + b, 9, 8 + b, 'e')
  }

  // Arms, the left one drawn and the right mirrored (x → 15 - x).
  const arm = (pose: Pose, mirror: boolean) => {
    const px = (x: number, y: number, c: string) => put(mirror ? W - 1 - x : x, y + b, c)
    const pr = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) px(x, y, 'p')
    }
    switch (pose) {
      case 'down':
        px(3, 8, 'b'), px(2, 9, 'b'), pr(1, 10, 2, 11)
        break
      case 'mid':
        px(3, 7, 'b'), px(2, 7, 'b'), pr(0, 6, 1, 8)
        break
      case 'up':
        px(3, 6, 'b'), px(2, 5, 'b'), pr(1, 2, 2, 4)
        break
      case 'high':
        px(3, 6, 'b'), px(3, 5, 'b'), px(3, 4, 'b'), pr(2, 0, 3, 3)
        break
      case 'cross':
        // Crossed overhead, the paddles past the middle: the marshaller's stop.
        px(3, 6, 'b'), px(3, 5, 'b'), px(4, 4, 'b'), px(5, 3, 'b'), px(6, 2, 'b'), pr(7, 0, 9, 1)
        break
    }
  }
  arm(f.left, false)
  arm(f.right, true)

  // A rising z while dozing.
  if (f.z >= 0) {
    const y = 4 - Math.floor(f.z / 2)
    put(13, y, 'z'), put(14, y, 'z'), put(14, y - 1, 'z'), put(13, y - 2, 'z'), put(14, y - 2, 'z')
  }
  return g.map(row => row.join(''))
}

/** A frame's pixels as one path per color, a run of a row being one rectangle. */
const paths = (rows: readonly string[], palette: Record<string, string>): string => {
  const byColor = new Map<string, string[]>()
  rows.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      const c = row[x]!
      let n = 1
      while (row[x + n] === c) n++
      if (c !== '.' && palette[c]) {
        const list = byColor.get(c) ?? []
        list.push(`M${x} ${y}h${n}v1h-${n}z`)
        byColor.set(c, list)
      }
      x += n
    }
  })
  return [...byColor].map(([c, d]) => `<path fill="${palette[c]}" d="${d.join('')}"/>`).join('')
}

/** Pixels per sprite pixel on the desktop band: 16 × 13 sprite pixels → 32 × 26 CSS px. */
export const SCALE = 2

/** The mood's twelve frames as one SVG; SMIL shows one frame at a time, looping. */
export const spriteSvg = (mood: Mood, scale = SCALE): string => {
  const palette = PALETTE[mood]
  const dur = `${(PACE[mood] * FRAMES) / 1000}s`
  const groups = Array.from({ length: FRAMES }, (_, i) => {
    const values = Array.from({ length: FRAMES }, (_, j) => (j === i ? 'visible' : 'hidden')).join(';')
    return (
      `<g visibility="${i === 0 ? 'visible' : 'hidden'}">` +
      `<animate attributeName="visibility" values="${values}" dur="${dur}" calcMode="discrete" repeatCount="indefinite"/>` +
      paths(frame(mood, i), palette) +
      `</g>`
    )
  })
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W * scale}" height="${H * scale}" shape-rendering="crispEdges">` +
    groups.join('') +
    `</svg>`
  )
}
