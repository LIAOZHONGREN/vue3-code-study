/*
 * @Author: your name
 * @Date: 2020-12-14 14:48:48
 * @LastEditTime: 2020-12-30 18:35:22
 * @LastEditors: Please set LastEditors
 * @Description: In User Settings Edit
 * @FilePath: \vue-next-master\packages\runtime-core\src\helpers\withRenderContext.ts
 */
import { Slot } from '../componentSlots'
import {
  setCurrentRenderingInstance,
  currentRenderingInstance
} from '../componentRenderUtils'
import { ComponentInternalInstance } from '../component'
import { isRenderingCompiledSlot } from './renderSlot'
import { closeBlock, openBlock } from '../vnode'

/**
 * Wrap a slot function to memoize current rendering instance 包装插槽方法以便记住当前渲染实例
 * @private
 */
export function withCtx(fn: Slot,ctx: ComponentInternalInstance | null = currentRenderingInstance) {
  if (!ctx) return fn
  const renderFnWithContext = (...args: any[]) => {
    // If a user calls a compiled slot inside a template expression (#1745), it
    // can mess up block tracking, so by default we need to push a null block to
    // avoid that. This isn't necessary if rendering a compiled `<slot>`.
    if (!isRenderingCompiledSlot) {
      openBlock(true /* null block that disables tracking */)
    }
    const owner = currentRenderingInstance
    setCurrentRenderingInstance(ctx)
    const res = fn(...args)
    setCurrentRenderingInstance(owner)
    if (!isRenderingCompiledSlot) {
      closeBlock()
    }
    return res
  }
  renderFnWithContext._c = true
  return renderFnWithContext
}
