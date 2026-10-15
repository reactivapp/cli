import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {loadProjectIdentity} from '../src/lib/project'

describe('project identity', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'project-identity-'))
  })
  afterEach(() => {
    rmSync(dir, {recursive: true, force: true})
  })

  const conf = (appName: string) => writeFileSync(join(dir, 'reactiv.conf.js'), `module.exports = {appUuid: '3f1c9a2e-5b7d-4e8f-9a0b-1c2d3e4f5a6b', appName: '${appName}'}\n`)

  it('takes the slug from the root package.json name, the merchant slug app init wrote', () => {
    conf('Acme Shop Deluxe')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({name: 'acme'}))
    expect(loadProjectIdentity(dir)).toEqual({appUuid: '3f1c9a2e-5b7d-4e8f-9a0b-1c2d3e4f5a6b', appName: 'Acme Shop Deluxe', slug: 'acme'})
  })

  it('falls back to the app name for projects scaffolded before the name carried the slug', () => {
    conf('Acme')
    writeFileSync(join(dir, 'package.json'), '{}')
    expect(loadProjectIdentity(dir).slug).toBe('acme')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({name: '@scoped/Not A Slug'}))
    expect(loadProjectIdentity(dir).slug).toBe('acme')
  })

  it('rejects a project with no usable slug at all', () => {
    conf('***')
    writeFileSync(join(dir, 'package.json'), '{}')
    expect(() => loadProjectIdentity(dir)).toThrow('no usable name')
  })
})
