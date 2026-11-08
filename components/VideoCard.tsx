import React, { memo } from 'react';
import { TouchableOpacity } from 'react-native';
import { useResponsiveLayout } from '@/hooks/useResponsiveLayout';
import { API } from '@/services/api';

// 导入不同平台的VideoCard组件
import VideoCardMobile from './VideoCard.mobile';
import VideoCardTablet from './VideoCard.tablet';
import VideoCardTV from './VideoCard.tv';

interface VideoCardProps extends React.ComponentProps<typeof TouchableOpacity> {
  id: string;
  source: string;
  title: string;
  poster: string;
  year?: string;
  rate?: string;
  sourceName?: string;
  progress?: number;
  playTime?: number;
  episodeIndex?: number;
  totalEpisodes?: number;
  onFocus?: () => void;
  onRecordDeleted?: () => void;
  api: API;
}

/**
 * 响应式VideoCard组件
 * 根据设备类型自动选择合适的VideoCard实现
 * 用 memo 包一层：列表父组件重渲染时（如 loadingMore 切换、搜索输入），
 * props 没变的卡片直接跳过重渲染；传入的 props 全是基础类型、
 * api 单例或 zustand 的稳定回调，浅比较有效。
 */
const VideoCard = memo(
  React.forwardRef<any, VideoCardProps>((props, ref) => {
    const { deviceType } = useResponsiveLayout();

    switch (deviceType) {
      case 'mobile':
        return <VideoCardMobile {...props} ref={ref} />;

      case 'tablet':
        return <VideoCardTablet {...props} ref={ref} />;

      case 'tv':
      default:
        return <VideoCardTV {...props} ref={ref} />;
    }
  })
);

VideoCard.displayName = 'VideoCard';

export default VideoCard;