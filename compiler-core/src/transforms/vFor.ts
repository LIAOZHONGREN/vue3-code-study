import {
  createStructuralDirectiveTransform,
  TransformContext
} from '../transform'
import {
  NodeTypes,
  ExpressionNode,
  createSimpleExpression,
  SourceLocation,
  SimpleExpressionNode,
  createCallExpression,
  createFunctionExpression,
  createObjectExpression,
  createObjectProperty,
  ForCodegenNode,
  RenderSlotCall,
  SlotOutletNode,
  ElementNode,
  DirectiveNode,
  ForNode,
  PlainElementNode,
  createVNodeCall,
  VNodeCall,
  ForRenderListExpression,
  BlockCodegenNode,
  ForIteratorExpression
} from '../ast'
import { createCompilerError, ErrorCodes } from '../errors'
import {
  getInnerRange,
  findProp,
  isTemplateNode,
  isSlotOutlet,
  injectProp
} from '../utils'
import {
  RENDER_LIST,
  OPEN_BLOCK,
  CREATE_BLOCK,
  FRAGMENT,
  CREATE_VNODE
} from '../runtimeHelpers'
import { processExpression } from './transformExpression'
import { validateBrowserExpression } from '../validateExpression'
import { PatchFlags, PatchFlagNames } from '@vue/shared'

export const transformFor = createStructuralDirectiveTransform(
  'for',
  (node, dir, context) => {
    const { helper } = context
    return processFor(node, dir, context, forNode => {
      // create the loop render function expression now, and add the
      // iterator on exit after all children have been traversed
      const renderExp = createCallExpression(helper(RENDER_LIST), [forNode.source]) as ForRenderListExpression
      const keyProp = findProp(node, `key`)
      const keyProperty = keyProp ? createObjectProperty(`key`, keyProp.type === NodeTypes.ATTRIBUTE ? createSimpleExpression(keyProp.value!.content, true) : keyProp.exp!) : null

      if (!__BROWSER__ && context.prefixIdentifiers && keyProperty) {
        // #2085 process :key expression needs to be processed in order for it
        // to behave consistently for <template v-for> and <div v-for>.
        // In the case of `<template v-for>`, the node is discarded and never
        // traversed so its key expression won't be processed by the normal
        // transforms.
        keyProperty.value = processExpression(
          keyProperty.value as SimpleExpressionNode,
          context
        )
      }

      const isStableFragment = forNode.source.type === NodeTypes.SIMPLE_EXPRESSION && forNode.source.constType > 0
      const fragmentFlag = isStableFragment ? PatchFlags.STABLE_FRAGMENT : keyProp ? PatchFlags.KEYED_FRAGMENT : PatchFlags.UNKEYED_FRAGMENT
      forNode.codegenNode = createVNodeCall(
        context,
        helper(FRAGMENT),
        undefined,
        renderExp,
        fragmentFlag +
        (__DEV__ ? ` /* ${PatchFlagNames[fragmentFlag]} */` : ``),
        undefined,
        undefined,
        true /* isBlock */,
        !isStableFragment /* disableTracking */,
        node.loc
      ) as ForCodegenNode

      return () => {
        // finish the codegen now that all children have been traversed 完成遍历所有子代的代码生成
        let childBlock: BlockCodegenNode
        const isTemplate = isTemplateNode(node)
        const { children } = forNode

        // check <template v-for> key placement
        if ((__DEV__ || !__BROWSER__) && isTemplate) {
          node.children.some(c => {
            if (c.type === NodeTypes.ELEMENT) {
              const key = findProp(c, 'key')
              if (key) {
                context.onError(
                  createCompilerError(
                    ErrorCodes.X_V_FOR_TEMPLATE_KEY_PLACEMENT,
                    key.loc
                  )
                )
                return true
              }
            }
          })
        }

        const needFragmentWrapper = children.length !== 1 || children[0].type !== NodeTypes.ELEMENT
        //node是<slot v-for="..."> 或 <template v-for="..."><slot/></template>
        const slotOutlet = isSlotOutlet(node) ? node  : isTemplate && node.children.length === 1 &&  isSlotOutlet(node.children[0])
            ? (node.children[0] as SlotOutletNode) // api-extractor somehow fails to infer this
            : null

        if (slotOutlet) {
          // <slot v-for="..."> or <template v-for="..."><slot/></template>
          childBlock = slotOutlet.codegenNode as RenderSlotCall
          if (isTemplate && keyProperty) {
            // <template v-for="..." :key="..."><slot/></template>
            // we need to inject the key to the renderSlot() call.
            // the props for renderSlot is passed as the 3rd argument.
            injectProp(childBlock, keyProperty, context)
          }
        } else if (needFragmentWrapper) {
          // <template v-for="..."> with text or multi-elements
          // should generate a fragment block for each loop
          childBlock = createVNodeCall(
            context,
            helper(FRAGMENT),
            keyProperty ? createObjectExpression([keyProperty]) : undefined,
            node.children,
            PatchFlags.STABLE_FRAGMENT +
            (__DEV__
              ? ` /* ${PatchFlagNames[PatchFlags.STABLE_FRAGMENT]} */`
              : ``),
            undefined,
            undefined,
            true
          )
        } else {
          // Normal element v-for. Directly use the child's codegenNode
          // but mark it as a block.
          childBlock = (children[0] as PlainElementNode)
            .codegenNode as VNodeCall
          if (isTemplate && keyProperty) {
            injectProp(childBlock, keyProperty, context)
          }
          childBlock.isBlock = !isStableFragment
          if (childBlock.isBlock) {
            helper(OPEN_BLOCK)
            helper(CREATE_BLOCK)
          } else {
            helper(CREATE_VNODE)
          }
        }

        renderExp.arguments.push(createFunctionExpression(
          createForLoopParams(forNode.parseResult),
          childBlock,
          true /* force newline */
        ) as ForIteratorExpression)
      }
    })
  }
)

