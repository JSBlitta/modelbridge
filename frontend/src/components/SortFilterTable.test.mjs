import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import PrimeVue from 'primevue/config'
import Aura from '@primevue/themes/aura'

describe('SortFilterTable.vue', () => {
  let server
  let Component

  before(async () => {
    server = await createServer({
      root: new URL('../..', import.meta.url).pathname,
      server: { middlewareMode: true },
      appType: 'custom',
      logLevel: 'error',
    })
    Component = await server.ssrLoadModule('/src/components/SortFilterTable.vue')
  })

  after(async () => {
    await server?.close()
  })

  async function renderTable(props, slots = {}) {
    const vnode = h(Component.default, props, slots)
    const app = createSSRApp(vnode)
    app.use(PrimeVue, {
      theme: { preset: Aura, options: { darkModeSelector: '.dark-mode' } },
    })
    return renderToString(app)
  }

  it('renders headers, values, empty marker and filter inputs', async () => {
    const html = await renderTable({
      rows: [
        { name: 'Alpha', status: null },
        { name: 'Beta', status: 'ok' },
      ],
      columns: [
        { field: 'name', header: 'Name' },
        { field: 'status', header: 'Status', filter: false },
      ],
    })

    assert.match(html, /Name/)
    assert.match(html, /Status/)
    assert.match(html, /Alpha/)
    assert.match(html, /Beta/)
    assert.match(html, /—/)

    // Default column gets a filter input; filter:false column does not.
    const inputMatches = html.match(/<input/g) || []
    assert.equal(inputMatches.length, 1, `expected 1 filter input, found ${inputMatches.length}`)
  })

  it('renders a named slot with custom markup', async () => {
    const html = await renderTable(
      {
        rows: [{ id: 1, label: 'x' }],
        columns: [{ field: 'label', header: 'Label' }],
      },
      {
        label: ({ data }) => `CUSTOM:${data.label}`,
      }
    )

    assert.match(html, /CUSTOM:x/)
  })
})
