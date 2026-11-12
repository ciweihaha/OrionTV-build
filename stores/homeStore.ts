import { create } from "zustand";
import { api, SearchResult, PlayRecord, isCancelError } from "@/services/api";
import type { AggVideoItem } from "@/services/api";
import { buildAggFilterParams } from "@/utils/categoryFilters";
import { PlayRecordManager, parseRecordKey } from "@/services/storage";
import { storageConfig } from "@/services/storageConfig";
import useAuthStore from "./authStore";
import { useSettingsStore } from "./settingsStore";
import { Logger } from "@/utils/Logger";

const logger = Logger.withTag('HomeStore');

export type RowItem = (SearchResult | PlayRecord) & {
  id: string;
  source: string;
  title: string;
  poster: string;
  progress?: number;
  play_time?: number;
  lastPlayed?: number;
  episodeIndex?: number;
  sourceName?: string;
  totalEpisodes?: number;
  year?: string;
  // CMS 项的 vod_area（如 "中国大陆"、"香港"）；豆瓣项与最近播放没有该字段。
  area?: string;
  rate?: string;
};

export interface Category {
  title: string;
  type?: "movie" | "tv" | "record";
  tag?: string;
  tags?: string[];
  // 仅 CMS 分类用；不填 = 豆瓣模式（现有行为不变）。
  // cmsType 与 tag/tags 互斥：进入 CMS 分类时 tag 不再生效。
  cmsType?: 1 | 2 | 3 | 4; // agg 的 t：1 电影、2 电视剧、3 动漫、4 综艺
}

const initialCategories: Category[] = [
  { title: "最近播放", type: "record" },
  // “豆瓣热播”：tag 仍是豆瓣的“热门”（豆瓣没有“热播”这个 tag，传“热播”
  // 会返回空列表；热门即豆瓣热播榜，与豆瓣 Top250 同走 getDoubanData）。
  { title: "豆瓣热播", type: "tv", tag: "热门" },
  { title: "电视剧", type: "tv", tags: ["国产剧", "美剧", "英剧", "韩剧", "日剧", "港剧", "日本动画", "动画"], cmsType: 2 },
  {
    title: "电影",
    type: "movie",
    tags: [
      "热门",
      "最新",
      "经典",
      "豆瓣高分",
      "冷门佳片",
      "华语",
      "欧美",
      "韩国",
      "日本",
      "动作",
      "喜剧",
      "爱情",
      "科幻",
      "悬疑",
      "恐怖",
    ],
    cmsType: 1,
  },
  { title: "动漫", type: "tv", cmsType: 3 },
  { title: "综艺", type: "tv", cmsType: 4 },
  { title: "豆瓣 Top250", type: "movie", tag: "top250" },
];

// CMS 回落用的豆瓣 tag：agg 失败或首屏空列表时用它回落豆瓣，不写 CMS 缓存。
// 电影/电视剧的回落 tag 与其 tags[0] 一致，动漫/综艺在 CMS 化后已无 tags/tag，
// 故用这张固定映射表，不得再从 tags 里猜。
const getCmsFallbackTag = (category: Category): string => {
  switch (category.title) {
    case "电影":
      return "热门";
    case "电视剧":
      return "国产剧";
    case "动漫":
      return "日本动画";
    case "综艺":
      return "综艺";
    default:
      return category.tags?.[0] || category.tag || "热门";
  }
};

// agg 项 -> RowItem（在 homeStore 做映射，不在 api.ts 混入 UI 类型）。
// source 保留 "agg"：VideoCard 点进详情时走 title 搜索，
// detailStore 已实测：preferredSource 失败/回 0 时会自动回落全量标题搜索，
// 因此本次不动 detailStore。若未来 detailStore 改掉回落，再改用 source 置空。
const mapAggItem = (item: AggVideoItem): RowItem => {
  return {
    id: item.vod_id,
    source: "agg",
    title: item.vod_name,
    poster: item.vod_pic || "",
    year: item.vod_year || "",
    // vod_area 一并保留：地区筛选虽走服务端参数，卡片数据仍应带全字段，
    // 后续客户端二次过滤或详情展示可直接用，不必再改映射。
    area: item.vod_area || "",
    rate: item.vod_douban_score && item.vod_douban_score !== "0.0" ? item.vod_douban_score : "",
    sourceName: item.type_name || "",
  } as unknown as RowItem;
};

