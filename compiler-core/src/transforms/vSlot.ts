import {
  ElementNode,
  ObjectExpression,
  createObjectExpression,
  NodeTypes,
  createObjectProperty,
  createSimpleExpression,
  createFunctionExpression,
  DirectiveNode,
  ElementTypes,
  ExpressionNode,
  Property,
  TemplateChildNode,
  SourceLocation,
  createConditionalExpression,
  ConditionalExpression,
  SimpleExpressionNode,
  FunctionExpression,
  CallExpression,
  createCallExpression,
  createArrayExpression,
  SlotsExpression
} from '../ast'
import { TransformContext, NodeTransform } from '../transform'
import { createCompilerError, ErrorCodes } from '../errors'
import {
  findDir,
  isTemplateNode,
  assert,
  isVSlot,
  hasScopeRef,
  isStaticExp
} from '../utils'
import { CREATE_SLOTS, RENDER_LIST, WITH_CTX } from '../runtimeHelpers'
import { parseForExpression, createForLoopParams } from './vFor'
import { SlotFlags, slotFlagsText } from '@vue/shared'

const defaultFallback = createSimpleExpression(`undefined`, false)

// A NodeTransform that:
// 1. Tracks scope identifiers for scoped slots so that they don't get prefixed
//    by transformExpression. This is only applied in non-browser builds with
//    { prefixIdentifiers: true }.
// 2. Track v-slot depths so that we know a slot is inside another slot.
//    Note the exit callback is executed before buildSlots() on the same node,
//    so only nested slots see positive numbers.
export const trackSlotScopes: NodeTransform = (node, context) => {
  //如果节点是元素节点,且标签类型为组件类型或模板类型
  if (node.type === NodeTypes.ELEMENT && (node.tagType === ElementTypes.COMPONENT || node.tagType === ElementTypes.TEMPLATE)) {
    // We are only checking non-empty v-slot here
    // since we only care about slots that introduce scope variables.
    const vSlot = findDir(node, 'slot')
    //如果节点具有插槽指令
    if (vSlot) {
      const slotProps = vSlot.exp
      if (!__BROWSER__ && context.prefixIdentifiers) {
        slotProps && context.addIdentifiers(slotProps)
      }
      context.scopes.vSlot++
      return () => {
        if (!__BROWSER__ && context.prefixIdentifiers) {
          slotProps && context.removeIdentifiers(slotProps)
        }
        context.scopes.vSlot--
      }
    }
  }
}

// A NodeTransform that tracks scope identifiers for scoped slots with v-for.
// This transform is only applied in non-browser builds with { prefixIdentifiers: true }
export const trackVForSlotScopes: NodeTransform = (node, context) => {
  let vFor
  //如果节点为模板元素节点,且节点有插槽指令和for指令
  if (isTemplateNode(node) && node.props.some(isVSlot) && (vFor = findDir(node, 'for'))) {
    const result = (vFor.parseResult = parseForExpression(vFor.exp as SimpleExpressionNode, BaseAudioContext))

    if (result) {
      const { value, key, index } = result
      const { addIdentifiers, removeIdentifiers } = context
      value && addIdentifiers(value)
      key && addIdentifiers(key)
      index && addIdentifiers(index)

      return () => {
        value && removeIdentifiers(value)
        key && removeIdentifiers(key)
        index && removeIdentifiers(index)
      }
    }
  }
}

export type SlotFnBuilder = (
  slotProps: ExpressionNode | undefined,
  slotChildren: TemplateChildNode[],
  loc: SourceLocation
) => FunctionExpression

const buildClientSlotFn: SlotFnBuilder = (props, children, loc) =>
  createFunctionExpression(
    props,
    children,
    false /* newline */,
    true /* isSlot */,
    children.length ? children[0].loc : loc
  )

