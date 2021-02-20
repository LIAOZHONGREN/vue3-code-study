import { NodeTransform, TransformContext } from '../transform'
import {
  NodeTypes,
  ElementTypes,
  CallExpression,
  ObjectExpression,
  ElementNode,
  DirectiveNode,
  ExpressionNode,
  ArrayExpression,
  createCallExpression,
  createArrayExpression,
  createObjectProperty,
  createSimpleExpression,
  createObjectExpression,
  Property,
  ComponentNode,
  VNodeCall,
  TemplateTextChildNode,
  DirectiveArguments,
  createVNodeCall,
  ConstantTypes
} from '../ast'
import {
  PatchFlags,
  PatchFlagNames,
  isSymbol,
  isOn,
  isObject,
  isReservedProp,
  capitalize,
  camelize
} from '@vue/shared'
import { createCompilerError, ErrorCodes } from '../errors'
import {
  RESOLVE_DIRECTIVE,
  RESOLVE_COMPONENT,
  RESOLVE_DYNAMIC_COMPONENT,
  MERGE_PROPS,
  TO_HANDLERS,
  TELEPORT,
  KEEP_ALIVE,
  SUSPENSE,
  UNREF
} from '../runtimeHelpers'
import {
  getInnerRange,
  toValidAssetId,
  findProp,
  isCoreComponent,
  isBindKey,
  findDir,
  isStaticExp
} from '../utils'
import { buildSlots } from './vSlot'
import { getConstantType } from './hoistStatic'
import { BindingTypes } from '../options'

// some directive transforms (e.g. v-model) may return a symbol for runtime
// import, which should be used instead of a resolveDirective call.
const directiveImportMap = new WeakMap<DirectiveNode, symbol>()