// 添加缓存项接口
interface CacheItem {
  data: RowItem[];
  timestamp: number;
  type: 'movie' | 'tv' | 'record';
  hasMore: boolean;
  // 仅 CMS 分支用：翻页时从缓存页数继续，不得把缓存的 40 条当成“已加载全部”。
  pagecount?: number;
  aggPage?: number;
}

const CACHE_EXPIRE_TIME = 5 * 60 * 1000; // 5分钟过期
const MAX_CACHE_SIZE = 10; // 最大缓存容量
const MAX_ITEMS_PER_CACHE = 40; // 每个缓存最大条目数

const getCacheKey = (category: Category, region?: string | null, year?: string | null) => {
  if (category.cmsType) {
    // CMS 缓存键必须含筛选值：否则切筛选后命中无筛选的旧缓存，
    // 列表还是没筛过的数据。
    return `cms-${category.cmsType}-${category.title}-area:${region || ""}-year:${year || ""}`;
  }
  return `${category.type || 'unknown'}-${category.title}-${category.tag || ''}`;
};

const isValidCache = (cacheItem: CacheItem) => {
  return Date.now() - cacheItem.timestamp < CACHE_EXPIRE_TIME;
};

interface HomeState {
  categories: Category[];
  selectedCategory: Category;
  contentData: RowItem[];
  loading: boolean;
  loadingMore: boolean;
  pageStart: number;
  // agg 分页专用：1-based 页码，首屏未加载为 0；不得复用豆瓣的 pageStart（offset 语义）。
  aggPage: number;
  hasMore: boolean;
  error: string | null;
  // CMS 地区 / 年代筛选：null = 全部；只在 CMS 分类下生效。
  regionFilter: string | null;
  yearFilter: string | null;
  // 当前列表是否来自 CMS：CMS 成功加载后 true，回落豆瓣/切分类时 false。
  // 筛选行只在 true 时渲染（豆瓣数据无地区/年代字段，不假装能筛）。
  cmsFilterAvailable: boolean;
  // keepFilterRow：筛选触发的重载传 true——加载期间不把筛选行卸掉，
  // 否则电视上焦点会被抢走，重载完焦点又被 hasTVPreferredFocus 拉回“全部”，
  // 用户再按 OK 会点到“全部”把刚选的筛选撤掉，看起来像“筛了没用”。
  fetchInitialData: (options?: { keepFilterRow?: boolean }) => Promise<void>;
  loadMoreData: () => Promise<void>;
  selectCategory: (category: Category) => void;
  setRegionFilter: (region: string | null) => void;
  setYearFilter: (year: string | null) => void;
  refreshPlayRecords: () => Promise<void>;
  clearError: () => void;
}

// 内存缓存，应用生命周期内有效
const dataCache = new Map<string, CacheItem>();

// 正在进行的 loadMoreData 属于哪个分类：切分类时旧请求可能还在飞，
// 新分类的加载不能被旧请求的 loadingMore 挡住（旧请求写结果时会被分类校验拦下）。
let activeLoadCategory: Category | null = null;
// 本次加载的取消控制器：新加载开始时中止上一次（切分类/切筛选后旧请求
// 的结果会被 isStale 丢弃，没必要继续重试到 3 次 × 15 秒）。
let activeLoadController: AbortController | null = null;

// 正在进行的 loadMoreData 属于哪组筛选：切筛选时旧请求可能还在飞，
// 新筛选的加载不能被旧请求的 loadingMore 挡住（与分类同理）。
let activeLoadRegion: string | null = null;
let activeLoadYear: string | null = null;