// Instead of being a DirectiveTransform, v-slot processing is called during
// transformElement to build the slots object for a component.
/**构建插槽, */
export function buildSlots(
  node: ElementNode,
  context: TransformContext,
  buildSlotFn: SlotFnBuilder = buildClientSlotFn
): {
  slots: SlotsExpression
  hasDynamicSlots: boolean
} {

  context.helper(WITH_CTX)

  const { children, loc } = node
  const slotsProperties: Property[] = []
  const dynamicSlots: (ConditionalExpression | CallExpression)[] = []

  /**用于构建{default:(props)=>children,...}的default */
  const buildDefaultSlotProperty = (
    props: ExpressionNode | undefined,
    children: TemplateChildNode[]
  ) => createObjectProperty(`default`, buildSlotFn(props, children, loc))

  // If the slot is inside a v-for or another v-slot, force it to be dynamic
  // since it likely uses a scope variable.
  //如果该插槽位于v-for或另一个v-slot内，请强制它为动态,因为它可能使用范围变量。
  let hasDynamicSlots = context.scopes.vSlot > 0 || context.scopes.vFor > 0
  // with `prefixIdentifiers: true`, this can be further optimized to make
  // it dynamic only when the slot actually uses the scope variables.
  if (!__BROWSER__ && !context.ssr && context.prefixIdentifiers) {
    hasDynamicSlots = hasScopeRef(node, context.identifiers)
  }

  // 1. Check for slot with slotProps on component itself.
  //    <Comp v-slot="{ prop }"/>
  const onComponentSlot = findDir(node, 'slot', true)
  if (onComponentSlot) {
    const { arg, exp } = onComponentSlot
    if (arg && !isStaticExp(arg)) {
      hasDynamicSlots = true
    }
    slotsProperties.push(
      createObjectProperty(
        arg || createSimpleExpression('default', true),
        buildSlotFn(exp, children, loc)
      )
    )
  }

  // 2. Iterate through children and check for template slots
  //    <template v-slot:foo="{ prop }">
  let hasTemplateSlots = false
  let hasNamedDefaultSlot = false
  const implicitDefaultChildren: TemplateChildNode[] = []
  const seenSlotNames = new Set<string>()

  //此循环用于处理children中的<template v-slot>类型的节点(主要是处理有插槽指令的同时有条件插槽或for插槽的情况),如果存在
  for (let i = 0; i < children.length; i++) {
    const slotElement = children[i]
    let slotDir

    if (!isTemplateNode(slotElement) || !(slotDir = findDir(slotElement, 'slot', true))) {
      // not a <template v-slot>, skip. 不是<template v-slot>，将跳过。
      if (slotElement.type !== NodeTypes.COMMENT) {
        implicitDefaultChildren.push(slotElement)
      }
      continue
    }

    //有插槽指令的组件不应该有children
    if (onComponentSlot) {
      // already has on-component slot - this is incorrect usage. 已经具有组件上的插槽-这是不正确的用法。
      context.onError(
        createCompilerError(ErrorCodes.X_V_SLOT_MIXED_SLOT_USAGE, slotDir.loc)
      )
      break
    }

    hasTemplateSlots = true
    const { children: slotChildren, loc: slotLoc } = slotElement
    const {
      arg: slotName = createSimpleExpression(`default`, true),
      exp: slotProps,
      loc: dirLoc
    } = slotDir

    // check if name is dynamic. 检查名称是否为动态。
    let staticSlotName: string | undefined
    if (isStaticExp(slotName)) {
      staticSlotName = slotName ? slotName.content : `default`
    } else {
      hasDynamicSlots = true
    }

    const slotFunction = buildSlotFn(slotProps, slotChildren, slotLoc)
    // check if this slot is conditional (v-if/v-for) 检查此插槽是否是有条件的（v-if /v-for）
    let vIf: DirectiveNode | undefined
    let vElse: DirectiveNode | undefined
    let vFor: DirectiveNode | undefined
    //如果 <template v-slot:name="{prop} v-if="bool">
    if ((vIf = findDir(slotElement, 'if'))) {
      hasDynamicSlots = true //标记有动态插槽
      dynamicSlots.push(
        createConditionalExpression(
          vIf.exp!,
          buildDynamicSlot(slotName, slotFunction),
          defaultFallback
        )else-
      )
    } else if (
      /**
       * 如果 <><template v-slot:name="{prop} v-if="bool">...</template><template v-slot:name2="{prop2} v-else(-if|undefined)=("bool2"|undefined)>...</template></>
       */
      (vElse = findDir(slotElement, /^else(-if)?$/, true /* allowEmpty */))
    ) {
      // find adjacent v-if
      let j = i
      let prev  //上一个不是注释节点的节点
      while (j--) {//跳过注释节点
        prev = children[j]
        if (prev.type !== NodeTypes.COMMENT) {
          break
        }
      }
      if (prev && isTemplateNode(prev) && findDir(prev, 'if')) {
        // remove node
        children.splice(i, 1) //因为要将它附加到先前的条件表达式节点中所以移除
        i--
        __TEST__ && assert(dynamicSlots.length > 0)
        // attach this slot to previous conditional 将此插槽附加到先前的条件
        let conditional = dynamicSlots[dynamicSlots.length - 1] as ConditionalExpression
        while (conditional.alternate.type === NodeTypes.JS_CONDITIONAL_EXPRESSION) {
          conditional = conditional.alternate
        }
        conditional.alternate = vElse.exp //它存在表示指令是v-else-if,那么alternate为一个条件表达式节点
          ? createConditionalExpression(
            vElse.exp,
            buildDynamicSlot(slotName, slotFunction),
            defaultFallback
          )
          : buildDynamicSlot(slotName, slotFunction)
      } else {//有v-else或v-else-if插槽的节点的上一个不是注释节点的节点没有v-if插槽,抛个错误
        context.onError(
          createCompilerError(ErrorCodes.X_V_ELSE_NO_ADJACENT_IF, vElse.loc)
        )
      }
    } else if ((vFor = findDir(slotElement, 'for'))) {//如果 <template v-slot:name="{prop} v-for="(item,key) in source" :key="key">...</template>
      hasDynamicSlots = true
      const parseResult = vFor.parseResult || parseForExpression(vFor.exp as SimpleExpressionNode, context)
      if (parseResult) {
        // Render the dynamic slots as an array and add it to the createSlot()
        // args. The runtime knows how to handle it appropriately.
        dynamicSlots.push(
          createCallExpression(context.helper(RENDER_LIST), [
            parseResult.source,
            createFunctionExpression(
              createForLoopParams(parseResult),
              buildDynamicSlot(slotName, slotFunction),
              true /* force newline */
            )
          ])
        )
      } else {
        context.onError(
          createCompilerError(ErrorCodes.X_V_FOR_MALFORMED_EXPRESSION, vFor.loc)
        )
      }
    } else {
      // check duplicate static names 
      if (staticSlotName) {
        if (seenSlotNames.has(staticSlotName)) {//检查重复
          context.onError(
            createCompilerError(
              ErrorCodes.X_V_SLOT_DUPLICATE_SLOT_NAMES,
              dirLoc
            )
          )
          continue
        }
        seenSlotNames.add(staticSlotName)
        if (staticSlotName === 'default') {
          hasNamedDefaultSlot = true
        }
      }
      slotsProperties.push(createObjectProperty(slotName, slotFunction))
    }
  }

  //构建默认插槽
  if (!onComponentSlot) {
    if (!hasTemplateSlots) {
      // implicit default slot (on component) 隐式默认插槽（在组件上）
      slotsProperties.push(buildDefaultSlotProperty(undefined, children))
    } else if (implicitDefaultChildren.length) {
      // implicit default slot (mixed with named slots) 隐式默认插槽（与命名插槽混合）
      /**
       * 例如:
       * <Comp>
       *    <div>...</div>
       *    <template v-slot:default>...</template>
       * </Comp>
       */
      if (hasNamedDefaultSlot) {
        context.onError(
          createCompilerError(
            ErrorCodes.X_V_SLOT_EXTRANEOUS_DEFAULT_SLOT_CHILDREN,
            implicitDefaultChildren[0].loc
          )
        )
      } else {
        slotsProperties.push(
          buildDefaultSlotProperty(undefined, implicitDefaultChildren)
        )
      }
    }
  }

  const slotFlag = hasDynamicSlots
    ? SlotFlags.DYNAMIC
    : hasForwardedSlots(node.children)
      ? SlotFlags.FORWARDED //<Comp><div>...<slot></slot></div></Comp>
      : SlotFlags.STABLE

  let slots = createObjectExpression(
    slotsProperties.concat(
      createObjectProperty(
        `_`,
        // 2 = compiled but dynamic = can skip normalization, but must run diff
        // 1 = compiled and static = can skip normalization AND diff as optimized
        createSimpleExpression(
          slotFlag + (__DEV__ ? ` /* ${slotFlagsText[slotFlag]} */` : ``),
          false
        )
      )
    ),
    loc
  ) as SlotsExpression
  if (dynamicSlots.length) {
    slots = createCallExpression(context.helper(CREATE_SLOTS), [
      slots,
      createArrayExpression(dynamicSlots)
    ]) as SlotsExpression
  }

  return {
    slots,
    hasDynamicSlots
  }
}

/**构建动态插槽,返回表示{name:"...",fn:func}的ObjectExpression */
function buildDynamicSlot(
  name: ExpressionNode, //表示插槽名的ExpressionNode
  fn: FunctionExpression //表示插槽函数的FunctionExpression
): ObjectExpression {
  return createObjectExpression([
    createObjectProperty(`name`, name),
    createObjectProperty(`fn`, fn)
  ])
}

/**判断子孙节点中是否有标签类型为ElementTypes.SLOT的节点 */
function hasForwardedSlots(children: TemplateChildNode[]): boolean {
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    if (child.type === NodeTypes.ELEMENT) {
      if (
        child.tagType === ElementTypes.SLOT ||
        (child.tagType === ElementTypes.ELEMENT &&
          hasForwardedSlots(child.children))
      ) {
        return true
      }
    }
  }
  return false
}
