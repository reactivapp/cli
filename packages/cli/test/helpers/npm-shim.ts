import {execFileSync} from 'node:child_process'
import {chmodSync, mkdirSync, writeFileSync} from 'node:fs'
import {delimiter, join} from 'node:path'

const realNpm = execFileSync('sh', ['-c', 'command -v npm'], {encoding: 'utf8'}).trim()

// Stands in for every registry npm call: `view`, `pack <registry package>`,
// `install` and `publish` answer from fixtures and record their arguments, so
// nothing leaves the machine. `pack` of a local directory (the submission
// staging dir) runs the real npm. FAKE_NPM_E401_ONCE (a flag file) makes the
// next registry call fail with E401 once, optionally only for
// FAKE_NPM_E401_ONCE_VERB; FAKE_NPM_E401_ALWAYS_VERB makes that verb always fail.
const NPM_SHIM = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_NPM_LOG"
if [ -n "$FAKE_NPM_E401_ALWAYS_VERB" ] && [ "$1" = "$FAKE_NPM_E401_ALWAYS_VERB" ]; then
  echo "npm error code E401" >&2
  exit 1
fi
if [ -n "$FAKE_NPM_E401_ONCE" ] && [ ! -f "$FAKE_NPM_E401_ONCE" ]; then
  if [ "$1" = "\${FAKE_NPM_E401_ONCE_VERB:-$1}" ] && { [ "$1" = "view" ] || [ "$1" = "publish" ] || [ "$1" = "install" ] || { [ "$1" = "pack" ] && [ "$2" = "@reactivapp/app-template" ]; }; }; then
    touch "$FAKE_NPM_E401_ONCE"
    echo "npm error code E401" >&2
    echo "npm error Unable to authenticate, your authentication token seems to be invalid." >&2
    exit 1
  fi