// generate a JavaScript AST for this element's codegen 为此元素的代码生成一个JavaScript AST
/**创建VNodelCall赋值node.codegenNode */
export const transformElement: NodeTransform = (node, context) => {
  //如果节点的节点类型不是元素,或节点类型是元素但是元素类型不是普通元素或组件就退出转换
  if (!(node.type === NodeTypes.ELEMENT && (node.tagType === ElementTypes.ELEMENT || node.tagType === ElementTypes.COMPONENT))) {
    return
  }
  // perform the work on exit, after all child expressions have been
  // processed and merged.
  //在处理并合并所有子表达式之后，执行退出工作。
  return function postTransformElement() {
    const { tag, props } = node
    const isComponent = node.tagType === ElementTypes.COMPONENT

    // The goal of the transform is to create a codegenNode implementing the
    // VNodeCall interface.
    //转换的目标是创建一个实现VNodeCall接口的codegenNode
    const vnodeTag = isComponent ? resolveComponentType(node as ComponentNode, context) : `"${tag}"`
    const isDynamicComponent = isObject(vnodeTag) && vnodeTag.callee === RESOLVE_DYNAMIC_COMPONENT

    let vnodeProps: VNodeCall['props']
    let vnodeChildren: VNodeCall['children']
    let vnodePatchFlag: VNodeCall['patchFlag']
    let patchFlag: number = 0
    let vnodeDynamicProps: VNodeCall['dynamicProps']
    let dynamicPropNames: string[] | undefined
    let vnodeDirectives: VNodeCall['directives']

    //使用Block(使用块的模式创建抽象节点)
    let shouldUseBlock =
      // dynamic component may resolve to plain elements
      isDynamicComponent ||
      vnodeTag === TELEPORT ||
      vnodeTag === SUSPENSE ||
      (!isComponent &&
        // <svg> and <foreignObject> must be forced into blocks so that block
        // updates inside get proper isSVG flag at runtime. (#639, #643)
        // This is technically web-specific, but splitting the logic out of core
        // leads to too much unnecessary complexity.
        (tag === 'svg' ||
          tag === 'foreignObject' ||
          // #938: elements with dynamic keys should be forced into blocks
          findProp(node, 'key', true)))

    // props
    if (props.length > 0) {
      const propsBuildResult = buildProps(node, context)
      vnodeProps = propsBuildResult.props
      patchFlag = propsBuildResult.patchFlag
      dynamicPropNames = propsBuildResult.dynamicPropNames
      const directives = propsBuildResult.directives
      vnodeDirectives =
        directives && directives.length
          ? (createArrayExpression( directives.map(dir => buildDirectiveArgs(dir, context))) as DirectiveArguments)
          : undefined
    }

    // children
    if (node.children.length > 0) {
      if (vnodeTag === KEEP_ALIVE) {
        // Although a built-in component, we compile KeepAlive with raw children
        // instead of slot functions so that it can be used inside Transition
        // or other Transition-wrapping HOCs.
        // To ensure correct updates with block optimizations, we need to:
        // 1. Force keep-alive into a block. This avoids its children being
        //    collected by a parent block.
        shouldUseBlock = true
        // 2. Force keep-alive to always be updated, since it uses raw children.
        patchFlag |= PatchFlags.DYNAMIC_SLOTS
        if (__DEV__ && node.children.length > 1) {
          context.onError(
            createCompilerError(ErrorCodes.X_KEEP_ALIVE_INVALID_CHILDREN, {
              start: node.children[0].loc.start,
              end: node.children[node.children.length - 1].loc.end,
              source: ''
            })
          )
        }
      }

      // 应该作为插槽来构建
      const shouldBuildAsSlots =
        isComponent &&
        // Teleport is not a real component and has dedicated runtime handling 传送不是一个真正的组件，有专门的运行时处理
        vnodeTag !== TELEPORT &&
        // explained above. 如上所述
        vnodeTag !== KEEP_ALIVE

      if (shouldBuildAsSlots) {
        const { slots, hasDynamicSlots } = buildSlots(node, context)
        vnodeChildren = slots
        if (hasDynamicSlots) {
          patchFlag |= PatchFlags.DYNAMIC_SLOTS
        }
      } else if (node.children.length === 1 && vnodeTag !== TELEPORT) {
        const child = node.children[0]
        const type = child.type
        // check for dynamic text children 检查动态文本子项
        const hasDynamicTextChild =
          type === NodeTypes.INTERPOLATION ||
          type === NodeTypes.COMPOUND_EXPRESSION
        if (
          hasDynamicTextChild &&
          getConstantType(child, context) === ConstantTypes.NOT_CONSTANT
        ) {
          patchFlag |= PatchFlags.TEXT
        }
        // pass directly if the only child is a text node 如果唯一的子节点是文本节点，则直接传递
        // (plain / interpolation / expression)
        if (hasDynamicTextChild || type === NodeTypes.TEXT) {
          vnodeChildren = child as TemplateTextChildNode
        } else {
          vnodeChildren = node.children
        }
      } else {
        vnodeChildren = node.children
      }
    }

    // patchFlag & dynamicPropNames
    if (patchFlag !== 0) {
      if (__DEV__) {
        if (patchFlag < 0) {
          // special flags (negative and mutually exclusive)
          vnodePatchFlag = patchFlag + ` /* ${PatchFlagNames[patchFlag]} */`
        } else {
          // bitwise flags
          const flagNames = Object.keys(PatchFlagNames)
            .map(Number)
            .filter(n => n > 0 && patchFlag & n)
            .map(n => PatchFlagNames[n])
            .join(`, `)
          vnodePatchFlag = patchFlag + ` /* ${flagNames} */`
        }
      } else {
        vnodePatchFlag = String(patchFlag)
      }
      if (dynamicPropNames && dynamicPropNames.length) {
        vnodeDynamicProps = stringifyDynamicPropNames(dynamicPropNames)
      }
    }

    node.codegenNode = createVNodeCall(
      context,
      vnodeTag,
      vnodeProps,
      vnodeChildren,
      vnodePatchFlag,
      vnodeDynamicProps,
      vnodeDirectives,
      !!shouldUseBlock,
      false /* disableTracking */,
      node.loc
    )
  }
}

