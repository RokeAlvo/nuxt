import { existsSync } from 'node:fs'
import { genArrayFromRaw, genDynamicImport, genExport, genImport, genObjectFromRawEntries, genSafeVariableName, genString } from 'knitwork'
import { join, relative, resolve } from 'pathe'
import type { JSValue } from 'untyped'
import { generateTypes, resolveSchema } from 'untyped'
import escapeRE from 'escape-string-regexp'
import { hash } from 'ohash'
import { camelCase } from 'scule'
import { filename } from 'pathe/utils'
import type { NuxtTemplate, NuxtTypeTemplate } from 'nuxt/schema'

import { annotatePlugins, checkForCircularDependencies } from './app'

export const vueShim: NuxtTemplate = {
  filename: 'types/vue-shim.d.ts',
  getContents: ({ nuxt }) => {
    if (!nuxt.options.typescript.shim) {
      return ''
    }

    return [
      'declare module \'*.vue\' {',
      '  import { DefineComponent } from \'vue\'',
      '  const component: DefineComponent<{}, {}, any>',
      '  export default component',
      '}',
    ].join('\n')
  },
}

// TODO: Use an alias
export const appComponentTemplate: NuxtTemplate = {
  filename: 'app-component.mjs',
  getContents: ctx => genExport(ctx.app.mainComponent!, ['default']),
}
// TODO: Use an alias
export const rootComponentTemplate: NuxtTemplate = {
  filename: 'root-component.mjs',
  // TODO: fix upstream in vite - this ensures that vite generates a module graph for islands
  // but should not be necessary (and has a warmup performance cost). See https://github.com/nuxt/nuxt/pull/24584.
  getContents: ctx => (ctx.nuxt.options.dev ? 'import \'#build/components.islands.mjs\';\n' : '') + genExport(ctx.app.rootComponent!, ['default']),
}
// TODO: Use an alias
export const errorComponentTemplate: NuxtTemplate = {
  filename: 'error-component.mjs',
  getContents: ctx => genExport(ctx.app.errorComponent!, ['default']),
}
// TODO: Use an alias
export const testComponentWrapperTemplate: NuxtTemplate = {
  filename: 'test-component-wrapper.mjs',
  getContents: ctx => genExport(resolve(ctx.nuxt.options.appDir, 'components/test-component-wrapper'), ['default']),
}

export const cssTemplate: NuxtTemplate = {
  filename: 'css.mjs',
  getContents: ctx => ctx.nuxt.options.css.map(i => genImport(i)).join('\n'),
}

export const clientPluginTemplate: NuxtTemplate = {
  filename: 'plugins/client.mjs',
  async getContents (ctx) {
    const clientPlugins = await annotatePlugins(ctx.nuxt, ctx.app.plugins.filter(p => !p.mode || p.mode !== 'server'))
    checkForCircularDependencies(clientPlugins)
    const exports: string[] = []
    const imports: string[] = []
    for (const plugin of clientPlugins) {
      const path = relative(ctx.nuxt.options.rootDir, plugin.src)
      const variable = genSafeVariableName(filename(plugin.src)).replace(/_(45|46|47)/g, '_') + '_' + hash(path)
      exports.push(variable)
      imports.push(genImport(plugin.src, variable))
    }
    return [
      ...imports,
      `export default ${genArrayFromRaw(exports)}`,
    ].join('\n')
  },
}

export const serverPluginTemplate: NuxtTemplate = {
  filename: 'plugins/server.mjs',
  async getContents (ctx) {
    const serverPlugins = await annotatePlugins(ctx.nuxt, ctx.app.plugins.filter(p => !p.mode || p.mode !== 'client'))
    checkForCircularDependencies(serverPlugins)
    const exports: string[] = []
    const imports: string[] = []
    for (const plugin of serverPlugins) {
      const path = relative(ctx.nuxt.options.rootDir, plugin.src)
      const variable = genSafeVariableName(filename(path)).replace(/_(45|46|47)/g, '_') + '_' + hash(path)
      exports.push(variable)
      imports.push(genImport(plugin.src, variable))
    }
    return [
      ...imports,
      `export default ${genArrayFromRaw(exports)}`,
    ].join('\n')
  },
}

