// taskr babel plugin with Babel 7 support
// https://github.com/lukeed/taskr/pull/305

const path = require('path')
const os = require('os')

// eslint-disable-next-line import/no-extraneous-dependencies
const { platformArchTriples } = require('@napi-rs/triples')
const triples = platformArchTriples[os.platform()][os.arch()] || []

let nativeBindings
let pendingBindings

module.exports = function (task, utils) {
  /**
   * This logic is copy-pasted from "packages/next/build/swc/index.js",
   * with some modifications and simplifications.
   *
   * Reasons of "packages/next/build/swc/index.js" not being reused:
   * - It is written in ES Module format, which has to be pre-compiled before use
   * - It is dependent on the pre-compiled version of "@napi-rs/triple"
   * - We don't need swc load error telemetry
   * - We can load "@next/swc-[platform]" directly from node_modules,
   *   skipping "@next/swc/natives/next-swc.[platform].node"
   */
  async function loadBindings() {
    if (pendingBindings) return pendingBindings

    pendingBindings = new Promise(async (resolve, reject) => {
      if (nativeBindings) resolve(nativeBindings)

      let bindings
      const attempts = []
      try {
        for (const triple of triples) {
          let pkg = `@next/swc-${triple.platformArchABI}`
          try {
            bindings = require(pkg)
            utils.log('use locally built binary of @next/swc')
            break
          } catch (e) {
            if (e?.code === 'MODULE_NOT_FOUND') {
              attempts.push(`${pkg} was not found`)
            } else {
              attempts.push(
                `An error occurred when loading ${pkg}: ${e.message ?? e}`
              )
            }
          }
        }

        if (bindings) {
          nativeBindings = {
            transform(src, options) {
              const isModule =
                typeof src !== undefined &&
                typeof src !== 'string' &&
                !Buffer.isBuffer(src)
              options = options || {}

              if (options?.jsc?.parser) {
                options.jsc.parser.syntax =
                  options.jsc.parser.syntax ?? 'ecmascript'
              }

              return bindings.transform(
                isModule ? JSON.stringify(src) : src,
                isModule,
                Buffer.from(JSON.stringify(options))
              )
            },
          }
          return resolve(nativeBindings)
        }

        utils.error(attempts)
        utils.error(
          'Try "node scripts/install-native.mjs" to (re)install pre-built binary of @next/swc'
        )
        reject(attempts)
      } catch (e) {
        reject(e)
      }
    })

    return pendingBindings
  }

  async function swcTransform(src, options) {
    try {
      return (await loadBindings()).transform(src, options)
    } catch (e) {
      throw new Error('Failed to load @next/swc')
    }
  }

  task.plugin(
    'swc',
    {},
    function* (
      file,
      serverOrClient,
      {
        stripExtension,
        keepImportAssertions = false,
        interopClientDefaultExport = false,
      } = {}
    ) {
      // Don't compile .d.ts
      if (file.base.endsWith('.d.ts')) return

      const isClient = serverOrClient === 'client'

      /** @type {import('@swc/core').Options} */
      const swcClientOptions = {
        module: {
          type: 'commonjs',
          ignoreDynamic: true,
        },
        jsc: {
          loose: true,
          externalHelpers: true,
          target: 'es2016',
          parser: {
            syntax: 'typescript',
            dynamicImport: true,
            importAssertions: true,
            tsx: file.base.endsWith('.tsx'),
          },
          experimental: {
            keepImportAssertions,
          },
          transform: {
            react: {
              pragma: 'React.createElement',
              pragmaFrag: 'React.Fragment',
              throwIfNamespace: true,
              development: false,
              useBuiltins: true,
            },
          },
        },
      }

      /** @type {import('@swc/core').Options} */
      const swcServerOptions = {
        module: {
          type: 'commonjs',
          ignoreDynamic: true,
        },
        env: {
          targets: {
            node: '12.0.0',
          },
        },
        jsc: {
          loose: true,
          // Do not enable externalHelpers for server-side code
          // "_is_native_function.mjs" helper is not compatible with edge runtime
          externalHelpers: false,
          parser: {
            syntax: 'typescript',
            dynamicImport: true,
            importAssertions: true,
            tsx: file.base.endsWith('.tsx'),
          },
          experimental: {
            keepImportAssertions,
          },
          transform: {
            react: {
              pragma: 'React.createElement',
              pragmaFrag: 'React.Fragment',
              throwIfNamespace: true,
              development: false,
              useBuiltins: true,
            },
          },
        },
      }

      const swcOptions = isClient ? swcClientOptions : swcServerOptions

      const filePath = path.join(file.dir, file.base)
      const fullFilePath = path.join(__dirname, filePath)
      const distFilePath = path.dirname(path.join(__dirname, 'dist', filePath))

      const options = {
        filename: path.join(file.dir, file.base),
        sourceMaps: true,
        inlineSourcesContent: false,
        sourceFileName: path.relative(distFilePath, fullFilePath),

        ...swcOptions,
      }

      const output = yield swcTransform(file.data.toString('utf-8'), options)
      const ext = path.extname(file.base)

      // Replace `.ts|.tsx` with `.js` in files with an extension
      if (ext) {
        const extRegex = new RegExp(ext.replace('.', '\\.') + '$', 'i')
        // Remove the extension if stripExtension is enabled or replace it with `.js`
        file.base = file.base.replace(extRegex, stripExtension ? '' : '.js')
      }

      if (output.map) {
        if (interopClientDefaultExport) {
          output.code += `
if ((typeof exports.default === 'function' || (typeof exports.default === 'object' && exports.default !== null)) && typeof exports.default.__esModule === 'undefined') {
  Object.defineProperty(exports.default, '__esModule', { value: true });
  Object.assign(exports.default, exports);
  module.exports = exports.default;
}
`
        }

        const map = `${file.base}.map`

        output.code += Buffer.from(`\n//# sourceMappingURL=${map}`)

        // add sourcemap to `files` array
        this._.files.push({
          base: map,
          dir: file.dir,
          data: Buffer.from(output.map),
        })
      }

      file.data = Buffer.from(setNextVersion(output.code))
    }
  )
}

function setNextVersion(code) {
  return code.replace(
    /process\.env\.__NEXT_VERSION/g,
    `"${require('./package.json').version}"`
  )
}
