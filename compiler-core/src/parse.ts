import { ParserOptions } from './options'
import { NO, isArray, makeMap, extend } from '@vue/shared'
import { ErrorCodes, createCompilerError, defaultOnError } from './errors'
import {
  assert,
  advancePositionWithMutation,
  advancePositionWithClone,
  isCoreComponent
} from './utils'
import {
  Namespaces,
  AttributeNode,
  CommentNode,
  DirectiveNode,
  ElementNode,
  ElementTypes,
  ExpressionNode,
  NodeTypes,
  Position,
  RootNode,
  SourceLocation,
  TextNode,
  TemplateChildNode,
  InterpolationNode,
  createRoot,
  ConstantTypes
} from './ast'

/**可选配置 */
type OptionalOptions = 'isNativeTag' | 'isBuiltInComponent'
/**合并解析器配置 */
type MergedParserOptions = Omit<Required<ParserOptions>, OptionalOptions> & Pick<ParserOptions, OptionalOptions>
/**属性值('<div class="ccc" />',AttributeValue表示ccc) */
type AttributeValue =
  | {
    content: string      //<div class="ccc" />,content等于'ccc'
    isQuoted: boolean    //表示ccc是否有引号引用
    loc: SourceLocation  
  }
  | undefined

// The default decoder only provides escapes for characters reserved as part of
// the template syntax, and is only used if the custom renderer did not provide
// a platform-specific decoder.
const decodeRE = /&(gt|lt|amp|apos|quot);/g
const decodeMap: Record<string, string> = {
  gt: '>',
  lt: '<',
  amp: '&',
  apos: "'",
  quot: '"'
}

export const defaultParserOptions: MergedParserOptions = {
  delimiters: [`{{`, `}}`],
  getNamespace: () => Namespaces.HTML,
  getTextMode: () => TextModes.DATA,
  isVoidTag: NO,
  isPreTag: NO,
  isCustomElement: NO,
  decodeEntities: (rawText: string): string =>
    rawText.replace(decodeRE, (_, p1) => decodeMap[p1]),
  onError: defaultOnError,
  comments: false
}

export const enum TextModes {
  //          | Elements | Entities | End sign              | Inside of
  DATA, //    | ✔        | ✔        | End tags of ancestors |
  RCDATA, //  | ✘        | ✔        | End tag of the parent | <textarea>
  RAWTEXT, // | ✘        | ✘        | End tag of the parent | <style>,<script>
  CDATA,  //指xml的<![CDATA[...]]>
  ATTRIBUTE_VALUE
}

export interface ParserContext {
  options: MergedParserOptions
  readonly originalSource: string
  source: string
  offset: number
  line: number
  column: number
  inPre: boolean // HTML <pre> tag, preserve whitespaces <pre>标记，保留空格
  inVPre: boolean // v-pre, do not process directives and interpolations v-pre，不处理指令和插值
}

export function baseParse(
  content: string,
  options: ParserOptions = {}
): RootNode {
  const context = createParserContext(content, options)
  const start = getCursor(context)
  return createRoot(
    parseChildren(context, TextModes.DATA, []),
    getSelection(context, start)
  )
}

function createParserContext(
  content: string,
  rawOptions: ParserOptions
): ParserContext {
  const options = extend({}, defaultParserOptions)
  for (const key in rawOptions) {
    // @ts-ignore
    options[key] = rawOptions[key] || defaultParserOptions[key]
  }
  return {
    options,
    column: 1,
    line: 1,
    offset: 0,
    originalSource: content,
    source: content,
    inPre: false,
    inVPre: false
  }
}
/**
 * @description: 
 * @param {*}
 * @return {*}
 */
