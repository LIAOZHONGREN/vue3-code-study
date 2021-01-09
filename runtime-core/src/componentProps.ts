import {
  toRaw,
  shallowReactive,
  trigger,
  TriggerOpTypes
} from '@vue/reactivity'
import {
  EMPTY_OBJ,
  camelize,
  hyphenate,
  capitalize,
  isString,
  isFunction,
  isArray,
  isObject,
  hasOwn,
  toRawType,
  PatchFlags,
  makeMap,
  isReservedProp,
  EMPTY_ARR,
  def,
  extend
} from '@vue/shared'
import { warn } from './warning'
import {
  Data,
  ComponentInternalInstance,
  ComponentOptions,
  ConcreteComponent,
  setCurrentInstance
} from './component'
import { isEmitListener } from './componentEmits'
import { InternalObjectKey } from './vnode'
import { AppContext } from './apiCreateApp'

export type ComponentPropsOptions<P = Data> = | ComponentObjectPropsOptions<P> | string[]

export type ComponentObjectPropsOptions<P = Data> = { [K in keyof P]: Prop<P[K]> | null }

export type Prop<T, D = T> = PropOptions<T, D> | PropType<T>

type DefaultFactory<T> = (props: Data) => T | null | undefined

interface PropOptions<T = any, D = T> {
  type?: PropType<T> | true | null
  required?: boolean
  default?: D | DefaultFactory<D> | null | undefined | object
  validator?(value: unknown): boolean
}

export type PropType<T> = PropConstructor<T> | PropConstructor<T>[]

type PropConstructor<T = any> =
  | { new(...args: any[]): T & object }
  | { (): T }
  | PropMethod<T>

type PropMethod<T, TConstructor = any> = T extends (...args: any) => any // if is function with args
  ? { new(): TConstructor; (): T; readonly prototype: TConstructor } // Create Function like constructor
  : never

type RequiredKeys<T> = {
  [K in keyof T]: T[K] extends
  | { required: true }
  | { default: any }
  // don't mark Boolean props as undefined
  | BooleanConstructor
  | { type: BooleanConstructor }
  ? K
  : never
}[keyof T]

type OptionalKeys<T> = Exclude<keyof T, RequiredKeys<T>>

type DefaultKeys<T> = {
  [K in keyof T]: T[K] extends
  | { default: any }
  // Boolean implicitly defaults to false
  | BooleanConstructor
  | { type: BooleanConstructor }
  ? T[K] extends { type: BooleanConstructor; required: true } // not default if Boolean is marked as required
  ? never
  : K
  : never
}[keyof T]

type InferPropType<T> = T extends null
  ? any // null & true would fail to infer
  : T extends { type: null | true }
  ? any // As TS issue https://github.com/Microsoft/TypeScript/issues/14829 // somehow `ObjectConstructor` when inferred from { (): T } becomes `any` // `BooleanConstructor` when inferred from PropConstructor(with PropMethod) becomes `Boolean`
  : T extends ObjectConstructor | { type: ObjectConstructor }
  ? Record<string, any>
  : T extends BooleanConstructor | { type: BooleanConstructor }
  ? boolean
  : T extends Prop<infer V, infer D> ? (unknown extends V ? D : V) : T

export type ExtractPropTypes<O> = O extends object
  ? { [K in RequiredKeys<O>]: InferPropType<O[K]> } &
  { [K in OptionalKeys<O>]?: InferPropType<O[K]> }
  : { [K in string]: any }

const enum BooleanFlags {
  shouldCast,
  shouldCastTrue
}

// extract props which defined with default from prop options
export type ExtractDefaultPropTypes<O> = O extends object
  ? { [K in DefaultKeys<O>]: InferPropType<O[K]> }
  : {}

type NormalizedProp =
  | null
  | (PropOptions & {
    [BooleanFlags.shouldCast]?: boolean
    [BooleanFlags.shouldCastTrue]?: boolean
  })