/**
 * 解析组件类型:
 * 动态组件:返回:CallExpression;
 * 内置组件:返回对应内置组件的runtimeHelper
 * setup方法中定义的组件:返回变换后的字符串($setup[...],unRef(...)等等)
 * 自引用组件(组件中使用自身):执行context.components.add(`_self`)和返回'component_self'
 * 自定义组件:执行context.components.add(tag)和返回'component_标签名'
 */
export function resolveComponentType(
  node: ComponentNode,
  context: TransformContext,
  ssr = false
) {
  const { tag } = node

  // 1. dynamic component 组件节点是有is(<component is="组件名">属性或v-is(<div v-is="组件名">)的动态组件
  const isProp = node.tag === 'component' ? findProp(node, 'is') : findDir(node, 'is')
  if (isProp) {
    const exp =
      isProp.type === NodeTypes.ATTRIBUTE
        ? isProp.value && createSimpleExpression(isProp.value.content, true)
        : isProp.exp
    if (exp) {
      return createCallExpression(context.helper(RESOLVE_DYNAMIC_COMPONENT), [
        exp
      ])
    }
  }

  // 2. built-in components (Teleport, Transition, KeepAlive, Suspense...) 组件节点表示的是内置组件
  const builtIn = isCoreComponent(tag) || context.isBuiltInComponent(tag)
  if (builtIn) {
    // built-ins are simply fallthroughs / have special handling during ssr
    // so we don't need to import their runtime equivalents
    if (!ssr) context.helper(builtIn)
    return builtIn
  }

  // 3. user component (from setup bindings) 在setup方法中定义的组件
  // this is skipped in browser build since browser builds do not perform
  // binding analysis.
  if (!__BROWSER__) {
    const fromSetup = resolveSetupReference(tag, context)
    if (fromSetup) {
      return fromSetup
    }
  }

  // 4. Self referencing component (inferred from filename) 自引用组件
  if (!__BROWSER__ && context.selfName) {
    if (capitalize(camelize(tag)) === context.selfName) {
      context.helper(RESOLVE_COMPONENT)
      context.components.add(`_self`)
      return toValidAssetId(`_self`, `component`)
    }
  }

  // 5. user component (resolve)  自定义组件
  context.helper(RESOLVE_COMPONENT)
  context.components.add(tag)
  return toValidAssetId(tag, `component`)
}

/**
 * 根据根据名称判断数据的数据来源类型,如果数据来源是setup方法中定义常量值,是内联类型就返回原名,驼峰或首字母大写处理过的名称,
 * 不然就返回'$setup[...(原名,驼峰或首字母大写处理过的名称字符)]';
 * 如果如果数据来源是setup方法中定义的变量,ref或ref()处理的数据,是内联类型就返回'unRef(...)',不然返回'$setup[...]'
 *  */
function resolveSetupReference(name: string, context: TransformContext) {
  const bindings = context.bindingMetadata
  if (!bindings) {
    return
  }

  const camelName = camelize(name)
  const PascalName = capitalize(camelName)
  const checkType = (type: BindingTypes) => {
    if (bindings[name] === type) {
      return name
    }
    if (bindings[camelName] === type) {
      return camelName
    }
    if (bindings[PascalName] === type) {
      return PascalName
    }
  }

  const fromConst = checkType(BindingTypes.SETUP_CONST)
  if (fromConst) {
    return context.inline
      ? // in inline mode, const setup bindings (e.g. imports) can be used as-is
      fromConst
      : `$setup[${JSON.stringify(fromConst)}]`
  }

  const fromMaybeRef =
    checkType(BindingTypes.SETUP_LET) ||
    checkType(BindingTypes.SETUP_REF) ||
    checkType(BindingTypes.SETUP_MAYBE_REF)
  if (fromMaybeRef) {
    return context.inline
      ? // setup scope bindings that may be refs need to be unrefed
      `${context.helperString(UNREF)}(${fromMaybeRef})`
      : `$setup[${JSON.stringify(fromMaybeRef)}]`
  }
}

export type PropsExpression = ObjectExpression | CallExpression | ExpressionNode

