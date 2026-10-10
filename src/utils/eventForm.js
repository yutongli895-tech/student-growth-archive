/**
 * 成长时间线的表单初值与删除参数（纯函数，可单测）
 *
 * 为什么单独抽出来：这里有两处「和界面长得没关系、错了却看不出来」的地方 ——
 *
 *   1. 表单初值。图片附件是 eventForm 的一部分，初值里漏掉 images，
 *      点「附加图片」时就会在 f.images.push 上抛错，界面只表现为「点了没反应」。
 *      成绩那边踩过同一个坑：openEditor 漏了 scoreId，保存打到 /score/undefined 拿 404。
 *
 *   2. 删除的定位方式。旧接口按 (日期,类型,内容) 三元组删，同一天、同类型、同内容的
 *      两条记录会被一次删掉两条 —— 加了配图之后这种「看起来一模一样」的记录更容易出现。
 *      现在优先按行主键删，三元组只作老数据的回落。这段「优先 id、否则三元组」的
 *      判断必须放在组件外面，才能被断言。
 */

export const EVENT_TYPES = ['奖励', '惩罚', '比赛', '活动', '提醒', '其他']

/** 新增事件的表单初值。重置一律调用它，避免出现「只清了一半字段」的不一致 */
export function emptyEventForm() {
  return { event_date: '', event_type: EVENT_TYPES[0], content: '', images: [] }
}

/**
 * 删除一条成长事件要带的参数。
 *
 * @param event 后端返回的事件（含 id / date / type / content）
 * @returns {{ id: string } | { event_date: string, event_type: string, content: string }}
 *          拿得到 id 就只用 id；拿不到（老接口、老缓存数据）才回落到三元组 ——
 *          那是唯一会误伤「双胞胎事件」的路径，所以尽量别走。
 */
export function eventDeleteParams(event) {
  const id = Number(event?.id)
  // 事件主键从 1 开始自增，0 / NaN 都只说明「这条数据没有主键」。
  // 后端同样只认 id > 0，两边判据保持一致，避免出现「前端发了 id、后端不认」。
  if (Number.isInteger(id) && id > 0) return { id: String(id) }
  return {
    event_date: event?.date ?? '',
    event_type: event?.type ?? '',
    content: event?.content ?? ''
  }
}

/** 提交给后端的附件：只传 dataURL 本身，不要把 { src, name } 整包发过去 */
export function eventImagePayload(images) {
  return (Array.isArray(images) ? images : [])
    .map(x => (typeof x === 'string' ? x : x?.src))
    .filter(x => typeof x === 'string' && x)
}