// normalized value is a tuple of the actual normalized options
// and an array of prop keys that need value casting (booleans and defaults)
export type NormalizedProps = Record<string, NormalizedProp>
export type NormalizedPropsOptions = [NormalizedProps, string[]] | []

/**从rawProps中过滤出props和attrs,并对props根据它的配置项处理,再把它们赋值到ComponentInternalInstance.props和ComponentInternalInstance.attrs */
export function initProps(
  instance: ComponentInternalInstance,
  rawProps: Data | null, //组件的抽象节点的props(ComponentInternalInstance.vnode.props,类型:(VNodeProps & { [key: string]: any }) | null)
  isStateful: number, // result of bitwise flag comparison
  isSSR = false
) {
  const props: Data = {}
  const attrs: Data = {}
  def(attrs, InternalObjectKey, 1)
  setFullProps(instance, rawProps, props, attrs)
  // validation
  if (__DEV__) {
    validateProps(props, instance)
  }

  if (isStateful) {
    // stateful
    instance.props = isSSR ? props : shallowReactive(props)
  } else {
    if (!instance.type.props) {
      // functional w/ optional props, props === attrs
      instance.props = attrs
    } else {
      // functional w/ declared props
      instance.props = props
    }
  }
  instance.attrs = attrs
}

/**更新props和attrs */
export function updateProps(
  instance: ComponentInternalInstance,
  rawProps: Data | null, //改变后的props
  rawPrevProps: Data | null,//改变前
  optimized: boolean     //是否使用优化
) {
  const { props, attrs, vnode: { patchFlag } } = instance
  const rawCurrentProps = toRaw(props)
  const [options] = instance.propsOptions

  //如果当前不是测试环境,当前组件没有使用热替换,它的父组件也没有使用热替换,使用优化,组件没有PatchFlags.FULL_PROPS标注
  if (
    // always force full diff in dev
    // - #1942 if hmr is enabled with sfc component
    // - vite#872 non-sfc component used by sfc component
    !(
      __DEV__ &&
      (instance.type.__hmrId ||
        (instance.parent && instance.parent.type.__hmrId))
    ) &&
    (optimized || patchFlag > 0) &&
    !(patchFlag & PatchFlags.FULL_PROPS)
  ) {
    //如果被PatchFlags.PROPS标注
    if (patchFlag & PatchFlags.PROPS) {
      // Compiler-generated props & no keys change, just set the updated
      // the props.
      //根据记录在dynamicProps中的prop的key循环的把rawProps中的prop的值更新到instance.props和instance.attrs
      const propsToUpdate = instance.vnode.dynamicProps!
      for (let i = 0; i < propsToUpdate.length; i++) {
        const key = propsToUpdate[i]
        // PROPS flag guarantees rawProps to be non-null
        const value = rawProps![key]
        if (options) {
          // attr / props separation was done on init and will be consistent
          // in this code path, so just check if attrs have it.
          if (hasOwn(attrs, key)) {
            attrs[key] = value
          } else {
            const camelizedKey = camelize(key)
            props[camelizedKey] = resolvePropValue(
              options,
              rawCurrentProps,
              camelizedKey,
              value,
              instance
            )
          }
        } else {
          attrs[key] = value
        }
      }
    }
  } else {
    // full props update.
    setFullProps(instance, rawProps, props, attrs)
    // in case of dynamic props, check if we need to delete keys from
    // the props object
    let kebabKey: string
    for (const key in rawCurrentProps) {
      //如果改变的props中已经不存在此prop,那么如果有props配置项就根据配置项处理,不然就直接把此prop从props中删除
      if (
        !rawProps ||
        // for camelCase
        (!hasOwn(rawProps, key) &&
          // it's possible the original props was passed in as kebab-case
          // and converted to camelCase (#955)
          ((kebabKey = hyphenate(key)) === key || !hasOwn(rawProps, kebabKey)))
      ) {
        if (options) {
          if (
            rawPrevProps &&
            // for camelCase
            (rawPrevProps[key] !== undefined ||
              // for kebab-case
              rawPrevProps[kebabKey!] !== undefined)
          ) {
            props[key] = resolvePropValue(
              options,
              rawProps || EMPTY_OBJ,
              key,
              undefined,
              instance
            )
          }
        } else {
          delete props[key]
        }
      }
    }
    // in the case of functional component w/o props declaration, props and
    // attrs point to the same object so it should already have been updated.
    if (attrs !== rawCurrentProps) {
      for (const key in attrs) {
        if (!rawProps || !hasOwn(rawProps, key)) {
          delete attrs[key]
        }
      }
    }
  }

  // trigger updates for $attrs in case it's used in component slots
  trigger(instance, TriggerOpTypes.SET, '$attrs')

  if (__DEV__ && rawProps) {
    validateProps(props, instance)
  }
}


