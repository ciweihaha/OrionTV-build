import React, { useCallback, useRef, useState, useEffect } from "react";
import { View, StyleSheet, FlatList, ActivityIndicator, TouchableOpacity, BackHandler } from "react-native";
import { useFocusEffect } from "expo-router";
import { ThemedText } from "@/components/ThemedText";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { getCommonResponsiveStyles } from "@/utils/ResponsiveStyles";

interface CustomScrollViewProps {
  data: any[];
  // index === 0 的卡片会收到 ref：回到顶部后要把焦点放回第一张卡片；
  // 调用方把 ref 透传给卡片（VideoCard 是 forwardRef，可直接 focus）
  renderItem: ({ item, index, ref }: { item: any; index: number; ref?: React.Ref<any> }) => React.ReactNode;
  numColumns?: number; // 如果不提供，将使用响应式默认值
  loading?: boolean;
  loadingMore?: boolean;
  error?: string | null;
  onEndReached?: () => void;
  loadMoreThreshold?: number;
  emptyMessage?: string;
  ListFooterComponent?: React.ComponentType<any> | React.ReactElement | null;
}

// TV 卡片固定几何（VideoCard.tv.tsx：海报 240 + 下方信息区 60）：
// 行高 = 卡片高 300 + 行间距 spacing（TV 为 16）。getItemLayout 只在 TV
// 上提供，手机/平板卡片高度随屏宽动态算，不固定，交给 FlatList 实测。
const TV_CARD_HEIGHT = 300;

