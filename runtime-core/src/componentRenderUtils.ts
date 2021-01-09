import {
  ComponentInternalInstance,
  FunctionalComponent,
  Data
} from './component'
import {
  VNode,
  normalizeVNode,
  createVNode,
  Comment,
  cloneVNode,
  VNodeArrayChildren,
  isVNode
} from './vnode'
import { handleError, ErrorCodes } from './errorHandling'
import { PatchFlags, ShapeFlags, isOn, isModelListener } from '@vue/shared'
import { warn } from './warning'
import { isHmrUpdating } from './hmr'
import { NormalizedProps } from './componentProps'
import { isEmitListener } from './componentEmits'

/**
 * mark the current rendering instance for asset resolution (e.g.
 * resolveComponent, resolveDirective) during render
 */
export let currentRenderingInstance: ComponentInternalInstance | null = null

export function setCurrentRenderingInstance(
  instance: ComponentInternalInstance | null
) {
  currentRenderingInstance = instance
}

/**
 * dev only flag to track whether $attrs was used during render.
 * If $attrs was used during render then the warning for failed attrs
 * fallthrough can be suppressed.
 * 仅在dev环境标注,可跟踪渲染期间是否使用了$attrs。 如果在渲染过程中使用了$attrs，则警告attrs失败.可以抑制掉线。 
 */
let accessedAttrs: boolean = false

export function markAttrsAccessed() {
  accessedAttrs = true
}

/**渲染组件的根,返回渲染完成的vnode */
export function renderComponentRoot(instance: ComponentInternalInstance): VNode {
  const {
    type: Component,
    vnode,
    proxy,
    withProxy,
    props,
    propsOptions: [propsOptions],
    slots,
    attrs,
    emit,
    render,
    renderCache,
    data,
    setupState,
    ctx
  } = instance

  let result
  currentRenderingInstance = instance
  if (__DEV__) { accessedAttrs = false }

  try {
    let fallthroughAttrs
    //如果是有状态组件
    if (vnode.shapeFlag & ShapeFlags.STATEFUL_COMPONENT) {
      // withProxy is a proxy with a different `has` trap only for
      // runtime-compiled render functions using `with` block.
      const proxyToUse = withProxy || proxy
      result = normalizeVNode(
        render!.call(
          proxyToUse,
          proxyToUse!,
          renderCache,
          props,
          setupState,
          data,
          ctx
        )
      )
      fallthroughAttrs = attrs
    } else {
      // functional
      const render = Component as FunctionalComponent
      // in dev, mark attrs accessed if optional props (attrs === props)
      if (__DEV__ && attrs === props) {
        markAttrsAccessed()
      }
      result = normalizeVNode(
        render.length > 1
          ? render(
            props,
            __DEV__
              ? {
                get attrs() {
                  markAttrsAccessed()
                  return attrs
                },
                slots,
                emit
              }
              : { attrs, slots, emit }
          )
          : render(props, null as any /* we know it doesn't need it */)
      )
      fallthroughAttrs = Component.props ? attrs : getFunctionalFallthrough(attrs)
    }

    // attr merging
    // in dev mode, comments are preserved, and it's possible for a template
    // to have comments along side the root element which makes it a fragment
    let root = result
    let setRoot: ((root: VNode) => void) | undefined = undefined
    if (__DEV__ && result.patchFlag & PatchFlags.DEV_ROOT_FRAGMENT) {
      ;[root, setRoot] = getChildRoot(result)
    }

    if (Component.inheritAttrs !== false && fallthroughAttrs) {
      const keys = Object.keys(fallthroughAttrs)
      const { shapeFlag } = root
      if (keys.length) {
        if (shapeFlag & ShapeFlags.ELEMENT || shapeFlag & ShapeFlags.COMPONENT) {
          if (propsOptions && keys.some(isModelListener)) {
            // If a v-model listener (onUpdate:xxx) has a corresponding declared
            // prop, it indicates this component expects to handle v-model and
            // it should not fallthrough.
            // related: #1543, #1643, #1989
            fallthroughAttrs = filterModelListeners(fallthroughAttrs,propsOptions)
          }
          root = cloneVNode(root, fallthroughAttrs)
        } else if (__DEV__ && !accessedAttrs && root.type !== Comment) {
          const allAttrs = Object.keys(attrs)
          const eventAttrs: string[] = []
          const extraAttrs: string[] = []
          for (let i = 0, l = allAttrs.length; i < l; i++) {
            const key = allAttrs[i]
            if (isOn(key)) {
              // ignore v-model handlers when they fail to fallthrough
              if (!isModelListener(key)) {
                // remove `on`, lowercase first letter to reflect event casing
                // accurately
                eventAttrs.push(key[2].toLowerCase() + key.slice(3))
              }
            } else {
              extraAttrs.push(key)
            }
          }
          if (extraAttrs.length) {
            warn(
              `Extraneous non-props attributes (` +
              `${extraAttrs.join(', ')}) ` +
              `were passed to component but could not be automatically inherited ` +
              `because component renders fragment or text root nodes.`
            )
          }
          if (eventAttrs.length) {
            warn(
              `Extraneous non-emits event listeners (` +
              `${eventAttrs.join(', ')}) ` +
              `were passed to component but could not be automatically inherited ` +
              `because component renders fragment or text root nodes. ` +
              `If the listener is intended to be a component custom event listener only, ` +
              `declare it using the "emits" option.`
            )
          }
        }
      }
    }

    // inherit directives
    if (vnode.dirs) {
      if (__DEV__ && !isElementRoot(root)) {
        warn(
          `Runtime directive used on component with non-element root node. ` +
          `The directives will not function as intended.`
        )
      }
      root.dirs = root.dirs ? root.dirs.concat(vnode.dirs) : vnode.dirs
    }
    // inherit transition data
    if (vnode.transition) {
      if (__DEV__ && !isElementRoot(root)) {
        warn(
          `Component inside <Transition> renders non-element root node ` +
          `that cannot be animated.`
        )
      }
      root.transition = vnode.transition
    }

    if (__DEV__ && setRoot) {
      setRoot(root)
    } else {
      result = root
    }
  } catch (err) {
    handleError(err, instance, ErrorCodes.RENDER_FUNCTION)
    result = createVNode(Comment) //渲染失败结果为空注释节点
  }
  currentRenderingInstance = null

  return result
}

