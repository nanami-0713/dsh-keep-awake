import type { UserConfig } from 'tsdown'

const PLUGIN_ID = '@dsh-external/dsh-keep-awake'

/** Web 运行时已预装这些模块，client bundle 只 require、不打进去。 */
const NEVER_BUNDLE = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  '@deepseek-ai/dsh-client-runtime/client',
]

/**
 * client 产物必须是 ModuleLoader.load 包起来的 CJS bundle。
 * 除 Web 运行时预装模块外全部打进 bundle；其余 @deepseek-ai/* 导入均为
 * type-only，打包时会消失。
 */
const clientBundle: UserConfig = {
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  deps: {
    neverBundle: NEVER_BUNDLE,
    alwaysBundle: (id: string) => !NEVER_BUNDLE.includes(id),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(PLUGIN_ID) + ', factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
}

export default [clientBundle] satisfies UserConfig[]
