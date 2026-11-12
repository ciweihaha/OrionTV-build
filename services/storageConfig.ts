// Define a simple storage configuration service
export interface StorageConfig {
  storageType: string | undefined;
  getStorageType: () => string | undefined;
  setStorageType: (type: string | undefined) => void;
}

// Create a singleton instance
export const storageConfig: StorageConfig = {
  // Default to undefined (will fallback to local storage)
  storageType: undefined,

  getStorageType() {
    // 未配置/拉取失败时回落本地存储：undefined 时各 Manager 若走 API 路径，
    // 冷启动服务器不可达时本地收藏/记录全看不到（AsyncStorage 里明明有）。
    // 服务器配置成功后 setStorageType 会覆盖为真实值。
    return this.storageType ?? "localstorage";
  },

  setStorageType(type: string | undefined) {
    this.storageType = type;
  },
};
