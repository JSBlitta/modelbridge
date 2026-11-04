// Every PascalCase tag in a .vue template must be imported by that file or
// registered in main.js. Vue renders an unresolved one as an empty unknown
// element with only a console warning: that is how the Import page lost its
// create button when f41eda2 dropped `import ConfirmedButton`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const SRC = new URL('.', import.meta.url).pathname
const BUILTIN = new Set(['Transition', 'TransitionGroup', 'KeepAlive', 'Teleport', 'Suspense', 'Component', 'RouterView', 'RouterLink'])

const global = new Set([...readFileSync(join(SRC, 'main.js'), 'utf8').matchAll(/app\.component\('(\w+)'/g)].map(m => m[1]))

function vueFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? vueFiles(join(dir, e.name)) : e.name.endsWith('.vue') ? [join(dir, e.name)] : [])
}

test('every component used in a template is imported or globally registered', () => {
  const problems = []
  for (const file of vueFiles(SRC)) {
    const src = readFileSync(file, 'utf8')
    const template = src.slice(0, src.lastIndexOf('</template>'))
    const imported = new Set([...src.matchAll(/^import\s+(\w+)\s+from/gm)].map(m => m[1]))
    for (const [, tag] of template.matchAll(/<([A-Z]\w*)/g)) {
      if (!imported.has(tag) && !global.has(tag) && !BUILTIN.has(tag)) problems.push(`${file.slice(SRC.length)}: <${tag}>`)
    }
  }
  assert.deepEqual([...new Set(problems)], [])
})
