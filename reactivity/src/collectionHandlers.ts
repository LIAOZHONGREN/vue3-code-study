//提供把Map,WeakMap,Set,WeakSet转换成Proxy的ProxyHandler

import { toRaw, reactive, readonly, ReactiveFlags } from './reactive'
import { track, trigger, ITERATE_KEY, MAP_KEY_ITERATE_KEY } from './effect'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import {
  isObject,
  capitalize,
  hasOwn,
  hasChanged,
  toRawType,
  isMap
} from '@vue/shared'

export type CollectionTypes = IterableCollections | WeakCollections

type IterableCollections = Map<any, any> | Set<any>
type WeakCollections = WeakMap<any, any> | WeakSet<any>
type MapTypes = Map<any, any> | WeakMap<any, any>
type SetTypes = Set<any> | WeakSet<any>

/**如果数值是对象就把它转换成响应式的(Proxy),反之原值返回 */
const toReactive = <T extends unknown>(value: T): T =>
  isObject(value) ? reactive(value) : value

/**如果数值为对象就把它转换成只读的响应式的(Proxy),反之原值返回 */
const toReadonly = <T extends unknown>(value: T): T =>
  isObject(value) ? readonly(value as Record<any, any>) : value

/**不做处理原值返回 */
const toShallow = <T extends unknown>(value: T): T => value

/**获取对象的原型 */
const getProto = <T extends CollectionTypes>(v: T): any =>
  Reflect.getPrototypeOf(v)

/**重写get操作的基础执行函数  根据提供的isReadonly和isShallow配置来处理get操作获取的值是否处理成响应式的(2.0时期是一次性递归处理) (添加get追踪)*/
function get(
  target: MapTypes,
  key: unknown,
  isReadonly = false,
  isShallow = false
) {
  // #1772: readonly(reactive(Map)) should return readonly + reactive version
  // of the value
  target = (target as any)[ReactiveFlags.RAW]
  const rawTarget = toRaw(target)
  const rawKey = toRaw(key)
  if (key !== rawKey) {
    !isReadonly && track(rawTarget, TrackOpTypes.GET, key)
  }
  !isReadonly && track(rawTarget, TrackOpTypes.GET, rawKey)

  const { has } = getProto(rawTarget)
  const wrap = isReadonly ? toReadonly : isShallow ? toShallow : toReactive
  if (has.call(rawTarget, key)) {
    return wrap(target.get(key))
  } else if (has.call(rawTarget, rawKey)) {
    return wrap(target.get(rawKey))
  }
}

/**重写has操作 (添加has追踪(关联引用了target的key相关的属性值的副作用以备执行相关触发时执行))*/
function has(this: CollectionTypes, key: unknown, isReadonly = false): boolean {
  const target = (this as any)[ReactiveFlags.RAW]
  const rawTarget = toRaw(target)
  const rawKey = toRaw(key)
  if (key !== rawKey) {
    !isReadonly && track(rawTarget, TrackOpTypes.HAS, key)
  }
  !isReadonly && track(rawTarget, TrackOpTypes.HAS, rawKey)
  return key === rawKey
    ? target.has(key)
    : target.has(key) || target.has(rawKey)
}

/**重写size操作 (添加iterate追踪(关联引用了target的key对应的属性值的副作用以备执行相关触发时执行)) */
function size(target: IterableCollections, isReadonly = false) {
  target = (target as any)[ReactiveFlags.RAW]
  !isReadonly && track(toRaw(target), TrackOpTypes.ITERATE, ITERATE_KEY)
  return Reflect.get(target, 'size', target)
}

/**重写add操作 (执行add触发(执行相关的副作用)) */
function add(this: SetTypes, value: unknown) {
  value = toRaw(value)
  const target = toRaw(this)
  const proto = getProto(target)
  const hadKey = proto.has.call(target, value)
  target.add(value)
  if (!hadKey) {
    trigger(target, TriggerOpTypes.ADD, value, value)
  }
  return this
}

/**重写set操作 (执行add或set触发(执行相关的副作用)) */
function set(this: MapTypes, key: unknown, value: unknown) {
  value = toRaw(value)
  const target = toRaw(this)
  const { has, get } = getProto(target)

  let hadKey = has.call(target, key)
  if (!hadKey) {
    key = toRaw(key)
    hadKey = has.call(target, key)
  } else if (__DEV__) {
    checkIdentityKeys(target, has, key)
  }

  const oldValue = get.call(target, key)
  target.set(key, value)
  if (!hadKey) {
    trigger(target, TriggerOpTypes.ADD, key, value)
  } else if (hasChanged(value, oldValue)) {
    trigger(target, TriggerOpTypes.SET, key, value, oldValue)
  }
  return this
}

