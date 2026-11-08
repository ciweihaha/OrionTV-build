import React, { useState, useRef, useEffect, useCallback } from "react";
import { View, TextInput, StyleSheet, Alert, Keyboard, TouchableOpacity } from "react-native";
import type { TextInputInstance } from "react-native";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import VideoCard from "@/components/VideoCard";
import VideoLoadingAnimation from "@/components/VideoLoadingAnimation";
import { api, SearchResult } from "@/services/api";
import { Search, QrCode, X } from "lucide-react-native";
import { StyledButton } from "@/components/StyledButton";
import { useRemoteControlStore } from "@/stores/remoteControlStore";
import { RemoteControlModal } from "@/components/RemoteControlModal";
import { useSettingsStore } from "@/stores/settingsStore";
import { useRouter, useFocusEffect } from "expo-router";
import { SearchHistoryManager } from "@/services/storage";
import { Colors } from "@/constants/Colors";
import CustomScrollView from "@/components/CustomScrollView";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { getCommonResponsiveStyles } from "@/utils/ResponsiveStyles";
import ResponsiveNavigation from "@/components/navigation/ResponsiveNavigation";
import ResponsiveHeader from "@/components/navigation/ResponsiveHeader";
import { DeviceUtils } from "@/utils/DeviceUtils";
import { Logger } from '@/utils/Logger';

const logger = Logger.withTag('SearchScreen');