const CustomScrollView: React.FC<CustomScrollViewProps> = ({
  data,
  renderItem,
  numColumns,
  loading = false,
  loadingMore = false,
  error = null,
  onEndReached,
  loadMoreThreshold = 200,
  emptyMessage = "暂无内容",
  ListFooterComponent,
}) => {
  const flatListRef = useRef<FlatList<any>>(null);
  const firstCardRef = useRef<any>(null); // <--- 新增
  const scrollToTopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 最近一次滚动位置：回到顶部是动画过程，用户中途又滚下去时，
  // 500ms 后的聚焦不能再把焦点抢回第一张卡
  const lastOffsetYRef = useRef(0);
  const [showScrollToTop, setShowScrollToTop] = useState(false);
  const responsiveConfig = useResponsiveLayout();
  const commonStyles = getCommonResponsiveStyles(responsiveConfig);
  const { deviceType } = responsiveConfig;

  // 动态样式：只在布局配置或回顶按钮显隐变化时重建。原来每次渲染都
  // StyleSheet.create 一整套（滚动时 handleScroll 触发的 setState 很频繁）。
  const dynamicStyles = React.useMemo(() => StyleSheet.create({
    listContent: {
      paddingBottom: responsiveConfig.spacing * 2,
      paddingHorizontal: responsiveConfig.spacing / 2,
    },
    // FlatList numColumns 下每行是一个 columnWrapper：行间距放这里，
    // 替代原来 ScrollView 里 rowContainer 的 marginBottom
    columnWrapper: {
      marginBottom: responsiveConfig.spacing,
    },
    // 每列等宽 flex:1，卡片在格内居中：与原来 space-around 的铺满效果一致，
    // 末行不足一列时卡片仍落在各自列位，不挤到左边
    itemCell: {
      flex: 1,
      alignItems: "center",
    },
    scrollToTopButton: {
      position: 'absolute',
      right: responsiveConfig.spacing,
      bottom: responsiveConfig.spacing * 2,
      backgroundColor: 'rgba(0, 0, 0, 0.6)',
      padding: responsiveConfig.spacing,
      borderRadius: responsiveConfig.spacing,
      opacity: showScrollToTop ? 1 : 0,
      // 透明时不拦截触摸：opacity 0 的按钮仍会吃掉点击，遮住下面的卡片
      pointerEvents: (showScrollToTop ? 'auto' : 'none') as 'auto' | 'none',
    },
  }), [responsiveConfig, showScrollToTop]);

  // 组件卸载时清掉 scrollToTop 的延时，避免已卸载后还去 focus 第一个卡片
  useEffect(() => {
    return () => {
      if (scrollToTopTimer.current) {
        clearTimeout(scrollToTopTimer.current);
      }
    };
  }, []);

  // 返回键处理：只在当前页聚焦时生效。首页经 expo-router Stack 切到详情页
  // 后仍挂载，普通 useEffect 注册的处理器会继续拦截返回键——首页滚到底
  // 后在详情页按返回，会触发首页的 scrollToTop 而不是返回（与 app/index.tsx
  // 的双击退出同一修法）。
  useFocusEffect(
    useCallback(() => {
      if (deviceType !== 'tv') return;
      const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
        if (showScrollToTop) {
          scrollToTop();
          return true; // 阻止默认的返回行为
        }
        return false; // 允许默认的返回行为
      });

      return () => backHandler.remove();
    }, [showScrollToTop, deviceType])
  );

  // 使用响应式列数，如果没有明确指定的话
  const effectiveColumns = numColumns || responsiveConfig.columns;

  const handleScroll = useCallback(
    ({ nativeEvent }: { nativeEvent: any }) => {
      const { contentOffset } = nativeEvent;

      lastOffsetYRef.current = contentOffset.y;

      // 显示/隐藏返回顶部按钮
      setShowScrollToTop(contentOffset.y > 200);
    },
    []
  );

  const handleEndReached = useCallback(() => {
    // 首屏加载时 loadingMore 是 false（第一页不置该标志）：滚动事件会
    // 在加载中重复触发 onEndReached，造成同一页重复请求；loading 时也挡住
    if (!loading && !loadingMore && onEndReached) {
      onEndReached();
    }
  }, [onEndReached, loading, loadingMore]);

  // loadMoreThreshold 是“距底部多少像素触发”（旧 ScrollView 语义）；
  // FlatList 的 onEndReachedThreshold 是“距底部多少个可视长度”，
  // 200px 在 1080p 电视上约 0.2 个可视长度
  const endReachedThreshold = Math.min(0.5, Math.max(0.1, loadMoreThreshold / 1000));

  const scrollToTop = () => {
    flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
    // 滚动动画结束后聚焦第一个卡片
    if (scrollToTopTimer.current) {
      clearTimeout(scrollToTopTimer.current);
    }
    scrollToTopTimer.current = setTimeout(() => {
      // 只有确实回到顶部才聚焦：用户中途又滚下去时别把焦点抢回来
      if (lastOffsetYRef.current <= 10) {
        firstCardRef.current?.focus();
      }
    }, 500); // 500ms 适配大多数动画时长
  };

  // TV 上行高固定，可直接算布局：滚动定位、回顶、翻页都不用等实测。
  // 手机/平板卡片高度随屏宽变，不提供，FlatList 按需实测。
  const getItemLayout = useCallback(
    (_: any, index: number) => {
      const rowHeight = TV_CARD_HEIGHT + responsiveConfig.spacing;
      const row = Math.floor(index / effectiveColumns);
      return { length: rowHeight, offset: rowHeight * row, index };
    },
    [effectiveColumns, responsiveConfig.spacing]
  );

  const renderFlatItem = useCallback(
    ({ item, index }: { item: any; index: number }) => (
      <View style={dynamicStyles.itemCell}>
        {renderItem({ item, index, ref: index === 0 ? firstCardRef : undefined })}
      </View>
    ),
    [renderItem, dynamicStyles]
  );

  const keyExtractor = useCallback(
    (item: any, index: number) => {
      if (item && item.id !== undefined && item.id !== null) {
        return item.source ? `${item.source}:${item.id}` : String(item.id);
      }
      return String(index);
    },
    []
  );

  const renderFooter = () => {
    if (ListFooterComponent) {
      if (React.isValidElement(ListFooterComponent)) {
        return ListFooterComponent;
      } else if (typeof ListFooterComponent === "function") {
        const Component = ListFooterComponent as React.ComponentType<any>;
        return <Component />;
      }
      return null;
    }
    if (loadingMore) {
      return <ActivityIndicator style={{ marginVertical: 20 }} size="large" />;
    }
    return null;
  };

  if (loading) {
    return (
      <View style={commonStyles.center}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={commonStyles.center}>
        <ThemedText type="subtitle" style={{ padding: responsiveConfig.spacing }}>
          {error}
        </ThemedText>
      </View>
    );
  }

  if (data.length === 0) {
    return (
      <View style={commonStyles.center}>
        <ThemedText>{emptyMessage}</ThemedText>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        ref={flatListRef}
        // 列数变化必须重挂：FlatList 不支持运行时改 numColumns
        key={effectiveColumns}
        data={data}
        renderItem={renderFlatItem}
        keyExtractor={keyExtractor}
        numColumns={effectiveColumns}
        columnWrapperStyle={dynamicStyles.columnWrapper}
        contentContainerStyle={dynamicStyles.listContent}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={responsiveConfig.deviceType !== 'tv'}
        onEndReached={handleEndReached}
        onEndReachedThreshold={endReachedThreshold}
        getItemLayout={deviceType === 'tv' ? getItemLayout : undefined}
        // 虚拟化：首屏只挂约 20 张卡，窗口外不渲染。原来 ScrollView 全量挂载，
        // 60 条首屏 = 60 张卡 + 60 张海报同时解码，是首屏卡顿的最大头。
        initialNumToRender={20}
        windowSize={10}
        maxToRenderPerBatch={20}
        // TV 上不开 removeClippedSubviews：滚动中焦点卡片被裁剪卸载会丢焦点；
        // 手机/平板无焦点问题，开它省内存。windowSize 虚拟化本身已覆盖大头。
        removeClippedSubviews={deviceType !== 'tv'}
        ListFooterComponent={renderFooter() ?? undefined}
      />
      {deviceType!=='tv' && (
        <TouchableOpacity
          style={dynamicStyles.scrollToTopButton}
          onPress={scrollToTop}
          activeOpacity={0.8}
        >
          <ThemedText>⬆️</ThemedText>
        </TouchableOpacity>
      )}
    </View>
  );
};

export default React.memo(CustomScrollView);