// target-agnostic transform used for both Client and SSR
/**创建ForNode把node替换... */
export function processFor(
  node: ElementNode,
  dir: DirectiveNode,
  context: TransformContext,
  processCodegen?: (forNode: ForNode) => (() => void) | undefined
) {

  //<div v-for >...</div> :报错
  if (!dir.exp) {
    context.onError(
      createCompilerError(ErrorCodes.X_V_FOR_NO_EXPRESSION, dir.loc)
    )
    return
  }

  //<div v-for="item,key,item in source" >...</div>:解析item,key,item in source
  const parseResult = parseForExpression(
    // can only be simple expression because vFor transform is applied
    // before expression transform.
    dir.exp as SimpleExpressionNode,
    context
  )

  if (!parseResult) {
    context.onError(
      createCompilerError(ErrorCodes.X_V_FOR_MALFORMED_EXPRESSION, dir.loc)
    )
    return
  }

  const { addIdentifiers, removeIdentifiers, scopes } = context
  const { source, value, key, index } = parseResult

  const forNode: ForNode = {
    type: NodeTypes.FOR,
    loc: dir.loc,
    source,
    valueAlias: value,
    keyAlias: key,
    objectIndexAlias: index,
    parseResult,
    children: isTemplateNode(node) ? node.children : [node]
  }

  //把当前解析的有for指令的节点替换成ForNode
  context.replaceNode(forNode)

  // bookkeeping
  scopes.vFor++ //记录ForNode的深度(ForNode的嵌套层:例如:<div v-for="item in source">...<div v-for="item in source">...</div></div>)
  if (!__BROWSER__ && context.prefixIdentifiers) {
    // scope management
    // inject identifiers to context
    value && addIdentifiers(value)
    key && addIdentifiers(key)
    index && addIdentifiers(index)
  }

  const onExit = processCodegen && processCodegen(forNode)

  return () => {
    scopes.vFor-- //解析完一层就减一
    if (!__BROWSER__ && context.prefixIdentifiers) {
      value && removeIdentifiers(value)
      key && removeIdentifiers(key)
      index && removeIdentifiers(index)
    }
    if (onExit) onExit()
  }
}

const forAliasRE = /([\s\S]*?)\s+(?:in|of)\s+([\s\S]*)/
// This regex doesn't cover the case if key or index aliases have destructuring,
// but those do not make sense in the first place, so this works in practice.
const forIteratorRE = /,([^,\}\]]*)(?:,([^,\}\]]*))?$/
const stripParensRE = /^\(|\)$/g


export interface ForParseResult {
  source: ExpressionNode  //"item in value":source表示value
  value: ExpressionNode | undefined
  key: ExpressionNode | undefined
  index: ExpressionNode | undefined
}


