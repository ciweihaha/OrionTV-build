/**
 * 自动跳过片头：片头结束时间的来源。
 *
 * 根因（1.6.7）：片头结束时间（introEndTime）只能由用户在播放控制条里
 * 手动点“标记片头”按钮记下来；片源数据（CMS 聚合）不带片头时间戳，
 * App 也没有自动检测。用户从没标过，introEndTime 永远是 undefined，
 * 开关就算默认开着，两条跳过路径也永远走不到，“跳过片头”一次都没触发过。
 *
 * 修法：没标过时用一个默认片头时长兜底（可配置，0 表示不用兜底），
 * 手动标记过的一律优先用标记值。
 */

/** 默认片头时长（秒）：多数剧集片头在 60~90 秒之间 */
export const DEFAULT_INTRO_SKIP_SECONDS = 90;

/** 设置里可选的片头时长（秒），0 表示不自动跳过、只用手动标记 */
export const INTRO_SKIP_OPTIONS = [0, 30, 60, 90, 120] as const;

/**
 * 算出本集真正用来跳过的片头结束时间（毫秒）。
 * @param markedMs 用户手动标记的片头结束时间（毫秒），没标过为 undefined
 * @param skipSeconds 默认片头时长（秒），<= 0 表示不用兜底
 * @returns 跳过目标（毫秒），没得跳时为 undefined
 */
export function resolveIntroEndTime(
  markedMs: number | undefined,
  skipSeconds: number,
): number | undefined {
  if (markedMs !== undefined && markedMs > 0) return markedMs;
  if (skipSeconds > 0) return skipSeconds * 1000;
  return undefined;
}