/**
 * @description: 从rawProps剔除保留属性(VNodeProps类型里的定义属性),剩下的属性根据props的配置项处理后填充入props参数,如果属性不是props的配置属性且不是emits的配置属性就填充入attrs参数
 * @param {*}
 * @return {*}
 */
function setFullProps(
  instance: ComponentInternalInstance,
  rawProps: Data | null,
  props: Data,
  attrs: Data
) {
  const [options, needCastKeys] = instance.propsOptions
  if (rawProps) {
    for (const key in rawProps) {
      const value = rawProps[key]
      // key, ref are reserved and never passed down
      //如果key值为保留属性key就不做处理
      if (isReservedProp(key)) {
        continue
      }
      // prop option names are camelized during normalization, so to support
      // kebab -> camel conversion here we need to camelize the key.
      let camelKey
      if (options && hasOwn(options, (camelKey = camelize(key)))) {
        props[camelKey] = value
      } else if (!isEmitListener(instance.emitsOptions, key)) {
        // Any non-declared (either as a prop or an emitted event) props are put
        // into a separate `attrs` object for spreading. Make sure to preserve
        // original key casing
        attrs[key] = value
      }
    }
  }

  if (needCastKeys) {
    const rawCurrentProps = toRaw(props)
    for (let i = 0; i < needCastKeys.length; i++) {
      const key = needCastKeys[i]
      props[key] = resolvePropValue(
        options!,
        rawCurrentProps,
        key,
        rawCurrentProps[key],
        instance
      )
    }
  }
}

/**
 * 处理prop对应的配置项有默认值且此prop没有设置就设置它的值为默认值,
 * 处理prop为布尔类型的且它对应的配置项有BooleanFlags.shouldCast属性为true,那么当props没设置它时就设置它的值为false
 */
function resolvePropValue(
  options: NormalizedProps,
  props: Data,
  key: string,
  value: unknown,
  instance: ComponentInternalInstance
) {
  const opt = options[key]
  if (opt != null) {
    const hasDefault = hasOwn(opt, 'default')
    // default values
    if (hasDefault && value === undefined) {
      const defaultValue = opt.default
      if (opt.type !== Function && isFunction(defaultValue)) {
        setCurrentInstance(instance)
        value = defaultValue(props)
        setCurrentInstance(null)
      } else {
        value = defaultValue
      }
    }
    // boolean casting
    if (opt[BooleanFlags.shouldCast]) {
      if (!hasOwn(props, key) && !hasDefault) {
        value = false
      } else if (
        opt[BooleanFlags.shouldCastTrue] &&
        (value === '' || value === hyphenate(key))
      ) {
        value = true
      }
    }
  }
  return value
}

