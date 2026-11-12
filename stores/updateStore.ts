import { create } from 'zustand';
import updateService from '../services/updateService';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Toast from 'react-native-toast-message';
import { Logger } from '@/utils/Logger';

const logger = Logger.withTag('UpdateStore');

// 安装进行中标志：遥控器连按两下“安装”会调两次 installApk，
// 系统安装器会被重复拉起；这里挡一道（store 字段就不加了，UI 不需要读它）
let installInFlight = false;

interface UpdateState {
  // 状态
  updateAvailable: boolean;
  currentVersion: string;
  remoteVersion: string;
  downloadUrl: string;
  downloading: boolean;
  downloadProgress: number;
  downloadedPath: string | null;
  error: string | null;
  lastCheckTime: number;
  skipVersion: string | null;
  showUpdateModal: boolean;
  isLatestVersion: boolean; // 新增：是否已是最新版本
  /** initUpdateStore 是否已完成（lastCheckTime 已从存储读回）：完成前
   * lastCheckTime 是初始值 0，_layout 的间隔判断恒真，12 小时间隔失效 */
  isInitialized: boolean;
  
  // 操作
  checkForUpdate: (silent?: boolean) => Promise<void>;
  startDownload: () => Promise<void>;
  installUpdate: () => Promise<void>;
  setShowUpdateModal: (show: boolean) => void;
  skipThisVersion: () => Promise<void>;
  reset: () => void;
}

const STORAGE_KEYS = {
  LAST_CHECK_TIME: 'update_last_check_time',
  SKIP_VERSION: 'update_skip_version',
};

