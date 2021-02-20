/*
 * @Author: your name
 * @Date: 2020-12-14 14:48:47
 * @LastEditTime: 2021-01-18 13:56:39
 * @LastEditors: Please set LastEditors
 * @Description: In User Settings Edit
 * @FilePath: \vue-next-master\packages\compiler-core\src\validateExpression.ts
 */
// these keywords should not appear inside expressions, but operators like

import { SimpleExpressionNode } from './ast'
import { TransformContext } from './transform'
import { createCompilerError, ErrorCodes } from './errors'

// typeof, instanceof and in are allowed 允许typeof，instanceof和in
const prohibitedKeywordRE = new RegExp(
  '\\b' +
    (
      'do,if,for,let,new,try,var,case,else,with,await,break,catch,class,const,' +
      'super,throw,while,yield,delete,export,import,return,switch,default,' +
      'extends,finally,continue,debugger,function,arguments,typeof,void'
    )
      .split(',')
      .join('\\b|\\b') +
    '\\b'
)

// strip strings in expressions 删除表达式中的字符串
const stripStringRE = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*\$\{|\}(?:[^`\\]|\\.)*`|`(?:[^`\\]|\\.)*`/g

/**
 * Validate a non-prefixed expression.
 * This is only called when using the in-browser runtime compiler since it
 * doesn't prefix expressions.
 */
export function validateBrowserExpression(
  node: SimpleExpressionNode,
  context: TransformContext,
  asParams = false,
  asRawStatements = false
) {
  const exp = node.content

  // empty expressions are validated per-directive since some directives
  // do allow empty expressions. 每个指令都验证空表达式，因为某些指令确实允许空表达式。
  if (!exp.trim()) {
    return
  }

  try {
    new Function(
      asRawStatements
        ? ` ${exp} `
        : `return ${asParams ? `(${exp}) => {}` : `(${exp})`}`
    )
  } catch (e) {
    let message = e.message
    const keywordMatch = exp
      .replace(stripStringRE, '')
      .match(prohibitedKeywordRE)
    //避免将JavaScript关键字用作属性名称  
    if (keywordMatch) {
      message = `avoid using JavaScript keyword as property name: "${
        keywordMatch[0]
      }"`
    }
    context.onError(
      createCompilerError(
        ErrorCodes.X_INVALID_EXPRESSION,
        node.loc,
        undefined,
        message
      )
    )
  }
}