/**重写delect操作 (执行delete触发(执行相关的副作用)) */
function deleteEntry(this: CollectionTypes, key: unknown) {
  const target = toRaw(this)
  const { has, get } = getProto(target)
  let hadKey = has.call(target, key)
  if (!hadKey) {
    key = toRaw(key)
    hadKey = has.call(target, key)
  } else if (__DEV__) {
    checkIdentityKeys(target, has, key)
  }

  const oldValue = get ? get.call(target, key) : undefined
  // forward the operation before queueing reactions
  const result = target.delete(key)
  if (hadKey) {
    trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
  }
  return result
}

/**重写clear操作 (执行clear触发(执行相关的副作用)) */
function clear(this: IterableCollections) {
  const target = toRaw(this)
  const hadItems = target.size !== 0
  const oldTarget = __DEV__
    ? isMap(target)
      ? new Map(target)
      : new Set(target)
    : undefined
  // forward the operation before queueing reactions
  const result = target.clear()
  if (hadItems) {
    trigger(target, TriggerOpTypes.CLEAR, undefined, undefined, oldTarget)
  }
  return result
}

/**重写forEach操作 (添加iterate追踪(关联引用了target的key对应的属性值的副作用以备执行相关触发时执行)) */
function createForEach(isReadonly: boolean, isShallow: boolean) {
  return function forEach(
    this: IterableCollections,
    callback: Function,
    thisArg?: unknown
  ) {
    const observed = this as any
    const target = observed[ReactiveFlags.RAW]
    const rawTarget = toRaw(target)
    const wrap = isReadonly ? toReadonly : isShallow ? toShallow : toReactive
    !isReadonly && track(rawTarget, TrackOpTypes.ITERATE, ITERATE_KEY)
    return target.forEach((value: unknown, key: unknown) => {
      // important: make sure the callback is
      // 1. invoked with the reactive map as `this` and 3rd arg
      // 2. the value received should be a corresponding reactive/readonly.
      return callback.call(thisArg, wrap(value), wrap(key), observed)
    })
  }
}

interface Iterable {
  [Symbol.iterator](): Iterator
}

interface Iterator {
  next(value?: any): IterationResult
}

interface IterationResult {
  value: any
  done: boolean
}

/**创建迭代器('keys', 'values', 'entries', Symbol.iterator) 根据提供的isReadonly和isShallow配置来处理迭代操作获取的值是否处理成响应式的(2.0时期是一次性递归处理)(添加iterate追踪)*/
function createIterableMethod(
  method: string | symbol,
  isReadonly: boolean,
  isShallow: boolean
) {
  return function (
    this: IterableCollections,
    ...args: unknown[]
  ): Iterable & Iterator {
    const target = (this as any)[ReactiveFlags.RAW]
    const rawTarget = toRaw(target)
    const targetIsMap = isMap(rawTarget)
    const isPair =
      method === 'entries' || (method === Symbol.iterator && targetIsMap)
    const isKeyOnly = method === 'keys' && targetIsMap
    const innerIterator = target[method](...args)
    const wrap = isReadonly ? toReadonly : isShallow ? toShallow : toReactive
    !isReadonly &&
      track(
        rawTarget,
        TrackOpTypes.ITERATE,
        isKeyOnly ? MAP_KEY_ITERATE_KEY : ITERATE_KEY
      )
    // return a wrapped iterator which returns observed versions of the
    // values emitted from the real iterator
    return {
      // iterator protocol
      next() {
        const { value, done } = innerIterator.next()
        return done
          ? { value, done }
          : {
            value: isPair ? [wrap(value[0]), wrap(value[1])] : wrap(value),
            done
          }
      },
      // iterable protocol
      [Symbol.iterator]() {
        return this
      }
    }
  }
}

/**根据TriggerOpTypes重写只读的数组型对象的写操作的方法(add,set,delete,clear:不做写操作,如果是测试环境就发出警告) */
function createReadonlyMethod(type: TriggerOpTypes): Function {
  return function (this: CollectionTypes, ...args: unknown[]) {
    if (__DEV__) {
      const key = args[0] ? `on key "${args[0]}" ` : ``
      console.warn(
        `${capitalize(type)} operation ${key}failed: target is readonly.`,
        toRaw(this)
      )
    }
    return type === TriggerOpTypes.DELETE ? false : this
  }
}

