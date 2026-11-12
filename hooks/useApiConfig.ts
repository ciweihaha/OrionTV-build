import { useEffect, useState } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';

export interface ApiConfigStatus {
  isConfigured: boolean;
  isValidating: boolean;
  isValid: boolean | null;
  error: string | null;
  needsConfiguration: boolean;
}

export const useApiConfig = () => {
  // 按字段订阅：原来整库订阅，改任何一个设置（如 m3u 地址、片头跳过）
  // 都会让用这个 hook 的首页重渲染；现在只跟这三个字段有关
  const apiBaseUrl = useSettingsStore((s) => s.apiBaseUrl);
  const serverConfig = useSettingsStore((s) => s.serverConfig);
  const isLoadingServerConfig = useSettingsStore((s) => s.isLoadingServerConfig);
  const [validationState, setValidationState] = useState<{
    isValidating: boolean;
    isValid: boolean | null;
    error: string | null;
  }>({
    isValidating: false,
    isValid: null,
    error: null,
  });

  const isConfigured = Boolean(apiBaseUrl && apiBaseUrl.trim());
  const needsConfiguration = !isConfigured;

  // 未配置时直接重置校验状态。L18d：不再像原来那样单独调一次
  // api.getServerConfig()——那与 store 的 fetchServerConfig 是两次并行重复请求。
  // store 的拉取已在 loadSettings / saveSettings / checkLoginStatus 里触发
  // （checkLoginStatus 无配置时还会主动拉取并重试），且 fetchServerConfig 内部
  // 有同地址单飞去重；本 hook 只订阅 store 的 serverConfig /
  // isLoadingServerConfig（见下面两个 effect），不再自己发请求。
  useEffect(() => {
    if (!isConfigured) {
      setValidationState({
        isValidating: false,
        isValid: false,
        error: null,
      });
    }
  }, [isConfigured]);

  // Reset validation when server config loading state changes
  useEffect(() => {
    if (isLoadingServerConfig) {
      setValidationState(prev => ({ ...prev, isValidating: true, error: null }));
    }
  }, [isLoadingServerConfig]);

  // Update validation state based on server config
  useEffect(() => {
    if (!isLoadingServerConfig && isConfigured) {
      if (serverConfig) {
        // 校验完成必须把 isValidating 复位：effect 2 在加载开始时把它置 true，
        // 这里不复位，status.isValidating 永久为真，非 CMS 分类永远显示
        // “正在验证服务器配置…”转圈（PR #16 L18d 重构删掉直接校验路径后引入的回归）。
        setValidationState(prev => ({ ...prev, isValidating: false, isValid: true, error: null }));
      } else {
        // store 未拿到配置：原先直接请求能区分的细分错误（Network/timeout/
        // 404/500 等）随直接请求一并取消——store 不暴露失败原因，统一报通用
        // 错误；具体失败原因由 store 的 fetchServerConfig 记在日志里
        setValidationState(prev => ({
          ...prev,
          isValidating: false,
          isValid: false,
          error: '无法获取服务器配置'
        }));
      }
    }
  }, [serverConfig, isLoadingServerConfig, isConfigured]);

  const status: ApiConfigStatus = {
    isConfigured,
    isValidating: validationState.isValidating || isLoadingServerConfig,
    isValid: validationState.isValid,
    error: validationState.error,
    needsConfiguration,
  };

  return status;
};

export const getApiConfigErrorMessage = (status: ApiConfigStatus): string => {
  if (status.needsConfiguration) {
    return '请点击右上角设置按钮，配置您的服务器地址';
  }

  if (status.error) {
    return status.error;
  }

  if (status.isValidating) {
    return '正在验证服务器配置...';
  }

  if (status.isValid === false) {
    return '服务器配置验证失败，请检查设置';
  }

  return '加载失败，请重试';
};