export default function SearchScreen() {
  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchHistory, setSearchHistory] = useState<string[]>([]);
  const textInputRef = useRef<TextInputInstance>(null);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const { showModal: showRemoteModal, lastMessage, targetPage, clearMessage } = useRemoteControlStore();
  const { remoteInputEnabled } = useSettingsStore();
  const router = useRouter();

  // 搜索历史（V1.5）：进入页面时加载
  useFocusEffect(
    useCallback(() => {
      SearchHistoryManager.get().then(setSearchHistory).catch(() => {});
    }, [])
  );

  // 响应式布局配置
  const responsiveConfig = useResponsiveLayout();
  const commonStyles = getCommonResponsiveStyles(responsiveConfig);
  const { deviceType, spacing } = responsiveConfig;

  // 搜索防抖：防止远程输入连续触发或用户快速重复点击产生大量请求
  const searchDebounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 进行中的搜索请求：新搜索到来时取消上一次，而不是丢弃新搜索；
  // 组件卸载时同样取消，避免请求完成后还往已卸载的组件写状态。
  const searchAbortController = useRef<AbortController | null>(null);
  // 搜索序号：只有最新一次搜索能关掉 loading，避免被取消的旧搜索把新搜索的
  // loading 状态误关掉。
  const searchSeqRef = useRef(0);
  // 被防抖顶掉的上一次 handleSearch 调用：它的 promise 也要 resolve，
  // 否则调用方（如果 await）会永远等下去
  const pendingResolveRef = useRef<(() => void) | null>(null);

  const handleSearch = async (searchText?: string) => {
    // 防抖 300ms
    if (searchDebounceTimer.current) {
      clearTimeout(searchDebounceTimer.current);
      pendingResolveRef.current?.();
      pendingResolveRef.current = null;
    }

    return new Promise<void>((resolve) => {
      pendingResolveRef.current = resolve;
      searchDebounceTimer.current = setTimeout(async () => {
        pendingResolveRef.current = null;
        const term = typeof searchText === "string" ? searchText : keyword;
        if (!term.trim()) {
          Keyboard.dismiss();
          resolve();
          return;
        }
        Keyboard.dismiss();
        // 取消上一次进行中的搜索，再发起本次搜索
        searchAbortController.current?.abort();
        const controller = new AbortController();
        searchAbortController.current = controller;
        const seq = ++searchSeqRef.current;
        setLoading(true);
        setError(null);
        try {
          const response = await api.searchVideos(term, controller.signal);
          if (response.results.length > 0) {
            setResults(response.results);
            // 搜索成功后记录历史（V1.5）
            SearchHistoryManager.add(term).then(() => SearchHistoryManager.get()).then(setSearchHistory).catch(() => {});
          } else {
            // 空结果也要清掉旧结果，避免下次进搜索时短暂闪出上一轮的旧卡片
            setResults([]);
            setError("没有找到相关内容");
          }
        } catch (err) {
          // 被新搜索或卸载取消的请求不算失败：静默处理，不显示错误
          //（与 stores/detailStore.ts 的 AbortError 处理一致）。
          if (err instanceof Error && err.name === "AbortError") {
            return;
          }
          // 把真实原因显示出来，不再统一吞成一句话：超时、未配服务器、登录过期、
          // 服务端报错各有各的提示，方便定位是应用问题还是服务器问题。
          const msg = err instanceof Error ? err.message : "";
          if (msg.includes("API_URL_NOT_SET")) {
            setError("未配置服务器地址，请先在设置里填写服务器");
          } else if (msg.includes("BODY_TIMEOUT_BREAKER_OPEN")) {
            setError("搜索连续超时，60 秒后再试");
          } else if (msg.includes("REQUEST_TIMEOUT") || msg.includes("RESPONSE_TIMEOUT")) {
            setError("搜索超时，服务器响应太慢，请稍后重试");
          } else if (msg.includes("UNAUTHORIZED")) {
            setError("登录已过期，请重新登录");
          } else if (msg.includes("RESPONSE_TOO_LARGE")) {
            setError("搜索结果太多，请换个更具体的关键词");
          } else if (msg.includes("HTTP error! status:")) {
            setError("服务器报错，请稍后重试");
          } else {
            setError("搜索失败，请稍后重试。");
          }
          logger.info("Search failed:", err);
        } finally {
          // 只有最新一次搜索能关 loading；被取消的旧搜索不碰新搜索的状态
          if (seq === searchSeqRef.current) {
            setLoading(false);
          }
          resolve();
        }
      }, 300);
    });
  };

  useEffect(() => {
    if (lastMessage && targetPage === 'search') {
      logger.debug("Received remote input:", lastMessage);
      const realMessage = lastMessage.split("_")[0];
      setKeyword(realMessage);
      handleSearch(realMessage);
      clearMessage(); // Clear the message after processing
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastMessage, targetPage]);

  // 组件卸载时清理防抖定时器，并取消进行中的搜索请求
  useEffect(() => {
    return () => {
      if (searchDebounceTimer.current) {
        clearTimeout(searchDebounceTimer.current);
      }
      searchAbortController.current?.abort();
    };
  }, []);

  const onSearchPress = () => handleSearch();

  const handleHistoryPress = (term: string) => {
    setKeyword(term);
    handleSearch(term);
  };

  const clearHistory = () => {
    SearchHistoryManager.clear().then(() => setSearchHistory([])).catch(() => {});
  };

  const handleQrPress = () => {
    if (!remoteInputEnabled) {
      Alert.alert("远程输入未启用", "请先在设置页面中启用远程输入功能", [
        { text: "取消", style: "cancel" },
        { text: "去设置", onPress: () => router.push("/settings") },
      ]);
      return;
    }
    showRemoteModal('search');
  };

  const renderItem = ({ item }: { item: SearchResult; index: number }) => (
    <VideoCard
      id={item.id.toString()}
      source={item.source}
      title={item.title}
      poster={item.poster}
      year={item.year}
      sourceName={item.source_name}
      api={api}
    />
  );

  // 动态样式
  const dynamicStyles = createResponsiveStyles(deviceType, spacing);

  const renderSearchContent = () => (
    <>
      <View style={dynamicStyles.searchContainer}>
        <TouchableOpacity
          activeOpacity={1}
          style={[
            dynamicStyles.inputContainer,
            {
              borderColor: isInputFocused ? Colors.dark.primary : "transparent",
            },
          ]}
          onPress={() => textInputRef.current?.focus()}
        >
          <TextInput
            ref={textInputRef}
            style={dynamicStyles.input}
            placeholder="搜索电影、剧集..."
            placeholderTextColor="#888"
            value={keyword}
            onChangeText={setKeyword}
            onSubmitEditing={onSearchPress}
            onFocus={() => setIsInputFocused(true)}
            onBlur={() => setIsInputFocused(false)}
            returnKeyType="search"
          />
        </TouchableOpacity>
        <StyledButton style={dynamicStyles.searchButton} onPress={onSearchPress}>
          <Search size={deviceType === 'mobile' ? 20 : 24} color="white" />
        </StyledButton>
        {deviceType !== 'mobile' && (
          <StyledButton style={dynamicStyles.qrButton} onPress={handleQrPress}>
            <QrCode size={deviceType === 'tv' ? 24 : 20} color="white" />
          </StyledButton>
        )}
      </View>

      {loading ? (
        <VideoLoadingAnimation showProgressBar={false} />
      ) : error || results.length === 0 ? (
        <View style={[commonStyles.center, { flex: 1 }]}>
          {/* 搜索历史（V1.5）：无结果时展示，TV 遥控器打字成本高 */}
          {searchHistory.length > 0 && (
            <View style={dynamicStyles.historyContainer}>
              <View style={dynamicStyles.historyHeader}>
                <ThemedText style={dynamicStyles.historyTitle}>搜索历史</ThemedText>
                <TouchableOpacity onPress={clearHistory} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <ThemedText style={dynamicStyles.historyClear}>清空</ThemedText>
                </TouchableOpacity>
              </View>
              <View style={dynamicStyles.historyChips}>
                {searchHistory.map((term) => (
                  <TouchableOpacity
                    key={term}
                    style={dynamicStyles.historyChip}
                    onPress={() => handleHistoryPress(term)}
                  >
                    <ThemedText style={dynamicStyles.historyChipText} numberOfLines={1}>{term}</ThemedText>
                    <X size={12} color="#888" />
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}
          {error && <ThemedText style={dynamicStyles.errorText}>{error}</ThemedText>}
        </View>
      ) : (
        <CustomScrollView
          data={results}
          renderItem={renderItem}
          loading={loading}
          error={error}
          emptyMessage="输入关键词开始搜索"
        />
      )}
      <RemoteControlModal />
    </>
  );

  const content = (
    <ThemedView style={[commonStyles.container, dynamicStyles.container]}>
      {renderSearchContent()}
    </ThemedView>
  );

  // 根据设备类型决定是否包装在响应式导航中
  if (deviceType === 'tv') {
    return content;
  }

  return (
    <ResponsiveNavigation>
      <ResponsiveHeader title="搜索" showBackButton />
      {content}
    </ResponsiveNavigation>
  );
}

const createResponsiveStyles = (deviceType: string, spacing: number) => {
  const isMobile = deviceType === 'mobile';
  const minTouchTarget = DeviceUtils.getMinTouchTargetSize();

  return StyleSheet.create({
    container: {
      flex: 1,
      paddingTop: deviceType === 'tv' ? 50 : 0,
    },
    searchContainer: {
      flexDirection: "row",
      paddingHorizontal: spacing,
      marginBottom: spacing,
      alignItems: "center",
      paddingTop: isMobile ? spacing / 2 : 0,
    },
    inputContainer: {
      flex: 1,
      height: isMobile ? minTouchTarget : 50,
      backgroundColor: "#2c2c2e",
      borderRadius: isMobile ? 8 : 8,
      marginRight: spacing / 2,
      borderWidth: 2,
      borderColor: "transparent",
      justifyContent: "center",
    },
    input: {
      flex: 1,
      paddingHorizontal: spacing,
      color: "white",
      fontSize: isMobile ? 16 : 18,
    },
    searchButton: {
      width: isMobile ? minTouchTarget : 50,
      height: isMobile ? minTouchTarget : 50,
      justifyContent: "center",
      alignItems: "center",
      borderRadius: isMobile ? 8 : 8,
      marginRight: deviceType !== 'mobile' ? spacing / 2 : 0,
    },
    qrButton: {
      width: isMobile ? minTouchTarget : 50,
      height: isMobile ? minTouchTarget : 50,
      justifyContent: "center",
      alignItems: "center",
      borderRadius: isMobile ? 8 : 8,
    },
    errorText: {
      color: "red",
      fontSize: isMobile ? 14 : 16,
      textAlign: "center",
    },
    historyContainer: {
      width: "100%",
      paddingHorizontal: spacing,
    },
    historyHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: spacing / 2,
    },
    historyTitle: {
      fontSize: isMobile ? 15 : 16,
      fontWeight: "bold",
      color: "#ccc",
    },
    historyClear: {
      fontSize: 13,
      color: "#888",
    },
    historyChips: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: spacing / 3,
    },
    historyChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      backgroundColor: "#2c2c2e",
      borderRadius: 16,
      paddingVertical: isMobile ? minTouchTarget / 5 : 8,
      paddingHorizontal: spacing / 2,
      maxWidth: "48%",
    },
    historyChipText: {
      fontSize: isMobile ? 13 : 14,
      color: "#ddd",
    },
  });
};