function parseChildren(
  context: ParserContext,
  mode: TextModes,
  ancestors: ElementNode[] //祖先节点的数组
): TemplateChildNode[] {
  const parent = last(ancestors)
  const ns = parent ? parent.ns : Namespaces.HTML
  const nodes: TemplateChildNode[] = []

  while (!isEnd(context, mode, ancestors)) {
    __TEST__ && assert(context.source.length > 0)
    const s = context.source
    let node: TemplateChildNode | TemplateChildNode[] | undefined = undefined

    if (mode === TextModes.DATA || mode === TextModes.RCDATA) {
      if (!context.inVPre && startsWith(s, context.options.delimiters[0])) {
        // '{{'
        node = parseInterpolation(context, mode)
      } else if (mode === TextModes.DATA && s[0] === '<') {
        // https://html.spec.whatwg.org/multipage/parsing.html#tag-open-state
        if (s.length === 1) {
          emitError(context, ErrorCodes.EOF_BEFORE_TAG_NAME, 1)
        } else if (s[1] === '!') {//解析注释类型的标签
          // https://html.spec.whatwg.org/multipage/parsing.html#markup-declaration-open-state
          if (startsWith(s, '<!--')) {//注释节点
            node = parseComment(context)
          } else if (startsWith(s, '<!DOCTYPE')) {
            // Ignore DOCTYPE by a limitation.
            node = parseBogusComment(context)
          } else if (startsWith(s, '<![CDATA[')) {
            if (ns !== Namespaces.HTML) {
              //Namespaces.XML
              node = parseCDATA(context, ancestors)
            } else {
              //html不存在'<![CDATA[...]]>'
              emitError(context, ErrorCodes.CDATA_IN_HTML_CONTENT)
              node = parseBogusComment(context)
            }
          } else {
            emitError(context, ErrorCodes.INCORRECTLY_OPENED_COMMENT)
            node = parseBogusComment(context)
          }
        } else if (s[1] === '/') {//意外的结束符(为被isEnd拦截,当mode=TextModes.ATTRIBUTE_VALUE时会出现此情况)
          // https://html.spec.whatwg.org/multipage/parsing.html#end-tag-open-state
          if (s.length === 2) {//</
            emitError(context, ErrorCodes.EOF_BEFORE_TAG_NAME, 2)
          } else if (s[2] === '>') {//</>
            emitError(context, ErrorCodes.MISSING_END_TAG_NAME, 2)
            advanceBy(context, 3)
            continue
          } else if (/[a-z]/i.test(s[2])) {
            emitError(context, ErrorCodes.X_INVALID_END_TAG)
            parseTag(context, TagType.End, parent)
            continue
          } else {
            emitError(
              context,
              ErrorCodes.INVALID_FIRST_CHARACTER_OF_TAG_NAME,
              2
            )
            node = parseBogusComment(context)
          }
        } else if (/[a-z]/i.test(s[1])) {
          node = parseElement(context, ancestors)
        } else if (s[1] === '?') {
          emitError(
            context,
            ErrorCodes.UNEXPECTED_QUESTION_MARK_INSTEAD_OF_TAG_NAME,
            1
          )
          node = parseBogusComment(context)
        } else {
          emitError(context, ErrorCodes.INVALID_FIRST_CHARACTER_OF_TAG_NAME, 1)
        }
      }
    }
    if (!node) {
      node = parseText(context, mode)
    }

    if (isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        pushNode(nodes, node[i])
      }
    } else {
      pushNode(nodes, node)
    }
  }

  // Whitespace management for more efficient output
  // (same as v2 whitespace: 'condense')
  let removedWhitespace = false
  if (mode !== TextModes.RAWTEXT) {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]
      if (!context.inPre && node.type === NodeTypes.TEXT) {
        if (!/[^\t\r\n\f ]/.test(node.content)) {
          const prev = nodes[i - 1]
          const next = nodes[i + 1]
          // If:
          // - the whitespace is the first or last node, or:
          // - the whitespace is adjacent to a comment, or:
          // - the whitespace is between two elements AND contains newline
          // Then the whitespace is ignored.
          if (
            !prev ||
            !next ||
            prev.type === NodeTypes.COMMENT ||
            next.type === NodeTypes.COMMENT ||
            (prev.type === NodeTypes.ELEMENT &&
              next.type === NodeTypes.ELEMENT &&
              /[\r\n]/.test(node.content))
          ) {
            removedWhitespace = true
            nodes[i] = null as any
          } else {
            // Otherwise, condensed consecutive whitespace inside the text
            // down to a single space
            node.content = ' '
          }
        } else {
          node.content = node.content.replace(/[\t\r\n\f ]+/g, ' ')
        }
      }
      // also remove comment nodes in prod by default
      if (
        !__DEV__ &&
        node.type === NodeTypes.COMMENT &&
        !context.options.comments
      ) {
        removedWhitespace = true
        nodes[i] = null as any
      }
    }
    if (context.inPre && parent && context.options.isPreTag(parent.tag)) {
      // remove leading newline per html spec
      // https://html.spec.whatwg.org/multipage/grouping-content.html#the-pre-element
      const first = nodes[0]
      if (first && first.type === NodeTypes.TEXT) {
        first.content = first.content.replace(/^\r?\n/, '')
      }
    }
  }

  return removedWhitespace ? nodes.filter(Boolean) : nodes
}

