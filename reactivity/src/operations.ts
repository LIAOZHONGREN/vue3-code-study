

/**跟踪类型 */
export const enum TrackOpTypes {
  GET = 'get', //跟踪get操作
  HAS = 'has',//跟踪存在判断存在
  ITERATE = 'iterate'//跟踪迭代操作
}

/**触发类型 */
export const enum TriggerOpTypes {
  SET = 'set',//set操作时触发
  ADD = 'add',//数组的add(push)操作时触发
  DELETE = 'delete',//对对象属性或数组成员的删除操作时触发
  CLEAR = 'clear',//对数组做清除操作时触发
}