/**
 * 把SimpleExpressionNode解析成ForParseResult,
 * 例子:SimpleExpressionNode.content为"(item,index) in value","item in value"或"(item,key,index) in value",
 * 那么解析出:
 * {
  source: ExpressionNode.content为"value"
  value: undefined|ExpressionNode.content为"item"
  key: undefined|ExpressionNode.content为"key"
  index: undefined|ExpressionNode.content为"index"
}
 * */
export function parseForExpression(
  input: SimpleExpressionNode,
  context: TransformContext
): ForParseResult | undefined {
  const loc = input.loc
  const exp = input.content //例子:exp为"(item,index) in value"
  const inMatch = exp.match(forAliasRE)
  if (!inMatch) return

  //例子:"(item,index) in value",LHS为"(item,index)",RHS为"value"
  const [, LHS, RHS] = inMatch

  const result: ForParseResult = {
    //source:例子:"(item,index) in value",source为表示"value"的SimpleExpressionNode
    source: createAliasExpression(
      loc,
      RHS.trim(),
      exp.indexOf(RHS, LHS.length)
    ),
    value: undefined,
    key: undefined,
    index: undefined
  }

  if (!__BROWSER__ && context.prefixIdentifiers) {
    result.source = processExpression(
      result.source as SimpleExpressionNode,
      context
    )
  }
  if (__DEV__ && __BROWSER__) {
    validateBrowserExpression(result.source as SimpleExpressionNode, context)
  }
  //去掉'('和')'后再去掉两端空格.例如:"( item,index ) in value",valueContent为"item,index"
  let valueContent = LHS.trim().replace(stripParensRE, '').trim()
  const trimmedOffset = LHS.indexOf(valueContent)

  /** ......解析 key和index..... */
  const iteratorMatch = valueContent.match(forIteratorRE)
  if (iteratorMatch) {
    valueContent = valueContent.replace(forIteratorRE, '').trim()

    const keyContent = iteratorMatch[1].trim()
    let keyOffset: number | undefined
    if (keyContent) {
      keyOffset = exp.indexOf(keyContent, trimmedOffset + valueContent.length)
      result.key = createAliasExpression(loc, keyContent, keyOffset)
      if (!__BROWSER__ && context.prefixIdentifiers) {
        result.key = processExpression(result.key, context, true)
      }
      if (__DEV__ && __BROWSER__) {
        validateBrowserExpression(
          result.key as SimpleExpressionNode,
          context,
          true
        )
      }
    }

    if (iteratorMatch[2]) {
      const indexContent = iteratorMatch[2].trim()

      if (indexContent) {
        result.index = createAliasExpression(
          loc,
          indexContent,
          exp.indexOf(
            indexContent,
            result.key
              ? keyOffset! + keyContent.length
              : trimmedOffset + valueContent.length
          )
        )
        if (!__BROWSER__ && context.prefixIdentifiers) {
          result.index = processExpression(result.index, context, true)
        }
        if (__DEV__ && __BROWSER__) {
          validateBrowserExpression(
            result.index as SimpleExpressionNode,
            context,
            true
          )
        }
      }
    }
  }

  //......解析value......
  if (valueContent) {
    result.value = createAliasExpression(loc, valueContent, trimmedOffset)
    if (!__BROWSER__ && context.prefixIdentifiers) {
      result.value = processExpression(result.value, context, true)
    }
    if (__DEV__ && __BROWSER__) {
      validateBrowserExpression(
        result.value as SimpleExpressionNode,
        context,
        true
      )
    }
  }

  return result
}

function createAliasExpression(
  range: SourceLocation,
  content: string,
  offset: number
): SimpleExpressionNode {
  return createSimpleExpression(
    content,
    false,
    getInnerRange(range, offset, content.length)
  )
}

/**创建for循环参数,就是把undefined的参数创建一个content为"_"的简单表达式节点代替 */
export function createForLoopParams({
  value,
  key,
  index
}: ForParseResult): ExpressionNode[] {
  const params: ExpressionNode[] = []
  if (value) {//"item in source"
    params.push(value)
  }
  if (key) {
    if (!value) {//"(_,key) in source"
      params.push(createSimpleExpression(`_`, false))
    }//"(item,key) in source"
    params.push(key)
  }
  if (index) {
    if (!key) {
      if (!value) {//"(_,__,index) in source"
        params.push(createSimpleExpression(`_`, false))
      }//"(item,__,index) in source"
      params.push(createSimpleExpression(`__`, false))
    }//"(item,key,index) in source"
    params.push(index)
  }
  return params
}
