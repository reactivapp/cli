import {Args, Command, Flags} from '@oclif/core'
import {spawn} from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'

import {capture, run} from '../../lib/npm'
import {assertDependenciesInSync, readManifest, resolveLayout, type ProjectLayout} from '../../lib/layout'
import {assertLibraryManifest} from '../../lib/submission'

/** First booted iPhone/iPad simulator UDID, or undefined. */
const bootedSimulatorUdid = (): string | undefined => {
  try {
    const devices = JSON.parse(capture('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'])) as {
      devices: Record<string, Array<{udid: string; state: string}>>
    }
    for (const [runtime, list] of Object.entries(devices.devices)) {
      // A booted watchOS/tvOS simulator must never win — run-ios can't target it.
      if (!runtime.includes('.iOS-')) continue
      const booted = list.find(device => device.state === 'Booted')
      if (booted) return booted.udid
    }
  } catch {
    return undefined
  }
  return undefined
}

/** Whether something already answers on the Metro port. */
const metroPortOccupied = (port: number): Promise<boolean> =>
  new Promise(resolve => {
    const request = http.get({host: '127.0.0.1', port, path: '/status', timeout: 1500}, response => {
      response.resume()
      resolve(true)
    })
    request.on('timeout', () => {
      request.destroy()
      resolve(true) // something is listening, just slow — still occupied
    })
    request.on('error', () => resolve(false))
  })

export class AppRun extends Command {
  static override description = 'Build and run the Reactiv Plus app (pod install + native build + Metro)'

  static override args = {
    platform: Args.string({description: 'target platform', options: ['ios'], required: true}),
  }

  static override flags = {
    'skip-pods': Flags.boolean({description: 'skip pod install', default: false}),
    simulator: Flags.string({description: 'iOS simulator name to target'}),
  }

  async run(): Promise<void> {
    const {renderSuccess} = await import('@reactivapp/cli-ui')
    const {flags} = await this.parse(AppRun)
    const projectRoot = process.cwd()

    if (!fs.existsSync(path.join(projectRoot, 'reactiv.conf.js'))) {
      this.error('not a Reactiv Plus project (reactiv.conf.js not found) — run this from the project root')
    }

    let layout: ProjectLayout
    try {
      layout = resolveLayout(projectRoot)
      assertLibraryManifest(readManifest(path.join(projectRoot, 'package.json')))
      assertDependenciesInSync(layout)
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error))
    }
    const {appDir} = layout

    if (!flags['skip-pods']) {
      this.log('Installing pods…')
      run('pod', ['install'], {cwd: path.join(appDir, 'ios')})
    }

    // A stale Metro from another project would silently serve the WRONG
    // bundle while our own Metro dies on the occupied port.
    if (await metroPortOccupied(8081)) {
      this.error(
        'port 8081 is already in use (another Metro?). Stop it first — a foreign Metro would serve the wrong project’s bundle.',
      )
    }

    this.log('Starting Metro (logs: .reactiv-metro.log)…')
    const metroLog = fs.openSync(path.join(projectRoot, '.reactiv-metro.log'), 'a')
    const metro = spawn('npx', ['react-native', 'start'], {
      cwd: appDir,
      detached: true,
      stdio: ['ignore', metroLog, metroLog],
    })
    let metroDied: string | undefined
    metro.on('error', error => {
      metroDied = error.message
    })
    metro.on('exit', code => {
      if (code !== 0 && code !== null) metroDied = `exited with code ${code}`
    })
    metro.unref()

    this.log('Building and launching the iOS app…')
    const runIosArgs = ['react-native', 'run-ios', '--no-packager']
    if (flags.simulator) {
      runIosArgs.push('--simulator', flags.simulator)
    } else {
      // Pin to the booted simulator — otherwise run-ios may pick a connected
      // physical device and fail on signing.
      const udid = bootedSimulatorUdid()
      if (udid) runIosArgs.push('--udid', udid)
    }
    try {
      run('npx', runIosArgs, {cwd: appDir})
    } catch (error) {
      // Don't leave an orphaned Metro behind a failed build.
      if (metro.pid) {
        try {
          process.kill(-metro.pid)
        } catch {
          /* already gone */
        }
      }
      throw error
    }

    if (metroDied) {
      this.error(`Metro failed to start (${metroDied}) — see .reactiv-metro.log`)
    }

    renderSuccess({
      headline: 'App launched',
      body: ['Metro is running in the background (.reactiv-metro.log)'],
    })
  }
}