//深度响应的数组型对象的读写操作方法的插桩(劫持)对象
const mutableInstrumentations: Record<string, Function> = {
  get(this: MapTypes, key: unknown) {
    return get(this, key)
  },
  get size() {
    return size((this as unknown) as IterableCollections)
  },
  has,
  add,
  set,
  delete: deleteEntry,
  clear,
  forEach: createForEach(false, false)
}

//浅响应式的数组型对象的读写操作方法的插桩(劫持)对象
const shallowInstrumentations: Record<string, Function> = {
  get(this: MapTypes, key: unknown) {
    return get(this, key, false, true)
  },
  get size() {
    return size((this as unknown) as IterableCollections)
  },
  has,
  add,
  set,
  delete: deleteEntry,
  clear,
  forEach: createForEach(false, true)
}

//只读的(不在响应处理(因为没有写操作),只做跟踪处理)数组型对象的读写操作方法的插桩(劫持)对象
const readonlyInstrumentations: Record<string, Function> = {
  get(this: MapTypes, key: unknown) {
    return get(this, key, true)
  },
  get size() {
    return size((this as unknown) as IterableCollections, true)
  },
  has(this: MapTypes, key: unknown) {
    return has.call(this, key, true)
  },
  add: createReadonlyMethod(TriggerOpTypes.ADD),
  set: createReadonlyMethod(TriggerOpTypes.SET),
  delete: createReadonlyMethod(TriggerOpTypes.DELETE),
  clear: createReadonlyMethod(TriggerOpTypes.CLEAR),
  forEach: createForEach(true, false)
}

//给每个数组型对象的读写操作方法的插桩(劫持)对象添加迭代器
const iteratorMethods = ['keys', 'values', 'entries', Symbol.iterator]
iteratorMethods.forEach(method => {
  mutableInstrumentations[method as string] = createIterableMethod(
    method,
    false,
    false
  )
  readonlyInstrumentations[method as string] = createIterableMethod(
    method,
    true,
    false
  )
  shallowInstrumentations[method as string] = createIterableMethod(
    method,
    false,
    true
  )
})

/**创建对数组型对象代理的get操作 (核心就是get操作时获取的读写方法通过代理替换成重写的读写方法(插桩(劫持)对象的方法)达到对对象进行操作或改变时进行追踪和触发执行相关副作用) */
function createInstrumentationGetter(isReadonly: boolean, shallow: boolean) {
  const instrumentations = shallow
    ? shallowInstrumentations
    : isReadonly
      ? readonlyInstrumentations
      : mutableInstrumentations

  return (
    target: CollectionTypes,
    key: string | symbol,
    receiver: CollectionTypes
  ) => {
    if (key === ReactiveFlags.IS_REACTIVE) {
      return !isReadonly
    } else if (key === ReactiveFlags.IS_READONLY) {
      return isReadonly
    } else if (key === ReactiveFlags.RAW) {
      return target
    }

    return Reflect.get(
      hasOwn(instrumentations, key) && key in target
        ? instrumentations
        : target,
      key,
      receiver
    )
  }
}

/**代理配置(深度响应) */
export const mutableCollectionHandlers: ProxyHandler<CollectionTypes> = {
  get: createInstrumentationGetter(false, false)
}

/**代理配置(浅响应) */
export const shallowCollectionHandlers: ProxyHandler<CollectionTypes> = {
  get: createInstrumentationGetter(false, true)
}
/**代理配置(只读 只做追踪 不做响应(因为只读不存在写操作)) */
export const readonlyCollectionHandlers: ProxyHandler<CollectionTypes> = {
  get: createInstrumentationGetter(true, false)
}

function checkIdentityKeys(
  target: CollectionTypes,
  has: (key: unknown) => boolean,
  key: unknown
) {
  const rawKey = toRaw(key)
  if (rawKey !== key && has.call(target, rawKey)) {
    const type = toRawType(target)
    console.warn(
      `Reactive ${type} contains both the raw and reactive ` +
      `versions of the same object${type === `Map` ? ` as keys` : ``}, ` +
      `which can lead to inconsistencies. ` +
      `Avoid differentiating between the raw and reactive versions ` +
      `of an object and only use the reactive version if possible.`
    )
  }
}
