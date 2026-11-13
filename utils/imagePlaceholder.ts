import type { ImageSource } from "expo-image";

/**
 * 海报占位图：1x1 透明 PNG（data URI，无需打包额外资源）。
 * 卡片本身底色是 #222，透明占位透出的就是深色卡片底，滚动时不再白闪。
 * expo-image 的 placeholder 接受 ImageSource，data URI 可直接用。
 */
export const IMAGE_PLACEHOLDER: ImageSource = {
  uri: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
};