function pushNode(nodes: TemplateChildNode[], node: TemplateChildNode): void {
  if (node.type === NodeTypes.TEXT) {
    const prev = last(nodes)
    // Merge if both this and the previous node are text and those are
    // consecutive. This happens for cases like "a < b".
    if (
      prev &&
      prev.type === NodeTypes.TEXT &&
      prev.loc.end.offset === node.loc.start.offset
    ) {
      prev.content += node.content
      prev.loc.end = node.loc.end
      prev.loc.source += node.loc.source
      return
    }
  }

  nodes.push(node)
}

//解析xml的'<![CDATA[...]]>',返回TemplateChildNode[]
function parseCDATA(
  context: ParserContext,
  ancestors: ElementNode[]
): TemplateChildNode[] {
  __TEST__ &&
    assert(last(ancestors) == null || last(ancestors)!.ns !== Namespaces.HTML)
  __TEST__ && assert(startsWith(context.source, '<![CDATA['))

  advanceBy(context, 9)
  const nodes = parseChildren(context, TextModes.CDATA, ancestors)
  if (context.source.length === 0) {
    emitError(context, ErrorCodes.EOF_IN_CDATA)
  } else {
    __TEST__ && assert(startsWith(context.source, ']]>'))
    advanceBy(context, 3)
  }

  return nodes
}

/**解析出注释节点(CommentNode) */
function parseComment(context: ParserContext): CommentNode {
  __TEST__ && assert(startsWith(context.source, '<!--'))

  const start = getCursor(context)//注释节点是开始位置
  let content: string

  // Regular comment.
  const match = /--(\!)?>/.exec(context.source)
  if (!match) {
    //没有'-->'就把'<!--'后的所有内容当成注释内容
    content = context.source.slice(4)
    advanceBy(context, context.source.length)
    emitError(context, ErrorCodes.EOF_IN_COMMENT)
  } else {
    if (match.index <= 3) { //<!--->
      emitError(context, ErrorCodes.ABRUPT_CLOSING_OF_EMPTY_COMMENT)
    }
    if (match[1]) { //<!--...--!>
      //match[1]等于'!'
      emitError(context, ErrorCodes.INCORRECTLY_CLOSED_COMMENT)
    }
    content = context.source.slice(4, match.index)//注释的内容(match.index为'-->'里第一个'-'在context.source里是索引)

    // Advancing with reporting nested comments. 
    const s = context.source.slice(0, match.index)
    let prevIndex = 1,
      nestedIndex = 0
    while ((nestedIndex = s.indexOf('<!--', prevIndex)) !== -1) {
      advanceBy(context, nestedIndex - prevIndex + 1)
      //判断是否嵌套注释了
      if (nestedIndex + 4 < s.length) {
        emitError(context, ErrorCodes.NESTED_COMMENT)
      }
      prevIndex = nestedIndex + 1
    }
    advanceBy(context, match.index + match[0].length - prevIndex + 1)
  }

  return {
    type: NodeTypes.COMMENT,
    content,
    loc: getSelection(context, start)
  }
}

/**(字面意思:解析假注释)解析出注释节点(CommentNode) */
function parseBogusComment(context: ParserContext): CommentNode | undefined {
  __TEST__ && assert(/^<(?:[\!\?]|\/[^a-z>])/i.test(context.source))

  const start = getCursor(context)
  const contentStart = context.source[1] === '?' ? 1 : 2
  let content: string

  const closeIndex = context.source.indexOf('>')
  if (closeIndex === -1) {
    content = context.source.slice(contentStart)
    advanceBy(context, context.source.length)
  } else {
    content = context.source.slice(contentStart, closeIndex)
    advanceBy(context, closeIndex + 1)
  }

  return {
    type: NodeTypes.COMMENT,
    content,
    loc: getSelection(context, start)
  }
}