export const appDefaults: NuxtTypeTemplate = {
  filename: 'types/app-defaults.d.ts',
  getContents: (ctx) => {
    const isV4 = ctx.nuxt.options.future.compatibilityVersion === 4
    return `
declare module '#app/defaults' {
  type DefaultAsyncDataErrorValue = ${isV4 ? 'undefined' : 'null'}
  type DefaultAsyncDataValue = ${isV4 ? 'undefined' : 'null'}
  type DefaultErrorValue = ${isV4 ? 'undefined' : 'null'}
  type DedupeOption = ${isV4 ? '\'cancel\' | \'defer\'' : 'boolean | \'cancel\' | \'defer\''}
}`
  },
}

export const pluginsDeclaration: NuxtTemplate = {
  filename: 'types/plugins.d.ts',
  getContents: async ({ nuxt, app }) => {
    const EXTENSION_RE = new RegExp(`(?<=\\w)(${nuxt.options.extensions.map(e => escapeRE(e)).join('|')})$`, 'g')

    const typesDir = join(nuxt.options.buildDir, 'types')
    const tsImports: string[] = []
    const pluginNames: string[] = []

    function exists (path: string) {
      return app.templates.some(t => t.write && path === t.dst) || existsSync(path)
    }

    for (const plugin of await annotatePlugins(nuxt, app.plugins)) {
      if (plugin.name) {
        pluginNames.push(`'${plugin.name}'`)
      }

      const pluginPath = resolve(typesDir, plugin.src)
      const relativePath = relative(typesDir, pluginPath)

      const correspondingDeclaration = pluginPath.replace(/\.(?<letter>[cm])?jsx?$/, '.d.$<letter>ts')
      if (correspondingDeclaration !== pluginPath && exists(correspondingDeclaration)) {
        tsImports.push(relativePath)
        continue
      }

      if (exists(pluginPath)) {
        tsImports.push(relativePath.replace(EXTENSION_RE, ''))
        continue
      }
    }

    return `// Generated by Nuxt'
import type { Plugin } from '#app'

type Decorate<T extends Record<string, any>> = { [K in keyof T as K extends string ? \`$\${K}\` : never]: T[K] }

type IsAny<T> = 0 extends 1 & T ? true : false
type InjectionType<A extends Plugin> = IsAny<A> extends true ? unknown : A extends Plugin<infer T> ? Decorate<T> : unknown

type NuxtAppInjections = \n  ${tsImports.map(p => `InjectionType<typeof ${genDynamicImport(p, { wrapper: false })}.default>`).join(' &\n  ')}

declare module '#app' {
  interface NuxtApp extends NuxtAppInjections { }

  interface NuxtAppLiterals {
    pluginName: ${pluginNames.join(' | ')}
  }
}

declare module '@vue/runtime-core' {
  interface ComponentCustomProperties extends NuxtAppInjections { }
}

declare module '@vue/runtime-dom' {
  interface ComponentCustomProperties extends NuxtAppInjections { }
}

declare module 'vue' {
  interface ComponentCustomProperties extends NuxtAppInjections { }
}

export { }
`
  },
}

const adHocModules = ['router', 'pages', 'imports', 'meta', 'components', 'nuxt-config-schema']
export const schemaTemplate: NuxtTemplate = {
  filename: 'types/schema.d.ts',
  getContents: async ({ nuxt }) => {
    const moduleInfo = nuxt.options._installedModules.map(m => ({
      ...m.meta,
      importName: m.entryPath || m.meta?.name,
    })).filter(m => m.configKey && m.name && !adHocModules.includes(m.name))

    const relativeRoot = relative(resolve(nuxt.options.buildDir, 'types'), nuxt.options.rootDir)
    const getImportName = (name: string) => (name[0] === '.' ? './' + join(relativeRoot, name) : name).replace(/\.\w+$/, '')
    const modules = moduleInfo.map(meta => [genString(meta.configKey), getImportName(meta.importName), meta])
    const privateRuntimeConfig = Object.create(null)
    for (const key in nuxt.options.runtimeConfig) {
      if (key !== 'public') {
        privateRuntimeConfig[key] = nuxt.options.runtimeConfig[key]
      }
    }
    const moduleOptionsInterface = [
      ...modules.map(([configKey, importName]) =>
        `    [${configKey}]?: typeof ${genDynamicImport(importName, { wrapper: false })}.default extends NuxtModule<infer O> ? Partial<O> : Record<string, any>`,
      ),
      modules.length > 0 ? `  modules?: (undefined | null | false | NuxtModule | string | [NuxtModule | string, Record<string, any>] | ${modules.map(([configKey, importName, meta]) => `[${genString(meta?.rawPath || importName)}, Exclude<NuxtConfig[${configKey}], boolean>]`).join(' | ')})[],` : '',
    ]
    return [
      'import { NuxtModule, RuntimeConfig } from \'@nuxt/schema\'',
      'declare module \'@nuxt/schema\' {',
      '  interface NuxtConfig {',
      moduleOptionsInterface,
      '  }',
      '}',
      'declare module \'nuxt/schema\' {',
      '  interface NuxtConfig {',
      moduleOptionsInterface,
      '  }',
      generateTypes(await resolveSchema(privateRuntimeConfig as Record<string, JSValue>),
        {
          interfaceName: 'RuntimeConfig',
          addExport: false,
          addDefaults: false,
          allowExtraKeys: false,
          indentation: 2,
        }),
      generateTypes(await resolveSchema(nuxt.options.runtimeConfig.public as Record<string, JSValue>),
        {
          interfaceName: 'PublicRuntimeConfig',
          addExport: false,
          addDefaults: false,
          allowExtraKeys: false,
          indentation: 2,
        }),
      '}',
      `declare module 'vue' {
        interface ComponentCustomProperties {
          $config: RuntimeConfig
        }
      }`,
    ].join('\n')
  },
}

