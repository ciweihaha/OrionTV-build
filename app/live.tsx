import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { View, FlatList, ScrollView, StyleSheet, ActivityIndicator, BackHandler, useTVEventHandler, Text, TouchableOpacity } from "react-native";
import type { TVRemoteEvent } from "react-native";
import { useRouter } from "expo-router";
import LivePlayer from "@/components/LivePlayer";
import { StyledButton } from "@/components/StyledButton";
import { getPlayableUrl, getCachedM3u, refreshM3u, Channel } from "@/services/m3u";
import { DEFAULT_EPG_URL, EpgData, getCachedEpg, refreshEpg, findEpgForChannel, currentProgrammes, programmeProgress } from "@/services/epg";
import { ThemedView } from "@/components/ThemedView";
import { useSettingsStore } from "@/stores/settingsStore";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { getCommonResponsiveStyles } from "@/utils/ResponsiveStyles";
import ResponsiveNavigation from "@/components/navigation/ResponsiveNavigation";
import ResponsiveHeader from "@/components/navigation/ResponsiveHeader";
import { LiveChannelPrefsManager, LiveLastChannel } from "@/services/storage";
import { Logger } from "@/utils/Logger";
import { Colors } from "@/constants/Colors";

const logger = Logger.withTag('LiveScreen');
const colors = Colors.dark;

// 天光云影同款常量：面板 15 秒无操作自动关闭（UI_SCREEN_AUTO_CLOSE_DELAY）
const PANEL_AUTO_CLOSE_MS = 15_000;
// 换台信息条显示时长：天光云影是 1.5 秒（UI_TEMP_PANEL_SCREEN_SHOW_DURATION），
// 这里多显示正在/稍后两个节目，4 秒才够看完
const TEMP_BAR_MS = 4000;
// 提示消息显示时长
const MESSAGE_MS = 3000;
// 数字换台：输入完成后提交的等待时间（毫秒）
const DIGIT_COMMIT_MS = 1500;
// 坏源自动跳台的连续失败上限（防死循环）
const MAX_AUTO_SKIP = 5;
// 收藏虚拟分组 key（不与真实分组名冲突）
const FAV_GROUP = "__fav__";

/**
 * Android TV 数字键 keyCode → 数字：KEYCODE_0..9 = 7..16，
 * RN useTVEventHandler 对未映射键上报 String(keyCode)；同时兼容直接上报 "0"-"9" 的设备。
 */
const DIGIT_KEY_MAP: Record<string, string> = {
  "7": "0", "8": "1", "9": "2", "10": "3", "11": "4",
  "12": "5", "13": "6", "14": "7", "15": "8", "16": "9",
};

/** 换台信息条：频道信息（台号+台名+正在/稍后节目）或一条提示消息 */
type TempBarState = { kind: 'channel' } | { kind: 'message'; text: string };

/** 频道卡片布局（电视与触摸设备不同尺寸；getItemLayout 与样式共用同一份数字） */
function getCardLayout(deviceType: string) {
  const isTV = deviceType === 'tv';
  const isTab = deviceType === 'tablet';
  return {
    width: isTV ? 230 : isTab ? 190 : 160,
    height: isTV ? 84 : 72,
    gap: 14,
  };
}

/** 台号：全列表全局序号，两位补零（天光云影 channelNoText 同款） */
function channelNoText(index: number): string {
  return String(index + 1).padStart(2, '0');
}