/**把props: Array<AttributeNode | DirectiveNode>处理成{props: PropsExpression | undefined,directives: DirectiveNode[],patchFlag: number,dynamicPropNames: string[]} */
export function buildProps(
  node: ElementNode,
  context: TransformContext,
  props: ElementNode['props'] = node.props,
  ssr = false
): {
  props: PropsExpression | undefined //...
  directives: DirectiveNode[] //指令节点数组
  patchFlag: number           //元素节点的静态标记
  dynamicPropNames: string[]  //元素节点的动态的prop名称数组
} {
  const { tag, loc: elementLoc } = node
  const isComponent = node.tagType === ElementTypes.COMPONENT
  let properties: ObjectExpression['properties'] = []
  const mergeArgs: PropsExpression[] = []
  const runtimeDirectives: DirectiveNode[] = []

  // patchFlag analysis
  let patchFlag = 0
  let hasRef = false
  let hasClassBinding = false
  let hasStyleBinding = false
  let hasHydrationEventBinding = false
  let hasDynamicKeys = false
  let hasVnodeHook = false
  const dynamicPropNames: string[] = []

  //分析PatchFlag
  const analyzePatchFlag = ({ key, value }: Property) => {
    //属性key是一个静态的SimpleExpressionNode
    if (isStaticExp(key)) {
      const name = key.content          //key名称
      const isEventHandler = isOn(name) //判断key名称是否是事件名

      //如果元素节点不是组件节点,key是事件名,
      if (
        !isComponent &&
        isEventHandler &&
        // omit the flag for click handlers because hydration gives click
        // dedicated fast path. 省略click处理程序的标志，因为它提供了click专用的快速捷径。
        name.toLowerCase() !== 'onclick' &&
        // omit v-model handlers 
        name !== 'onUpdate:modelValue' &&
        // omit onVnodeXXX hooks  排除抽象节点hooks
        !isReservedProp(name)
      ) {
        hasHydrationEventBinding = true //元素节点有基础的事件绑定
      }

      if (isEventHandler && isReservedProp(name)) {
        hasVnodeHook = true   //元素有抽象节点的hook绑定
      }

      if (
        value.type === NodeTypes.JS_CACHE_EXPRESSION ||
        ((value.type === NodeTypes.SIMPLE_EXPRESSION ||
          value.type === NodeTypes.COMPOUND_EXPRESSION) &&
          getConstantType(value, context) > 0)
      ) {
        // skip if the prop is a cached handler or has constant value 如果prop是缓存的处理程序或具有恒定值，则跳过
        return
      }
      if (name === 'ref') {
        hasRef = true  //元素节点有ref绑定
      } else if (name === 'class' && !isComponent) {
        hasClassBinding = true //元素节点有class绑定
      } else if (name === 'style' && !isComponent) {
        hasStyleBinding = true //元素节点有style绑定
      } else if (name !== 'key' && !dynamicPropNames.includes(name)) {
        dynamicPropNames.push(name)
      }
    } else {
      hasDynamicKeys = true
    }
  }

  for (let i = 0; i < props.length; i++) {
    // static attribute 静态属性
    const prop = props[i]
    //属性类型
    if (prop.type === NodeTypes.ATTRIBUTE) {
      const { loc, name, value } = prop
      let isStatic = true
      if (name === 'ref') {
        hasRef = true
        // in inline mode there is no setupState object, so we can't use string
        // keys to set the ref. Instead, we need to transform it to pass the
        // acrtual ref instead. 在内联模式中没有setupState对象，因此我们不能使用字符串键来设置ref。相反，我们需要将其转换为传递acrual ref
        if (!__BROWSER__ && context.inline) {
          isStatic = false
        }
      }
      // skip :is on <component>
      if (name === 'is' && tag === 'component') {
        continue
      }
      properties.push(
        createObjectProperty(
          createSimpleExpression(
            name,
            true,
            getInnerRange(loc, 0, name.length)
          ),
          createSimpleExpression(
            value ? value.content : '',
            isStatic,
            value ? value.loc : loc
          )
        )
      )
    } else {//指令类型
      // directives
      const { name, arg, exp, loc } = prop
      const isBind = name === 'bind'
      const isOn = name === 'on'

      // skip v-slot - it is handled by its dedicated transform. 跳过v-slot 它由其专用转换处理
      if (name === 'slot') {
        if (!isComponent) {
          context.onError(
            createCompilerError(ErrorCodes.X_V_SLOT_MISPLACED, loc)
          )
        }
        continue
      }
      // skip v-once - it is handled by its dedicated transform. 跳过v-once 它由其专用转换处理。
      if (name === 'once') {
        continue
      }
      // skip v-is and :is on <component> 跳过 v-is 和 :is(v-bind:is)
      if (
        name === 'is' ||
        (isBind && tag === 'component' && isBindKey(arg, 'is'))
      ) {
        continue
      }
      // skip v-on in SSR compilation 在SSR编译中跳过v-on
      if (isOn && ssr) {
        continue
      }

      // special case for v-bind and v-on with no argument v-bind和v-on的特殊情况，不带绑定属性
      if (!arg && (isBind || isOn)) {
        hasDynamicKeys = true
        if (exp) {
          if (properties.length) {
            mergeArgs.push(
              createObjectExpression(dedupeProperties(properties), elementLoc)
            )
            properties = []
          }
          if (isBind) {
            mergeArgs.push(exp)
          } else {
            // v-on="obj" -> toHandlers(obj)
            mergeArgs.push({
              type: NodeTypes.JS_CALL_EXPRESSION,
              loc,
              callee: context.helper(TO_HANDLERS),
              arguments: [exp]
            })
          }
        } else {
          context.onError(
            createCompilerError(
              isBind
                ? ErrorCodes.X_V_BIND_NO_EXPRESSION
                : ErrorCodes.X_V_ON_NO_EXPRESSION,
              loc
            )
          )
        }
        continue
      }

      const directiveTransform = context.directiveTransforms[name]
      if (directiveTransform) {
        // has built-in directive transform. 具有内置的指令转换。
        const { props, needRuntime } = directiveTransform(prop, node, context)
        !ssr && props.forEach(analyzePatchFlag)
        properties.push(...props)
        if (needRuntime) {
          runtimeDirectives.push(prop)
          if (isSymbol(needRuntime)) {
            directiveImportMap.set(prop, needRuntime)
          }
        }
      } else {
        // no built-in transform, this is a user custom directive. 没有内置的转换，这是一个用户自定义指令。
        runtimeDirectives.push(prop)
      }
    }
  }

  let propsExpression: PropsExpression | undefined = undefined

  // has v-bind="object" or v-on="object", wrap with mergeProps
  if (mergeArgs.length) {
    if (properties.length) {
      mergeArgs.push(
        createObjectExpression(dedupeProperties(properties), elementLoc)
      )
    }
    if (mergeArgs.length > 1) {
      propsExpression = createCallExpression(
        context.helper(MERGE_PROPS),
        mergeArgs,
        elementLoc
      )
    } else {
      // single v-bind with nothing else - no need for a mergeProps call
      propsExpression = mergeArgs[0]
    }
  } else if (properties.length) {
    propsExpression = createObjectExpression(
      dedupeProperties(properties),
      elementLoc
    )
  }

  // patchFlag analysis
  if (hasDynamicKeys) {
    patchFlag |= PatchFlags.FULL_PROPS
  } else {
    if (hasClassBinding) {
      patchFlag |= PatchFlags.CLASS
    }
    if (hasStyleBinding) {
      patchFlag |= PatchFlags.STYLE
    }
    if (dynamicPropNames.length) {
      patchFlag |= PatchFlags.PROPS
    }
    if (hasHydrationEventBinding) {
      patchFlag |= PatchFlags.HYDRATE_EVENTS
    }
  }
  if (
    (patchFlag === 0 || patchFlag === PatchFlags.HYDRATE_EVENTS) &&
    (hasRef || hasVnodeHook || runtimeDirectives.length > 0)
  ) {
    patchFlag |= PatchFlags.NEED_PATCH
  }

  return {
    props: propsExpression,
    directives: runtimeDirectives,
    patchFlag,
    dynamicPropNames
  }
}