// Add layouts template
export const layoutTemplate: NuxtTemplate = {
  filename: 'layouts.mjs',
  getContents ({ app }) {
    const layoutsObject = genObjectFromRawEntries(Object.values(app.layouts).map(({ name, file }) => {
      return [name, genDynamicImport(file, { interopDefault: true })]
    }))
    return [
      `export default ${layoutsObject}`,
    ].join('\n')
  },
}

// Add middleware template
export const middlewareTemplate: NuxtTemplate = {
  filename: 'middleware.mjs',
  getContents ({ app }) {
    const globalMiddleware = app.middleware.filter(mw => mw.global)
    const namedMiddleware = app.middleware.filter(mw => !mw.global)
    const namedMiddlewareObject = genObjectFromRawEntries(namedMiddleware.map(mw => [mw.name, genDynamicImport(mw.path)]))
    return [
      ...globalMiddleware.map(mw => genImport(mw.path, genSafeVariableName(mw.name))),
      `export const globalMiddleware = ${genArrayFromRaw(globalMiddleware.map(mw => genSafeVariableName(mw.name)))}`,
      `export const namedMiddleware = ${namedMiddlewareObject}`,
    ].join('\n')
  },
}

export const nitroSchemaTemplate: NuxtTemplate = {
  filename: 'types/nitro-nuxt.d.ts',
  getContents () {
    return /* typescript */`
/// <reference path="./schema.d.ts" />

import type { RuntimeConfig } from 'nuxt/schema'
import type { H3Event } from 'h3'
import type { LogObject } from 'consola'
import type { NuxtIslandContext, NuxtIslandResponse, NuxtRenderHTMLContext } from 'nuxt/app'

declare module 'nitropack' {
  interface NitroRuntimeConfigApp {
    buildAssetsDir: string
    cdnURL: string
  }
  interface NitroRuntimeConfig extends RuntimeConfig {}
  interface NitroRouteConfig {
    ssr?: boolean
    experimentalNoScripts?: boolean
  }
  interface NitroRouteRules {
    ssr?: boolean
    experimentalNoScripts?: boolean
    appMiddleware?: Record<string, boolean>
  }
  interface NitroRuntimeHooks {
    'dev:ssr-logs': (ctx: { logs: LogObject[], path: string }) => void | Promise<void>
    'render:html': (htmlContext: NuxtRenderHTMLContext, context: { event: H3Event }) => void | Promise<void>
    'render:island': (islandResponse: NuxtIslandResponse, context: { event: H3Event, islandContext: NuxtIslandContext }) => void | Promise<void>
  }
}
`
  },
}

export const clientConfigTemplate: NuxtTemplate = {
  filename: 'nitro.client.mjs',
  getContents: () => `
export const useRuntimeConfig = () => window?.__NUXT__?.config || {}
`,
}