/**规范化props配置,prop的配置的BooleanFlags属性在此处设置 (把appContext的混入和组件配置里的混入,扩展的props和组件配置的props规范化成NormalizedPropsOptions返回(将赋值到组件内部实例的propsOptions属性))*/
export function normalizePropsOptions(comp: ConcreteComponent,appContext: AppContext,asMixin = false): NormalizedPropsOptions {
  if (!appContext.deopt && comp.__props) {
    return comp.__props
  }

  const raw = comp.props
  const normalized: NormalizedPropsOptions[0] = {}
  const needCastKeys: NormalizedPropsOptions[1] = []

  // apply mixin/extends props
  let hasExtends = false
  //此处用于兼容2.0
  if (__FEATURE_OPTIONS_API__ && !isFunction(comp)) {
    const extendProps = (raw: ComponentOptions) => {
      hasExtends = true
      const [props, keys] = normalizePropsOptions(raw, appContext, true)
      extend(normalized, props)
      if (keys) needCastKeys.push(...keys)
    }
    if (!asMixin && appContext.mixins.length) {
      appContext.mixins.forEach(extendProps)
    }
    if (comp.extends) {
      extendProps(comp.extends)
    }
    if (comp.mixins) {
      comp.mixins.forEach(extendProps)
    }
  }

  if (!raw && !hasExtends) {
    return (comp.__props = EMPTY_ARR as any)
  }

  if (isArray(raw)) {
    for (let i = 0; i < raw.length; i++) {
      if (__DEV__ && !isString(raw[i])) {
        warn(`props must be strings when using array syntax.`, raw[i])
      }
      const normalizedKey = camelize(raw[i])
      if (validatePropName(normalizedKey)) {
        normalized[normalizedKey] = EMPTY_OBJ
      }
    }
  } else if (raw) {
    if (__DEV__ && !isObject(raw)) {
      warn(`invalid props options`, raw)
    }
    for (const key in raw) {
      const normalizedKey = camelize(key)
      if (validatePropName(normalizedKey)) {
        const opt = raw[key]
        const prop: NormalizedProp = (normalized[normalizedKey] =
          isArray(opt) || isFunction(opt) ? { type: opt } : opt)
        if (prop) {
          const booleanIndex = getTypeIndex(Boolean, prop.type)
          const stringIndex = getTypeIndex(String, prop.type)
          prop[BooleanFlags.shouldCast] = booleanIndex > -1
          prop[BooleanFlags.shouldCastTrue] =
            stringIndex < 0 || booleanIndex < stringIndex
          // if the prop needs boolean casting or default value
          if (booleanIndex > -1 || hasOwn(prop, 'default')) {
            needCastKeys.push(normalizedKey)
          }
        }
      }
    }
  }

  return (comp.__props = [normalized, needCastKeys])
}

/**prop的名字开头字符不可以是$ */
function validatePropName(key: string) {
  if (key[0] !== '$') {
    return true
  } else if (__DEV__) {
    warn(`Invalid prop name: "${key}" is a reserved property.`)
  }
  return false
}

// use function string name to check type constructors
// so that it works across vms / iframes.
/**获取函数名 */
function getType(ctor: Prop<any>): string {
  const match = ctor && ctor.toString().match(/^\s*function (\w+)/)
  return match ? match[1] : ''
}

/**判断方法名是否相等 */
function isSameType(a: Prop<any>, b: Prop<any>): boolean {
  return getType(a) === getType(b)
}

/**获取type在expectedTypes(预期类型(可能是数组或方法))中的索引,如果expectedTypes是方法,就判断相等返回0或-1 */
function getTypeIndex(
  type: Prop<any>,
  expectedTypes: PropType<any> | void | null | true
): number {
  if (isArray(expectedTypes)) {
    for (let i = 0, len = expectedTypes.length; i < len; i++) {
      if (isSameType(expectedTypes[i], type)) {
        return i
      }
    }
  } else if (isFunction(expectedTypes)) {
    return isSameType(expectedTypes, type) ? 0 : -1
  }
  return -1
}

/**
 * dev only
 * 使用for循环验证props中每个prop
 */
function validateProps(props: Data, instance: ComponentInternalInstance) {
  const rawValues = toRaw(props)
  const options = instance.propsOptions[0]
  for (const key in options) {
    let opt = options[key]
    if (opt == null) continue
    validateProp(key, rawValues[key], opt, !hasOwn(rawValues, key))
  }
}

