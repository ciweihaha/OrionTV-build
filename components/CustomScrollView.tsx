import React, { useCallback, useRef, useState, useEffect } from "react";
import { View, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity, BackHandler } from "react-native";
import type { ScrollViewInstance } from "react-native";
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
  const scrollViewRef = useRef<ScrollViewInstance>(null);
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
    rowContainer: {
      flexDirection: "row",
      marginBottom: responsiveConfig.spacing,
    },
    fullRowContainer: {
      justifyContent: "space-around",
      marginRight: responsiveConfig.spacing / 2,
    },
    partialRowContainer: {
      justifyContent: "flex-start",
    },
    itemContainer: {
      width: responsiveConfig.cardWidth,
    },
    itemWithMargin: {
      width: responsiveConfig.cardWidth,
      marginRight: responsiveConfig.spacing,
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
      const { layoutMeasurement, contentOffset, contentSize } = nativeEvent;
      const isCloseToBottom = layoutMeasurement.height + contentOffset.y >= contentSize.height - loadMoreThreshold;

      lastOffsetYRef.current = contentOffset.y;

      // 显示/隐藏返回顶部按钮
      setShowScrollToTop(contentOffset.y > 200);

      // 首屏加载时 loadingMore 是 false（第一页不置该标志）：滚动事件会
      // 在加载中重复触发 onEndReached，造成同一页重复请求；loading 时也挡住
      if (isCloseToBottom && !loading && !loadingMore && onEndReached) {
        onEndReached();
      }
    },
    [onEndReached, loading, loadingMore, loadMoreThreshold]
  );

  const scrollToTop = () => {
    scrollViewRef.current?.scrollTo({ y: 0, animated: true });
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

  // 将数据按行分组
  const groupItemsByRow = (items: any[], columns: number) => {
    const rows = [];
    for (let i = 0; i < items.length; i += columns) {
      rows.push(items.slice(i, i + columns));
    }
    return rows;
  };

  const rows = groupItemsByRow(data, effectiveColumns);


  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        ref={scrollViewRef}
        contentContainerStyle={dynamicStyles.listContent}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={responsiveConfig.deviceType !== 'tv'}
      >
        {rows.map((row, rowIndex) => {
          const isFullRow = row.length === effectiveColumns;
          const rowStyle = isFullRow ? dynamicStyles.fullRowContainer : dynamicStyles.partialRowContainer;

          return (
            <View key={rowIndex} style={[dynamicStyles.rowContainer, rowStyle]}>
              {row.map((item, itemIndex) => {
                const actualIndex = rowIndex * effectiveColumns + itemIndex;
                const isLastItemInPartialRow = !isFullRow && itemIndex === row.length - 1;
                const itemStyle = isLastItemInPartialRow ? dynamicStyles.itemContainer : dynamicStyles.itemWithMargin;

                const cardProps = {
                  style: isFullRow ? dynamicStyles.itemContainer : itemStyle,
                };

                return (
                  // key 不能放进 spread（eslint jsx-key 识别不到），直接写在 JSX 上
                  <View key={actualIndex} {...cardProps}>
                    {renderItem({ item, index: actualIndex, ref: actualIndex === 0 ? firstCardRef : undefined })}
                  </View>
                );
              })}
            </View>
          );
        })}
        {renderFooter()}
      </ScrollView>
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