export const appConfigDeclarationTemplate: NuxtTemplate = {
  filename: 'types/app.config.d.ts',
  getContents ({ app, nuxt }) {
    const typesDir = join(nuxt.options.buildDir, 'types')
    const configPaths = app.configs.map(path => relative(typesDir, path).replace(/\b\.\w+$/g, ''))

    return `
import type { CustomAppConfig } from 'nuxt/schema'
import type { Defu } from 'defu'
${configPaths.map((id: string, index: number) => `import ${`cfg${index}`} from ${JSON.stringify(id)}`).join('\n')}

declare const inlineConfig = ${JSON.stringify(nuxt.options.appConfig, null, 2)}
type ResolvedAppConfig = Defu<typeof inlineConfig, [${app.configs.map((_id: string, index: number) => `typeof cfg${index}`).join(', ')}]>
type IsAny<T> = 0 extends 1 & T ? true : false

type MergedAppConfig<Resolved extends Record<string, unknown>, Custom extends Record<string, unknown>> = {
  [K in keyof (Resolved & Custom)]: K extends keyof Custom
    ? unknown extends Custom[K]
      ? Resolved[K]
      : IsAny<Custom[K]> extends true
        ? Resolved[K]
        : Custom[K] extends Record<string, any>
            ? Resolved[K] extends Record<string, any>
              ? MergedAppConfig<Resolved[K], Custom[K]>
              : Exclude<Custom[K], undefined>
            : Exclude<Custom[K], undefined>
    : Resolved[K]
}

declare module 'nuxt/schema' {
  interface AppConfig extends MergedAppConfig<ResolvedAppConfig, CustomAppConfig> { }
}
declare module '@nuxt/schema' {
  interface AppConfig extends MergedAppConfig<ResolvedAppConfig, CustomAppConfig> { }
}
`
  },
}

export const appConfigTemplate: NuxtTemplate = {
  filename: 'app.config.mjs',
  write: true,
  getContents ({ app, nuxt }) {
    return `
import { updateAppConfig } from '#app/config'
import { defuFn } from 'defu'

const inlineConfig = ${JSON.stringify(nuxt.options.appConfig, null, 2)}

// Vite - webpack is handled directly in #app/config
if (import.meta.hot) {
  import.meta.hot.accept((newModule) => {
    updateAppConfig(newModule.default)
  })
}

${app.configs.map((id: string, index: number) => `import ${`cfg${index}`} from ${JSON.stringify(id)}`).join('\n')}

export default /*@__PURE__*/ defuFn(${app.configs.map((_id: string, index: number) => `cfg${index}`).concat(['inlineConfig']).join(', ')})
`
  },
}

export const publicPathTemplate: NuxtTemplate = {
  filename: 'paths.mjs',
  getContents ({ nuxt }) {
    return [
      'import { joinRelativeURL } from \'ufo\'',
      !nuxt.options.dev && 'import { useRuntimeConfig } from \'#internal/nitro\'',

      nuxt.options.dev
        ? `const appConfig = ${JSON.stringify(nuxt.options.app)}`
        : 'const appConfig = useRuntimeConfig().app',

      'export const baseURL = () => appConfig.baseURL',
      'export const buildAssetsDir = () => appConfig.buildAssetsDir',

      'export const buildAssetsURL = (...path) => joinRelativeURL(publicAssetsURL(), buildAssetsDir(), ...path)',

      'export const publicAssetsURL = (...path) => {',
      '  const publicBase = appConfig.cdnURL || appConfig.baseURL',
      '  return path.length ? joinRelativeURL(publicBase, ...path) : publicBase',
      '}',

      // On server these are registered directly in packages/nuxt/src/core/runtime/nitro/renderer.ts
      'if (import.meta.client) {',
      '  globalThis.__buildAssetsURL = buildAssetsURL',
      '  globalThis.__publicAssetsURL = publicAssetsURL',
      '}',
    ].filter(Boolean).join('\n')
  },
}

export const dollarFetchTemplate: NuxtTemplate = {
  filename: 'fetch.mjs',
  getContents () {
    return [
      'import { $fetch } from \'ofetch\'',
      'import { baseURL } from \'#internal/nuxt/paths\'',
      'if (!globalThis.$fetch) {',
      '  globalThis.$fetch = $fetch.create({',
      '    baseURL: baseURL()',
      '  })',
      '}',
    ].join('\n')
  },
}