/** 右上角日期时间：11月12日 周四 18:30 */
function formatDateTime(nowMs: number): string {
  const d = new Date(nowMs);
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 周${weekdays[d.getDay()]} ${hh}:${mm}`;
}

/** 节目时间：08:00 */
function formatProgrammeTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

interface ChannelCardProps {
  item: Channel;
  isFavRow: boolean;
  isCurrent: boolean;
  isFocused: boolean;
  isFav: boolean;
  now?: { title: string; progress: number };
  styles: ReturnType<typeof createResponsiveStyles>;
  onSelect: (channel: Channel) => void;
  onToggleFav: (channel: Channel) => void;
  onFocusCard: (channel: Channel) => void;
}

// 频道卡片（memo，模块级）：面板每次焦点移动都重渲染，旧版 renderChannelCard
// 是普通函数，所有可见卡片跟着全量重渲染。memo 后只有 isFocused/isCurrent/
// isFav/now 变化的卡片重渲染；now 每 30 秒 tick 才换引用，焦点移动不影响它。
const ChannelCard = React.memo(function ChannelCard({
  item,
  isFavRow,
  isCurrent,
  isFocused,
  isFav,
  now,
  styles,
  onSelect,
  onToggleFav,
  onFocusCard,
}: ChannelCardProps) {
  return (
    <TouchableOpacity
      onPress={() => onSelect(item)}
      onLongPress={() => onToggleFav(item)}
      onFocus={() => onFocusCard(item)}
      // 当前台同时在收藏行和所属分组行出现：首选焦点只给所属分组那张卡，
      // 否则两张卡都抢焦点，落点不确定
      hasTVPreferredFocus={isCurrent && !isFavRow}
      activeOpacity={0.8}
      style={[
        styles.channelCard,
        isCurrent && styles.channelCardCurrent,
        isFocused && styles.channelCardFocused,
      ]}
    >
      <View style={styles.channelCardText}>
        <Text
          numberOfLines={1}
          style={[styles.channelCardName, isFocused && styles.channelCardTextFocused]}
        >
          {isFav ? `★ ${item.name}` : item.name}
        </Text>
        <Text
          numberOfLines={1}
          style={[styles.channelCardProgramme, isFocused && styles.channelCardTextFocused]}
        >
          {now?.title ?? ""}
        </Text>
      </View>
      {now && (
        <View style={styles.cardProgressTrack}>
          <View style={[isFocused ? styles.progressFillLight : styles.progressFill, { width: `${now.progress * 100}%` }]} />
        </View>
      )}
    </TouchableOpacity>
  );
});

export default function LiveScreen() {
  const m3uUrl = useSettingsStore((s) => s.m3uUrl);
  const router = useRouter();

  // 响应式布局配置
  const responsiveConfig = useResponsiveLayout();
  const commonStyles = getCommonResponsiveStyles(responsiveConfig);
  const { deviceType, spacing } = responsiveConfig;
  const cardLayout = useMemo(() => getCardLayout(deviceType), [deviceType]);

  const [channels, setChannels] = useState<Channel[]>([]);
  const [groupedChannels, setGroupedChannels] = useState<Record<string, Channel[]>>({});
  const [channelGroups, setChannelGroups] = useState<string[]>([]);
  const [favChannels, setFavChannels] = useState<LiveLastChannel[]>([]);
  // 收藏 URL 集合：原来每张卡每渲染都 favChannels.some() 一次（O(收藏数)），
  // 面板每 30 秒 tick + 每次焦点移动都全量重算；Set 查一次 O(1)
  const favUrlSet = useMemo(
    () => new Set(favChannels.map((f) => f.url)),
    [favChannels]
  );

  const [currentChannelIndex, setCurrentChannelIndex] = useState(0);
  /** 当前频道的线路下标（同名多地址频道合并而来，左右键切换） */
  const [currentUrlIdx, setCurrentUrlIdx] = useState(0);
  /** 重挂 LivePlayer 的序号：选了当前正在播的台时 index 不变，streamUrl 也不变，
   *  换 key 才能让播放器重新加载（重试坏台） */
  const [retrySeq, setRetrySeq] = useState(0);
  /** 手动重载 m3u 的序号：加载失败后点“重试”时 +1，触发 loadChannels 重新跑 */
  const [reloadSeq, setReloadSeq] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isPanelVisible, setIsPanelVisible] = useState(false);
  /** 节目单数据（天光云影同款来源 ysp.ciweihaha.win/epg.xml） */
  const [epg, setEpg] = useState<EpgData | null>(null);
  /** 节目单弹窗打开的频道（null = 关闭） */
  const [epgDialogChannel, setEpgDialogChannel] = useState<Channel | null>(null);
  /** 面板里最后聚焦的频道（菜单键打开它的节目单） */
  const [focusedChannel, setFocusedChannel] = useState<Channel | null>(null);
  /** 换台信息条（频道信息或提示消息），null = 隐藏 */
  const [tempBar, setTempBar] = useState<TempBarState | null>(null);
  /** 当前时间戳（30 秒一跳）：驱动右上角时钟与节目进度条刷新 */
  const [nowMs, setNowMs] = useState(() => Date.now());

  const tempTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const digitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const digitBufRef = useRef("");                          // TV 事件闭包内读最新缓冲
  const failCountRef = useRef(0);                          // 连续失败计数（坏源跳台）
  const lastChannelRestoredRef = useRef(false);            // 上次频道只恢复一次
  const channelsRef = useRef<Channel[]>([]);               // 数字换台闭包内读最新列表

  useEffect(() => { channelsRef.current = channels; }, [channels]);

  // 时钟：30 秒刷新一次（右上角时间 + 节目进度）
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // 组件卸载时清理全部定时器，防止 setState 到已卸载组件
  useEffect(() => {
    return () => {
      if (tempTimer.current) clearTimeout(tempTimer.current);
      if (panelTimer.current) clearTimeout(panelTimer.current);
      if (digitTimer.current) clearTimeout(digitTimer.current);
    };
  }, []);

  // 收藏频道加载（V1.5）
  useEffect(() => {
    LiveChannelPrefsManager.getFavChannels().then(setFavChannels).catch(() => {});
  }, []);

  // ---------- 换台信息条（天光云影 PanelTempScreen 同款） ----------

  const showTempBar = useCallback((state: TempBarState, ms: number) => {
    setTempBar(state);
    if (tempTimer.current) clearTimeout(tempTimer.current);
    tempTimer.current = setTimeout(() => setTempBar(null), ms);
  }, []);

  const showChannelTempBar = useCallback(() => {
    showTempBar({ kind: 'channel' }, TEMP_BAR_MS);
  }, [showTempBar]);

  const showMessage = useCallback((text: string) => {
    showTempBar({ kind: 'message', text }, MESSAGE_MS);
  }, [showTempBar]);

  const hideTempBar = useCallback(() => {
    if (tempTimer.current) clearTimeout(tempTimer.current);
    setTempBar(null);
  }, []);

  // ---------- 频道面板开关与 15 秒自动关闭 ----------

  const pokePanelTimer = useCallback(() => {
    if (panelTimer.current) clearTimeout(panelTimer.current);
    panelTimer.current = setTimeout(() => {
      setIsPanelVisible(false);
      setEpgDialogChannel(null);
    }, PANEL_AUTO_CLOSE_MS);
  }, []);

  const openPanel = useCallback(() => {
    hideTempBar();
    setIsPanelVisible(true);
    pokePanelTimer();
  }, [hideTempBar, pokePanelTimer]);

  const closePanel = useCallback(() => {
    if (panelTimer.current) clearTimeout(panelTimer.current);
    setIsPanelVisible(false);
    setEpgDialogChannel(null);
  }, []);

  // 返回键：节目单弹窗开着先关弹窗，面板开着关面板（天光云影同款层级）
  useEffect(() => {
    if (!isPanelVisible && !epgDialogChannel) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (epgDialogChannel) {
        setEpgDialogChannel(null);
        pokePanelTimer();
        return true;
      }
      closePanel();
      return true;
    });
    return () => sub.remove();
  }, [isPanelVisible, epgDialogChannel, pokePanelTimer, closePanel]);

  // ---------- 分组构建（V1.5：有收藏时在最前插入收藏虚拟分组） ----------

  const buildGroups = useCallback((list: Channel[], favs: LiveLastChannel[]) => {
    const groups: Record<string, Channel[]> = {};
    if (favs.length > 0) {
      groups[FAV_GROUP] = list.filter((c) => favs.some((f) => f.url === c.url));
    }
    for (const channel of list) {
      const groupName = channel.group || "Other";
      if (!groups[groupName]) groups[groupName] = [];
      groups[groupName].push(channel);
    }
    return groups;
  }, []);

  // 收藏变化 → 重建分组（收藏虚拟组置顶）
  useEffect(() => {
    const groups = buildGroups(channels, favChannels);
    setGroupedChannels(groups);
    setChannelGroups(Object.keys(groups));
  }, [channels, favChannels, buildGroups]);

  // ---------- m3u 加载（V1.5：缓存秒进 + 后台刷新 + 恢复上次频道） ----------

  useEffect(() => {
    let cancelled = false;
    const loadChannels = async () => {
      if (!m3uUrl) return;
      setIsLoading(true);
      lastChannelRestoredRef.current = false;

      // 1) 缓存优先（内存 → 磁盘）：有缓存先渲染，直播页秒开
      const cached = await getCachedM3u(m3uUrl);
      if (cancelled) return;
      if (cached.length > 0) {
        setChannels(cached);
        setIsLoading(false);
        if (!lastChannelRestoredRef.current) {
          lastChannelRestoredRef.current = true;
          const last = await LiveChannelPrefsManager.getLastChannel();
          const idx = last ? cached.findIndex((c) => c.url === last.url) : -1;
          if (idx >= 0) {
            setCurrentChannelIndex(idx);
          }
        }
      }

      // 2) 网络刷新（无缓存时这就是首次加载；有缓存时为后台更新）
      const fresh = await refreshM3u(m3uUrl);
      if (cancelled) return;
      if (fresh.length > 0) {
        setChannels(fresh);
        if (!lastChannelRestoredRef.current) {
          lastChannelRestoredRef.current = true;
          const last = await LiveChannelPrefsManager.getLastChannel();
          const idx = last ? fresh.findIndex((c) => c.url === last.url) : -1;
          if (idx >= 0) {
            setCurrentChannelIndex(idx);
          }
        }
      } else if (cached.length === 0) {
        logger.info("m3u load failed and no cache available");
      }
      setIsLoading(false);
    };
    loadChannels();
    return () => { cancelled = true; };
    // reloadSeq 只作重触发信号，effect 内不读它（与 retrySeq 同款用法）
  }, [m3uUrl, reloadSeq]);

  // 频道列表刷新后可能变短：当前索引越界时钳制到末尾，否则 currentChannel
  // 为 undefined，selectedChannelUrl 为 null，播放器黑屏
  useEffect(() => {
    if (channels.length > 0 && currentChannelIndex >= channels.length) {
      setCurrentChannelIndex(channels.length - 1);
    }
  }, [channels, currentChannelIndex]);

  // ---------- EPG 加载（与 m3u 同款：缓存秒显 + 后台刷新） ----------

  useEffect(() => {
    let cancelled = false;
    const loadEpg = async () => {
      const cached = await getCachedEpg(DEFAULT_EPG_URL);
      if (!cancelled && cached) setEpg(cached);
      const fresh = await refreshEpg(DEFAULT_EPG_URL);
      if (!cancelled && fresh) setEpg(fresh);
    };
    loadEpg();
    return () => { cancelled = true; };
  }, []);

  // ---------- 当前频道与节目单 ----------

  const currentChannel = channels[currentChannelIndex];
  const selectedChannelUrl = currentChannel
    ? getPlayableUrl(currentChannel.urls[currentUrlIdx] ?? currentChannel.url)
    : null;

  const currentEpgChannel = useMemo(
    () => (currentChannel ? findEpgForChannel(epg, currentChannel.tvgId, currentChannel.name) : null),
    [epg, currentChannel],
  );
  const currentProgrammesData = useMemo(
    () => currentProgrammes(currentEpgChannel, nowMs),
    [currentEpgChannel, nowMs],
  );

  /** 各频道正在播的节目（面板卡片用）：id → { 节目名， 进度 0..1 } */
  const epgNowById = useMemo(() => {
    const map: Record<string, { title: string; progress: number }> = {};
    if (!epg) return map;
    for (const ch of channels) {
      const e = findEpgForChannel(epg, ch.tvgId, ch.name);
      const cur = e ? currentProgrammes(e, nowMs) : null;
      if (cur?.now) {
        map[ch.id] = { title: cur.now.title, progress: programmeProgress(cur.now, nowMs) };
      }
    }
    return map;
  }, [epg, channels, nowMs]);

  // ---------- 选台 / 换台 / 切线路 ----------

  // 记住上次频道（V1.5）：换台/选台时保存
  const saveLastChannel = useCallback((channel: Channel) => {
    LiveChannelPrefsManager.saveLastChannel({ url: channel.url, name: channel.name }).catch(() => {});
  }, []);

  const selectChannelByIndex = useCallback((index: number, list: Channel[], isAutoSkip = false) => {
    if (index < 0 || index >= list.length) return;
    // 选了当前正在播的台（列表里重选之前失败的台、单频道列表自动跳台）：
    // index 没变，LivePlayer 的 streamUrl effect 不会重跑，坏台就卡在“加载失败”；
    // 换 key 重挂播放器才真正重试
    if (index === currentChannelIndex) {
      setRetrySeq((s) => s + 1);
    } else {
      setCurrentUrlIdx(0); // 换台回到主线路
    }
    setCurrentChannelIndex(index);
    // 只有手动换台才清零自动跳台计数：自动跳台走同一条路，清零会让
    // handlePlaybackError 的 MAX_AUTO_SKIP 上限永远到不了——全是坏源时
    // 无限循环跳台
    if (!isAutoSkip) failCountRef.current = 0;
    showChannelTempBar();
    saveLastChannel(list[index]);
  }, [currentChannelIndex, showChannelTempBar, saveLastChannel]);

  const handleSelectChannel = useCallback((channel: Channel) => {
    const globalIndex = channels.findIndex((c) => c.id === channel.id);
    if (globalIndex !== -1) {
      selectChannelByIndex(globalIndex, channels);
      closePanel();
    }
  }, [channels, selectChannelByIndex, closePanel]);

  const changeChannel = useCallback(
    (direction: "next" | "prev", isAutoSkip = false) => {
      const list = channelsRef.current;
      if (list.length === 0) return;
      const newIndex =
        direction === "next"
          ? (currentChannelIndex + 1) % list.length
          : (currentChannelIndex - 1 + list.length) % list.length;
      selectChannelByIndex(newIndex, list, isAutoSkip);
    },
    [currentChannelIndex, selectChannelByIndex]
  );

  /** 切线路（天光云影：左右键切同一频道的多条地址；单线路频道无动作） */
  const changeLine = useCallback((direction: "next" | "prev") => {
    const ch = channels[currentChannelIndex];
    if (!ch || ch.urls.length <= 1) return;
    const delta = direction === "next" ? 1 : -1;
    setCurrentUrlIdx((prev) => (prev + delta + ch.urls.length) % ch.urls.length);
    failCountRef.current = 0;
    showChannelTempBar();
  }, [channels, currentChannelIndex, showChannelTempBar]);

  // ---------- V1.5：数字键换台 ----------

  const commitDigits = useCallback(() => {
    const n = parseInt(digitBufRef.current, 10);
    digitBufRef.current = "";
    if (digitTimer.current) {
      clearTimeout(digitTimer.current);
      digitTimer.current = null;
    }
    const list = channelsRef.current;
    if (!isNaN(n) && n >= 1 && n <= list.length) {
      selectChannelByIndex(n - 1, list);
    } else if (!isNaN(n)) {
      showMessage(`无 ${n} 号频道`);
    }
  }, [selectChannelByIndex, showMessage]);

  const handleDigit = useCallback((digit: string) => {
    const next = (digitBufRef.current + digit).slice(-4); // 最多 4 位，超出丢最早
    digitBufRef.current = next;
    showMessage(`输入频道号：${next}`);
    // 唯一匹配立即切换：存在该号且不存在以它为前缀的更大号（如输入 5 但列表有 50+）
    const n = parseInt(next, 10);
    const list = channelsRef.current;
    // 以 n 为前缀的最小更大号是 n*10（如 5 → 50）：列表长度达到它才说明可能存在，
    // 原来用 (n+1)*10 高了一个量级——列表 55 个台时输 5 会直接切到 5 台，
    // 再也输不出 50-55
    const hasLonger = !isNaN(n) && list.length >= n * 10;
    if (!isNaN(n) && n >= 1 && n <= list.length && !hasLonger) {
      commitDigits();
      return;
    }
    if (digitTimer.current) clearTimeout(digitTimer.current);
    digitTimer.current = setTimeout(commitDigits, DIGIT_COMMIT_MS);
  }, [commitDigits, showMessage]);

  // ---------- V1.5：收藏当前频道 ----------

  const toggleFavCurrent = useCallback(async () => {
    const ch = channelsRef.current[currentChannelIndex];
    if (!ch) return;
    try {
      const added = await LiveChannelPrefsManager.toggleFavChannel({ url: ch.url, name: ch.name });
      setFavChannels(await LiveChannelPrefsManager.getFavChannels());
      showMessage(`${ch.name}  ${added ? "★ 已收藏" : "已取消收藏"}`);
    } catch {
      showMessage("收藏失败，请重试");
    }
  }, [currentChannelIndex, showMessage]);

  const toggleFavChannelItem = useCallback(async (channel: Channel) => {
    try {
      const added = await LiveChannelPrefsManager.toggleFavChannel({ url: channel.url, name: channel.name });
      const favs = await LiveChannelPrefsManager.getFavChannels();
      setFavChannels(favs);
      showMessage(`${channel.name}  ${added ? "★ 已收藏" : "已取消收藏"}`);
      pokePanelTimer();
    } catch {
      showMessage("收藏失败，请重试");
    }
  }, [showMessage, pokePanelTimer]);

  // ---------- V1.5：坏源自动跳台 ----------

  const handlePlaybackError = useCallback(() => {
    const list = channelsRef.current;
    if (list.length === 0) return;
    failCountRef.current += 1;
    if (failCountRef.current > MAX_AUTO_SKIP) {
      showMessage("连续切换失败，请按上下键手动换台");
      return;
    }
    // 频道面板打开时不自动跳台（用户正在浏览），只提示
    if (isPanelVisible) {
      showMessage("信号异常，请重新选择频道");
      return;
    }
    // 先换台（会刷出新台的信息条），再盖上提示消息，用户才能看到原因
    changeChannel("next", true);
    showMessage("信号异常，自动切换下一频道…");
  }, [changeChannel, isPanelVisible, showMessage]);

  const handlePlaybackStatus = useCallback((status: { isLoaded?: boolean; isPlaying?: boolean }) => {
    if (status.isLoaded && status.isPlaying) {
      failCountRef.current = 0; // 播放成功清零
    }
  }, []);

  // ---------- 节目单弹窗：左右键切换频道 ----------

  const switchEpgDialogChannel = useCallback((direction: 1 | -1) => {
    if (!epgDialogChannel) return;
    const list = channelsRef.current;
    const idx = list.findIndex((c) => c.id === epgDialogChannel.id);
    if (idx < 0 || list.length === 0) return;
    setEpgDialogChannel(list[(idx + direction + list.length) % list.length]);
    pokePanelTimer();
  }, [epgDialogChannel, pokePanelTimer]);

  const closeEpgDialog = useCallback(() => {
    setEpgDialogChannel(null);
    pokePanelTimer();
  }, [pokePanelTimer]);

  // ---------- 电视遥控器（天光云影映射） ----------
  // 播放界面：上/下换台，左/右切线路，OK 打开频道面板，菜单收藏当前台，数字键输台号
  // 面板打开时：方向键走原生焦点移动，菜单键打开焦点频道的节目单
  // 节目单弹窗：左/右切换频道节目单，OK/返回关闭

  const handleTVEvent = useCallback(
    (event: TVRemoteEvent) => {
      if (deviceType !== 'tv') return;
      const t = event.eventType ?? "";

      // 以下离散按键（含数字键、弹窗内的左右/确认）只响应松键
      // （eventKeyAction === 1）：原生层对同一按键在 ACTION_DOWN 与
      // ACTION_UP 各发一次事件（第 97 轮），不守会一次按键执行两次——
      // 左右换台一次连跳两台、菜单收藏刚加上就又被取消、节目单弹窗
      // 里左右切台一次跳两台。数字键走的是同一条 useTVEventHandler
      // 事件通道，原来数字分支在守卫之前先行返回，每按一位数字会输入
      // 两次（如按 5 变 55），现统一移到守卫之后。eventKeyAction 缺失
      // （NaN）的设备不受守卫影响，仍按原样处理。
      // TODO（需真机验证）：以上依据是代码分析（同一事件通道 + 原生层双发注释），
      // 未在真机上验证数字键是否确实双发；若真机上数字键只发按下事件，本分支需要
      // 改回守卫之前。
      const keyAction = Number(event.eventKeyAction);
      if (!Number.isNaN(keyAction) && keyAction !== 1) {
        return; // 按下那次不处理，只处理松键那次
      }

      // 节目单弹窗打开时：左右切台节目单，OK 关闭；上下留给列表焦点
      if (epgDialogChannel) {
        if (t === "left") { switchEpgDialogChannel(-1); return; }
        if (t === "right") { switchEpgDialogChannel(1); return; }
        if (t === "select") { closeEpgDialog(); return; }
        return;
      }

      // 面板打开时：菜单键打开焦点频道的节目单；其余事件放行给原生焦点移动
      if (isPanelVisible) {
        if (t === "menu") {
          const target = focusedChannel ?? channels[currentChannelIndex];
          if (target) {
            setEpgDialogChannel(target);
            pokePanelTimer();
          }
        }
        return;
      }

      // 数字键换台（V1.5）
      const digit = /^[0-9]$/.test(t) ? t : DIGIT_KEY_MAP[t];
      if (digit) {
        handleDigit(digit);
        return;
      }
      if (t === "menu") {
        toggleFavCurrent();
        return;
      }
      // 失败页重试：当前台失败过且之后没成功过（failCount 未清零）时，
      // OK 键重选当前台（同台换 key 重挂播放器）；平时 OK 键打开频道面板。
      // 但自动跳台已耗尽（failCount > MAX_AUTO_SKIP）时同台重试无意义，
      // OK 改开面板让用户手动选台——否则 OK 永远被重试劫持，面板打不开。
      if (t === "select") {
        if (failCountRef.current > 0 && failCountRef.current <= MAX_AUTO_SKIP) {
          selectChannelByIndex(currentChannelIndex, channels);
        } else {
          openPanel();
        }
        return;
      }
      if (t === "up") changeChannel("prev");
      else if (t === "down") changeChannel("next");
      else if (t === "left") changeLine("prev");
      else if (t === "right") changeLine("next");
    },
    [deviceType, epgDialogChannel, isPanelVisible, focusedChannel, channels, currentChannelIndex,
      switchEpgDialogChannel, closeEpgDialog, pokePanelTimer, handleDigit, toggleFavCurrent,
      selectChannelByIndex, openPanel, changeChannel, changeLine]
  );

  useTVEventHandler(deviceType === 'tv' ? handleTVEvent : () => {});

  // 动态样式：createResponsiveStyles 每 render 都重新 StyleSheet.create，
  // 用 useMemo memo 化，只随 deviceType/spacing/cardLayout 变化重建
  const dynamicStyles = useMemo(
    () => createResponsiveStyles(deviceType, spacing, cardLayout),
    [deviceType, spacing, cardLayout],
  );

  // ---------- 渲染：换台信息条 ----------

  const renderTempBar = () => {
    if (!tempBar) return null;
    // 面板打开时：频道信息条不显示（面板底部已有当前频道信息），但提示
    // 消息必须显示——handlePlaybackError 在面板打开时只发消息不跳台，
    // 原来这里直接 return null，消息被面板盖住用户永远看不到
    if (tempBar.kind === 'message') {
      return (
        <View style={dynamicStyles.tempBar}>
          <Text style={dynamicStyles.tempMessage}>{tempBar.text}</Text>
        </View>
      );
    }
    if (isPanelVisible) return null;
    if (!currentChannel) return null;
    const now = currentProgrammesData?.now ?? null;
    const next = currentProgrammesData?.next ?? null;
    return (
      <View style={dynamicStyles.tempBar}>
        <View style={dynamicStyles.tempChannelRow}>
          <Text style={dynamicStyles.tempChannelNo}>{channelNoText(currentChannelIndex)}</Text>
          <Text style={dynamicStyles.tempChannelName} numberOfLines={1}>{currentChannel.name}</Text>
          {currentChannel.urls.length > 1 && (
            <Text style={dynamicStyles.lineBadge}>{`${currentUrlIdx + 1}/${currentChannel.urls.length}`}</Text>
          )}
        </View>
        <Text style={dynamicStyles.tempProgramme} numberOfLines={1}>
          {`正在播放：${now?.title ?? "无节目"}`}
        </Text>
        <Text style={dynamicStyles.tempProgramme} numberOfLines={1}>
          {`稍后播放：${next?.title ?? "无节目"}`}
        </Text>
        {now && (
          <View style={dynamicStyles.progressTrack}>
            <View style={[dynamicStyles.progressFill, { width: `${programmeProgress(now, nowMs) * 100}%` }]} />
          </View>
        )}
      </View>
    );
  };

  // ---------- 渲染：面板底部当前频道信息 ----------

  const renderPanelCurrentInfo = () => {
    if (!currentChannel) return null;
    const now = currentProgrammesData?.now ?? null;
    const next = currentProgrammesData?.next ?? null;
    return (
      <TouchableOpacity
        activeOpacity={0.8}
        onPress={() => setEpgDialogChannel(currentChannel)}
        onFocus={pokePanelTimer}
        style={dynamicStyles.panelCurrentInfo}
      >
        <View style={dynamicStyles.panelCurrentNameRow}>
          <Text style={dynamicStyles.panelCurrentName} numberOfLines={1}>{currentChannel.name}</Text>
          {currentChannel.urls.length > 1 && (
            <Text style={dynamicStyles.lineBadge}>{`${currentUrlIdx + 1}/${currentChannel.urls.length}`}</Text>
          )}
        </View>
        <Text style={dynamicStyles.panelCurrentProgramme} numberOfLines={1}>
          {`正在播放：${now?.title ?? "无节目"}`}
        </Text>
        <Text style={dynamicStyles.panelCurrentProgramme} numberOfLines={1}>
          {`稍后播放：${next?.title ?? "无节目"}`}
        </Text>
        {now && (
          <View style={dynamicStyles.progressTrack}>
            <View style={[dynamicStyles.progressFill, { width: `${programmeProgress(now, nowMs) * 100}%` }]} />
          </View>
        )}
      </TouchableOpacity>
    );
  };

  // ---------- 渲染：频道卡片（台名 + 正在播的节目 + 进度条） ----------

  // 卡片获焦回调：稳定引用，ChannelCard memo 的 prop 之一（内联箭头会
  // 让 memo 每渲染都失效）
  const handleFocusCard = useCallback((ch: Channel) => {
    setFocusedChannel(ch);
    pokePanelTimer();
  }, [pokePanelTimer]);

  // 频道卡片（memo）：面板每次焦点移动都会重渲染，旧 renderChannelCard 是
  // 普通函数，所有可见卡片跟着全量重渲染（遥控器按一下卡一下）。抽成 memo
  // 组件后只有 isFocused/isCurrent 变化的卡片重渲染；onPress 等内联箭头
  // 在组件内部，不影响 memo 的 props 比较。
  const renderChannelCard = useCallback(({ item, isFavRow }: { item: Channel; isFavRow: boolean }) => {
    return (
      <ChannelCard
        item={item}
        isFavRow={isFavRow}
        isCurrent={currentChannel?.id === item.id}
        isFocused={focusedChannel?.id === item.id}
        isFav={favUrlSet.has(item.url)}
        now={epgNowById[item.id]}
        styles={dynamicStyles}
        onSelect={handleSelectChannel}
        onToggleFav={toggleFavChannelItem}
        onFocusCard={handleFocusCard}
      />
    );
  }, [currentChannel, focusedChannel, favUrlSet, epgNowById, dynamicStyles, handleSelectChannel, toggleFavChannelItem, handleFocusCard]);

  // ---------- 渲染：频道面板（天光云影新面板同款） ----------
  // 全屏半透明遮罩；右上角台号 + 日期时间；底部当前频道信息 +
  // 按分组纵排、每组一横排频道卡片；15 秒无操作自动关闭

  const renderPanel = () => {
    if (!isPanelVisible) return null;
    return (
      <View style={dynamicStyles.panelOverlay}>
        {/* 触摸设备点遮罩空白处关闭面板；电视上不可聚焦，不抢焦点 */}
        <TouchableOpacity
          activeOpacity={1}
          focusable={false}
          onPress={closePanel}
          style={dynamicStyles.panelBackdrop}
        />
        <View style={dynamicStyles.panelTopRight}>
          <Text style={dynamicStyles.panelChannelNo}>{channelNoText(currentChannelIndex)}</Text>
          <View style={dynamicStyles.panelTopDivider} />
          <Text style={dynamicStyles.panelDateTime}>{formatDateTime(nowMs)}</Text>
        </View>
        <View style={dynamicStyles.panelBottom}>
          {renderPanelCurrentInfo()}
          {isLoading && channels.length === 0 ? (
            <ActivityIndicator size="large" color="#fff" style={dynamicStyles.panelLoading} />
          ) : (
            <ScrollView
              style={dynamicStyles.panelGroupScroll}
              showsVerticalScrollIndicator={false}
            >
              {channelGroups.map((group) => {
                const list = groupedChannels[group] ?? [];
                const currentIdxInGroup = list.findIndex((c) => c.id === currentChannel?.id);
                return (
                  <View key={group} style={dynamicStyles.panelGroupSection}>
                    <View style={dynamicStyles.panelGroupHeader}>
                      <Text style={dynamicStyles.panelGroupName}>
                        {group === FAV_GROUP ? "★ 收藏" : group}
                      </Text>
                      <Text style={dynamicStyles.panelGroupCount}>{`${list.length}个频道`}</Text>
                    </View>
                    <FlatList
                      data={list}
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      keyExtractor={(item) => item.id}
                      initialScrollIndex={currentIdxInGroup > 0 ? currentIdxInGroup : 0}
                      initialNumToRender={32}
                      getItemLayout={(_data, index) => ({
                        length: cardLayout.width + cardLayout.gap,
                        offset: (cardLayout.width + cardLayout.gap) * index,
                        index,
                      })}
                      renderItem={({ item }) => renderChannelCard({ item, isFavRow: group === FAV_GROUP })}
                      contentContainerStyle={dynamicStyles.panelRowContent}
                    />
                  </View>
                );
              })}
            </ScrollView>
          )}
          <Text style={dynamicStyles.panelHint}>
            {deviceType === 'tv'
              ? "OK 选台 · 长按 OK 收藏 · 菜单键看节目单 · 15 秒无操作自动关闭"
              : "点选换台 · 长按收藏 · 点当前频道信息看节目单"}
          </Text>
        </View>
      </View>
    );
  };

  // ---------- 渲染：节目单弹窗 ----------

  const renderEpgDialog = () => {
    if (!epgDialogChannel) return null;
    const epgChannel = findEpgForChannel(epg, epgDialogChannel.tvgId, epgDialogChannel.name);
    const programmes = epgChannel?.programmes ?? [];
    const dialogIndex = channels.findIndex((c) => c.id === epgDialogChannel.id);
    const currentProgIndex = programmes.findIndex((p) => p.startAt <= nowMs && nowMs < p.endAt);
    return (
      <View style={dynamicStyles.dialogOverlay}>
        <TouchableOpacity
          activeOpacity={1}
          focusable={false}
          onPress={closeEpgDialog}
          style={dynamicStyles.panelBackdrop}
        />
        <View style={dynamicStyles.dialogBox}>
          <Text style={dynamicStyles.dialogTitle} numberOfLines={1}>
            {`${dialogIndex >= 0 ? channelNoText(dialogIndex) : ""} ${epgDialogChannel.name}`}
          </Text>
          {programmes.length === 0 ? (
            <Text style={dynamicStyles.dialogEmpty}>暂无节目单</Text>
          ) : (
            <FlatList
              data={programmes}
              keyExtractor={(item) => `${item.startAt}`}
              initialScrollIndex={currentProgIndex > 0 ? currentProgIndex : 0}
              initialNumToRender={50}
              getItemLayout={(_data, index) => ({ length: 44, offset: 44 * index, index })}
              showsVerticalScrollIndicator={false}
              renderItem={({ item, index }) => {
                const isCurrent = item.startAt <= nowMs && nowMs < item.endAt;
                return (
                  <TouchableOpacity
                    onPress={closeEpgDialog}
                    onFocus={pokePanelTimer}
                    // 没有“正在播”的节目时（EPG 不覆盖当前时刻），焦点落第一行：
                    // 否则没有任何一行有首选焦点，电视上弹窗打开后焦点无处落
                    hasTVPreferredFocus={isCurrent || (currentProgIndex < 0 && index === 0)}
                    activeOpacity={0.8}
                    style={[dynamicStyles.dialogRow, isCurrent && dynamicStyles.dialogRowCurrent]}
                  >
                    <Text style={[dynamicStyles.dialogTime, isCurrent && dynamicStyles.dialogTextCurrent]}>
                      {`${formatProgrammeTime(item.startAt)} - ${formatProgrammeTime(item.endAt)}`}
                    </Text>
                    <Text
                      numberOfLines={1}
                      style={[dynamicStyles.dialogProgramme, isCurrent && dynamicStyles.dialogTextCurrent]}
                    >
                      {item.title}
                    </Text>
                    {isCurrent && (
                      <View style={dynamicStyles.dialogRowProgressTrack}>
                        <View style={[dynamicStyles.progressFill, { width: `${programmeProgress(item, nowMs) * 100}%` }]} />
                      </View>
                    )}
                  </TouchableOpacity>
                );
              }}
            />
          )}
          <Text style={dynamicStyles.dialogHint}>
            {deviceType === 'tv' ? "左右键切换频道 · 确认/返回关闭" : "点节目或空白处关闭"}
          </Text>
        </View>
      </View>
    );
  };

  const renderLiveContent = () => (
    <>
      {isLoading && channels.length === 0 ? (
        <View style={dynamicStyles.emptyContainer}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={dynamicStyles.emptyText}>正在加载直播源...</Text>
        </View>
      ) : channels.length === 0 ? (
        // 没配 m3u 或拉取失败且无缓存：原来只剩 LivePlayer 的“按 OK 键选择
        // 频道”，但一个频道都没有，OK 打开的也是空面板——给明确指引
        <View style={dynamicStyles.emptyContainer}>
          <Text style={dynamicStyles.emptyTitle}>
            {!m3uUrl ? "未配置直播源" : "直播源加载失败"}
          </Text>
          <Text style={dynamicStyles.emptyText}>
            {!m3uUrl
              ? "请在 设置 → 直播源 中填写 M3U 地址"
              : "请检查网络或 M3U 地址是否正确"}
          </Text>
          {!m3uUrl ? (
            <StyledButton
              text="去设置"
              variant="primary"
              onPress={() => router.push("/settings")}
              style={dynamicStyles.emptyButton}
              hasTVPreferredFocus
            />
          ) : (
            <StyledButton
              text="重试"
              variant="primary"
              onPress={() => setReloadSeq((s) => s + 1)}
              style={dynamicStyles.emptyButton}
              hasTVPreferredFocus
            />
          )}
        </View>
      ) : (
        <LivePlayer
          key={retrySeq}
          streamUrl={selectedChannelUrl}
          onPlaybackStatusUpdate={handlePlaybackStatus}
          onPlaybackError={handlePlaybackError}
          onRetry={() => selectChannelByIndex(currentChannelIndex, channels)}
        />
      )}
      {/* 触摸设备没有遥控器：右下角给一个开面板的按钮 */}
      {deviceType !== 'tv' && !isPanelVisible && (
        <TouchableOpacity onPress={openPanel} style={dynamicStyles.openPanelFab} activeOpacity={0.8}>
          <Text style={dynamicStyles.openPanelFabText}>频道</Text>
        </TouchableOpacity>
      )}
      {renderPanel()}
      {renderEpgDialog()}
      {/* 提示消息放最后渲染，盖在面板之上（见 renderTempBar） */}
      {renderTempBar()}
    </>
  );

  const content = (
    <ThemedView style={[commonStyles.container, dynamicStyles.container]}>
      {renderLiveContent()}
    </ThemedView>
  );

  // 根据设备类型决定是否包装在响应式导航中
  if (deviceType === 'tv') {
    return content;
  }

  return (
    <ResponsiveNavigation>
      <ResponsiveHeader title="直播" showBackButton />
      {content}
    </ResponsiveNavigation>
  );
}


const createResponsiveStyles = (
  deviceType: string,
  spacing: number,
  cardLayout: { width: number; height: number; gap: number },
) => {
  const isMobile = deviceType === 'mobile';
  const isTV = deviceType === 'tv';

  return StyleSheet.create({
    container: {
      flex: 1,
    },
    // ---------- 换台信息条（左下角） ----------
    tempBar: {
      position: "absolute",
      left: isTV ? 48 : 16,
      bottom: isTV ? 48 : 24,
      maxWidth: isTV ? 720 : "85%",
      backgroundColor: "rgba(0, 0, 0, 0.75)",
      borderRadius: 10,
      paddingHorizontal: isTV ? 20 : 14,
      paddingVertical: isTV ? 14 : 10,
    },
    tempMessage: {
      color: "#fff",
      fontSize: isTV ? 20 : 16,
    },
    tempChannelRow: {
      flexDirection: "row",
      alignItems: "baseline",
    },
    tempChannelNo: {
      color: colors.primary,
      fontSize: isTV ? 30 : 22,
      fontWeight: "bold",
      marginRight: 12,
    },
    tempChannelName: {
      color: "#fff",
      fontSize: isTV ? 28 : 20,
      fontWeight: "bold",
      flexShrink: 1,
    },
    lineBadge: {
      color: "#fff",
      backgroundColor: "rgba(255, 255, 255, 0.25)",
      fontSize: isTV ? 14 : 12,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 4,
      marginLeft: 8,
      overflow: "hidden",
    },
    tempProgramme: {
      color: "rgba(255, 255, 255, 0.85)",
      fontSize: isTV ? 18 : 14,
      marginTop: 4,
    },
    progressTrack: {
      height: 4,
      backgroundColor: "rgba(255, 255, 255, 0.25)",
      borderRadius: 2,
      marginTop: 8,
      overflow: "hidden",
    },
    progressFill: {
      height: "100%",
      backgroundColor: colors.primary,
      borderRadius: 2,
    },
    progressFillLight: {
      height: "100%",
      backgroundColor: "#fff",
      borderRadius: 2,
    },
    // ---------- 频道面板 ----------
    panelOverlay: {
      ...StyleSheet.absoluteFill,
      backgroundColor: "rgba(0, 0, 0, 0.5)",
      justifyContent: "flex-end",
    },
    panelBackdrop: {
      ...StyleSheet.absoluteFill,
    },
    panelTopRight: {
      position: "absolute",
      top: isTV ? 32 : 16,
      right: isTV ? 48 : 16,
      flexDirection: "row",
      alignItems: "center",
    },
    panelChannelNo: {
      color: "#fff",
      fontSize: isTV ? 30 : 22,
      fontWeight: "bold",
    },
    panelTopDivider: {
      width: 2,
      height: 30,
      backgroundColor: "#fff",
      marginHorizontal: 12,
    },
    panelDateTime: {
      color: "#fff",
      fontSize: isTV ? 20 : 15,
    },
    panelBottom: {
      paddingHorizontal: isTV ? 48 : 16,
      paddingBottom: isTV ? 28 : 16,
      maxHeight: "72%",
    },
    panelCurrentInfo: {
      marginBottom: 16,
    },
    panelCurrentNameRow: {
      flexDirection: "row",
      alignItems: "baseline",
    },
    panelCurrentName: {
      color: "#fff",
      fontSize: isTV ? 34 : 24,
      fontWeight: "bold",
      flexShrink: 1,
    },
    panelCurrentProgramme: {
      color: "rgba(255, 255, 255, 0.85)",
      fontSize: isTV ? 19 : 15,
      marginTop: 4,
    },
    panelLoading: {
      paddingVertical: 40,
    },
    panelGroupScroll: {
      flexGrow: 0,
    },
    panelGroupSection: {
      marginBottom: 14,
    },
    panelGroupHeader: {
      flexDirection: "row",
      alignItems: "baseline",
      marginBottom: 8,
    },
    panelGroupName: {
      color: "#fff",
      fontSize: isTV ? 17 : 14,
      fontWeight: "bold",
    },
    panelGroupCount: {
      color: "rgba(255, 255, 255, 0.7)",
      fontSize: isTV ? 14 : 12,
      marginLeft: 8,
    },
    panelRowContent: {
      paddingRight: spacing,
    },
    panelHint: {
      color: "rgba(255, 255, 255, 0.6)",
      fontSize: isTV ? 14 : 12,
      textAlign: "center",
      marginTop: 12,
    },
    // ---------- 频道卡片 ----------
    channelCard: {
      width: cardLayout.width,
      height: cardLayout.height,
      marginRight: cardLayout.gap,
      backgroundColor: "rgba(0, 0, 0, 0.8)",
      borderRadius: 8,
      borderWidth: 2,
      borderColor: "transparent",
      paddingHorizontal: 10,
      paddingVertical: 8,
      justifyContent: "space-between",
      overflow: "hidden",
    },
    channelCardCurrent: {
      borderColor: colors.primary,
    },
    channelCardFocused: {
      backgroundColor: colors.primary,
      borderColor: colors.primary,
    },
    channelCardText: {
      flex: 1,
      justifyContent: "space-around",
    },
    channelCardName: {
      color: "#fff",
      fontSize: isTV ? 19 : 15,
      fontWeight: "500",
    },
    channelCardProgramme: {
      color: "rgba(255, 255, 255, 0.75)",
      fontSize: isTV ? 14 : 12,
    },
    channelCardTextFocused: {
      color: "#fff",
    },
    cardProgressTrack: {
      height: 3,
      backgroundColor: "rgba(255, 255, 255, 0.25)",
      borderRadius: 2,
      overflow: "hidden",
    },
    // ---------- 节目单弹窗 ----------
    dialogOverlay: {
      ...StyleSheet.absoluteFill,
      backgroundColor: "rgba(0, 0, 0, 0.6)",
      justifyContent: "center",
      alignItems: "center",
    },
    dialogBox: {
      width: isMobile ? "92%" : isTablet(deviceType) ? "70%" : "55%",
      maxHeight: "75%",
      backgroundColor: "rgba(20, 20, 20, 0.97)",
      borderRadius: 12,
      padding: isTV ? 24 : 16,
    },
    dialogTitle: {
      color: "#fff",
      fontSize: isTV ? 24 : 18,
      fontWeight: "bold",
      marginBottom: 12,
    },
    dialogEmpty: {
      color: "rgba(255, 255, 255, 0.7)",
      fontSize: isTV ? 17 : 14,
      textAlign: "center",
      paddingVertical: 32,
    },
    dialogRow: {
      height: 44,
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 10,
      borderRadius: 6,
    },
    dialogRowCurrent: {
      backgroundColor: "rgba(0, 187, 94, 0.25)",
    },
    dialogTime: {
      color: "rgba(255, 255, 255, 0.7)",
      fontSize: isTV ? 16 : 13,
      width: isTV ? 150 : 120,
    },
    dialogProgramme: {
      color: "#fff",
      fontSize: isTV ? 17 : 14,
      flex: 1,
    },
    dialogTextCurrent: {
      color: colors.primary,
      fontWeight: "bold",
    },
    dialogRowProgressTrack: {
      width: 60,
      height: 3,
      backgroundColor: "rgba(255, 255, 255, 0.25)",
      borderRadius: 2,
      overflow: "hidden",
      marginLeft: 8,
    },
    dialogHint: {
      color: "rgba(255, 255, 255, 0.6)",
      fontSize: isTV ? 14 : 12,
      textAlign: "center",
      marginTop: 12,
    },
    // ---------- 触摸设备开面板按钮 ----------
    openPanelFab: {
      position: "absolute",
      right: 16,
      bottom: 24,
      backgroundColor: "rgba(0, 0, 0, 0.7)",
      borderRadius: 22,
      paddingHorizontal: 20,
      height: 44,
      justifyContent: "center",
      alignItems: "center",
    },
    openPanelFabText: {
      color: "#fff",
      fontSize: 15,
      fontWeight: "bold",
    },
    // 无频道时的居中指引（未配 m3u / 拉取失败 / 加载中）
    emptyContainer: {
      flex: 1,
      justifyContent: "center",
      alignItems: "center",
      backgroundColor: "#000",
      paddingHorizontal: 32,
    },
    emptyTitle: {
      color: "#fff",
      fontSize: isTV ? 24 : 20,
      fontWeight: "bold",
      textAlign: "center",
      marginBottom: 12,
    },
    emptyText: {
      color: "#ccc",
      fontSize: isTV ? 18 : 15,
      textAlign: "center",
      marginBottom: 24,
    },
    emptyButton: {
      minWidth: 140,
    },
  });
};

// 辅助：modalContent 宽度判断（避免三元嵌套可读性差）
function isTablet(deviceType: string) {
  return deviceType === "tablet";
}
