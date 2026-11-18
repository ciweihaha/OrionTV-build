import React, { useEffect, useCallback, useRef, useState } from "react";
import { View, StyleSheet, ActivityIndicator, FlatList, Pressable, Animated, StatusBar, Platform, BackHandler, ToastAndroid } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { api } from "@/services/api";
import VideoCard from "@/components/VideoCard";
import { useFocusEffect, useRouter } from "expo-router";
import { Search, Settings, LogOut, Heart } from "lucide-react-native";
import { StyledButton } from "@/components/StyledButton";
import useHomeStore, { RowItem, Category } from "@/stores/homeStore";
import useAuthStore from "@/stores/authStore";
import CustomScrollView from "@/components/CustomScrollView";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { getCommonResponsiveStyles } from "@/utils/ResponsiveStyles";
import ResponsiveNavigation from "@/components/navigation/ResponsiveNavigation";
import { useApiConfig, getApiConfigErrorMessage } from "@/hooks/useApiConfig";
import { Colors } from "@/constants/Colors";

const LOAD_MORE_THRESHOLD = 200;

export default function HomeScreen() {
  const router = useRouter();
  const colorScheme = "dark";
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const insets = useSafeAreaInsets();

  // 响应式布局配置
  const responsiveConfig = useResponsiveLayout();
  const commonStyles = getCommonResponsiveStyles(responsiveConfig);
  const { deviceType, spacing } = responsiveConfig;

  const {
    categories,
    selectedCategory,
    contentData,
    loading,
    loadingMore,
    error,
    errorDetail,
    fetchInitialData,
    retryLoad,
    loadMoreData,
    selectCategory,
    refreshPlayRecords,
    clearError,
    cmsFilterAvailable,
    aggFilters,
    aggFilterGroups,
    filtersVisible,
    setAggFilter,
    clearAggFilters,
    toggleFilters,
  } = useHomeStore();
  const { isLoggedIn, logout } = useAuthStore();
  const apiConfigStatus = useApiConfig();

  useFocusEffect(
    useCallback(() => {
      refreshPlayRecords();
    }, [refreshPlayRecords])
  );

  // 双击返回退出逻辑（只限当前页面）
  const backPressTimeRef = useRef<number | null>(null);

  useFocusEffect(
    useCallback(() => {
      const handleBackPress = () => {
        const now = Date.now();

        // 如果还没按过返回键，或距离上次超过2秒
        if (!backPressTimeRef.current || now - backPressTimeRef.current > 2000) {
          backPressTimeRef.current = now;
          ToastAndroid.show("再按一次返回键退出", ToastAndroid.SHORT);
          return true; // 拦截返回事件，不退出
        }

        // 两次返回键间隔小于2秒，退出应用
        BackHandler.exitApp();
        return true;
      };

      // 仅限 Android 平台启用此功能
      if (Platform.OS === "android") {
        const backHandler = BackHandler.addEventListener("hardwareBackPress", handleBackPress);

        // 返回首页时重置状态
        return () => {
          backHandler.remove();
          backPressTimeRef.current = null;
        };
      }
    }, [])
  );

  // 统一的数据获取逻辑
  // CMS 模式：CMS 的加载唯一入口是 store 的 selectCategory，effect 在此直接返回，
  // 不做 tag 默认、不重复调 fetchInitialData，且 tag 默认逻辑会把 CMS 分类拉回豆瓣；
  // 缓存命中时首屏只有 40 条，effect 再拉一次还会把首屏 60 条覆盖成缓存 40 条。
  useEffect(() => {
    if (!selectedCategory) return;

    if (selectedCategory.cmsType) {
      return;
    }

    // 如果是容器分类且没有选择标签，设置默认标签
    if (selectedCategory.tags && !selectedCategory.tag) {
      const defaultTag = selectedCategory.tags[0];
      setSelectedTag(defaultTag);
      selectCategory({ ...selectedCategory, tag: defaultTag });
      return;
    }

    // 只有在API配置完成且分类有效时才获取数据
    // 例外：最近播放是本地记录，不依赖服务器，未配服务器时也加载
    // （未登录时 store 直接返回空列表，不会发请求；不放行会在未配置时
    // 永远停在 loading 转圈）。
    const isRecordCategory = selectedCategory.type === "record";
    if (
      (apiConfigStatus.isConfigured && !apiConfigStatus.needsConfiguration) ||
      isRecordCategory
    ) {
      // 对于有标签的分类，需要确保有标签才获取数据
      if (selectedCategory.tags && selectedCategory.tag) {
        fetchInitialData();
      }
      // 对于无标签的分类，直接获取数据
      else if (!selectedCategory.tags) {
        fetchInitialData();
      }
    }
  }, [
    selectedCategory,
    selectedCategory?.tag,
    apiConfigStatus.isConfigured,
    apiConfigStatus.needsConfiguration,
    fetchInitialData,
    selectCategory,
  ]);

  // 清除错误状态的逻辑在 shouldShowApiConfig 之后（见下）：只清“需要服务
  // 器才有的分类”的错误。CMS 分类（agg 直连）与最近播放（本地）不依赖
  // 服务器，它们的加载错误是真实错误（网络/超时），必须显示出来（带重
  // 试）；原来无服务器时任何错误都立即清掉，agg 失败时首页只剩“该分类
  // 下暂无内容”、无报错、无重试，问题被静默藏起来。

  useEffect(() => {
    if (loading) {
      fadeAnim.setValue(0);
    } else if (contentData.length > 0) {
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 300,
        useNativeDriver: true,
      }).start();
    } else {
      // 空列表也要恢复不透明：原来只有“有内容”才把透明度动画回 1，
      // 空分类加载完后透明度还停在加载时置的 0，空态提示
      // （"该分类下暂无内容"）被盖住，页面一片空白
      fadeAnim.setValue(1);
    }
  }, [loading, contentData.length, fadeAnim]);

  // 下面几个回调用 useCallback 稳定身份：CustomScrollView 已 memo，回调每渲染
  // 一变就会让 memo 失效，列表跟着全量重渲染（VideoCard 虽 memo，但行容器
  // 与 ScrollView 本身仍会重建）。
  const handleCategorySelect = useCallback((category: Category) => {
    setSelectedTag(null);
    selectCategory(category);
  }, [selectCategory]);

  const handleTagSelect = useCallback((tag: string) => {
    setSelectedTag(tag);
    if (selectedCategory) {
      const categoryWithTag = { ...selectedCategory, tag: tag };
      selectCategory(categoryWithTag);
    }
  }, [selectedCategory, selectCategory]);

  // CMS 筛选（agg 下发的 4 组：地区/年代/语言/排序）：点选项直接走
  // store（值没变或不在 CMS 分类下 store 内部不做事）；store 记下新值后带
  // keepFilterRow 重拉首屏，筛选面板不卸、电视焦点不丢，列表按新条件变。
  // “全部/默认”项的 v 是空串，点它等于清掉该组筛选。
  const handleFilterSelect = useCallback((key: keyof typeof aggFilters, value: string) => {
    setAggFilter(key, value);
  }, [setAggFilter]);

  // 任一组筛选有值即“已选”：筛选按钮显示“筛选（已选）”，面板里出现“重置筛选”。
  const hasActiveAggFilter = React.useMemo(
    () => Object.values(aggFilters).some(Boolean),
    [aggFilters],
  );

  const isCmsCategory = !!selectedCategory?.cmsType;
  // 最近播放是本地记录分类，同样不依赖服务器配置（与 CMS 同理豁免）。
  const isRecordCategory = selectedCategory?.type === "record";

  // 动态样式只在布局相关值变化时重建：原来每次渲染都 StyleSheet.create
  // 一整套；且 renderCategory 依赖它，不 memo 的话 useCallback 也稳不住。
  const dynamicStyles = React.useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      paddingTop: deviceType === "mobile" ? insets.top : deviceType === "tablet" ? insets.top + 20 : 40,
    },
    headerContainer: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      // TV 上左右各留 32px：顶栏贴着屏幕边缘 + 电视 overscan，右边按钮会被切
      paddingHorizontal: deviceType === "tv" ? spacing * 2 : spacing * 1.5,
      marginBottom: spacing,
    },
    headerTitle: {
      // TV 下原来 32 号加粗：首页/直播两个 tab 占满顶栏、字往下顶 16px 后
      // 挤到下面的分类行，看着像遮挡。1.6.6 改 24 号仍不够（只改字号没改
      // 行高，ThemedText 默认行高 24*scale、1920 宽屏上 46px）：1.6.8 再
      // 降一档到 20 号、TV 行高锁死 28px。
      fontSize: deviceType === "mobile" ? 24 : deviceType === "tablet" ? 28 : 20,
      lineHeight: deviceType === "tv" ? 28 : undefined,
      fontWeight: "bold",
      paddingTop: deviceType === "tv" ? 0 : 16,
    },
    rightHeaderButtons: {
      flexDirection: "row",
      alignItems: "center",
    },
    iconButton: {
      borderRadius: 30,
      marginLeft: spacing / 2,
    },
    categoryContainer: {
      paddingBottom: spacing / 2,
    },
    categoryListContent: {
      paddingHorizontal: spacing,
      // TV 上右边多留 48px：分类行贴着屏幕右边缘 + 电视 overscan，
      // 最后一个分类按钮会被切掉一半
      paddingRight: deviceType === "tv" ? spacing * 3 : undefined,
    },
    categoryButton: {
      paddingHorizontal: deviceType === "tv" ? spacing / 4 : spacing / 2,
      paddingVertical: spacing / 2,
      borderRadius: deviceType === "mobile" ? 6 : 8,
      marginHorizontal: deviceType === "tv" ? spacing / 4 : spacing / 2, // TV端使用更小的间距
    },
    categoryText: {
      fontSize: deviceType === "mobile" ? 14 : 16,
      fontWeight: "500",
      // ThemedText 默认行高 24*scale（TV 上 46px），分类字看着巨大还往下顶
      lineHeight: 22,
    },
    // CMS 筛选行：标签 + 横向选项，与分类行/标签行同一套按钮样式。
    // 标签灰色、与选项区分；列表占满剩余宽度（行容器是 row 布局，
    // FlatList 不给 flex: 1 会被标签挤到只剩内容宽、横向滑不动）。
    filterRow: {
      flexDirection: "row",
      alignItems: "center",
    },
    filterLabel: {
      fontSize: 16,
      fontWeight: "500",
      lineHeight: 22,
      color: "grey",
      marginLeft: spacing,
      marginRight: spacing / 2,
    },
    filterList: {
      flex: 1,
    },
    // 筛选列表左侧不加内边距（标签的 marginLeft 已留出），右侧 TV 多留
    // 48px 防 overscan 切掉最后一个选项（与分类行一致）。
    filterListContent: {
      paddingRight: deviceType === "tv" ? spacing * 3 : undefined,
    },
    contentContainer: {
      flex: 1,
    },
  }), [deviceType, insets.top, spacing]);

  const renderCategory = useCallback(({ item }: { item: Category }) => {
    const isSelected = selectedCategory?.title === item.title;
    return (
      <StyledButton
        text={item.title}
        onPress={() => handleCategorySelect(item)}
        isSelected={isSelected}
        style={dynamicStyles.categoryButton}
        textStyle={dynamicStyles.categoryText}
      />
    );
  }, [selectedCategory, handleCategorySelect, dynamicStyles]);

  const renderContentItem = useCallback(({ item, ref }: { item: RowItem; index: number; ref?: React.Ref<any> }) => (
    <VideoCard
      ref={ref}
      id={item.id}
      source={item.source}
      title={item.title}
      poster={item.poster}
      year={item.year}
      rate={item.rate}
      progress={item.progress}
      playTime={item.play_time}
      episodeIndex={item.episodeIndex}
      sourceName={item.sourceName}
      totalEpisodes={item.totalEpisodes}
      api={api}
      onRecordDeleted={fetchInitialData}
    />
  ), [fetchInitialData]);

  const renderFooter = useCallback(() => {
    if (!loadingMore) return null;
    return <ActivityIndicator style={{ marginVertical: 20 }} size="large" />;
  }, [loadingMore]);

  // 检查是否需要显示API配置提示
  // CMS 分类不走这条：agg 地址硬编码直连，不依赖用户服务器；未配服务器时
  // CMS 内容照样能加载，配置提示不能盖住它（否则动漫/综艺这类无 tags 的
  // CMS 分类在新装应用上永远显示“请配置服务器地址”，用户以为连不上网）。
  // 最近播放（本地记录）同样豁免：本地数据不需要服务器配置。
  const shouldShowApiConfig =
    apiConfigStatus.needsConfiguration &&
    selectedCategory &&
    !selectedCategory.tags &&
    !selectedCategory.cmsType &&
    !isRecordCategory;

  // 清除错误状态：只清“需要服务器才有的分类”的错误（此时配置提示会替
  // 代错误屏显示，残留的旧错误不能盖住它）。CMS 与最近播放的错误不经过
  // 这里，加载失败时错误屏 + 重试按钮正常出现。
  useEffect(() => {
    if (shouldShowApiConfig && error) {
      clearError();
    }
  }, [shouldShowApiConfig, error, clearError]);

  // TV端和平板端的顶部导航
  const renderHeader = () => {
    if (deviceType === "mobile") {
      // 移动端不显示顶部导航，使用底部Tab导航
      return null;
    }

    return (
      <View style={dynamicStyles.headerContainer}>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <ThemedText style={dynamicStyles.headerTitle}>首页</ThemedText>
          <Pressable android_ripple={deviceType === 'tv' ? { color: 'transparent' } : { color: Colors.dark.link }} style={{ marginLeft: 20 }} onPress={() => router.push("/live")}>
            {({ focused }) => (
              <ThemedText style={[dynamicStyles.headerTitle, { color: focused ? "white" : "grey" }]}>直播</ThemedText>
            )}
          </Pressable>
        </View>
        <View style={dynamicStyles.rightHeaderButtons}>
          <StyledButton style={dynamicStyles.iconButton} onPress={() => router.push("/favorites")} variant="ghost">
            <Heart color={colorScheme === "dark" ? "white" : "black"} size={24} />
          </StyledButton>
          <StyledButton
            style={dynamicStyles.iconButton}
            onPress={() => router.push({ pathname: "/search" })}
            variant="ghost"
          >
            <Search color={colorScheme === "dark" ? "white" : "black"} size={24} />
          </StyledButton>
          <StyledButton style={dynamicStyles.iconButton} onPress={() => router.push("/settings")} variant="ghost">
            <Settings color={colorScheme === "dark" ? "white" : "black"} size={24} />
          </StyledButton>
          {isLoggedIn && (
            <StyledButton style={dynamicStyles.iconButton} onPress={logout} variant="ghost">
              <LogOut color={colorScheme === "dark" ? "white" : "black"} size={24} />
            </StyledButton>
          )}
        </View>
      </View>
    );
  };

  // 动态样式


  const content = (
    <ThemedView style={[commonStyles.container, dynamicStyles.container]}>
      {/* 状态栏 */}
      {deviceType === "mobile" && <StatusBar barStyle="light-content" />}

      {/* 顶部导航 */}
      {renderHeader()}

      {/* 分类选择器 */}
      <View style={dynamicStyles.categoryContainer}>
        <FlatList
          data={categories}
          renderItem={renderCategory}
          keyExtractor={(item) => item.title}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={dynamicStyles.categoryListContent}
        />
      </View>

      {/* 子分类标签：仅豆瓣模式渲染；CMS 模式下隐藏 */}
      {selectedCategory && selectedCategory.tags && !selectedCategory.cmsType && (
        <View style={dynamicStyles.categoryContainer}>
          <FlatList
            data={selectedCategory.tags}
            renderItem={({ item, index }) => {
              const isSelected = selectedTag === item;
              return (
                <StyledButton
                  hasTVPreferredFocus={index === 0}
                  text={item}
                  onPress={() => handleTagSelect(item)}
                  isSelected={isSelected}
                  style={dynamicStyles.categoryButton}
                  textStyle={dynamicStyles.categoryText}
                  variant="ghost"
                />
              );
            }}
            keyExtractor={(item) => item}
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={dynamicStyles.categoryListContent}
          />
        </View>
      )}

      {/* CMS 筛选面板：只在 CMS 内容成功加载后出现（cmsFilterAvailable）。
          豆瓣/最近播放没有筛选字段，不渲染、不假装能筛。选项组由服务端下发
          （agg filters 字段中服务端可靠的 4 组：地区/年代/语言/排序），不硬编码；
          类型/评分服务端处理不可靠，不提供、不渲染。
          默认收起，点“筛选”展开；已选时按钮显示“筛选（已选）”。选中态用绿底
          （ghost variant 已修成选中绿底）、焦点用 3px 白边（StyledButton），
          两者可叠加：选中+聚焦 = 绿底白边。面板不抢初始焦点（不设
          hasTVPreferredFocus），遥控下移进来再选；切筛选时 store 带
          keepFilterRow 重载，面板不卸、焦点不丢，列表按新条件变。 */}
      {cmsFilterAvailable && (
        <>
          <View style={[dynamicStyles.categoryContainer, dynamicStyles.filterRow]}>
            <StyledButton
              text={filtersVisible ? "收起筛选" : hasActiveAggFilter ? "筛选（已选）" : "筛选"}
              onPress={toggleFilters}
              style={dynamicStyles.categoryButton}
              textStyle={dynamicStyles.categoryText}
              variant="ghost"
            />
            {hasActiveAggFilter && (
              <StyledButton
                text="重置筛选"
                onPress={clearAggFilters}
                style={dynamicStyles.categoryButton}
                textStyle={dynamicStyles.categoryText}
                variant="ghost"
              />
            )}
          </View>
          {filtersVisible && aggFilterGroups.map((group) => (
            <View
              key={group.key}
              style={[dynamicStyles.categoryContainer, dynamicStyles.filterRow]}
            >
              <ThemedText style={dynamicStyles.filterLabel}>{group.name}</ThemedText>
              <FlatList
                data={group.value}
                renderItem={({ item }) => (
                  <StyledButton
                    text={item.n}
                    onPress={() => handleFilterSelect(group.key, item.v)}
                    isSelected={aggFilters[group.key] === item.v}
                    style={dynamicStyles.categoryButton}
                    textStyle={dynamicStyles.categoryText}
                    variant="ghost"
                  />
                )}
                keyExtractor={(item) => `${group.key}-${item.n}-${item.v}`}
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={dynamicStyles.filterListContent}
                style={dynamicStyles.filterList}
              />
            </View>
          ))}
        </>
      )}

      {/* 内容网格 */}
      {shouldShowApiConfig ? (
        <View style={commonStyles.center}>
          <ThemedText type="subtitle" style={{ padding: spacing, textAlign: "center" }}>
            {getApiConfigErrorMessage(apiConfigStatus)}
          </ThemedText>
        </View>
      ) : apiConfigStatus.isValidating && !isCmsCategory && !isRecordCategory ? (
        <View style={commonStyles.center}>
          <ActivityIndicator size="large" />
          <ThemedText type="subtitle" style={{ padding: spacing, textAlign: "center" }}>
            正在验证服务器配置...
          </ThemedText>
        </View>
      ) : apiConfigStatus.error && !apiConfigStatus.isValid && !isCmsCategory && !isRecordCategory ? (
        <View style={commonStyles.center}>
          <ThemedText type="subtitle" style={{ padding: spacing, textAlign: "center" }}>
            {apiConfigStatus.error}
          </ThemedText>
        </View>
      ) : loading ? (
        <View style={commonStyles.center}>
          <ActivityIndicator size="large" />
        </View>
      ) : error ? (
        <View style={commonStyles.center}>
          <ThemedText type="subtitle" style={{ padding: spacing }}>
            {error}
          </ThemedText>
          {/* 原始错误值（v1.7.7）：友好文案看不出是哪一环失败
              （AGG_INVALID_RESPONSE / JSON 解析失败 / 超时 / 网络异常），
              原始值单独一行显示，方便定位；与友好文案相同时不重复显示。
              重试走 store 的 retryLoad 硬重载（绕过缓存命中与同内容
              后台刷新），点按一定重新发起请求。
              注意：不要给这个按钮加 hasTVPreferredFocus——v1.7.7 真机实测，
              带它的重试按钮在平板上触摸/确认键/Enter 全都点不动（零流量），
              而同屏不带它的分类按钮都能点；电视上遥控仍可移焦到它上面按确认。 */}
          {errorDetail && errorDetail !== error ? (
            <ThemedText style={{ padding: spacing, textAlign: "center" }}>
              {errorDetail}
            </ThemedText>
          ) : null}
          <StyledButton
            text="重试"
            variant="primary"
            onPress={() => retryLoad()}
          />
        </View>
      ) : (
        <Animated.View style={[dynamicStyles.contentContainer, { opacity: fadeAnim }]}>
          <CustomScrollView
            data={contentData}
            renderItem={renderContentItem}
            loading={loading}
            loadingMore={loadingMore}
            error={error}
            onEndReached={loadMoreData}
            loadMoreThreshold={LOAD_MORE_THRESHOLD}
            emptyMessage={isCmsCategory ? "该分类下暂无内容" : (selectedCategory?.tags ? "请选择一个子分类" : "该分类下暂无内容")}
            ListFooterComponent={renderFooter}
          />
        </Animated.View>
      )}
    </ThemedView>
  );

  // 根据设备类型决定是否包装在响应式导航中
  if (deviceType === "tv") {
    return content;
  }

  return <ResponsiveNavigation>{content}</ResponsiveNavigation>;
}