function parseElement(
  context: ParserContext,
  ancestors: ElementNode[]
): ElementNode | undefined {
  __TEST__ && assert(/^<[a-z]/i.test(context.source))

  // Start tag.
  const wasInPre = context.inPre
  const wasInVPre = context.inVPre
  const parent = last(ancestors)
  const element = parseTag(context, TagType.Start, parent)
  const isPreBoundary = context.inPre && !wasInPre
  const isVPreBoundary = context.inVPre && !wasInVPre

  if (element.isSelfClosing || context.options.isVoidTag(element.tag)) {
    return element
  }

  // Children.
  ancestors.push(element)
  const mode = context.options.getTextMode(element, parent)
  const children = parseChildren(context, mode, ancestors)
  ancestors.pop()

  element.children = children

  // End tag.
  if (startsWithEndTagOpen(context.source, element.tag)) {
    parseTag(context, TagType.End, parent)
  } else {
    emitError(context, ErrorCodes.X_MISSING_END_TAG, 0, element.loc.start)
    if (context.source.length === 0 && element.tag.toLowerCase() === 'script') {
      const first = children[0]
      if (first && startsWith(first.loc.source, '<!--')) {
        emitError(context, ErrorCodes.EOF_IN_SCRIPT_HTML_COMMENT_LIKE_TEXT)
      }
    }
  }

  element.loc = getSelection(context, element.loc.start)

  if (isPreBoundary) {
    context.inPre = false
  }
  if (isVPreBoundary) {
    context.inVPre = false
  }
  return element
}

const enum TagType {
  Start, //表示头标签 <div>
  End    //表示尾标签 </div>
}

const isSpecialTemplateDirective = /*#__PURE__*/ makeMap(
  `if,else,else-if,for,slot`
)

/**
 * Parse a tag (E.g. `<div id=a>`) with that type (start tag or end tag).
 * 解析具有该类型（开始标签或结束标签）的标签（例如<div id = a>）
 */
function parseTag(
  context: ParserContext,
  type: TagType,
  parent: ElementNode | undefined
): ElementNode {
  __TEST__ && assert(/^<\/?[a-z]/i.test(context.source))
  __TEST__ &&
    assert(
      type === (startsWith(context.source, '</') ? TagType.End : TagType.Start)
    )

  // Tag open.
  const start = getCursor(context) 
  const match = /^<\/?([a-z][^\t\r\n\f />]*)/i.exec(context.source)!
  const tag = match[1]  //标签名
  const ns = context.options.getNamespace(tag, parent)//命名空间

  advanceBy(context, match[0].length)//操作偏移并剔除'<'+tag或'</'+tag
  advanceSpaces(context)

  // save current state in case we need to re-parse attributes with v-pre
  //保存当前状态，以防我们需要使用v-pre重新解析属性
  const cursor = getCursor(context)
  const currentSource = context.source

  // Attributes.
  let props = parseAttributes(context, type)

  // check <pre> tag 判断是不是<pre>标签
  if (context.options.isPreTag(tag)) {
    context.inPre = true
  }

  // check v-pre 判断标签是否设置了v-pre指令
  if (
    !context.inVPre &&
    props.some(p => p.type === NodeTypes.DIRECTIVE && p.name === 'pre')
  ) {
    context.inVPre = true
    // reset context
    extend(context, cursor)
    context.source = currentSource
    // re-parse attrs and filter out v-pre itself
    props = parseAttributes(context, type).filter(p => p.name !== 'v-pre')
  }

  // Tag close.
  let isSelfClosing = false
  if (context.source.length === 0) {
    emitError(context, ErrorCodes.EOF_IN_TAG)
  } else {
    isSelfClosing = startsWith(context.source, '/>')
    if (type === TagType.End && isSelfClosing) {
      emitError(context, ErrorCodes.END_TAG_WITH_TRAILING_SOLIDUS)
    }
    advanceBy(context, isSelfClosing ? 2 : 1)
  }

  let tagType = ElementTypes.ELEMENT
  const options = context.options
  if (!context.inVPre && !options.isCustomElement(tag)) {
    const hasVIs = props.some(
      p => p.type === NodeTypes.DIRECTIVE && p.name === 'is'
    )
    if (options.isNativeTag && !hasVIs) {
      if (!options.isNativeTag(tag)) tagType = ElementTypes.COMPONENT
    } else if (
      hasVIs ||
      isCoreComponent(tag) ||
      (options.isBuiltInComponent && options.isBuiltInComponent(tag)) ||
      /^[A-Z]/.test(tag) ||
      tag === 'component'
    ) {
      tagType = ElementTypes.COMPONENT
    }

    if (tag === 'slot') {
      tagType = ElementTypes.SLOT
    } else if (
      tag === 'template' &&
      props.some(p => {
        return (
          p.type === NodeTypes.DIRECTIVE && isSpecialTemplateDirective(p.name)
        )
      })
    ) {
      tagType = ElementTypes.TEMPLATE
    }
  }

  return {
    type: NodeTypes.ELEMENT,
    ns,
    tag,
    tagType,
    props,
    isSelfClosing,
    children: [],
    loc: getSelection(context, start),
    codegenNode: undefined // to be created during transform phase
  }
}

