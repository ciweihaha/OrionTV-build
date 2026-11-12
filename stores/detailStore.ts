import { create } from "zustand";
import { SearchResult, api, isCancelError } from "@/services/api";
import { getResolutionFromM3U8 } from "@/services/m3u8";
import { useSettingsStore } from "@/stores/settingsStore";
import { FavoriteManager } from "@/services/storage";
import { Logger } from "@/utils/Logger";

const logger = Logger.withTag('DetailStore');

/** 标准搜索与 m3u8 清晰度检测的并发上限：启用源多时全部并行会瞬间打爆服务端/占满连接池 */
const SEARCH_CONCURRENCY_LIMIT = 5;

/**
 * 带并发上限的任务执行器：按顺序启动任务，同时运行不超过 limit 个，
 * 全部完成后返回结果（与 Promise.all 同语义：任一任务抛错即 reject，
 * 但已在飞的任务仍会跑完）。搜索扇出与 m3u8 清晰度检测共用。
 */
async function runWithConcurrencyLimit<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]();
    }
  });
  await Promise.all(workers);
  return results;
}

export type SearchResultWithResolution = SearchResult & { resolution?: string | null };

interface DetailState {
  q: string | null;
  searchResults: SearchResultWithResolution[];
  sources: { source: string; source_name: string; resolution: string | null | undefined }[];
  detail: SearchResultWithResolution | null;
  loading: boolean;
  error: string | null;
  allSourcesLoaded: boolean;
  controller: AbortController | null;
  isFavorited: boolean;
  failedSources: Set<string>; // 记录失败的source列表

  init: (q: string, preferredSource?: string, id?: string) => Promise<void>;
  setDetail: (detail: SearchResultWithResolution) => Promise<void>;
  abort: () => void;
  toggleFavorite: () => Promise<void>;
  markSourceAsFailed: (source: string, reason: string) => void;
  getNextAvailableSource: (currentSource: string, episodeIndex: number) => SearchResultWithResolution | null;
}

