import { currentRenderingInstance } from '../componentRenderUtils'
import {
  currentInstance,
  ConcreteComponent,
  ComponentOptions,
  getComponentName
} from '../component'
import { Directive } from '../directives'
import { camelize, capitalize, isString } from '@vue/shared'
import { warn } from '../warning'
import { VNodeTypes } from '../vnode'

const COMPONENTS = 'components'
const DIRECTIVES = 'directives'

/**
 * @private
 * 通过名字从components中解析出组件
 */
export function resolveComponent(name: string): ConcreteComponent | string {
  return resolveAsset(COMPONENTS, name) || name
}

export const NULL_DYNAMIC_COMPONENT = Symbol()

/**
 * @private
 * 通过名字(isString(component))从components中解析出动态组件,如果component不是字符,且!!component=true就返回component,不然返回NULL_DYNAMIC_COMPONENT
 */
export function resolveDynamicComponent(component: unknown): VNodeTypes {
  if (isString(component)) {
    return resolveAsset(COMPONENTS, component, false) || component
  } else {
    // invalid types will fallthrough to createVNode and raise warning
    return (component || NULL_DYNAMIC_COMPONENT) as any
  }
}

/**
 * @private
 * 通过名字从directives解析出指令
 */
export function resolveDirective(name: string): Directive | undefined {
  return resolveAsset(DIRECTIVES, name)
}

/**
 * @private
 * overload 1: components
 */
function resolveAsset(
  type: typeof COMPONENTS,
  name: string,
  warnMissing?: boolean
): ConcreteComponent | undefined
// overload 2: directives
function resolveAsset(
  type: typeof DIRECTIVES,
  name: string
): Directive | undefined
// implementation
function resolveAsset(
  type: typeof COMPONENTS | typeof DIRECTIVES,
  name: string,
  warnMissing = true
) {
  const instance = currentRenderingInstance || currentInstance
  if (instance) {
    const Component = instance.type

    // self name has highest priority
    if (type === COMPONENTS) {
      // special self referencing call generated by compiler
      // inferred from SFC filename
      if (name === `_self`) {
        return Component
      }

      const selfName = getComponentName(Component)
      if (
        selfName &&
        (selfName === name ||
          selfName === camelize(name) ||
          selfName === capitalize(camelize(name)))
      ) {
        return Component
      }
    }

    const res =
      // local registration
      // check instance[type] first for components with mixin or extends.
      resolve(instance[type] || (Component as ComponentOptions)[type], name) ||
      // global registration
      resolve(instance.appContext[type], name)
    if (__DEV__ && warnMissing && !res) {
      warn(`Failed to resolve ${type.slice(0, -1)}: ${name}`)
    }
    return res
  } else if (__DEV__) {
    warn(
      `resolve${capitalize(type.slice(0, -1))} ` +
      `can only be used in render() or setup().`
    )
  }
}

/**通过属性名获取属性值(以属性名不同的形态(驼峰式,首字母大小驼峰式,连接符式)取,获取到值为止,都获取不到返回undefined) */
function resolve(registry: Record<string, any> | undefined, name: string) {
  return (
    registry &&
    (registry[name] ||
      registry[camelize(name)] ||
      registry[capitalize(camelize(name))])
  )
}
