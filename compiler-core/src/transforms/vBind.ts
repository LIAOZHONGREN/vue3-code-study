/*
 * @Author: your name
 * @Date: 2020-12-14 14:48:47
 * @LastEditTime: 2021-01-23 19:26:09
 * @LastEditors: your name
 * @Description: In User Settings Edit
 * @FilePath: \vue-next-master\packages\compiler-core\src\transforms\vBind.ts
 */
import { DirectiveTransform } from '../transform'
import { createObjectProperty, createSimpleExpression, NodeTypes } from '../ast'
import { createCompilerError, ErrorCodes } from '../errors'
import { camelize } from '@vue/shared'
import { CAMELIZE } from '../runtimeHelpers'

// v-bind without arg is handled directly in ./transformElements.ts due to it affecting
// codegen for the entire props object. This transform here is only for v-bind
// *with* args.
//不带arg的v-bind直接在./transformElements.ts中处理，因为它会影响
//整个props对象的codegen。此转换仅适用于v-bind
//*带有*args。 
export const transformBind: DirectiveTransform = (dir, node, context) => {
  const { exp, modifiers, loc } = dir
  const arg = dir.arg!

  if (arg.type !== NodeTypes.SIMPLE_EXPRESSION) {
    arg.children.unshift(`(`)
    arg.children.push(`) || ""`)
  } else if (!arg.isStatic) {
    arg.content = `${arg.content} || ""`
  }

  // .prop is no longer necessary due to new patch behavior
  // .sync is replaced by v-model:arg
  if (modifiers.includes('camel')) {
    if (arg.type === NodeTypes.SIMPLE_EXPRESSION) {
      if (arg.isStatic) {
        arg.content = camelize(arg.content)
      } else {
        arg.content = `${context.helperString(CAMELIZE)}(${arg.content})`
      }
    } else {
      arg.children.unshift(`${context.helperString(CAMELIZE)}(`)
      arg.children.push(`)`)
    }
  }

  if (
    !exp ||
    (exp.type === NodeTypes.SIMPLE_EXPRESSION && !exp.content.trim())
  ) {
    context.onError(createCompilerError(ErrorCodes.X_V_BIND_NO_EXPRESSION, loc))
    return {
      props: [createObjectProperty(arg!, createSimpleExpression('', true, loc))]
    }
  }

  return {
    props: [createObjectProperty(arg!, exp)]
  }
}
