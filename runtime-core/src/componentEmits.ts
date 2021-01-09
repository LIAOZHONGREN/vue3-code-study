import {
  camelize,
  EMPTY_OBJ,
  toHandlerKey,
  extend,
  hasOwn,
  hyphenate,
  isArray,
  isFunction,
  isOn,
  toNumber
} from '@vue/shared'
import {
  ComponentInternalInstance,
  ComponentOptions,
  ConcreteComponent,
  formatComponentName
} from './component'
import { callWithAsyncErrorHandling, ErrorCodes } from './errorHandling'
import { warn } from './warning'
import { UnionToIntersection } from './helpers/typeUtils'
import { devtoolsComponentEmit } from './devtools'
import { AppContext } from './apiCreateApp'

export type ObjectEmitsOptions = Record<string, ((...args: any[]) => any) | null>
export type EmitsOptions = ObjectEmitsOptions | string[]

export type EmitFn<
  Options = ObjectEmitsOptions,
  Event extends keyof Options = keyof Options
> = Options extends Array<infer V>
  ? (event: V, ...args: any[]) => void
  : {} extends Options // if the emit is empty object (usually the default value for emit) should be converted to function
    ? (event: string, ...args: any[]) => void
    : UnionToIntersection<
        {
          [key in Event]: Options[key] extends ((...args: infer Args) => any)
            ? (event: key, ...args: Args) => void
            : (event: key, ...args: any[]) => void
        }[Event]
      >

/**发射事件 */
export function emit(
  instance: ComponentInternalInstance,
  event: string,
  ...rawArgs: any[]
) {
  const props = instance.vnode.props || EMPTY_OBJ

  if (__DEV__) {
    const {
      emitsOptions,
      propsOptions: [propsOptions]
    } = instance
    if (emitsOptions) {
      //如果事件没在emitsOptions配置中说明
      if (!(event in emitsOptions)) {
        //propsOptions配置中也没有事件方法的声明
        if (!propsOptions || !(toHandlerKey(event) in propsOptions)) {
          warn(
            `Component emitted event "${event}" but it is neither declared in ` +
              `the emits option nor as an "${toHandlerKey(event)}" prop.`
          )
        }
      } else {
        //如果emitsOptions配置是对象且事件名对应到emitsOptions配置的属性值是函数,那么此函数是用于验证事件函数的参数是否符号标准,不不符合就输出警告
        const validator = emitsOptions[event]
        if (isFunction(validator)) {
          const isValid = validator(...rawArgs)
          if (!isValid) {
            warn(
              `Invalid event arguments: event validation failed for event "${event}".`
            )
          }
        }
      }
    }
  }

  let args = rawArgs
  const isModelListener = event.startsWith('update:')//是否是v-model的update事件

  // for v-model update:xxx events, apply modifiers on args
  const modelArg = isModelListener && event.slice(7)
  //如果是v-model的update事件且存在'number'或'trim'就根据相关修饰重新修饰参数
  if (modelArg && modelArg in props) {
    const modifiersKey = `${
      modelArg === 'modelValue' ? 'model' : modelArg
    }Modifiers`
    const { number, trim } = props[modifiersKey] || EMPTY_OBJ
    if (trim) {
      args = rawArgs.map(a => a.trim())
    } else if (number) {
      args = rawArgs.map(toNumber)
    }
  }

  if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
    devtoolsComponentEmit(instance, event, args)
  }

  if (__DEV__) {
    const lowerCaseEvent = event.toLowerCase()
    if (lowerCaseEvent !== event && props[toHandlerKey(lowerCaseEvent)]) {
      warn(
        `Event "${lowerCaseEvent}" is emitted in component ` +
          `${formatComponentName(
            instance,
            instance.type
          )} but the handler is registered for "${event}". ` +
          `Note that HTML attributes are case-insensitive and you cannot use ` +
          `v-on to listen to camelCase events when using in-DOM templates. ` +
          `You should probably use "${hyphenate(event)}" instead of "${event}".`
      )
    }
  }

  // convert handler name to camelCase. See issue #2249
  let handlerName = toHandlerKey(camelize(event))
  let handler = props[handlerName]
  // for v-model update:xxx events, also trigger kebab-case equivalent
  // for props passed via kebab-case
  if (!handler && isModelListener) {
    handlerName = toHandlerKey(hyphenate(event))
    handler = props[handlerName]
  }

  if (handler) {
    callWithAsyncErrorHandling(
      handler,
      instance,
      ErrorCodes.COMPONENT_EVENT_HANDLER,
      args
    )
  }

  //处理有Once修饰的事件
  const onceHandler = props[handlerName + `Once`]
  if (onceHandler) {
    if (!instance.emitted) {
      ;(instance.emitted = {} as Record<string, boolean>)[handlerName] = true
    } else if (instance.emitted[handlerName]) {
      return
    }
    callWithAsyncErrorHandling(
      onceHandler,
      instance,
      ErrorCodes.COMPONENT_EVENT_HANDLER,
      args
    )
  }
}

/**规范化EmitsOptions配置(把app的mixins中和当前组件的mixins中和当前组件的extends中和当前组件的emits中的所有数组类型或对象类型的EmitsOptions配置统一规范化成ObjectEmitsOptions类型的配置) */
export function normalizeEmitsOptions(comp: ConcreteComponent,appContext: AppContext,asMixin = false): ObjectEmitsOptions | null {
  if (!appContext.deopt && comp.__emits !== undefined) {
    return comp.__emits
  }

  const raw = comp.emits
  let normalized: ObjectEmitsOptions = {}

  // apply mixin/extends props
  let hasExtends = false
  //此处用于兼容2.0
  if (__FEATURE_OPTIONS_API__ && !isFunction(comp)) {
    const extendEmits = (raw: ComponentOptions) => {
      hasExtends = true
      extend(normalized, normalizeEmitsOptions(raw, appContext, true))
    }
    if (!asMixin && appContext.mixins.length) {
      appContext.mixins.forEach(extendEmits)
    }
    if (comp.extends) {
      extendEmits(comp.extends)
    }
    if (comp.mixins) {
      comp.mixins.forEach(extendEmits)
    }
  }

  if (!raw && !hasExtends) {
    return (comp.__emits = null)
  }

  if (isArray(raw)) {
    raw.forEach(key => (normalized[key] = null))
  } else {
    extend(normalized, raw)
  }
  return (comp.__emits = normalized)
}

// Check if an incoming prop key is a declared emit event listener.
// e.g. With `emits: { click: null }`, props named `onClick` and `onclick` are
// both considered matched listeners.
export function isEmitListener(options: ObjectEmitsOptions | null,key: string): boolean {
  if (!options || !isOn(key)) {
    return false
  }
  key = key.slice(2).replace(/Once$/, '')
  return (
    hasOwn(options, key[0].toLowerCase() + key.slice(1)) ||
    hasOwn(options, hyphenate(key)) ||
    hasOwn(options, key)
  )
}