/**
 * dev only
 * In dev mode, template root level comments are rendered, which turns the
 * template into a fragment root, but we need to locate the single element
 * root for attrs and scope id processing.
 * 如果提供的抽象节点中的children中不存在VNodeArrayChildren类型的值,且只存在一个非注释类型的抽象节点的抽象节点,就返回这个唯一的非注释类型的抽象节点和设置这个节点的方法的数组,不然就返回[vnode(参数), undefined]
 */
const getChildRoot = (vnode: VNode): [VNode, ((root: VNode) => void) | undefined] => {
  const rawChildren = vnode.children as VNodeArrayChildren
  const dynamicChildren = vnode.dynamicChildren
  const childRoot = filterSingleRoot(rawChildren)
  if (!childRoot) {
    return [vnode, undefined]
  }
  const index = rawChildren.indexOf(childRoot)
  const dynamicIndex = dynamicChildren ? dynamicChildren.indexOf(childRoot) : -1
  const setRoot = (updatedRoot: VNode) => {
    rawChildren[index] = updatedRoot
    if (dynamicChildren) {
      if (dynamicIndex > -1) {
        dynamicChildren[dynamicIndex] = updatedRoot
      } else if (updatedRoot.patchFlag > 0) {
        vnode.dynamicChildren = [...dynamicChildren, updatedRoot]
      }
    }
  }
  return [normalizeVNode(childRoot), setRoot]
}

/**如果children(VNodeArrayChildren)中不存在VNodeArrayChildren类型的值,且只存在一个非注释类型的抽象节点的抽象节点,就返回这个唯一的非注释类型的抽象节点,不存在就返回undefined */
export function filterSingleRoot(children: VNodeArrayChildren): VNode | undefined {
  let singleRoot
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    if (isVNode(child)) {
      // ignore user comment
      if (child.type !== Comment || child.children === 'v-if') {
        if (singleRoot) {
          // has more than 1 non-comment child, return now
          return
        } else {
          singleRoot = child
        }
      }
    } else {
      return
    }
  }
  return singleRoot
}

