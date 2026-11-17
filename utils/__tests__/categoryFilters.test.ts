import {
  ALL_OPTION,
  REGION_OPTIONS,
  YEAR_OPTION_COUNT,
  buildAggFilterParams,
  filterServerReliableGroups,
  getYearOptions,
} from "../categoryFilters";

describe("REGION_OPTIONS（agg 实测值，2026-11-12）", () => {
  it("首项是全部（不传参数）", () => {
    expect(REGION_OPTIONS[0]).toEqual(ALL_OPTION);
    expect(ALL_OPTION).toEqual({ label: "全部", value: null });
  });

  it("包含 agg 实测出现过的地区值", () => {
    const values = REGION_OPTIONS.map((o) => o.value);
    expect(values).toEqual([
      null,
      "中国大陆",
      "香港",
      "台湾",
      "美国",
      "韩国",
      "日本",
      "英国",
    ]);
  });

  it("显示名与传参值一致（服务端按该值包含匹配）", () => {
    for (const option of REGION_OPTIONS.slice(1)) {
      expect(option.label).toBe(option.value);
    }
  });
});

describe("getYearOptions", () => {
  it("返回全部 + 当前年份往回 6 年的单年", () => {
    const options = getYearOptions(new Date("2026-11-12T00:00:00"));
    expect(options).toHaveLength(1 + YEAR_OPTION_COUNT);
    expect(options[0]).toEqual({ label: "全部", value: null });
    expect(options[1]).toEqual({ label: "2026", value: "2026" });
    expect(options[options.length - 1]).toEqual({ label: "2020", value: "2020" });
  });

  it("跨年时以传入日期的年份为准", () => {
    const options = getYearOptions(new Date("2027-01-05T00:00:00"));
    expect(options[1]).toEqual({ label: "2027", value: "2027" });
    expect(options[options.length - 1]).toEqual({ label: "2021", value: "2021" });
  });

  it("默认用当前年份（不传参不抛错）", () => {
    const options = getYearOptions();
    expect(options[1].value).toBe(String(new Date().getFullYear()));
  });
});

describe("buildAggFilterParams", () => {
  it("两项都未选时返回空对象（不拼参数，与无筛选一致）", () => {
    expect(buildAggFilterParams(null, null)).toEqual({});
    expect(buildAggFilterParams(undefined, undefined)).toEqual({});
  });

  it("只选地区只返回 area", () => {
    expect(buildAggFilterParams("中国大陆", null)).toEqual({ area: "中国大陆" });
  });

  it("只选年代只返回 year", () => {
    expect(buildAggFilterParams(null, "2024")).toEqual({ year: "2024" });
  });

  it("两项都选都返回（服务端组合生效）", () => {
    expect(buildAggFilterParams("美国", "2024")).toEqual({ area: "美国", year: "2024" });
  });
});

// 服务端下发的筛选组只保留可靠的 4 组（2026-11-18）：
// cate（类型）与 score（评分）服务端处理不可靠，不作为筛选选项提供、
// 面板不出现；筛选全部以服务端为准，不做客户端过滤。
describe("filterServerReliableGroups（只留服务端可靠的 4 组）", () => {
  const groups = [
    { key: "cate", name: "类型", value: [{ n: "全部", v: "" }, { n: "科幻片", v: "科幻片" }] },
    { key: "area", name: "地区", value: [{ n: "全部", v: "" }, { n: "香港", v: "香港" }] },
    { key: "year", name: "年代", value: [{ n: "全部", v: "" }, { n: "2024", v: "2024" }] },
    { key: "lang", name: "语言", value: [{ n: "全部", v: "" }, { n: "日语", v: "日语" }] },
    { key: "score", name: "评分", value: [{ n: "全部", v: "" }, { n: "8分以上", v: "8分以上" }] },
    { key: "order", name: "排序", value: [{ n: "默认", v: "" }, { n: "最新", v: "最新" }] },
  ] as const;

  it("6 组进、4 组出：cate/score 组被滤掉，area/year/lang/order 原样保留", () => {
    const kept = filterServerReliableGroups(groups as any);
    expect(kept.map((g) => g.key)).toEqual(["area", "year", "lang", "order"]);
    expect(kept.find((g) => g.key === "area")!.value).toEqual([
      { n: "全部", v: "" },
      { n: "香港", v: "香港" },
    ]);
  });

  it("服务端只下发可靠组时原样返回（不复制、不改顺序）", () => {
    const reliable = groups.filter((g) => g.key !== "cate" && g.key !== "score") as any;
    expect(filterServerReliableGroups(reliable)).toEqual(reliable);
  });

  it("服务端一组都不下发时返回空数组", () => {
    expect(filterServerReliableGroups([])).toEqual([]);
  });
});
