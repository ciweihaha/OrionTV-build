// CMS 分类（agg videolist）的地区 / 年代筛选选项与参数构造。
//
// 字段来源（2026-11-12 agg 实测）：
// - 地区：vod_area，实测值如 中国大陆 / 中国香港 / 香港 / 中国台湾 / 台湾 /
//   美国 / 韩国 / 日本 / 英国等；复合值用 " / "、逗号或空格分隔多地区
//   （如 "英国 / 美国"、"中国大陆,中国香港"）。
// - 年代：vod_year，四位年份字符串（如 "2025"）。
//
// 服务端筛选语义（2026-11-12 agg 实测）：
// - area 参数是包含匹配：area=香港 同时命中 "香港" 与 "中国香港"；
//   area=台湾 同时命中 "台湾" 与 "中国台湾"；area=中国大陆 也命中
//   "中国大陆,中国香港" 这类合拍片。
// - year 参数是精确年份匹配：year=201 返回 0 条，年代段无法服务端表达，
//   故年代选项只给单年（当前年份往回 6 年），不做 2010 年代这种分段。
// - area 与 year 可组合同时生效（实测 area=美国&year=2024 只返回美国 2024 片）。
//
// 豆瓣分类与最近播放不提供地区/年代字段，筛选行在这些分类下不渲染
// （见 app/index.tsx），不假装能筛。

export interface FilterOption {
  /** 界面显示的文字 */
  label: string;
  /** 传给 agg 的参数值；null = 全部（不传参数） */
  value: string | null;
}

export const ALL_OPTION: FilterOption = { label: "全部", value: null };

/** 地区选项：显示名即传参值，均为 agg 实测出现过的 vod_area 值。 */
export const REGION_OPTIONS: FilterOption[] = [
  ALL_OPTION,
  { label: "中国大陆", value: "中国大陆" },
  { label: "香港", value: "香港" },
  { label: "台湾", value: "台湾" },
  { label: "美国", value: "美国" },
  { label: "韩国", value: "韩国" },
  { label: "日本", value: "日本" },
  { label: "英国", value: "英国" },
];

/** 年代单年选项的个数：当前年份往回 6 年，共 7 个。 */
export const YEAR_OPTION_COUNT = 7;

/** 年代选项：全部 + 当前年份往回 6 年的单年。now 可注入，便于测试。 */
export function getYearOptions(now: Date = new Date()): FilterOption[] {
  const currentYear = now.getFullYear();
  const options: FilterOption[] = [ALL_OPTION];
  for (let i = 0; i < YEAR_OPTION_COUNT; i++) {
    const year = String(currentYear - i);
    options.push({ label: year, value: year });
  }
  return options;
}

/** 传给 agg getAggCategory 的筛选参数：未选的项不出现。 */
export interface CmsFilterParams {
  area?: string;
  year?: string;
}

/** 把两个筛选值拼成 agg 请求参数；两项都未选时返回空对象。 */
export function buildAggFilterParams(
  region: string | null | undefined,
  year: string | null | undefined,
): CmsFilterParams {
  const params: CmsFilterParams = {};
  if (region) params.area = region;
  if (year) params.year = year;
  return params;
}
