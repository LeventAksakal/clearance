import { describe, expect, test } from 'claude-code/testing'

// The test engine has no `$.state`, so the band draws the WAITING badge here;
// the CLEARED and HOLD lines are covered in badge.test.ts and checked live.

const BAND = {
  plugin: 'clearance',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 } as never,
} as const

describe('badge band', () => {
  test('is always up, and keeps a band drawn beneath it', async ($, on) => {
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine band</Text>
    })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: '● clearance' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('draws the marshaller where the surface has Svg', async ($, on) => {
    on('ui.render', () => ({ type: 'engine', ref: 'AbovePrompt' }) as never)
    const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
    // The kit's `find` doesn't index Svg leaves; the drawn tree has it. An
    // image, not an interactive frame: a rebuilt frame blanks on every redraw.
    const drawn = JSON.stringify(await desktop.drawn())
    expect(drawn).toContain('"type":"Svg"')
    expect(drawn).not.toContain('isInteractive')
    await desktop.unmount()
    const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await terminal.find({ type: 'Text', text: '●' })).toBeDefined()
    await terminal.unmount()
  })

  test('yields to a survey', async ($, on) => {
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>survey</Text>
    })
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop', props: { hasSurvey: true, isWorking: false, maxRows: 10, bodyColumns: 120 } as never })
    expect(await ui.find({ type: 'Text', text: '● clearance' })).toBeUndefined()
    await ui.unmount()
  })
})