/**解析属性(props),返回(AttributeNode | DirectiveNode)[] */
function parseAttributes(
  context: ParserContext,
  type: TagType
): (AttributeNode | DirectiveNode)[] {
  const props = []
  const attributeNames = new Set<string>()

  //没有source.length > 0,且没有遇到标签结束符('>'或'/>')就进入循环
  while (
    context.source.length > 0 &&
    !startsWith(context.source, '>') &&
    !startsWith(context.source, '/>')
  ) {
    //意外的'/'(<tag /...或</tag  /...>)
    if (startsWith(context.source, '/')) {
      emitError(context, ErrorCodes.UNEXPECTED_SOLIDUS_IN_TAG)
      advanceBy(context, 1)
      advanceSpaces(context)
      continue
    }
    //结束标签不可以带属性
    if (type === TagType.End) {
      emitError(context, ErrorCodes.END_TAG_WITH_ATTRIBUTES)
    }

    const attr = parseAttribute(context, attributeNames)
    if (type === TagType.Start) {
      props.push(attr)
    }

    if (/^[^\t\r\n\f />]/.test(context.source)) {
      emitError(context, ErrorCodes.MISSING_WHITESPACE_BETWEEN_ATTRIBUTES) //属性之间缺少空格
    }
    advanceSpaces(context) //偏移并剔除掉空白符
  }
  return props
}