/**从对象中过滤出'class','style'和'on字符开头'的属性 */
const getFunctionalFallthrough = (attrs: Data): Data | undefined => {
  let res: Data | undefined
  for (const key in attrs) {
    if (key === 'class' || key === 'style' || isOn(key)) {
      ; (res || (res = {}))[key] = attrs[key]
    }
  }
  return res
}

/**从attrs把v-model:xxx类型的'onUpdate:'过滤掉 */
const filterModelListeners = (attrs: Data, props: NormalizedProps): Data => {
  const res: Data = {}
  for (const key in attrs) {
    if (!isModelListener(key) || !(key.slice(9) in props)) {
      res[key] = attrs[key]
    }
  }
  return res
}

const isElementRoot = (vnode: VNode) => {
  return (
    vnode.shapeFlag & ShapeFlags.COMPONENT ||
    vnode.shapeFlag & ShapeFlags.ELEMENT ||
    vnode.type === Comment // potential v-if branch switch
  )
}

/**判刑是否需要更新组件 */
export function shouldUpdateComponent(
  prevVNode: VNode,
  nextVNode: VNode,
  optimized?: boolean
): boolean {
  const { props: prevProps, children: prevChildren, component } = prevVNode
  const { props: nextProps, children: nextChildren, patchFlag } = nextVNode
  const emits = component!.emitsOptions

  // Parent component's render function was hot-updated. Since this may have
  // caused the child component's slots content to have changed, we need to
  // force the child to update as well.
  if (__DEV__ && (prevChildren || nextChildren) && isHmrUpdating) {
    return true
  }

  // force child update for runtime directive or transition on component vnode.
  if (nextVNode.dirs || nextVNode.transition) {
    return true
  }

  if (optimized && patchFlag >= 0) {
    if (patchFlag & PatchFlags.DYNAMIC_SLOTS) {
      // slot content that references values that might have changed,
      // e.g. in a v-for
      return true
    }
    if (patchFlag & PatchFlags.FULL_PROPS) {
      if (!prevProps) {
        return !!nextProps
      }
      // presence of this flag indicates props are always non-null
      return hasPropsChanged(prevProps, nextProps!, emits)
    } else if (patchFlag & PatchFlags.PROPS) {
      const dynamicProps = nextVNode.dynamicProps!
      for (let i = 0; i < dynamicProps.length; i++) {
        const key = dynamicProps[i]
        if (
          nextProps![key] !== prevProps![key] &&
          !isEmitListener(emits, key)
        ) {
          return true
        }
      }
    }
  } else {
    // this path is only taken by manually written render functions
    // so presence of any children leads to a forced update
    if (prevChildren || nextChildren) {
      if (!nextChildren || !(nextChildren as any).$stable) {
        return true
      }
    }
    if (prevProps === nextProps) {
      return false
    }
    if (!prevProps) {
      return !!nextProps
    }
    if (!nextProps) {
      return true
    }
    return hasPropsChanged(prevProps, nextProps, emits)
  }

  return false
}

/**判断props是否有变化 */
function hasPropsChanged(
  prevProps: Data,
  nextProps: Data,
  emitsOptions: ComponentInternalInstance['emitsOptions']
): boolean {
  const nextKeys = Object.keys(nextProps)
  if (nextKeys.length !== Object.keys(prevProps).length) {
    return true
  }
  for (let i = 0; i < nextKeys.length; i++) {
    const key = nextKeys[i]
    if (
      nextProps[key] !== prevProps[key] &&
      !isEmitListener(emitsOptions, key)
    ) {
      return true
    }
  }
  return false
}

/**多重组件都是同一个根元素类型的抽象节点,那么它们的el都相同(如果我的父组件的根节点是我,那么我的el就是父组件的el) */
export function updateHOCHostEl(
  { vnode, parent }: ComponentInternalInstance,
  el: typeof vnode.el // HostNode
) {
  while (parent && parent.subTree === vnode) {
    ; (vnode = parent.vnode).el = el
    parent = parent.parent
  }
}