// Allow direct access to specific exposed nuxt.config
export const nuxtConfigTemplate: NuxtTemplate = {
  filename: 'nuxt.config.mjs',
  getContents: (ctx) => {
    const fetchDefaults = {
      ...ctx.nuxt.options.experimental.defaults.useFetch,
      baseURL: undefined,
      headers: undefined,
    }
    const shouldEnableComponentIslands = ctx.nuxt.options.experimental.componentIslands && (
      ctx.nuxt.options.dev || ctx.nuxt.options.experimental.componentIslands !== 'auto' || ctx.app.pages?.some(p => p.mode === 'server') || ctx.app.components?.some(c => c.mode === 'server' && !ctx.app.components.some(other => other.pascalName === c.pascalName && other.mode === 'client'))
    )
    return [
      ...Object.entries(ctx.nuxt.options.app).map(([k, v]) => `export const ${camelCase('app-' + k)} = ${JSON.stringify(v)}`),
      `export const renderJsonPayloads = ${!!ctx.nuxt.options.experimental.renderJsonPayloads}`,
      `export const componentIslands = ${shouldEnableComponentIslands}`,
      `export const payloadExtraction = ${!!ctx.nuxt.options.experimental.payloadExtraction}`,
      `export const cookieStore = ${!!ctx.nuxt.options.experimental.cookieStore}`,
      `export const appManifest = ${!!ctx.nuxt.options.experimental.appManifest}`,
      `export const remoteComponentIslands = ${typeof ctx.nuxt.options.experimental.componentIslands === 'object' && ctx.nuxt.options.experimental.componentIslands.remoteIsland}`,
      `export const selectiveClient = ${typeof ctx.nuxt.options.experimental.componentIslands === 'object' && Boolean(ctx.nuxt.options.experimental.componentIslands.selectiveClient)}`,
      `export const devPagesDir = ${ctx.nuxt.options.dev ? JSON.stringify(ctx.nuxt.options.dir.pages) : 'null'}`,
      `export const devRootDir = ${ctx.nuxt.options.dev ? JSON.stringify(ctx.nuxt.options.rootDir) : 'null'}`,
      `export const devLogs = ${JSON.stringify(ctx.nuxt.options.features.devLogs)}`,
      `export const nuxtLinkDefaults = ${JSON.stringify(ctx.nuxt.options.experimental.defaults.nuxtLink)}`,
      `export const asyncDataDefaults = ${JSON.stringify({
        ...ctx.nuxt.options.experimental.defaults.useAsyncData,
        value: ctx.nuxt.options.experimental.defaults.useAsyncData.value === 'null' ? null : undefined,
        errorValue: ctx.nuxt.options.experimental.defaults.useAsyncData.errorValue === 'null' ? null : undefined,
      })}`,
      `export const resetAsyncDataToUndefined = ${ctx.nuxt.options.experimental.resetAsyncDataToUndefined}`,
      `export const nuxtDefaultErrorValue = ${ctx.nuxt.options.future.compatibilityVersion === 4 ? 'undefined' : 'null'}`,
      `export const fetchDefaults = ${JSON.stringify(fetchDefaults)}`,
      `export const vueAppRootContainer = ${ctx.nuxt.options.app.rootAttrs.id ? `'#${ctx.nuxt.options.app.rootAttrs.id}'` : `'body > ${ctx.nuxt.options.app.rootTag}'`}`,
      `export const viewTransition = ${ctx.nuxt.options.experimental.viewTransition}`,
      `export const appId = ${JSON.stringify(ctx.nuxt.options.appId)}`,
      `export const outdatedBuildInterval = ${ctx.nuxt.options.experimental.checkOutdatedBuildInterval}`,
    ].join('\n\n')
  },
}

const TYPE_FILENAME_RE = /\.([cm])?[jt]s$/
const DECLARATION_RE = /\.d\.[cm]?ts$/
export const buildTypeTemplate: NuxtTemplate = {
  filename: 'types/build.d.ts',
  getContents ({ app }) {
    let declarations = ''

    for (const file of app.templates) {
      if (file.write || !file.filename || DECLARATION_RE.test(file.filename)) {
        continue
      }

      if (TYPE_FILENAME_RE.test(file.filename)) {
        const typeFilenames = new Set([file.filename.replace(TYPE_FILENAME_RE, '.d.$1ts'), file.filename.replace(TYPE_FILENAME_RE, '.d.ts')])
        if (app.templates.some(f => f.filename && typeFilenames.has(f.filename))) {
          continue
        }
      }

      declarations += 'declare module ' + JSON.stringify(join('#build', file.filename)) + ';\n'
    }

    return declarations
  },
}