/**解析单个属性(prop或指令),返回AttributeNode | DirectiveNode */
function parseAttribute(
  context: ParserContext,
  nameSet: Set<string>
): AttributeNode | DirectiveNode {
  __TEST__ && assert(/^[^\t\r\n\f />]/.test(context.source))

  // Name.
  const start = getCursor(context)
  const match = /^[^\t\r\n\f />][^\t\r\n\f />=]*/.exec(context.source)! //开头字符不可以是空白符和/>,开头字符往回出现空白符,/>或=后终止匹配
  const name = match[0] //属性名

  //属性重复
  if (nameSet.has(name)) {
    emitError(context, ErrorCodes.DUPLICATE_ATTRIBUTE)
  }
  nameSet.add(name)

  //属性名称前出现意外的等号
  if (name[0] === '=') {
    emitError(context, ErrorCodes.UNEXPECTED_EQUALS_SIGN_BEFORE_ATTRIBUTE_NAME)
  }
  {
    const pattern = /["'<]/g
    let m: RegExpExecArray | null
    while ((m = pattern.exec(name))) {
      //属性名称中出现意外字符
      emitError(
        context,
        ErrorCodes.UNEXPECTED_CHARACTER_IN_ATTRIBUTE_NAME,
        m.index
      )
    }
  }

  advanceBy(context, name.length)//偏移和剔除掉属性名

  // Value
  let value: AttributeValue = undefined

  if (/^[\t\r\n\f ]*=/.test(context.source)) {
    advanceSpaces(context)//偏移和剔除掉=号前的空白符
    advanceBy(context, 1)//偏移和剔除掉=号
    advanceSpaces(context)//偏移和剔除掉=号后的空白符
    value = parseAttributeValue(context)
    if (!value) {// 缺少属性值
      emitError(context, ErrorCodes.MISSING_ATTRIBUTE_VALUE)
    }
  }
  const loc = getSelection(context, start)

  //如果属性名有指令符或就是指令符就把它处理成DirectiveNode
  if (!context.inVPre && /^(v-|:|@|#)/.test(name)) {
    const match = /(?:^v-([a-z0-9-]+))?(?:(?::|^@|^#)(\[[^\]]+\]|[^\.]+))?(.+)?$/i.exec(name)!

    //指令名称
    const dirName = match[1] || (startsWith(name, ':') ? 'bind' : startsWith(name, '@') ? 'on' : 'slot')

    let arg: ExpressionNode | undefined

    //match[2]不为undefined,那么它就是指令绑定的属性名称,例如:v-bind:class="ccc"或 @[event]="func",match[2]为'class'或'[event]'
    if (match[2]) {
      const isSlot = dirName === 'slot'
      const startOffset = name.indexOf(match[2])
      const loc = getSelection(
        context,
        getNewPosition(context, start, startOffset),//获取属性名的开始位置信息
        getNewPosition(
          context,
          start,
          startOffset + match[2].length + ((isSlot && match[3]) || '').length
        ) //获取属性名的结尾位置
      )
      let content = match[2]
      let isStatic = true

      //如果属性名是[...]的形式的,表示属性是一个参数变量
      if (content.startsWith('[')) {
        isStatic = false

        if (!content.endsWith(']')) {//如果属性名是'['开头却不是']'结尾
          emitError(
            context,
            ErrorCodes.X_MISSING_DYNAMIC_DIRECTIVE_ARGUMENT_END //缺少动态指令参数结尾
          )
        }

        content = content.substr(1, content.length - 2) //获取动态的属性参数变量
      } else if (isSlot) {
        // #1241 special case for v-slot: vuetify relies extensively on slot
        // names containing dots. v-slot doesn't have any modifiers and Vue 2.x
        // supports such usage so we are keeping it consistent with 2.x.
        //v-slot的特例：vuetify广泛依赖于包含点的插槽名称。v-slot没有任何修饰符，而vue2.x支持这种用法，所以我们将它与2.x保持一致。
        content += match[3] || ''
      }

      arg = {
        type: NodeTypes.SIMPLE_EXPRESSION,
        content,          //如果属性值是[...]形式的,那么它不包括[]
        isStatic,
        constType: isStatic
          ? ConstantTypes.CAN_STRINGIFY
          : ConstantTypes.NOT_CONSTANT,
        loc   //范围是包括[]的,如果有的话
      }
    }

    if (value && value.isQuoted) {
      //包范围更新为不包括引用符("")
      const valueLoc = value.loc
      valueLoc.start.offset++
      valueLoc.start.column++
      valueLoc.end = advancePositionWithClone(valueLoc.start, value.content)
      valueLoc.source = valueLoc.source.slice(1, -1)
    }

    return {
      type: NodeTypes.DIRECTIVE,
      name: dirName,
      exp: value && {
        type: NodeTypes.SIMPLE_EXPRESSION,
        content: value.content,
        isStatic: false,
        // Treat as non-constant by default. This can be potentially set to
        // other values by `transformExpression` to make it eligible for hoisting.
        constType: ConstantTypes.NOT_CONSTANT,
        loc: value.loc
      },
      arg,
      modifiers: match[3] ? match[3].substr(1).split('.') : [],
      loc
    }
  }

  return {
    type: NodeTypes.ATTRIBUTE,
    name,
    value: value && {
      type: NodeTypes.TEXT,
      content: value.content,
      loc: value.loc
    },
    loc
  }
}

/**解析AttributeValue(表示属性值或属性值变量的名称) */
function parseAttributeValue(context: ParserContext): AttributeValue {
  const start = getCursor(context)
  let content: string

  const quote = context.source[0]
  const isQuoted = quote === `"` || quote === `'`
  if (isQuoted) {
    // Quoted value.
    advanceBy(context, 1)//偏移并剔除掉开头的引用符(例如:"value")

    const endIndex = context.source.indexOf(quote)//获取尾部的引用符在context.source中的索引
    if (endIndex === -1) {
      content = parseTextData(
        context,
        context.source.length,
        TextModes.ATTRIBUTE_VALUE
      )
    } else {
      content = parseTextData(context, endIndex, TextModes.ATTRIBUTE_VALUE)
      advanceBy(context, 1)//偏移并剔除掉尾部的引用符
    }
  } else {
    // Unquoted
    const match = /^[^\t\r\n\f >]+/.exec(context.source)
    if (!match) {
      return undefined
    }
    const unexpectedChars = /["'<=`]/g
    let m: RegExpExecArray | null
    while ((m = unexpectedChars.exec(match[0]))) {
      emitError(
        context,
        ErrorCodes.UNEXPECTED_CHARACTER_IN_UNQUOTED_ATTRIBUTE_VALUE,//未加引号的属性值中出现意外字符
        m.index
      )
    }
    content = parseTextData(context, match[0].length, TextModes.ATTRIBUTE_VALUE)
  }

  return { content/**不包括引用符,如果原本有引用符的话 */, isQuoted, loc: getSelection(context, start)/**范围包括引用符,如果有引用符的话 */ }
}

/**解析出插值节点(InterpolationNode;({{var}})) */
function parseInterpolation(
  context: ParserContext,
  mode: TextModes
): InterpolationNode | undefined {
  const [open, close] = context.options.delimiters
  __TEST__ && assert(startsWith(context.source, open))

  const closeIndex = context.source.indexOf(close, open.length) //插值结束符所在的索引值
  if (closeIndex === -1) {
    //插值节点没有结束符(}})
    emitError(context, ErrorCodes.X_MISSING_INTERPOLATION_END)
    return undefined
  }

  const start = getCursor(context) //插值节点的开始位置
  advanceBy(context, open.length)  //偏移
  const innerStart = getCursor(context)//插值内容的开始位置
  const innerEnd = getCursor(context)
  const rawContentLength = closeIndex - open.length //插值的原始长度
  const rawContent = context.source.slice(0, rawContentLength)//插值的原始内容
  const preTrimContent = parseTextData(context, rawContentLength, mode)//解析后的插值内容
  const content = preTrimContent.trim() //去掉左右空格(content等于'{{var}}'里的var)
  const startOffset = preTrimContent.indexOf(content) //开头的偏移(就是去掉的头空格长度)
  if (startOffset > 0) {
    //更新'{{var}}'里的var相对ParserContext.originalSource的开始的位置信息
    advancePositionWithMutation(innerStart, rawContent, startOffset)
  }
  const endOffset = rawContentLength - (preTrimContent.length - content.length - startOffset)//尾部的偏移(就是去掉的尾部空格长度)
  //更新'{{var}}'里的var相对ParserContext.originalSource的结束的位置信息
  advancePositionWithMutation(innerEnd, rawContent, endOffset)
  advanceBy(context, close.length)//更新位置并把'}}'修剪

  return {
    type: NodeTypes.INTERPOLATION,
    content: {
      type: NodeTypes.SIMPLE_EXPRESSION,
      isStatic: false,
      // Set `isConstant` to false by default and will decide in transformExpression
      constType: ConstantTypes.NOT_CONSTANT,
      content,
      loc: getSelection(context, innerStart, innerEnd)
    },
    loc: getSelection(context, start)
  }
}

function parseText(context: ParserContext, mode: TextModes): TextNode {
  __TEST__ && assert(context.source.length > 0)

  const endTokens = ['<', context.options.delimiters[0]]
  if (mode === TextModes.CDATA) {
    endTokens.push(']]>')
  }

  let endIndex = context.source.length
  for (let i = 0; i < endTokens.length; i++) {
    const index = context.source.indexOf(endTokens[i], 1)
    if (index !== -1 && endIndex > index) {
      endIndex = index
    }
  }

  __TEST__ && assert(endIndex > 0)

  const start = getCursor(context)
  const content = parseTextData(context, endIndex, mode)

  return {
    type: NodeTypes.TEXT,
    content,
    loc: getSelection(context, start)
  }
}

/**
 * Get text data with a given length from the current location.
 * This translates HTML entities in the text data.
 * 从当前位置获取给定长度的文本数据。这将转换文本数据中的HTML实体
 */
function parseTextData(
  context: ParserContext,
  length: number,
  mode: TextModes
): string {
  const rawText = context.source.slice(0, length)
  advanceBy(context, length)
  if (
    mode === TextModes.RAWTEXT ||
    mode === TextModes.CDATA ||
    rawText.indexOf('&') === -1
  ) {
    return rawText
  } else {
    // DATA or RCDATA containing "&"". Entity decoding required.
    return context.options.decodeEntities(
      rawText,
      mode === TextModes.ATTRIBUTE_VALUE
    )
  }
}

/**获取光标位置 */
function getCursor(context: ParserContext): Position {
  const { column, line, offset } = context
  return { column, line, offset }
}
/**返回SourceLocation */
function getSelection(
  context: ParserContext,
  start: Position,
  end?: Position
): SourceLocation {
  end = end || getCursor(context)
  return {
    start,
    end,
    source: context.originalSource.slice(start.offset, end.offset)
  }
}

/**返回数组的尾部项 */
function last<T>(xs: T[]): T | undefined {
  return xs[xs.length - 1]
}

/**判断searchString是否是source的开头字符串 */
function startsWith(source: string, searchString: string): boolean {
  return source.startsWith(searchString)
}

/**更新已经解析到的位置(Position)(相对于ParserContext.originalSource),并把从ParserContext.source中已经解析的字符修剪 */
function advanceBy(context: ParserContext, numberOfCharacters: number): void {
  const { source } = context
  __TEST__ && assert(numberOfCharacters <= source.length)
  advancePositionWithMutation(context, source, numberOfCharacters)
  context.source = source.slice(numberOfCharacters)
}

/**把source开头的/^[\t\r\n\f ]+/ 调用advanceBy偏移截取掉 */
function advanceSpaces(context: ParserContext): void {
  const match = /^[\t\r\n\f ]+/.exec(context.source)
  if (match) {
    advanceBy(context, match[0].length)
  }
}

/**通过提供的开始位置和偏移量以context.originalSource重新计算返回一个新位置信息 */
function getNewPosition(
  context: ParserContext,
  start: Position,
  numberOfCharacters: number
): Position {
  return advancePositionWithClone(
    start,
    context.originalSource.slice(start.offset, numberOfCharacters),
    numberOfCharacters
  )
}

function emitError(
  context: ParserContext,
  code: ErrorCodes,
  offset?: number,
  loc: Position = getCursor(context)
): void {
  if (offset) {
    loc.offset += offset
    loc.column += offset
  }
  context.options.onError(
    createCompilerError(code, {
      start: loc,
      end: loc,
      source: ''
    })
  )
}

/**判断是否已经解析到了结束位置('</...>','</'或']]>') */
function isEnd(
  context: ParserContext,
  mode: TextModes,
  ancestors: ElementNode[]
): boolean {
  const s = context.source

  switch (mode) {
    case TextModes.DATA:
      if (startsWith(s, '</')) {
        //TODO: probably bad performance
        for (let i = ancestors.length - 1; i >= 0; --i) {
          if (startsWithEndTagOpen(s, ancestors[i].tag)) {
            return true
          }
        }
      }
      break

    case TextModes.RCDATA:
    case TextModes.RAWTEXT: {
      const parent = last(ancestors)
      if (parent && startsWithEndTagOpen(s, parent.tag)) {
        return true
      }
      break
    }

    case TextModes.CDATA:
      if (startsWith(s, ']]>')) {
        return true
      }
      break
  }

  return !s
}

/**判断source的开头是否是tag的结束标签 */
function startsWithEndTagOpen(source: string, tag: string): boolean {
  return (
    startsWith(source, '</') &&
    source.substr(2, tag.length).toLowerCase() === tag.toLowerCase() &&
    /[\t\r\n\f />]/.test(source[2 + tag.length] || '>')
  )
}
