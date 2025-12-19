// @ts-check

// Using esbuild for faster dev builds.
// We are still using Rollup for production builds because it generates
// smaller files and provides better tree-shaking.

import esbuild from 'esbuild'
import fs from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'
import { polyfillNode } from 'esbuild-plugin-polyfill-node'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))

const {
  values: { format: rawFormat, prod, inline: inlineDeps }, // 参数值
  positionals, // 位置参数
} = parseArgs({
  // 允许位置参数
  allowPositionals: true,
  options: {
    // CLI 参数：format，短参数 -f，默认 'global'
    format: {
      type: 'string',
      short: 'f',
      default: 'global',
    },
    // CLI 参数：prod（布尔），短参数 -p，默认 false（开发模式）
    prod: {
      type: 'boolean',
      short: 'p',
      default: false,
    },
    // CLI 参数：inline（布尔），短参数 -i，默认 false（是否内联依赖）
    inline: {
      type: 'boolean',
      short: 'i',
      default: false,
    },
  },
})

// 如果没有提供 format 就用 'global'
const format = rawFormat || 'global'
// positionals 用来接收目标包名（例如：vue、reactivity 等），默认目标 ['vue']
const targets = positionals.length ? positionals : ['vue']

// 根据 format 决定 esbuild 的输出 format
// resolve output
const outputFormat = format.startsWith('global')
  ? 'iife'
  : format === 'cjs'
    ? 'cjs'
    : 'esm'

// 特殊后缀处理，例如 'esm-bundler-runtime' -> runtime.esm-bundler（用于输出文件名）    
const postfix = format.endsWith('-runtime')
  ? `runtime.${format.replace(/-runtime$/, '')}`
  : format

// 读取私有包目录列表，用于判断目标包是在 packages 还是 packages-private
const privatePackages = fs.readdirSync('packages-private')

for (const target of targets) {
  // 确定包所在根目录（私有包或普通 packages）
  const pkgBase = privatePackages.includes(target)
    ? `packages-private`
    : `packages`
  const pkgBasePath = `../${pkgBase}/${target}`
  const pkg = require(`${pkgBasePath}/package.json`)

  // 生成输出文件路径，文件名包含包名、postfix、是否 prod 等信息
  const outfile = resolve(
    __dirname,
    `${pkgBasePath}/dist/${
      target === 'vue-compat' ? `vue` : target
    }.${postfix}.${prod ? `prod.` : ``}js`,
  )
  const relativeOutfile = relative(process.cwd(), outfile)

  // 解析 externals（哪些依赖不打包进输出）
  // resolve externals
  // TODO this logic is largely duplicated from rollup.config.js
  /** @type {string[]} */
  let external = []
  if (!inlineDeps) {
    // 在 cjs 或 esm-bundler 模式下，把 package.json 中的 dependencies/peerDependencies 全部视为外部依赖
    // cjs & esm-bundler: external all deps
    if (format === 'cjs' || format.includes('esm-bundler')) {
      external = [
        ...external,
        ...Object.keys(pkg.dependencies || {}),
        ...Object.keys(pkg.peerDependencies || {}),
        // for @vue/compiler-sfc / server-renderer
        // Node 内置或特殊模块（针对某些包）
        'path',
        'url',
        'stream',
      ]
    }

    // 对 compiler-sfc 做一些额外的 external 配置（因为它依赖一堆模板引擎等）
    if (target === 'compiler-sfc') {
      const consolidatePkgPath = require.resolve(
        '@vue/consolidate/package.json',
        {
          paths: [resolve(__dirname, `../packages/${target}/`)],
        },
      )
      const consolidateDeps = Object.keys(
        require(consolidatePkgPath).devDependencies,
      )
      external = [
        ...external,
        ...consolidateDeps,
        'fs',
        'vm',
        'crypto',
        'react-dom/server',
        'teacup/lib/express',
        'arc-templates/dist/es5',
        'then-pug',
        'then-jade',
      ]
    }
  }

  // 定义 esbuild 插件数组（这里添加一个打印重建日志插件）
  /** @type {Array<import('esbuild').Plugin>} */
  const plugins = [
    {
      name: 'log-rebuild',
      setup(build) {
        build.onEnd(() => {
          console.log(`built: ${relativeOutfile}`)
        })
      },
    },
  ]

  // 如果不是 cjs 且启用了 enableNonBrowserBranches，则注入 node polyfills（用于在浏览器环境模拟 Node API）
  if (format !== 'cjs' && pkg.buildOptions?.enableNonBrowserBranches) {
    plugins.push(polyfillNode())
  }

  // 创建 esbuild 上下文（context），并启用 watch 模式以在文件变更时自动重建
  esbuild
    .context({
      entryPoints: [resolve(__dirname, `${pkgBasePath}/src/index.ts`)],
      outfile,
      bundle: true,
      external,
      sourcemap: true,
      format: outputFormat,
      globalName: pkg.buildOptions?.name,
      platform: format === 'cjs' ? 'node' : 'browser',
      plugins,
      define: {
        // 通过 define 注入编译时常量（会被替换为字面量）
        __COMMIT__: `"dev"`,
        __VERSION__: `"${pkg.version}"`,
        __DEV__: prod ? `false` : `true`,
        __TEST__: `false`,
        __BROWSER__: String(
          format !== 'cjs' && !pkg.buildOptions?.enableNonBrowserBranches,
        ),
        __GLOBAL__: String(format === 'global'),
        __ESM_BUNDLER__: String(format.includes('esm-bundler')),
        __ESM_BROWSER__: String(format.includes('esm-browser')),
        __CJS__: String(format === 'cjs'),
        __SSR__: String(format !== 'global'),
        __COMPAT__: String(target === 'vue-compat'),
        // feature flags（示例：功能开关）
        __FEATURE_SUSPENSE__: `true`,
        __FEATURE_OPTIONS_API__: `true`,
        __FEATURE_PROD_DEVTOOLS__: `false`,
        __FEATURE_PROD_HYDRATION_MISMATCH_DETAILS__: `true`,
      },
    })
    .then(ctx => ctx.watch()) // 启用 watch：返回的 context 启动监听，变动时自动构建
}