const useDetailStore = create<DetailState>((set, get) => ({
  q: null,
  searchResults: [],
  sources: [],
  detail: null,
  loading: true,
  error: null,
  allSourcesLoaded: false,
  controller: null,
  isFavorited: false,
  failedSources: new Set(),

  init: async (q, preferredSource, id) => {
    const perfStart = performance.now();
    logger.info(`[PERF] DetailStore.init START - q: ${q}, preferredSource: ${preferredSource}, id: ${id}`);
    
    const { controller: oldController } = get();
    if (oldController) {
      oldController.abort();
    }
    const newController = new AbortController();
    const signal = newController.signal;

    set({
      q,
      loading: true,
      searchResults: [],
      detail: null,
      error: null,
      allSourcesLoaded: false,
      controller: newController,
      // 收藏状态先复位：init 末尾的收藏检查是异步的，窗口期内详情页会
      // 显示上一个视频的爱心状态（从已收藏视频 A 再开未收藏视频 B 时）
      isFavorited: false,
      // 失败源是按视频记的：不清空的话，视频 A 上失败的源会在整个会话内
      // 对所有其他视频的回落都被排除（M3）
      failedSources: new Set(),
    });

    const { videoSource } = useSettingsStore.getState();

    const processAndSetResults = async (results: SearchResult[], merge = false) => {
      // 先把结果写进 store：详情页立刻可看，不用等最慢的那个 m3u8
      // （原来 Promise.all 等全部清晰度测完才写，一个挂起的源能拖 10 秒，
      // 详情页一直转圈）；清晰度随后逐个补，测出一个更新一个
      if (signal.aborted) return;

      // 归一化：服务端某搜索结果缺 episodes 字段时，渲染层直接读 .length
      // 会 TypeError 白屏（应用无 ErrorBoundary）。此处统一补 []，下游
      // 全受益（getNextAvailableSource 的存在性防御说明缺字段是可能发生的）。
      const normalizedResults: SearchResultWithResolution[] = results.map((r) => ({
        ...r,
        episodes: Array.isArray(r.episodes) ? r.episodes : [],
      }));

      set((state) => {
        const existingSources = new Set(state.searchResults.map((r) => r.source));
        const newResults = normalizedResults.filter((r) => !existingSources.has(r.source));
        const finalResults: SearchResultWithResolution[] = merge
          ? [...state.searchResults, ...newResults]
          : normalizedResults;

        return {
          searchResults: finalResults,
          sources: finalResults.map((r) => ({
            source: r.source,
            source_name: r.source_name,
            resolution: r.resolution,
          })),
          detail: state.detail ?? finalResults[0] ?? null,
        };
      });

      // 后台逐个测清晰度：不 await，调用方清 loading 不用等它；
      // 每次写之前都查 signal，换详情/离页后不再往新 init 的 state 里写。
      // 并发上限 5：每个源 1 个 m3u8 检测，源多时全部并行会瞬间占满连接池（L18b）
      void runWithConcurrencyLimit(
        normalizedResults.map((searchResult) => async () => {
          let resolution;
          try {
            if (searchResult.episodes && searchResult.episodes.length > 0) {
              resolution = await getResolutionFromM3U8(searchResult.episodes[0], signal);
            }
          } catch (e) {
            if ((e as Error).name !== "AbortError") {
              logger.info(`Failed to get resolution for ${searchResult.source_name}`, e);
            }
          }
          if (signal.aborted || !resolution) return;
          set((state) => ({
            searchResults: state.searchResults.map((r) =>
              r.source === searchResult.source ? { ...r, resolution } : r
            ),
            sources: state.sources.map((s) =>
              s.source === searchResult.source ? { ...s, resolution } : s
            ),
          }));
        }),
        SEARCH_CONCURRENCY_LIMIT,
      );
    };

    try {
      // Optimization for favorite navigation
      if (preferredSource && id) {
        const searchPreferredStart = performance.now();
        logger.info(`[PERF] API searchVideo (preferred) START - source: ${preferredSource}, query: "${q}"`);
        
        let preferredResult: SearchResult[] = [];
        let preferredSearchError: any = null;
        
        try {
          const response = await api.searchVideo(q, preferredSource, signal);
          preferredResult = response.results;
        } catch (error) {
          preferredSearchError = error;
          logger.error(`[ERROR] API searchVideo (preferred) FAILED - source: ${preferredSource}, error:`, error);
        }
        
        const searchPreferredEnd = performance.now();
        logger.info(`[PERF] API searchVideo (preferred) END - took ${(searchPreferredEnd - searchPreferredStart).toFixed(2)}ms, results: ${preferredResult.length}, error: ${!!preferredSearchError}`);
        
        if (signal.aborted) return;
        
        // 检查preferred source结果
        if (preferredResult.length > 0) {
          logger.info(`[SUCCESS] Preferred source "${preferredSource}" found ${preferredResult.length} results for "${q}"`);
          await processAndSetResults(preferredResult, false);
          // 换详情/离开页面时 processAndSetResults 不抛错直接返回（已取消），
          // 这里不能无条件清 loading，否则会把新一次 init 的加载指示提前关掉
          if (!signal.aborted) set({ loading: false });
        } else {
          // 降级策略：preferred source失败时立即尝试所有源
          if (preferredSearchError) {
            logger.warn(`[FALLBACK] Preferred source "${preferredSource}" failed with error, trying all sources immediately`);
          } else {
            logger.warn(`[FALLBACK] Preferred source "${preferredSource}" returned 0 results for "${q}", trying all sources immediately`);
          }
          
          // 立即尝试所有源，不再依赖后台搜索
          const fallbackStart = performance.now();
          logger.info(`[PERF] FALLBACK search (all sources) START - query: "${q}"`);
          
          try {
            const { results: allResults } = await api.searchVideos(q, signal);
            const fallbackEnd = performance.now();
            logger.info(`[PERF] FALLBACK search END - took ${(fallbackEnd - fallbackStart).toFixed(2)}ms, total results: ${allResults.length}`);
            
            const filteredResults = allResults.filter(item => item.title === q);
            logger.info(`[FALLBACK] Filtered results: ${filteredResults.length} matches for "${q}"`);
            
            if (filteredResults.length > 0) {
              logger.info(`[SUCCESS] FALLBACK search found results, proceeding with ${filteredResults[0].source_name}`);
              await processAndSetResults(filteredResults, false);
              if (!signal.aborted) set({ loading: false });
            } else {
              logger.error(`[ERROR] FALLBACK search found no matching results for "${q}"`);
              set({ 
                error: `未找到 "${q}" 的播放源，请检查标题或稍后重试`,
                loading: false 
              });
            }
          } catch (fallbackError) {
            // 被取消（换详情/离开页面）不算失败：不写 error 状态
            if (signal.aborted || (fallbackError instanceof Error && fallbackError.name === "AbortError")) return;
            logger.error(`[ERROR] FALLBACK search FAILED:`, fallbackError);
            set({ 
              error: `搜索失败：${fallbackError instanceof Error ? fallbackError.message : '网络错误，请稍后重试'}`,
              loading: false 
            });
          }
        }
        
        // 后台搜索（如果preferred source成功的话）
        if (preferredResult.length > 0) {
          const searchAllStart = performance.now();
          logger.info(`[PERF] API searchVideos (background) START`);
          
          try {
            const { results: allResults } = await api.searchVideos(q, signal);
            
            const searchAllEnd = performance.now();
            logger.info(`[PERF] API searchVideos (background) END - took ${(searchAllEnd - searchAllStart).toFixed(2)}ms, results: ${allResults.length}`);
            
            if (signal.aborted) return;
            await processAndSetResults(allResults.filter(item => item.title === q), true);
          } catch (backgroundError) {
            // 被取消不算失败，也不记警告日志
            if (signal.aborted || (backgroundError instanceof Error && backgroundError.name === "AbortError")) return;
            logger.warn(`[WARN] Background search failed, but preferred source already succeeded:`, backgroundError);
          }
        }
      } else {
        // Standard navigation: fetch resources, then fetch details one by one
        const resourcesStart = performance.now();
        logger.info(`[PERF] API getResources START - query: "${q}"`);
        
        try {
          const allResources = await api.getResources(signal);
          
          const resourcesEnd = performance.now();
          logger.info(`[PERF] API getResources END - took ${(resourcesEnd - resourcesStart).toFixed(2)}ms, resources: ${allResources.length}`);
          
          const enabledResources = videoSource.enabledAll
            ? allResources
            : allResources.filter((r) => videoSource.sources[r.key]);

          logger.info(`[PERF] Enabled resources: ${enabledResources.length}/${allResources.length}`);
          
          if (enabledResources.length === 0) {
            logger.error(`[ERROR] No enabled resources available for search`);
            set({ 
              error: "没有可用的视频源，请检查设置或联系管理员",
              loading: false 
            });
            return;
          }

          let firstResultFound = false;
          let totalResults = 0;
          // 搜索任务以函数形式交给并发池：启用源多时全部并行会瞬间发出 N 个
          // 请求，上限 5 个同时进行（L18b）；任务内自带 try/catch，单个源
          // 失败不影响其他源，与原来 Promise.all 的行为一致
          const searchTasks = enabledResources.map((resource) => async () => {
            try {
              const searchStart = performance.now();
              const { results } = await api.searchVideo(q, resource.key, signal);
              const searchEnd = performance.now();
              logger.info(`[PERF] API searchVideo (${resource.name}) took ${(searchEnd - searchStart).toFixed(2)}ms, results: ${results.length}`);
              
              if (results.length > 0) {
                totalResults += results.length;
                logger.info(`[SUCCESS] Source "${resource.name}" found ${results.length} results for "${q}"`);
                await processAndSetResults(results, true);
                if (!firstResultFound) {
                  // 已取消时不碰 loading：新一次 init 正在加载，关掉它会闪“未找到”
                  if (!signal.aborted) set({ loading: false }); // Stop loading indicator on first result
                  firstResultFound = true;
                  logger.info(`[SUCCESS] First result found from "${resource.name}", stopping loading indicator`);
                }
              } else {
                logger.warn(`[WARN] Source "${resource.name}" returned 0 results for "${q}"`);
              }
            } catch (error) {
              // 被取消不算失败：直接跳过，否则下面的 totalResults===0 会把旧错误写进新 init
              if (signal.aborted || (error instanceof Error && error.name === "AbortError")) return;
              logger.error(`[ERROR] Failed to fetch from ${resource.name}:`, error);
            }
          });

          await runWithConcurrencyLimit(searchTasks, SEARCH_CONCURRENCY_LIMIT);
          
          // 检查是否找到任何结果（已取消时不写 error：新一次 init 正在跑，
          // 旧错误会盖掉新结果，详情页直接显示“未找到”）
          if (totalResults === 0 && !signal.aborted) {
            logger.error(`[ERROR] All sources returned 0 results for "${q}"`);
            set({ 
              error: `未找到 "${q}" 的播放源，请尝试其他关键词或稍后重试`,
              loading: false 
            });
          } else if (!signal.aborted) {
            logger.info(`[SUCCESS] Standard search completed, total results: ${totalResults}`);
          }
        } catch (resourceError) {
          // 被取消不算失败：getResources 的 AbortError 不能写进新 init 的 error。
          // 只判 name === "AbortError" 不够：Expo 原生 fetch 的取消错误 name 是
          // "Error"（message 含 canceled），1.6.7 实测因此漏判、超时被当成硬失败
          // 显示给用户。用 isCancelError 统一识别（见 services/api.ts）。
          if (signal.aborted || isCancelError(resourceError)) return;
          logger.error(`[ERROR] Failed to get resources:`, resourceError);
          // 超时已在 getResources 内重试过一次，仍失败时给一句人话，不暴露内部错误码
          const isTimeout =
            resourceError instanceof Error &&
            (resourceError.message.startsWith("REQUEST_TIMEOUT") ||
              resourceError.message.startsWith("RESPONSE_TIMEOUT"));
          set({
            error: `获取视频源失败：${
              isTimeout
                ? "网络超时，请检查网络后重试"
                : resourceError instanceof Error
                  ? resourceError.message
                  : "网络错误，请稍后重试"
            }`,
            loading: false,
          });
          return;
        }
      }

      // 已取消：后面的最终检查读的是新一次 init 的 state，别动它
      if (signal.aborted) return;

      const favoriteCheckStart = performance.now();
      const finalState = get();
      
      // 最终检查：如果所有搜索都完成但仍然没有结果
      if (finalState.searchResults.length === 0 && !finalState.error) {
        logger.error(`[ERROR] All search attempts completed but no results found for "${q}"`);
        set({ error: `未找到 "${q}" 的播放源，请检查标题拼写或稍后重试` });
      } else if (finalState.searchResults.length > 0) {
        logger.info(`[SUCCESS] DetailStore.init completed successfully with ${finalState.searchResults.length} sources`);
      }

      if (finalState.detail) {
        const { source, id } = finalState.detail;
        logger.info(`[INFO] Checking favorite status for source: ${source}, id: ${id}`);
        try {
          const isFavorited = await FavoriteManager.isFavorited(source, id.toString());
          // await 期间若新 init 已开始，旧视频的收藏状态不能写到新详情上
          //（与 setDetail 同一守卫）
          if (get().detail === finalState.detail) {
            set({ isFavorited });
          }
          logger.info(`[INFO] Favorite status: ${isFavorited}`);
        } catch (favoriteError) {
          logger.warn(`[WARN] Failed to check favorite status:`, favoriteError);
        }
      } else {
        logger.warn(`[WARN] No detail found after all search attempts for "${q}"`);
      }
      
      const favoriteCheckEnd = performance.now();
      logger.info(`[PERF] Favorite check took ${(favoriteCheckEnd - favoriteCheckStart).toFixed(2)}ms`);
      
    } catch (e) {
      // 取消识别与内层一致：Expo 原生 fetch 的取消错误 name 是 `Error`
      // （message 含 canceled），只认 AbortError 会漏判，把取消写成“搜索失败”。
      if (!isCancelError(e)) {
        logger.error(`[ERROR] DetailStore.init caught unexpected error:`, e);
        const errorMessage = e instanceof Error ? e.message : "获取数据失败";
        set({ error: `搜索失败：${errorMessage}` });
      } else {
        logger.info(`[INFO] DetailStore.init aborted by user`);
      }
    } finally {
      if (!signal.aborted) {
        set({ loading: false, allSourcesLoaded: true });
        logger.info(`[INFO] DetailStore.init cleanup completed`);
      }
      
      const perfEnd = performance.now();
      logger.info(`[PERF] DetailStore.init COMPLETE - total time: ${(perfEnd - perfStart).toFixed(2)}ms`);
    }
  },

  setDetail: async (detail) => {
    // 先复位：收藏检查是异步的，窗口期内会显示上一个源的爱心状态
    set({ detail, isFavorited: false });
    const { source, id } = detail;
    const isFavorited = await FavoriteManager.isFavorited(source, id.toString());
    // 切源很快时，旧的收藏检查可能后返回：只给当前仍在显示的详情写，
    // 否则会把上一个源的收藏状态写到新源上
    if (get().detail === detail) {
      set({ isFavorited });
    }
  },

  abort: () => {
    get().controller?.abort();
  },

  toggleFavorite: async () => {
    const { detail } = get();
    if (!detail) return;

    const { source, id, title, poster, source_name, episodes, year } = detail;
    const favoriteItem = {
      cover: poster,
      title,
      poster,
      source_name,
      total_episodes: episodes?.length ?? 0,
      search_title: get().q!,
      year: year || "",
    };

    const newIsFavorited = await FavoriteManager.toggle(source, id.toString(), favoriteItem);
    // 切源快时旧的 toggle 可能后返回：只给当前仍在显示的详情写（与
    // setDetail / init 末尾的收藏检查同款身份守卫），否则旧源的收藏
    // 状态会写到新源上
    if (get().detail === detail) {
      set({ isFavorited: newIsFavorited });
    }
  },

  markSourceAsFailed: (source: string, reason: string) => {
    const { failedSources } = get();
    const newFailedSources = new Set(failedSources);
    newFailedSources.add(source);
    
    logger.warn(`[SOURCE_FAILED] Marking source "${source}" as failed due to: ${reason}`);
    logger.info(`[SOURCE_FAILED] Total failed sources: ${newFailedSources.size}`);
    
    set({ failedSources: newFailedSources });
  },

  getNextAvailableSource: (currentSource: string, episodeIndex: number) => {
    const { searchResults, failedSources } = get();
    
    logger.info(`[SOURCE_SELECTION] Looking for alternative to "${currentSource}" for episode ${episodeIndex + 1}`);
    logger.info(`[SOURCE_SELECTION] Failed sources: [${Array.from(failedSources).join(', ')}]`);
    
    // 过滤掉当前source和已失败的sources
    const availableSources = searchResults.filter(result => 
      result.source !== currentSource && 
      !failedSources.has(result.source) &&
      result.episodes && 
      result.episodes.length > episodeIndex
    );
    
    logger.info(`[SOURCE_SELECTION] Available sources: ${availableSources.length}`);
    availableSources.forEach(source => {
      logger.info(`[SOURCE_SELECTION] - ${source.source} (${source.source_name}): ${source.episodes?.length || 0} episodes`);
    });
    
    if (availableSources.length === 0) {
      logger.error(`[SOURCE_SELECTION] No available sources for episode ${episodeIndex + 1}`);
      return null;
    }
    
    // 优先选择清晰度最高的 source：按数字高度排，2160p/1440p 也能正确排在前面
    //（原来只认 1080/720/480/360 四档，4K 会被当成“未知”排在 360p 后面）
    const sortedSources = availableSources.sort((a, b) => {
      const height = (res: string) => {
        const m = res.match(/(\d+)/);
        return m ? parseInt(m[1], 10) : 0;
      };
      return height(b.resolution || '') - height(a.resolution || '');
    });
    
    const selectedSource = sortedSources[0];
    logger.info(`[SOURCE_SELECTION] Selected fallback source: ${selectedSource.source} (${selectedSource.source_name}) with resolution: ${selectedSource.resolution || 'unknown'}`);
    
    return selectedSource;
  },
}));

export const sourcesSelector = (state: DetailState) => state.sources;
export default useDetailStore;
export const episodesSelectorBySource = (source: string) => (state: DetailState) =>
  state.searchResults.find((r) => r.source === source)?.episodes || [];