const useHomeStore = create<HomeState>((set, get) => ({
  categories: initialCategories,
  selectedCategory: initialCategories[0],
  contentData: [],
  loading: true,
  loadingMore: false,
  pageStart: 0,
  aggPage: 0,
  hasMore: true,
  error: null,
  regionFilter: null,
  yearFilter: null,
  cmsFilterAvailable: false,

  fetchInitialData: async (options?: { keepFilterRow?: boolean }) => {
    const { apiBaseUrl } = useSettingsStore.getState();
    const { selectedCategory, regionFilter, yearFilter } = get();
    // 登录检查只对最近播放串行等（loadMoreData 的 record 分支要读 isLoggedIn）；
    // CMS/豆瓣内容不依赖登录态，串行等会让服务器不可达时的 3×15 秒重试
    // 拖住全部内容加载，改为后台跑（authStore 内有失败缓存与去重）。
    if (selectedCategory.type === 'record') {
      await useAuthStore.getState().checkLoginStatus(apiBaseUrl);
    } else {
      void useAuthStore.getState().checkLoginStatus(apiBaseUrl);
    }

    const cacheKey = getCacheKey(selectedCategory, regionFilter, yearFilter);

    // 最近播放不缓存，始终实时获取
    if (selectedCategory.type === 'record') {
      set({ loading: true, contentData: [], pageStart: 0, aggPage: 0, hasMore: true, error: null, cmsFilterAvailable: false });
      await get().loadMoreData();
      return;
    }

    // 检查缓存
    if (dataCache.has(cacheKey) && isValidCache(dataCache.get(cacheKey)!)) {
      const cachedData = dataCache.get(cacheKey)!;
      // 真 LRU：命中时把条目移到末尾（Map 按插入序，淘汰时删第一个）。
      // 原来只按插入序淘汰，常用分类可能被不常用的挤掉。
      dataCache.delete(cacheKey);
      dataCache.set(cacheKey, cachedData);
      set({
        loading: false,
        contentData: cachedData.data,
        pageStart: cachedData.data.length,
        aggPage: selectedCategory.cmsType ? (cachedData.aggPage ?? 1) : 0,
        hasMore: cachedData.hasMore,
        error: null,
        // CMS 缓存只由 CMS 成功分支写入，命中即说明数据来自 CMS。
        cmsFilterAvailable: !!selectedCategory.cmsType,
      });
      return;
    }

    // 筛选触发的重载不卸筛选行：行还在，焦点就还留在刚点的选项上；
    // 切分类/首次加载时保持原来的 false（行要等 CMS 成功后才出现）。
    set({
      loading: true,
      contentData: [],
      pageStart: 0,
      aggPage: 0,
      hasMore: true,
      error: null,
      cmsFilterAvailable: options?.keepFilterRow ? get().cmsFilterAvailable : false,
    });
    await get().loadMoreData();
  },

  loadMoreData: async () => {
    const { selectedCategory, pageStart, aggPage, loadingMore, hasMore, regionFilter, yearFilter } = get();
    if (!hasMore) return;
    // 同一分类的重复加载才挡；切分类后旧请求还在飞时，新分类的加载要放行，
    // 旧请求写结果时会被下面的分类校验拦下，不会写错数据
    if (loadingMore && activeLoadCategory === selectedCategory && activeLoadRegion === regionFilter && activeLoadYear === yearFilter) return;
    // 本次加载归属的分类：每次 await 之后校验，分类变了就丢弃结果，不再写 store
    const loadCategory = selectedCategory;
    // 本次加载归属的筛选值：每次 await 之后连同分类一起校验，
    // 筛选变了就丢弃结果，不再写 store（与切分类同理）。
    const loadRegion = regionFilter;
    const loadYear = yearFilter;
    const isStale = () =>
      get().selectedCategory !== loadCategory ||
      get().regionFilter !== loadRegion ||
      get().yearFilter !== loadYear;
    activeLoadCategory = selectedCategory;
    activeLoadRegion = loadRegion;
    activeLoadYear = loadYear;
    // 取消上一次加载的请求（同分类重复加载已被上面的 guard 拦下，走到这里
    // 一定是换了分类/筛选，旧请求的结果注定被 isStale 丢弃）。
    activeLoadController?.abort();
    const loadController = new AbortController();
    activeLoadController = loadController;
    const loadSignal = loadController.signal;

    if (selectedCategory.cmsType ? aggPage > 0 : pageStart > 0) {
      set({ loadingMore: true });
    }

    try {
      if (selectedCategory.type === "record") {
        const { isLoggedIn } = useAuthStore.getState();
        // 本地模式不要求登录：记录在 AsyncStorage 里，未配服务器/登录过期
        // 时也应可见（M3 只修了数据层回落，这层门控没区分存储类型）。
        // 只有服务端存储（redis）才必须登录。
        if (storageConfig.getStorageType() !== "localstorage" && !isLoggedIn) {
          set({ contentData: [], hasMore: false });
          return;
        }
        const records = await PlayRecordManager.getAll();
        if (isStale()) return;
        const rowItems = Object.entries(records)
          .map(([key, record]) => {
            // key 是 generateKey 拼的 `${source}+${id}`（source/id 里的 '+' 已转义），
            // 用 parseRecordKey 解析（与 app/favorites.tsx 同一处修法）
            const { source, id } = parseRecordKey(key);
            return {
              ...record,
              id,
              source,
              // total_time 为 0（保存时没拿到片长）时直接除会得到 Infinity/NaN，
              // 续播进度条拿去算宽度会直接坏掉
              progress: record.total_time > 0 ? Math.min(1, Math.max(0, record.play_time / record.total_time)) : 0,
              poster: record.cover,
              sourceName: record.source_name,
              episodeIndex: record.index,
              totalEpisodes: record.total_episodes,
              lastPlayed: record.save_time,
              play_time: record.play_time,
            };
          })
          // .filter((record) => record.progress !== undefined && record.progress > 0 && record.progress < 1)
          .sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));

        set({ contentData: rowItems, hasMore: false });
      } else if (selectedCategory.cmsType) {
        // CMS 分支必须放在豆瓣分支之前：CMS 分类同时残留 type 字段，
        // 判断顺序决定走哪条路；tag 在 CMS 模式下不生效。
        const cmsType = selectedCategory.cmsType;
        const nextPg = (get().aggPage || 0) + 1;

        // 回落豆瓣：仅首屏（nextPg === 1）回落；翻页失败不回落、不清空已有列表，
        // 直接抛到外层 catch 显示错误。回落不写 CMS 缓存。
        const fallbackToDouban = async () => {
          const cat = get().selectedCategory;
          const fallbackType = cat.type === "movie" ? "movie" : "tv";
          const fallbackTag = getCmsFallbackTag(cat);
          const doubanResult = await api.getDoubanData(fallbackType, fallbackTag, 20, 0, loadSignal);
          if (isStale()) return;
          // 与 getAggCategory 一致：先校验 list 是数组，异常结构抛有意义的错误（L9）
          if (!Array.isArray(doubanResult?.list)) {
            throw new Error("DOUBAN_INVALID_RESPONSE");
          }
          const doubanItems = doubanResult.list.map((item) => ({
            ...item,
            id: item.title,
            source: "douban",
          })) as RowItem[];
          set({
            contentData: doubanItems,
            pageStart: doubanItems.length,
            aggPage: 0,
            hasMore: doubanResult.list.length !== 0,
            error: null,
            // 回落数据是豆瓣项，无地区/年代字段，筛选行隐藏。
            cmsFilterAvailable: false,
          });
        };

        // 筛选已选时 agg 失败/空列表不再回落豆瓣：筛选是服务端做的，
        // 窄组合（如 英国+2020）首屏确实可能 0 条——回落会显示未筛的豆瓣
        // 内容并把 cmsFilterAvailable 置 false 卸掉筛选行，用户看到的就是
        // “点了筛选，列表没变，筛选行还消失了”。无筛选时保持回落。
        const hasActiveFilter = !!(loadRegion || loadYear);

        // 豆瓣回落走用户服务器的 /api/douban，未配服务器时回落必抛
        // API_URL_NOT_SET，只会把真正的 agg 网络错误掩盖成“请配置服务器地址”。
        // 无服务器时不回落：失败直接抛 agg 原错，空列表直接显示空态。
        const canFallbackToDouban = !!useSettingsStore.getState().apiBaseUrl?.trim();

        let result;
        try {
          result = await api.getAggCategory(cmsType, nextPg, buildAggFilterParams(regionFilter, yearFilter), loadSignal);
          if (isStale()) return;
        } catch (aggError) {
          if (isStale()) return;
          if (nextPg === 1 && !hasActiveFilter && canFallbackToDouban) {
            await fallbackToDouban();
            return;
          }
          throw aggError;
        }
        // agg 成功但首屏空列表：无筛选时是异常（CMS 大类按 agg 设计
        // “宁可多不可空”），走回落；有筛选时是合法结果（窄组合确实没片），
        // 显示空状态、保留筛选行，用户可直接改筛选，不回落豆瓣。
        if (result.list.length === 0 && nextPg === 1) {
          if (hasActiveFilter) {
            set({
              contentData: [],
              pageStart: 0,
              aggPage: 1,
              hasMore: false,
              error: null,
              cmsFilterAvailable: true,
            });
            return;
          }
          if (!canFallbackToDouban) {
            // 无服务器可回落：agg 空列表即最终结果，显示空态，不抛错。
            set({
              contentData: [],
              pageStart: 0,
              aggPage: 1,
              hasMore: false,
              error: null,
              cmsFilterAvailable: false,
            });
            return;
          }
          await fallbackToDouban();
          return;
        }

        const newItems = result.list.map(mapAggItem);
        const cacheKey = getCacheKey(selectedCategory, regionFilter, yearFilter);
        // 筛选后 agg 的 pagecount 是虚值（实测固定 100，与真实可翻页数无关），
        // 翻页返回空列表时必须停下，否则一直翻一直空。
        const nextHasMore = newItems.length > 0 && nextPg < result.pagecount;

        if (nextPg === 1) {
          for (const [key, value] of dataCache.entries()) {
            if (!isValidCache(value)) {
              dataCache.delete(key);
            }
          }
          if (dataCache.size >= MAX_CACHE_SIZE) {
            const oldestKey = Array.from(dataCache.keys())[0];
            dataCache.delete(oldestKey);
          }
          dataCache.set(cacheKey, {
            data: newItems.slice(0, MAX_ITEMS_PER_CACHE),
            timestamp: Date.now(),
            type: selectedCategory.type || 'tv',
            hasMore: nextHasMore,
            pagecount: result.pagecount,
            aggPage: 1,
          });
          set({
            contentData: newItems,
            pageStart: newItems.length,
            aggPage: 1,
            hasMore: nextHasMore,
            cmsFilterAvailable: true,
            error: null,
          });
        } else {
          const existingCache = dataCache.get(cacheKey);
          if (existingCache && existingCache.data.length < MAX_ITEMS_PER_CACHE) {
            // 真 LRU：Map.set 不改变已有 key 的插入序，先删再设才移到末尾
            dataCache.delete(cacheKey);
            // aggPage 只在整页完整并入缓存时才推进：data 被 slice(0, 40) 截断
            // 时若仍记 nextPg，缓存命中后 contentData 只有 40 条、aggPage 已
            // 是下一页，loadMore 会直接跳过被截掉的那部分。保持旧 aggPage，
            // 下次 loadMore 重取同一页，去重会滤掉已有的，截掉的补回来。
            const mergedData = [...existingCache.data, ...newItems];
            const truncated = mergedData.length > MAX_ITEMS_PER_CACHE;
            dataCache.set(cacheKey, {
              ...existingCache,
              data: mergedData.slice(0, MAX_ITEMS_PER_CACHE),
              // 截断时 hasMore 必须为 true：缓存只有 40 条却宣称“没有更多”，
              // 切分类再回来后尾部条目刷不出来，直到缓存过期。保持旧 aggPage
              // + hasMore=true，下次 loadMore 重取同一页，去重补回截掉的条目。
              hasMore: truncated ? true : nextHasMore,
              pagecount: result.pagecount,
              aggPage: truncated ? existingCache.aggPage : nextPg,
            });
          }
          set((state) => {
            // 2026-11-02 翻页去重：服务端改为按请求页码轮换上游站，
            // 同一部影片可能在不同页由不同站返回（vod_id 前缀不同、片名相同），
            // 追加时按片名去重，网格不再出现重复卡片。
            const seen = new Set<string>();
            for (const it of state.contentData) {
              const k = String(it.title || "").trim().toLowerCase();
              if (k) seen.add(k);
            }
            const deduped = newItems.filter((it) => {
              const k = String(it.title || "").trim().toLowerCase();
              if (!k || seen.has(k)) return false;
              seen.add(k);
              return true;
            });
            return {
              contentData: [...state.contentData, ...deduped],
              pageStart: state.pageStart + deduped.length,
              aggPage: nextPg,
              hasMore: nextHasMore,
              cmsFilterAvailable: true,
              error: null,
            };
          });
        }
      } else if (selectedCategory.type && selectedCategory.tag) {
        const result = await api.getDoubanData(
          selectedCategory.type,
          selectedCategory.tag,
          20,
          pageStart,
          loadSignal
        );
        if (isStale()) return;

        // 与 getAggCategory 一致：先校验 list 是数组，异常结构抛有意义的错误（L9）
        if (!Array.isArray(result?.list)) {
          throw new Error("DOUBAN_INVALID_RESPONSE");
        }

        const newItems = result.list.map((item) => ({
          ...item,
          id: item.title,
          source: "douban",
        })) as RowItem[];

        const cacheKey = getCacheKey(selectedCategory);

        if (pageStart === 0) {
          // 清理过期缓存
          for (const [key, value] of dataCache.entries()) {
            if (!isValidCache(value)) {
              dataCache.delete(key);
            }
          }

          // 如果缓存太大，删除最旧的项
          if (dataCache.size >= MAX_CACHE_SIZE) {
            const oldestKey = Array.from(dataCache.keys())[0];
            dataCache.delete(oldestKey);
          }

          // 限制缓存的数据条目数，但不限制显示的数据
          const cacheItems = newItems.slice(0, MAX_ITEMS_PER_CACHE);

          // 存储新缓存
          dataCache.set(cacheKey, {
            data: cacheItems,
            timestamp: Date.now(),
            type: selectedCategory.type,
            hasMore: true // 始终为 true，因为我们允许继续加载
          });

          set({
            contentData: newItems, // 使用完整的新数据
            pageStart: newItems.length,
            hasMore: result.list.length !== 0,
            error: null,
          });
        } else {
          // 增量加载时更新缓存
          const existingCache = dataCache.get(cacheKey);
          if (existingCache) {
            // 只有当缓存数据少于最大限制时才更新缓存
            if (existingCache.data.length < MAX_ITEMS_PER_CACHE) {
              const updatedData = [...existingCache.data, ...newItems];
              const limitedCacheData = updatedData.slice(0, MAX_ITEMS_PER_CACHE);

              // 真 LRU：Map.set 不改变已有 key 的插入序，先删再设才移到末尾
              dataCache.delete(cacheKey);
              dataCache.set(cacheKey, {
                ...existingCache,
                data: limitedCacheData,
                hasMore: true // 始终为 true，因为我们允许继续加载
              });
            }
          }

          // 翻页去重：与 CMS 分支同理，豆瓣分页接口换页时也可能返回
          // 与上一页重叠的条目，按片名去重，网格不再出现重复卡片
          set((state) => {
            const seen = new Set<string>();
            for (const it of state.contentData) {
              const k = String(it.title || "").trim().toLowerCase();
              if (k) seen.add(k);
            }
            const deduped = newItems.filter((it) => {
              const k = String(it.title || "").trim().toLowerCase();
              if (!k || seen.has(k)) return false;
              seen.add(k);
              return true;
            });
            return {
              contentData: [...state.contentData, ...deduped],
              pageStart: state.pageStart + deduped.length,
              hasMore: result.list.length !== 0,
              error: null,
            };
          });
        }
      } else if (selectedCategory.tags) {
        // It's a container category, do not load content, but clear current content
        set({ contentData: [], hasMore: false });
      } else {
        set({ hasMore: false });
      }
    } catch (err: any) {
      // 分类已变：旧请求的错误不写给新分类
      if (isStale()) return;
      // 被取消的请求不写 error：同一切换会触发两次 fetchInitialData
      //（selectCategory + index effect），第二次会取消第一次；第一次的
      // AbortError 若写成“加载失败”，第二次成功后 error 还残留，首页
      // 显示报错屏、内容其实已加载成功
      if (loadSignal.aborted || isCancelError(err)) return;
      // 归一化：抛出的不一定是 Error（如字符串），直接读 err.message.includes
      // 会在 catch 块内再抛 TypeError；非 Error 一律按空消息处理，走默认文案
      const msg = err instanceof Error ? err.message : "";
      let errorMessage = "加载失败，请重试";

      if (msg === "API_URL_NOT_SET") {
        errorMessage = "请点击右上角设置按钮，配置您的服务器地址";
      } else if (msg === "UNAUTHORIZED") {
        // 会话超时：API 层已尝试自动重登并重试，仍失败说明重登也没成功，
        // 此时才提示用户重新登录（登录框由 restoreSession 弹出）。
        errorMessage = "认证失败，请重新登录";
      } else if (msg === "DOUBAN_INVALID_RESPONSE") {
        errorMessage = "数据格式异常，请稍后重试";
      } else if (msg.includes("Network")) {
        errorMessage = "网络连接失败，请检查网络连接";
      } else if (msg.includes("timeout")) {
        errorMessage = "请求超时，请检查网络或服务器状态";
      } else if (msg.includes("404")) {
        errorMessage = "服务器API路径不正确，请检查服务器配置";
      } else if (msg.includes("500")) {
        errorMessage = "服务器内部错误，请联系管理员";
      } else if (msg.includes("403")) {
        errorMessage = "访问被拒绝，请检查权限设置";
      }

      set({ error: errorMessage });
    } finally {
      // 只清属于本次加载的标记：旧请求（上一组筛选）的 finally 不能把
      // 新请求的标记清掉，否则新请求还在飞时又来一次加载会被放行，
      // 造成同一页重复请求。
      if (
        activeLoadCategory === loadCategory &&
        activeLoadRegion === loadRegion &&
        activeLoadYear === loadYear
      ) {
        activeLoadCategory = null;
        activeLoadRegion = null;
        activeLoadYear = null;
        if (activeLoadController === loadController) {
          activeLoadController = null;
        }
      }
      // 分类已变：旧请求的 finally 不能清新分类的 loading/loadingMore，
      // 否则新分类还在加载，首页会先闪一下“暂无内容”
      if (!isStale()) {
        set({ loading: false, loadingMore: false });
      }
    }
  },

  selectCategory: (category: Category) => {
    const currentCategory = get().selectedCategory;
    const cacheKey = getCacheKey(category);
    // 切换判定加 cmsType：CMS 分类切回豆瓣时，不能只靠 title/tag 判断，
    // 否则会残留上一模式的状态。

    if (currentCategory.title !== category.title || currentCategory.tag !== category.tag || currentCategory.cmsType !== category.cmsType) {
      set({
        selectedCategory: category,
        contentData: [],
        pageStart: 0,
        aggPage: 0,
        hasMore: true,
        error: null,
        // 旧分类的 loadMore 还在飞时切分类，旧请求 finally 因 isStale 跳过
        // 清理；缓存命中路径不发新请求，无人再清 loadingMore，底部转圈
        // 会永久显示——切分类时直接复位。
        loadingMore: false,
        // 切分类时筛选回到全部，不把上个分类的筛选带过来。
        regionFilter: null,
        yearFilter: null,
        cmsFilterAvailable: false,
      });

      if (category.type === 'record') {
        get().fetchInitialData().catch((error) => {
          logger.warn("selectCategory: fetchInitialData failed", error);
        });
        return;
      }

      const cachedData = dataCache.get(cacheKey);
      if (cachedData && isValidCache(cachedData)) {
        // 真 LRU：命中时把条目移到末尾（第 10 轮只修了 fetchInitialData，
        // selectCategory 是切分类的主路径，漏了就等于没修）
        dataCache.delete(cacheKey);
        dataCache.set(cacheKey, cachedData);
        set({
          contentData: cachedData.data,
          pageStart: cachedData.data.length,
          aggPage: category.cmsType ? (cachedData.aggPage ?? 1) : 0,
          hasMore: cachedData.hasMore,
          loading: false,
          cmsFilterAvailable: category.cmsType ? true : false,
        });
      } else {
        // 删除过期缓存
        if (cachedData) {
          dataCache.delete(cacheKey);
        }
        get().fetchInitialData().catch((error) => {
          logger.warn("selectCategory: fetchInitialData failed", error);
        });
      }
    }
  },

  // 切筛选：值没变或不在 CMS 分类下不做事；否则记下新值并重拉首屏。
  // fetchInitialData 会按含筛选值的新缓存键查缓存，命中则直接用缓存。
  // 重载带 keepFilterRow：加载期间筛选行不卸，电视焦点不丢。
  setRegionFilter: (region: string | null) => {
    const { regionFilter, selectedCategory } = get();
    if (region === regionFilter) return;
    if (!selectedCategory?.cmsType) return;
    set({ regionFilter: region });
    get().fetchInitialData({ keepFilterRow: true });
  },

  setYearFilter: (year: string | null) => {
    const { yearFilter, selectedCategory } = get();
    if (year === yearFilter) return;
    if (!selectedCategory?.cmsType) return;
    set({ yearFilter: year });
    get().fetchInitialData({ keepFilterRow: true });
  },

  refreshPlayRecords: async () => {
    const { apiBaseUrl } = useSettingsStore.getState();
    // 设置尚未加载完成（apiBaseUrl 为空）时无法判断登录态，直接跳过，
    // 避免冷启动首帧（子组件 focus 早于 loadSettings 完成）误删"最近播放"分类。
    if (!apiBaseUrl) return;
    await useAuthStore.getState().checkLoginStatus(apiBaseUrl);
    const { isLoggedIn } = useAuthStore.getState();
    // 本地模式不要求登录（同 loadMoreData record 分支）：未登录时删掉
    // “最近播放”分类，本地记录就永远看不到了
    if (storageConfig.getStorageType() !== "localstorage" && !isLoggedIn) {
      // updater 应为纯函数：selectCategory（含嵌套 set 与异步加载）不能在
      // updater 内调，时序脆弱；先算新分类，set 之后再切（分类为空时不切）。
      const { categories, selectedCategory } = get();
      if (!categories.some((c) => c.type === "record")) return;
      const newCategories = categories.filter((c) => c.type !== "record");
      set({ categories: newCategories });
      if (selectedCategory.type === "record" && newCategories.length > 0) {
        get().selectCategory(newCategories[0]);
      }
      return;
    }
    const records = await PlayRecordManager.getAll();
    const hasRecords = Object.keys(records).length > 0;
    set((state) => {
      const recordCategoryExists = state.categories.some((c) => c.type === "record");
      if (hasRecords && !recordCategoryExists) {
        return { categories: [initialCategories[0], ...state.categories] };
      }
      if (!hasRecords && recordCategoryExists) {
        const newCategories = state.categories.filter((c) => c.type !== "record");
        if (state.selectedCategory.type === "record") {
          get().selectCategory(newCategories[0] || null);
        }
        return { categories: newCategories };
      }
      return {};
    });

    get().fetchInitialData().catch((error) => {
      logger.warn("refreshPlayRecords: fetchInitialData failed", error);
    });
  },

  clearError: () => {
    set({ error: null });
  },
}));

export default useHomeStore;