/**
 * dev only
 * 根据prop在props配置项的配置验证prop是否符号配置,不符号就输出对应的警告
 */
function validateProp(
  name: string,
  value: unknown,
  prop: PropOptions,
  isAbsent: boolean //props配置中有的prop,props中是否没设置prop
) {
  const { type, required, validator } = prop
  // required! 如果此prop是必须要设置的却没有设置它就输出警告,跳出验证程序
  if (required && isAbsent) {
    warn('Missing required prop: "' + name + '"')
    return
  }
  // missing but optional
  //如果此prop是null,而它不是必须的,跳出验证程序
  if (value == null && !prop.required) {
    return
  }
  // type check
  if (type != null && type !== true) {
    let isValid = false
    const types = isArray(type) ? type : [type]
    const expectedTypes = []
    // value is valid as long as one of the specified types match
    //只要指定的类型之一匹配，值就有效
    for (let i = 0; i < types.length && !isValid; i++) {
      const { valid, expectedType } = assertType(value, types[i])
      expectedTypes.push(expectedType || '')
      isValid = valid
    }
    if (!isValid) {
      warn(getInvalidTypeMessage(name, value, expectedTypes))
      return
    }
  }
  // custom validator
  //如果有提供验证程序就验证value,验证不通过就输出警告
  if (validator && !validator(value)) {
    warn('Invalid prop: custom validator check failed for prop "' + name + '".')
  }
}

/**判断是否是基本类型的构造函数名 */
const isSimpleType = /*#__PURE__*/ makeMap(
  'String,Number,Boolean,Function,Symbol'
)

//断言结果
type AssertionResult = {
  valid: boolean       //断言是否通过
  expectedType: string //预期的类型
}

/**
 * dev only
 * 断言value的类型是否是type
 */
function assertType(value: unknown, type: PropConstructor): AssertionResult {
  let valid
  const expectedType = getType(type)
  if (isSimpleType(expectedType)) {
    const t = typeof value
    valid = t === expectedType.toLowerCase()
    // for primitive wrapper objects
    if (!valid && t === 'object') {
      valid = value instanceof type
    }
  } else if (expectedType === 'Object') {
    valid = isObject(value)
  } else if (expectedType === 'Array') {
    valid = isArray(value)
  } else {
    valid = value instanceof type
  }
  return {
    valid,
    expectedType
  }
}

/**
 * dev only
 */
function getInvalidTypeMessage(
  name: string,
  value: unknown,
  expectedTypes: string[]
): string {
  let message =
    `Invalid prop: type check failed for prop "${name}".` +
    ` Expected ${expectedTypes.map(capitalize).join(', ')}`
  const expectedType = expectedTypes[0]
  const receivedType = toRawType(value)
  const expectedValue = styleValue(value, expectedType)
  const receivedValue = styleValue(value, receivedType)
  // check if we need to specify expected value
  if (
    expectedTypes.length === 1 &&
    isExplicable(expectedType) &&
    !isBoolean(expectedType, receivedType)
  ) {
    message += ` with value ${expectedValue}`
  }
  message += `, got ${receivedType} `
  // check if we need to specify received value
  if (isExplicable(receivedType)) {
    message += `with value ${receivedValue}.`
  }
  return message
}

/**
 * dev only
 */
function styleValue(value: unknown, type: string): string {
  if (type === 'String') {
    return `"${value}"`
  } else if (type === 'Number') {
    return `${Number(value)}`
  } else {
    return `${value}`
  }
}

/**
 * dev only
 */
function isExplicable(type: string): boolean {
  const explicitTypes = ['string', 'number', 'boolean']
  return explicitTypes.some(elem => type.toLowerCase() === elem)
}

/**
 * dev only
 */
function isBoolean(...args: string[]): boolean {
  return args.some(elem => elem.toLowerCase() === 'boolean')
}