fi
case "$1" in
  view)
    case "$2" in
      @reactivapp/mobile|@reactivapp/mobile@*)
        case "$3" in
          version) echo "\${FAKE_MOBILE_LATEST:-2608.13.1}" ;;
          versions) echo "\${FAKE_MOBILE_VERSIONS-[\"2608.13.1\"]}" ;;
          dependencies) echo '{}' ;;
          peerDependencies) node -e "const peers = JSON.parse(process.env.FAKE_MOBILE_PEERS || '{}'); const version = process.argv[1].split('@')[2] || process.env.FAKE_MOBILE_LATEST || '2608.13.1'; console.log(JSON.stringify(peers[version] || {react: '19.2.3', 'react-native': '0.86.0'}))" "$2" ;;
          *) echo "unexpected npm view field $3" >&2; exit 1 ;;
        esac
        exit 0 ;;
      @reactiv-submissions/*)
        cat "$FAKE_NPM_VIEW_STDOUT"
        cat "$FAKE_NPM_VIEW_STDERR" >&2
        exit "$FAKE_NPM_VIEW_STATUS" ;;
    esac ;;
  pack)
    if [ "$2" = "@reactivapp/app-template" ]; then
      cp "$FAKE_TEMPLATE_TGZ" "$4/"
      basename "$FAKE_TEMPLATE_TGZ"
      exit 0
    fi ;;
  install)
    if grep -q 'CODEARTIFACT_AUTH_TOKEN' .npmrc 2>/dev/null; then echo "install saw a placeholder token line" >&2; exit 1; fi
    if ! grep -q '>>> reactiv' .npmrc 2>/dev/null; then echo "install ran without the managed block" >&2; exit 1; fi
    LEGACY_PEER_DEPS=0; for arg in "$@"; do [ "$arg" = "--legacy-peer-deps" ] && LEGACY_PEER_DEPS=1; done
    SHIM_LEGACY_PEER_DEPS=$LEGACY_PEER_DEPS node -e "
      const fs = require('fs');
      const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      const fallback = {'@reactivapp/mobile': '2608.13.1', react: '19.2.3', 'react-native': '0.86.0'};
      const legacyPeerDeps = process.env.SHIM_LEGACY_PEER_DEPS === '1';
      for (const [name, version] of Object.entries(fallback)) {
        const own = (manifest.dependencies || {})[name] || (manifest.devDependencies || {})[name];
        if (legacyPeerDeps && !own) continue;
        const declared = own || (manifest.peerDependencies || {})[name] || version;
        fs.mkdirSync('node_modules/' + name, {recursive: true});
        const installed = name === '@reactivapp/mobile' ? {name, version: declared, dependencies: {}} : {name, version: declared};
        fs.writeFileSync('node_modules/' + name + '/package.json', JSON.stringify(installed));
        if (name === '@reactivapp/mobile') fs.writeFileSync('package-lock.json', JSON.stringify({packages: {'node_modules/@reactivapp/mobile': {version: declared}}}));
      }
    "
    echo "added 3 packages"
    exit 0 ;;
  run)
    if [ "$2" = "typecheck" ]; then
      installed=$(node -p "require('./node_modules/@reactivapp/mobile/package.json').version" 2>/dev/null)
      if [ -n "$FAKE_TYPECHECK_FAIL_ON" ] && [ "$installed" = "$FAKE_TYPECHECK_FAIL_ON" ]; then
        echo "src/index.ts(1,10): error TS2305: Module '\"@reactivapp/mobile\"' has no exported member 'registerSection'."
        exit 2
      fi
      echo "typecheck clean against @reactivapp/mobile@$installed"
      exit 0
    fi ;;
  publish)
    if [ -n "$FAKE_NPM_PUBLISH_COPY" ]; then cp "$2" "$FAKE_NPM_PUBLISH_COPY"; fi
    exit 0 ;;
esac
exec "$REAL_NPM" "$@"
`

export interface NpmShim {
  binDir: string
  log: string
  env: Record<string, string>
}

export const installNpmShim = (workDir: string, templateTgz = ''): NpmShim => {
  const binDir = join(workDir, 'shim-bin')
  mkdirSync(binDir, {recursive: true})
  writeFileSync(join(binDir, 'npm'), NPM_SHIM)
  chmodSync(join(binDir, 'npm'), 0o755)
  const log = join(workDir, 'npm.log')
  const viewStdout = join(workDir, 'view-stdout.json')
  const viewStderr = join(workDir, 'view-stderr.txt')
  writeFileSync(log, '')
  writeFileSync(viewStdout, '[]')
  writeFileSync(viewStderr, '')
  return {
    binDir,
    log,
    env: {
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
      REAL_NPM: realNpm,
      FAKE_NPM_LOG: log,
      FAKE_NPM_VIEW_STDOUT: viewStdout,
      FAKE_NPM_VIEW_STDERR: viewStderr,
      FAKE_NPM_VIEW_STATUS: '0',
      FAKE_TEMPLATE_TGZ: templateTgz,
    },
  }
}

const PLACEHOLDER_NPMRC = [
  '@reactivapp:registry=https://reactivapp-000000000000.d.codeartifact.us-east-1.amazonaws.com/npm/tools/',
  '//reactivapp-000000000000.d.codeartifact.us-east-1.amazonaws.com/npm/tools/:_authToken=${CODEARTIFACT_AUTH_TOKEN}',
]

export const buildTemplateTarball = (
  workDir: string,
  options: {gitignore?: string; legacyLayout?: boolean; omitRootNpmrc?: boolean; delegations?: Record<string, string>} = {},
): string => {
  const root = join(workDir, 'template-src')
  const template = join(root, 'package', 'template')
  const source = join(template, options.legacyLayout ? 'custom' : 'src')
  mkdirSync(join(source, 'customizations'), {recursive: true})
  writeFileSync(join(root, 'package', 'package.json'), '{"name":"@reactivapp/app-template","version":"1.0.0"}')
  writeFileSync(join(template, 'gitignore'), options.gitignore ?? 'node_modules/\n# local env + registry tokens are never committed\n.env\n.npmrc\n')
  if (!options.omitRootNpmrc) writeFileSync(
    join(template, 'npmrc'),
    [...PLACEHOLDER_NPMRC, '//reactivapp-000000000000.d.codeartifact.us-east-1.amazonaws.com/npm/submissions-{{APP_SLUG}}/:_authToken=${CODEARTIFACT_AUTH_TOKEN}', ''].join('\n'),
  )
  writeFileSync(join(template, 'reactiv.conf.js'), "module.exports = {appUuid: '{{APP_UUID}}', appName: '{{APP_NAME}}'}\n")
  writeFileSync(
    join(source, 'index.ts'),
    "export {CustomCompositions} from './customizations/CustomCompositions';\nexport {registerCustomComponents} from './customizations/registerCustomComponents';\n",
  )
  writeFileSync(join(source, 'customizations', 'CustomCompositions.tsx'), 'export const CustomCompositions = {};\n')
  writeFileSync(join(source, 'customizations', 'registerCustomComponents.tsx'), 'export function registerCustomComponents() {}\n')
  const peers = {'@reactivapp/mobile': '{{PLATFORM_VERSION}}', react: '{{REACT_VERSION}}', 'react-native': '{{REACT_NATIVE_VERSION}}'}
  if (options.legacyLayout) {
    writeFileSync(join(template, 'package.json.template'), JSON.stringify({name: '{{APP_SLUG}}', private: true, dependencies: peers}) + '\n')
    writeFileSync(join(template, 'env.template'), 'REACTIV_APP_IDENTIFIER={{APP_UUID}}\n')
  } else {
    writeFileSync(
      join(template, 'package.json.template'),
      JSON.stringify({
        name: '{{APP_SLUG}}',
        private: true,
        main: 'src/index.ts',
        'react-native': 'src/index.ts',
        files: ['src'],
        scripts: {typecheck: 'node node_modules/@reactivapp/mobile/toolchain/typecheck.mjs'},
        dependencies: {},
        peerDependencies: peers,
        devDependencies: {...peers, typescript: '~5.8.3'},
      }) + '\n',
    )
    mkdirSync(join(template, 'app', 'ios'), {recursive: true})
    writeFileSync(
      join(template, 'app', 'package.json.template'),
      JSON.stringify({name: '{{APP_SLUG}}-app', private: true, dependencies: peers, devDependencies: {metro: '0.83.0'}}) + '\n',
    )
    writeFileSync(join(template, 'app', 'npmrc'), [...PLACEHOLDER_NPMRC, ''].join('\n'))
    writeFileSync(join(template, 'app', 'env.template'), 'REACTIV_APP_IDENTIFIER={{APP_UUID}}\n')
    writeFileSync(join(template, 'app', 'index.js'), "import '{{APP_SLUG}}';\n")
    const delegations: Record<string, string> = {
      'app/metro.config.js': "module.exports = require('@reactivapp/mobile/toolchain/metro')(__dirname);\n",
      'app/babel.config.js': "module.exports = {presets: [require('@reactivapp/mobile/toolchain/babel-preset')]};\n",
      'app/react-native.config.js': "module.exports = {dependencies: require('@reactivapp/mobile/toolchain/rn-config')(__dirname)};\n",
      'tsconfig.json': '{"extends": "@reactivapp/mobile/toolchain/tsconfig.base.json", "include": ["src"]}\n',
      'app/ios/Podfile': '# pods\n',
      ...options.delegations,
    }
    for (const [file, content] of Object.entries(delegations)) writeFileSync(join(template, file), content)
  }
  const tarball = join(workDir, 'reactivapp-app-template-1.0.0.tgz')
  execFileSync('tar', ['-czf', tarball, '-C', root, 'package'])
  return tarball
}
