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
      expect(await ui.find({ type: 'Text', text: 'Clearance' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('draws the marshaller where the surface has Svg', async ($, on) => {
    on('ui.render', () => ({ type: 'engine', ref: 'AbovePrompt' }) as never)
    const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
    // The kit's `find` doesn't index Svg leaves; the drawn tree has it.
    expect(JSON.stringify(await desktop.drawn())).toContain('"type":"Svg"')
    await desktop.unmount()
    const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await terminal.find({ type: 'Text', text: '·' })).toBeDefined()
    await terminal.unmount()
  })

  test('yields to a survey', async ($, on) => {
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>survey</Text>
    })
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop', props: { hasSurvey: true, isWorking: false, maxRows: 10, bodyColumns: 120 } as never })
    expect(await ui.find({ type: 'Text', text: 'Clearance' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('footer chip', () => {
  test('keeps the mode labels, adds the marshaller and the live line on the desktop, passes on the terminal', async ($, on) => {
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine modes</Text>
    })
    const props = { modes: ['focus'] } as never
    const desktop = await $.ui.mount({ plugin: 'clearance', component: 'SessionMode', surface: 'desktop', props })
    const drawn = JSON.stringify(await desktop.drawn())
    expect(drawn).toContain('"type":"Svg"')
    expect(drawn).toContain('focus')
    expect(drawn).toContain('waiting for a snapshot')
    await desktop.unmount()
    const terminal = await $.ui.mount({ plugin: 'clearance', component: 'SessionMode', surface: 'terminal', props })
    expect(await terminal.find({ type: 'Text', text: 'engine modes' })).toBeDefined()
    await terminal.unmount()
  })
})
