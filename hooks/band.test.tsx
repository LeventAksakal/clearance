import { describe, expect, test } from 'claude-code/testing'

// The test engine has no `$.state`, so the HOLD drawing is checked live; this
// covers the band staying out of the way, on both surfaces.

const BAND = {
  plugin: 'clearance',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 } as never,
} as const

describe('HOLD band', () => {
  test('stays out of the way while cleared', async ($, on) => {
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine band</Text>
    })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: /clearance HOLD/ })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
      await ui.unmount()
    }
  })
})
