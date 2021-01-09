import { ComponentInternalInstance, currentInstance } from './component'
import {
  VNode,
  VNodeNormalizedChildren,
  normalizeVNode,
  VNodeChild,
  InternalObjectKey
} from './vnode'
import {
  isArray,
  isFunction,
  EMPTY_OBJ,
  ShapeFlags,
  extend,
  def,
  SlotFlags
} from '@vue/shared'
import { warn } from './warning'
import { isKeepAlive } from './components/KeepAlive'
import { withCtx } from './helpers/withRenderContext'
import { isHmrUpdating } from './hmr'

export type Slot = (...args: any[]) => VNode[]

export type InternalSlots = {
  [name: string]: Slot | undefined
}

export type Slots = Readonly<InternalSlots>

export type RawSlots = {
  [name: string]: unknown
  // manual render fn hint to skip forced children updates
  $stable?: boolean
  /**
   * for tracking slot owner instance. This is attached during
   * normalizeChildren when the component vnode is created.
   * @internal
   */
  _ctx?: ComponentInternalInstance | null
  /**
   * indicates compiler generated slots
   * we use a reserved property instead of a vnode patchFlag because the slots
   * object may be directly passed down to a child component in a manual
   * render function, and the optimization hint need to be on the slot object
   * itself to be preserved.
   * @internal
   */
  _?: SlotFlags
}

const isInternalKey = (key: string) => key[0] === '_' || key === '$stable'

/**规范化Slot的返回值(VNode[]|VNode),返回VNode[] */
const normalizeSlotValue = (value: unknown): VNode[] =>
  isArray(value)
    ? value.map(normalizeVNode)
    : [normalizeVNode(value as VNodeChild)]

    /**规范化Slot */
const normalizeSlot = (key: string, rawSlot: Function, ctx: ComponentInternalInstance | null | undefined): Slot =>
  withCtx((props: any) => {
    if (__DEV__ && currentInstance) {
      warn(
        `Slot "${key}" invoked outside of the render function: ` +
        `this will not track dependencies used in the slot. ` +
        `Invoke the slot function inside the render function instead.`
      )
    }
    return normalizeSlotValue(rawSlot(props))
  }, ctx)

/**把RawSlots规范转化为InternalSlots */
const normalizeObjectSlots = (rawSlots: RawSlots, slots: InternalSlots) => {
  const ctx = rawSlots._ctx
  for (const key in rawSlots) {
    if (isInternalKey(key)) continue
    const value = rawSlots[key]
    if (isFunction(value)) {
      slots[key] = normalizeSlot(key, value, ctx)
    } else if (value != null) {
      if (__DEV__) {
        warn(
          `Non-function value encountered for slot "${key}". ` +
          `Prefer function slots for better performance.`
        )
      }
      const normalized = normalizeSlotValue(value)
      slots[key] = () => normalized
    }
  }
}

/**把children(VNode[]|VNode)规范转化为默认插槽 */
const normalizeVNodeSlots = (
  instance: ComponentInternalInstance,
  children: VNodeNormalizedChildren
) => {
  if (__DEV__ && !isKeepAlive(instance.vnode)) {
    warn(
      `Non-function value encountered for default slot. ` +
      `Prefer function slots for better performance.`
    )
  }
  const normalized = normalizeSlotValue(children)
  instance.slots.default = () => normalized
}

/**把组件的抽象节点的children转化为slots赋值到组件内部实例的slots */
export const initSlots = (instance: ComponentInternalInstance,children: VNodeNormalizedChildren) => {
  if (instance.vnode.shapeFlag & ShapeFlags.SLOTS_CHILDREN) {
    const type = (children as RawSlots)._
    if (type) {
      instance.slots = children as InternalSlots
      // make compiler marker non-enumerable
      def(children as InternalSlots, '_', type)
    } else {
      normalizeObjectSlots(children as RawSlots, (instance.slots = {}))
    }
  } else {
    instance.slots = {}
    if (children) {
      normalizeVNodeSlots(instance, children)
    }
  }
  def(instance.slots, InternalObjectKey, 1)
}

/**更新插槽 */
export const updateSlots = (
  instance: ComponentInternalInstance,
  children: VNodeNormalizedChildren
) => {
  const { vnode, slots } = instance
  let needDeletionCheck = true //是否需要删除已经过时无效的插槽
  let deletionComparisonTarget = EMPTY_OBJ //暂存有效插槽的对象
  if (vnode.shapeFlag & ShapeFlags.SLOTS_CHILDREN) {
    const type = (children as RawSlots)._
    if (type) {
      // compiled slots.
      if (__DEV__ && isHmrUpdating) {
        // Parent was HMR updated so slot content may have changed.
        // force update slots and mark instance for hmr as well
        extend(slots, children as Slots)
      } else if (type === SlotFlags.STABLE) {
        // compiled AND stable.
        // no need to update, and skip stale slots removal. 无需更新，并跳过过时无效的插槽删除。
        needDeletionCheck = false
      } else {
        // compiled but dynamic (v-if/v-for on slots) - update slots, but skip
        // normalization. 已编译但是动态的（插槽上为v-if /v-for）-更新插槽，但跳过规范化。
        extend(slots, children as Slots)
      }
    } else {
      needDeletionCheck = !(children as RawSlots).$stable
      normalizeObjectSlots(children as RawSlots, slots)
    }
    deletionComparisonTarget = children as RawSlots
  } else if (children) {
    // non slot object children (direct value) passed to a component 传递给组件的非插槽对象子代（转为默认插槽）
    normalizeVNodeSlots(instance, children)
    deletionComparisonTarget = { default: 1 }
  }

  // delete stale slots 删除过时无效的插槽
  if (needDeletionCheck) {
    for (const key in slots) {
      if (!isInternalKey(key) && !(key in deletionComparisonTarget)) {
        delete slots[key]
      }
    }
  }
}
