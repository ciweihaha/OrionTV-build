import React, { useCallback } from "react";
import { View, StyleSheet } from "react-native";
import { useFocusEffect } from "expo-router";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import useFavoritesStore from "@/stores/favoritesStore";
import { Favorite, parseRecordKey } from "@/services/storage";
import VideoCard from "@/components/VideoCard";
import { api } from "@/services/api";
import CustomScrollView from "@/components/CustomScrollView";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { getCommonResponsiveStyles } from "@/utils/ResponsiveStyles";
import ResponsiveNavigation from "@/components/navigation/ResponsiveNavigation";
import ResponsiveHeader from "@/components/navigation/ResponsiveHeader";

export default function FavoritesScreen() {
  const { favorites, loading, error, fetchFavorites } = useFavoritesStore();

  // 响应式布局配置
  const responsiveConfig = useResponsiveLayout();
  const commonStyles = getCommonResponsiveStyles(responsiveConfig);
  const { deviceType, spacing } = responsiveConfig;

  // 每次回到收藏页都刷新：在详情页取消收藏后返回，列表否则还留着已取消的那条
  //（普通 useEffect 只在挂载时跑一次，返回时页面还在栈里不会重跑）
  useFocusEffect(
    useCallback(() => {
      fetchFavorites();
    }, [fetchFavorites])
  );

  // renderItem 稳定引用：CustomScrollView 已 memo（第 11 轮），内联函数会让
  // memo 每渲染都失效；只依赖模块单例 api 与纯函数 parseRecordKey，空依赖即可
  const renderItem = useCallback(({ item, ref }: { item: Favorite & { key: string }; index: number; ref?: React.Ref<any> }) => {
    // key 是 generateKey 拼的 `${source}+${id}`（source/id 里的 '+' 已转义），
    // 用 parseRecordKey 解析（与 stores/homeStore.ts 同一处修法）
    const { source, id } = parseRecordKey(item.key);
    return (
      <VideoCard
        ref={ref}
        id={id}
        source={source}
        title={item.title}
        sourceName={item.source_name}
        poster={item.cover}
        year={item.year}
        api={api}
      />
    );
  }, []);

  // 动态样式
  const dynamicStyles = createResponsiveStyles(deviceType, spacing);

  const renderFavoritesContent = () => (
    <>
      {deviceType === 'tv' && (
        <View style={dynamicStyles.headerContainer}>
          <ThemedText style={dynamicStyles.headerTitle}>我的收藏</ThemedText>
        </View>
      )}
      <CustomScrollView
        data={favorites}
        renderItem={renderItem}
        loading={loading}
        error={error}
        emptyMessage="暂无收藏"
      />
    </>
  );

  const content = (
    <ThemedView style={[commonStyles.container, dynamicStyles.container]}>
      {renderFavoritesContent()}
    </ThemedView>
  );

  // 根据设备类型决定是否包装在响应式导航中
  if (deviceType === 'tv') {
    return content;
  }

  return (
    <ResponsiveNavigation>
      <ResponsiveHeader title="我的收藏" showBackButton />
      {content}
    </ResponsiveNavigation>
  );
}

const createResponsiveStyles = (deviceType: string, spacing: number) => {
  const isMobile = deviceType === 'mobile';
  const isTablet = deviceType === 'tablet';
  const isTV = deviceType === 'tv';

  return StyleSheet.create({
    container: {
      flex: 1,
      paddingTop: isTV ? spacing * 2 : 0,
    },
    headerContainer: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: spacing * 1.5,
      marginBottom: spacing / 2,
    },
    headerTitle: {
      fontSize: isMobile ? 24 : isTablet ? 28 : 32,
      fontWeight: "bold",
      paddingTop: spacing,
      color: 'white',
    },
  });
};