// Dedupe props in an object literal.
// Literal duplicated attributes would have been warned during the parse phase,
// however, it's possible to encounter duplicated `onXXX` handlers with different
// modifiers. We also need to merge static and dynamic class / style attributes.
// - onXXX handlers / style: merge into array
// - class: merge into single expression with concatenation
//文本重复的属性在解析阶段会被警告，但是，可能会遇到具有不同修饰符的重复的“onXXX”处理程序。我们还需要合并静态和动态类/样式属性。-onXXX处理程序样式：合并到数组中 -类：合并到带有串联的单个表达式中
function dedupeProperties(properties: Property[]): Property[] {
  const knownProps: Map<string, Property> = new Map()
  const deduped: Property[] = []
  for (let i = 0; i < properties.length; i++) {
    const prop = properties[i]
    // dynamic keys are always allowed 始终允许使用动态键
    if (prop.key.type === NodeTypes.COMPOUND_EXPRESSION || !prop.key.isStatic) {
      deduped.push(prop)
      continue
    }
    const name = prop.key.content
    const existing = knownProps.get(name)
    if (existing) {
      if (name === 'style' || name === 'class' || name.startsWith('on')) {
        mergeAsArray(existing, prop)
      }
      // unexpected duplicate, should have emitted error during parse
    } else {
      knownProps.set(name, prop)
      deduped.push(prop)
    }
  }
  return deduped
}