export const useUpdateStore = create<UpdateState>((set, get) => ({
  // 初始状态
  updateAvailable: false,
  currentVersion: updateService.getCurrentVersion(),
  remoteVersion: '',
  downloadUrl: '',
  downloading: false,
  downloadProgress: 0,
  downloadedPath: null,
  error: null,
  lastCheckTime: 0,
  skipVersion: null,
  showUpdateModal: false,
  isLatestVersion: false, // 新增：初始为false
  isInitialized: false,

  // 检查更新
  checkForUpdate: async (silent = false) => {
    try {
      set({ error: null, isLatestVersion: false });

      // 获取跳过的版本
      const skipVersion = await AsyncStorage.getItem(STORAGE_KEYS.SKIP_VERSION);
      
      const versionInfo = await updateService.checkVersion(silent);
      const isUpdateAvailable = updateService.isUpdateAvailable(versionInfo.version);
      
      // 如果有更新且不是要跳过的版本
      const shouldShowUpdate = isUpdateAvailable && versionInfo.version !== skipVersion;

      // 检查是否已经是最新版本
      const isLatest = !isUpdateAvailable;

      set({
        remoteVersion: versionInfo.version,
        downloadUrl: versionInfo.downloadUrl,
        updateAvailable: isUpdateAvailable,
        lastCheckTime: Date.now(),
        skipVersion,
        // 有更新就弹 Modal，无论是否静默：silent 只应抑制“已是最新版本”
        // 的 Toast（下面单独处理）。旧代码静默时恒不弹，冷启动自动检查
        // 发现新版也无人知晓，自动更新功能实际无效。
        showUpdateModal: shouldShowUpdate,
        isLatestVersion: isLatest,
      });

      // 如果是手动检查且已是最新版本，显示提示
      if (!silent && isLatest) {
        Toast.show({
          type: 'success',
          text1: '已是最新版本',
          text2: `当前版本 v${updateService.getCurrentVersion()} 已是最新版本`,
          visibilityTime: 3000,
        });
      }

      // 保存最后检查时间：单独 try/catch——写失败（存储满/权限问题）不能
      // 掩盖已成功的版本检查，否则 catch 会置 error + updateAvailable:
      // false，有更新也不弹 Modal
      try {
        await AsyncStorage.setItem(
          STORAGE_KEYS.LAST_CHECK_TIME,
          Date.now().toString()
        );
      } catch (storageError) {
        logger.warn('保存最后检查时间失败:', storageError);
      }
    } catch (error) {
      logger.warn('检查更新失败:', error);
      set({ 
        error: error instanceof Error ? error.message : '检查更新失败',
        updateAvailable: false,
        isLatestVersion: false,
      });
    }
  },

  // 开始下载
  startDownload: async () => {
    const { downloadUrl, downloading } = get();

    // 防重复下载：UI 层已有 disabled 保护，这里再挡一道（连续调用/外部调用时
    // 两个下载任务会互相干扰进度回调，且各写各的时间戳文件）
    if (downloading) return;

    if (!downloadUrl) {
      set({ error: '下载地址无效' });
      return;
    }

    try {
      set({ 
        downloading: true, 
        downloadProgress: 0, 
        error: null 
      });

      const filePath = await updateService.downloadApk(
        downloadUrl,
        (progress) => {
          set({ downloadProgress: progress });
        }
      );

      set({
        downloadedPath: filePath,
        downloading: false,
        downloadProgress: 100,
        // 下载完成务必把弹窗重新亮出来：下载中途按返回关掉弹窗后，
        // 下载是在后台继续的；不亮出来用户就不知道下完了、也没入口安装，
        // 那个 APK 就一直躺在文档目录里
        showUpdateModal: true,
      });
    } catch (error) {
      logger.warn('下载失败:', error);
      set({ 
        downloading: false,
        downloadProgress: 0,
        error: error instanceof Error ? error.message : '下载失败',
      });
    }
  },

  // 安装更新
  installUpdate: async () => {
    const { downloadedPath } = get();

    if (!downloadedPath) {
      set({ error: '安装文件不存在' });
      return;
    }

    if (installInFlight) return;
    installInFlight = true;
    try {
      await updateService.installApk(downloadedPath);
      // 安装开始后，关闭弹窗
      set({ showUpdateModal: false });
    } catch (error) {
      logger.error('安装失败:', error);
      set({
        error: error instanceof Error ? error.message : '安装失败',
      });
    } finally {
      installInFlight = false;
    }
  },

  // 设置显示更新弹窗
  setShowUpdateModal: (show: boolean) => {
    set({ showUpdateModal: show });
  },

  // 跳过此版本
  skipThisVersion: async () => {
    const { remoteVersion } = get();
    
    if (remoteVersion) {
      // 与 checkForUpdate 的 setItem 同款处理（F9）：写操作失败时不抛未处理拒绝，
      // 弹窗保持打开并 Toast 提示，用户可重试；否则 set 不执行、弹窗卡住，
      // 下次检查还会再弹同一版本。
      try {
        await AsyncStorage.setItem(STORAGE_KEYS.SKIP_VERSION, remoteVersion);
      } catch (e) {
        logger.warn('跳过版本保存失败:', e);
        Toast.show({
          type: 'error',
          text1: '跳过失败，请重试',
        });
        return;
      }
      set({ 
        skipVersion: remoteVersion,
        showUpdateModal: false,
      });
    }
  },

  // 重置状态
  reset: () => {
    set({
      downloading: false,
      downloadProgress: 0,
      downloadedPath: null,
      error: null,
      showUpdateModal: false,
      isLatestVersion: false, // 重置时也要重置这个状态
    });
  },
}));

// 初始化时加载存储的数据
export const initUpdateStore = async () => {
  try {
    const lastCheckTime = await AsyncStorage.getItem(STORAGE_KEYS.LAST_CHECK_TIME);
    const skipVersion = await AsyncStorage.getItem(STORAGE_KEYS.SKIP_VERSION);
    
    useUpdateStore.setState({
      lastCheckTime: lastCheckTime ? parseInt(lastCheckTime, 10) : 0,
      skipVersion: skipVersion || null,
    });
  } catch (error) {
    logger.error('初始化更新存储失败:', error);
  } finally {
    // 读失败也置位：lastCheckTime 保持 0，检查按“从未检查过”跑一次，
    // 而不是永远等不到初始化、永远不检查
    useUpdateStore.setState({ isInitialized: true });
  }
};