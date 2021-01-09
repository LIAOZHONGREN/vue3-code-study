
import {
  computed as _computed,
  ComputedRef,
  WritableComputedOptions,
  WritableComputedRef,
  ComputedGetter
} from '@vue/reactivity'
import { recordInstanceBoundEffect } from './component'

export function computed<T>(getter: ComputedGetter<T>): ComputedRef<T>
export function computed<T>(options: WritableComputedOptions<T>): WritableComputedRef<T>
/**与reactivity包的computed基本一样,只是加了recordInstanceBoundEffect方法把副作用存放到组件实例的effects数组(记录在组件的setup（）中创建的效果，以便可以当组件卸载时停止(调用reactivity包的stop方法))*/
export function computed<T>(getterOrOptions: ComputedGetter<T> | WritableComputedOptions<T>) {
  const c = _computed(getterOrOptions as any)
  recordInstanceBoundEffect(c.effect)
  return c
}