/**把existing.value和incoming.value(SimpleExpressionNode)合并成ArrayExpression */
function mergeAsArray(existing: Property, incoming: Property) {
  if (existing.value.type === NodeTypes.JS_ARRAY_EXPRESSION) {
    existing.value.elements.push(incoming.value)
  } else {
    existing.value = createArrayExpression(
      [existing.value, incoming.value],
      existing.loc
    )
  }
}

/**构建指令参数(DirectiveArgumentNode) */
function buildDirectiveArgs(
  dir: DirectiveNode,
  context: TransformContext
): ArrayExpression {
  const dirArgs: ArrayExpression['elements'] = []
  const runtime = directiveImportMap.get(dir)
  if (runtime) {
    // built-in directive with runtime
    dirArgs.push(context.helperString(runtime))
  } else {
    // user directive.
    // see if we have directives exposed via <script setup>
    const fromSetup = !__BROWSER__ && resolveSetupReference(dir.name, context)
    if (fromSetup) {
      dirArgs.push(fromSetup)
    } else {
      // inject statement for resolving directive
      context.helper(RESOLVE_DIRECTIVE)
      context.directives.add(dir.name)
      dirArgs.push(toValidAssetId(dir.name, `directive`))
    }
  }
  const { loc } = dir
  if (dir.exp) dirArgs.push(dir.exp)
  if (dir.arg) {
    if (!dir.exp) {
      dirArgs.push(`void 0`)
    }
    dirArgs.push(dir.arg)
  }
  if (Object.keys(dir.modifiers).length) {
    if (!dir.arg) {
      if (!dir.exp) {
        dirArgs.push(`void 0`)
      }
      dirArgs.push(`void 0`)
    }
    const trueExpression = createSimpleExpression(`true`, false, loc)
    dirArgs.push(
      createObjectExpression(
        dir.modifiers.map(modifier =>
          createObjectProperty(modifier, trueExpression)
        ),
        loc
      )
    )
  }
  return createArrayExpression(dirArgs, dir.loc)
}

/**string[] to '[,,,]' */
function stringifyDynamicPropNames(props: string[]): string {
  let propsNamesString = `[`
  for (let i = 0, l = props.length; i < l; i++) {
    propsNamesString += JSON.stringify(props[i])
    if (i < l - 1) propsNamesString += ', '
  }
  return propsNamesString + `]`
}
