// UpdateService.ts
import { File, Paths } from 'expo-file-system';
// 新 API 没有取 content:// URI 的方法，安装 APK 需要它，只能走 legacy 子包
import { getContentUriAsync } from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import Toast from 'react-native-toast-message';
import { version as currentVersion } from '../package.json';
import { UPDATE_CONFIG } from '../constants/UpdateConfig';
import { Logger } from '@/utils/Logger';
import { readJsonWithLimit, readTextWithLimit } from './httpBody';
import { Platform } from 'react-native';

const logger = Logger.withTag('UpdateService');

interface VersionInfo {
  version: string;
  downloadUrl: string;
}

/**
 * 只在 Android 平台使用的常量（iOS 不会走到下载/安装流程）
 */
const ANDROID_MIME_TYPE = 'application/vnd.android.package-archive';

/** 版本检查请求超时（毫秒，2026-10-28：10 秒放宽到 20 秒，国内网络容错） */
const VERSION_CHECK_TIMEOUT_MS = 20_000;
/** 版本检查响应最大体积：与 api.ts 的 JSON 上限一致（2MB），防被劫持的
 * 版本端点返回超大 JSON 占满内存（L5）。正常响应只是个小对象。 */
const MAX_VERSION_CHECK_BYTES = 2 * 1024 * 1024;
/** SHA256 文件获取超时（毫秒） */
const SHA256_FETCH_TIMEOUT_MS = 15_000;
/** SHA256 文件最大体积：正常是 "hash  filename" 一行（约 100 字节），4KB 已留足
 * 余量；超限返回 null，调用方 fail-closed 中止更新（防被劫持的端点返回超大
 * 文本占满内存，resp.text() 无上限）。 */
const MAX_SHA256_FILE_BYTES = 4 * 1024;
/**
 * APK 下载体积上限（200MB）：防被投毒/劫持的 CDN 返回超大文件占满设备存储。
 * 正常 release APK 约几十 MB，200MB 已留足余量。
 */
const MAX_APK_DOWNLOAD_BYTES = 200 * 1024 * 1024;
/** 更新相关网络操作的最大重试次数 */
const UPDATE_MAX_RETRIES = 3;
/** 版本检查重试退避基数（毫秒，实际延迟 = 基数 × 第几次重试） */
const VERSION_CHECK_RETRY_BASE_DELAY_MS = 2_000;
/** APK 下载重试退避基数（毫秒，实际延迟 = 基数 × 第几次重试） */
const APK_DOWNLOAD_RETRY_BASE_DELAY_MS = 3_000;

class UpdateService {
  private static instance: UpdateService;
  static getInstance(): UpdateService {
    if (!UpdateService.instance) {
      UpdateService.instance = new UpdateService();
    }
    return UpdateService.instance;
  }

  /** --------------------------------------------------------------
   *  1️⃣ 远程版本检查（保持不变，只是把 fetch 包装成 async/await）
   * --------------------------------------------------------------- */
  async checkVersion(): Promise<VersionInfo> {
    for (let attempt = 1; attempt <= UPDATE_MAX_RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), VERSION_CHECK_TIMEOUT_MS);
        try {
          const response = await fetch(UPDATE_CONFIG.GITHUB_RAW_URL, {
            signal: controller.signal,
          });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          // 超时须覆盖到响应体读完，且计时器在所有路径（含 fetch 抛错）都清理。
          // 体读取走共享工具（L5）：带 2MB 体积上限与独立体超时 race——
          // RN 下 response.json() 无法被 AbortSignal 中断，只靠上面的定时器，
          // 慢速服务端能让调用挂起远超 20 秒（同 M6）。
          const remotePackage = await readJsonWithLimit<{ version?: unknown }>(
            response,
            MAX_VERSION_CHECK_BYTES,
            VERSION_CHECK_TIMEOUT_MS,
            controller.signal,
          );
          const remoteVersion = remotePackage?.version as string;
          // 校验版本号：服务端返回异常内容（如错误页）时不能拿着 undefined 去拼下载地址，
          // 否则下载阶段才报一个看不懂的错
          if (!remoteVersion || typeof remoteVersion !== "string") {
            throw new Error("Invalid version info from server");
          }
          return {
            version: remoteVersion,
            downloadUrl: UPDATE_CONFIG.getDownloadUrl(remoteVersion),
          };
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (e) {
        logger.warn(`checkVersion attempt ${attempt}/${UPDATE_MAX_RETRIES}`, e);
        // 确定性错误不重试：版本文件内容异常、4xx、响应超限、JSON 损坏——
        // 原样重发只会得到同一答复，白白多等 2 次 × 退避。
        let isDeterministic = false;
        if (e instanceof Error) {
          if (e.message === 'Invalid version info from server') isDeterministic = true;
          // getDownloadUrl 抛的格式错误同样是确定性的：同一版本号重发
          // 还是同一格式，不重试（旧代码漏了，多等 2 次退避约 12 秒）
          else if (e.message.startsWith('Invalid version format')) isDeterministic = true;
          else if (e.message.startsWith('RESPONSE_TOO_LARGE')) isDeterministic = true;
          else {
            const httpMatch = e.message.match(/^HTTP (\d+)$/);
            if (httpMatch) {
              const status = Number(httpMatch[1]);
              if (status >= 400 && status < 500) isDeterministic = true;
            }
          }
        }
        if (e instanceof SyntaxError) isDeterministic = true;
        if (isDeterministic || attempt === UPDATE_MAX_RETRIES) {
          Toast.show({
            type: 'error',
            text1: '检查更新失败',
            text2: '无法获取版本信息，请检查网络',
          });
          throw e;
        }
        // 指数退避
        await new Promise(r => setTimeout(r, VERSION_CHECK_RETRY_BASE_DELAY_MS * attempt));
      }
    }
    // 这句永远走不到，仅为 TypeScript 报错
    throw new Error('Unexpected');
  }

  /** --------------------------------------------------------------
   *  2️⃣ 清理旧的 APK 文件（使用 expo-file-system 的 API）
   * --------------------------------------------------------------- */
  private async cleanOldApkFiles(): Promise<void> {
    try {
      // expo-file-system 58 新 API：Paths.document 为 Directory，list() 同步返回条目
      const listing = Paths.document.list();
      const apkFiles = listing
        .filter(entry => entry.name.startsWith('OrionTV_v') && entry.name.endsWith('.apk'))
        .map(entry => entry.name);

      if (apkFiles.length <= 2) return;

      const sorted = apkFiles.sort((a, b) => {
        const numA = parseInt(a.replace(/[^0-9]/g, ''), 10);
        const numB = parseInt(b.replace(/[^0-9]/g, ''), 10);
        return numB - numA; // 倒序（最新在前）
      });

      const stale = sorted.slice(2); // 保留最新的两个
      for (const file of stale) {
        try {
          new File(Paths.document, file).delete();
          logger.debug(`Deleted old APK: ${file}`);
        } catch (e) {
          logger.warn(`Failed to delete ${file}`, e);
        }
      }
    } catch (e) {
      logger.warn('cleanOldApkFiles error', e);
    }
  }

  /**
   * 下载前用 HEAD 请求预检 APK 体积，超限直接拒绝，避免下载超大恶意文件。
   * 拿不到 Content-Length 时放行（由下载进度回调兜底）。
   * HEAD 请求本身失败（网络抖动、CDN 不支持 HEAD、超时）也放行：预检只是
   * 优化手段，下载进度回调同样会强制执行体积上限；让预检失败中止整个下载
   * 是本末倒置（尤其部分 CDN 对 HEAD 返回 405/403）。
   */
  private async assertApkSizeAcceptable(url: string): Promise<void> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SHA256_FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(url, { method: 'HEAD', signal: controller.signal });
      const len = resp.headers.get('content-length');
      if (len) {
        const bytes = parseInt(len, 10);
        if (!Number.isNaN(bytes) && bytes > MAX_APK_DOWNLOAD_BYTES) {
          throw new Error(`APK_TOO_LARGE: declared ${bytes} bytes`);
        }
      }
    } catch (e) {
      // 只有超限才中止；其余（网络失败、超时、HEAD 不支持）都只是“拿不到
      // 声明体积”，记一条日志后放行，下载进度回调兜底。
      if (e instanceof Error && e.message.startsWith('APK_TOO_LARGE')) throw e;
      logger.warn('APK HEAD pre-check failed, proceeding (size enforced during download):', e);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** --------------------------------------------------------------
   *  3️⃣ 下载 APK（使用 expo-file-system 的下载 API）
   *  安全：下载完成后校验 SHA256（从 <url>.sha256 获取期望值）。
   *  发布流程必须在 GitHub Release 中附带 .sha256 文件。
   * --------------------------------------------------------------- */
  async downloadApk(
    url: string,
    onProgress?: (percent: number) => void,
  ): Promise<string> {
    await this.cleanOldApkFiles();

    for (let attempt = 1; attempt <= UPDATE_MAX_RETRIES; attempt++) {
      let targetFile: File | null = null;
      try {
        const timestamp = Date.now();
        const fileName = `OrionTV_v${timestamp}.apk`;
        targetFile = new File(Paths.document, fileName);

        // 下载前先 HEAD 预检体积：被劫持的 CDN 可能返回超大文件
        await this.assertApkSizeAcceptable(url);

        // expo-file-system 58：DownloadTask 进度回调为 `{bytesWritten, totalBytes}`
        //（totalBytes 为 -1 表示服务端未提供 Content-Length）
        // 注意：进度回调里 throw 毫无作用（native 侧不等它），超限只能靠
        // pauseAsync 停掉下载——它会让 downloadAsync() 以 null  resolve，
        // 所以用 abortedForSize 记下来，下载返回后据此抛 APK_TOO_LARGE；
        // 否则这里会被当成普通失败重试 3 次，白白再下 600MB。
        let abortedForSize = false;
        const task = File.createDownloadTask(url, targetFile, {
          onProgress: async progress => {
            if (abortedForSize) return;
            if (progress.bytesWritten > MAX_APK_DOWNLOAD_BYTES) {
              logger.warn(`APK download exceeded ${MAX_APK_DOWNLOAD_BYTES} bytes, aborting`);
              abortedForSize = true;
              await task.pauseAsync();
              return;
            }
            if (onProgress && progress.totalBytes > 0) {
              const percent = Math.floor(
                (progress.bytesWritten / progress.totalBytes) * 100,
              );
              onProgress(percent);
            }
          },
        });

        const downloadedFile = await task.downloadAsync();
        if (abortedForSize) {
          throw new Error('APK_TOO_LARGE');
        }
        if (!downloadedFile) {
          throw new Error('Download failed: No URI available');
        }

        // 下载后硬校验实际体积：HEAD 预检可被绕过、进度回调也非必达，
        // 落盘大小超限一律删文件并中止（走 catch 的 APK_TOO_LARGE 不重试分支），
        // 不进入后续 SHA 校验与安装
        const downloadedInfo = downloadedFile.info();
        if (downloadedInfo.size !== undefined && downloadedInfo.size > MAX_APK_DOWNLOAD_BYTES) {
          throw new Error(`APK_TOO_LARGE: downloaded ${downloadedInfo.size} bytes`);
        }

        // SHA256 完整性校验（P0-3：防 CDN 投毒）
        await this.verifyApkSha256(downloadedFile.uri, url);

        logger.debug(`APK downloaded and verified: ${downloadedFile.uri}`);
        return downloadedFile.uri;
      } catch (e) {
        // 校验失败或下载失败时删除残留文件，避免安装被篡改的包
        if (targetFile) {
          try {
            if (targetFile.exists) targetFile.delete();
          } catch { /* ignore */ }
        }
        logger.warn(`downloadApk attempt ${attempt}/${UPDATE_MAX_RETRIES}`, e);
        // 体积超限是确定性失败，不重试
        if (e instanceof Error && e.message.includes('APK_TOO_LARGE')) {
          Toast.show({
            type: 'error',
            text1: '下载文件过大',
            text2: 'APK 体积超过安全上限，已取消下载',
          });
          throw e;
        }
        // SHA256 相关失败同样是确定性失败（文件被篡改/损坏，或校验文件有问题），
        // 重试只会白白重下整个 APK（约 50MB×3）：立即抛错不重试（L4，与
        // APK_TOO_LARGE 同款处理）。其中 .sha256 拉取失败/格式无效已在
        // verifyApkSha256 内弹过更具体的提示，这里不再重复弹。
        if (e instanceof Error && e.message.includes('SHA256')) {
          const alreadyToasted =
            e.message.includes('cannot obtain expected hash') ||
            e.message.includes('invalid expected hash format');
          if (!alreadyToasted) {
            Toast.show({
              type: 'error',
              text1: '安全校验失败',
              text2: 'APK 完整性校验未通过，已删除该文件，请勿安装',
            });
          }
          throw e;
        }
        if (attempt === UPDATE_MAX_RETRIES) {
          const isShaError = e instanceof Error && e.message.includes('SHA256');
          Toast.show({
            type: 'error',
            text1: isShaError ? '安全校验失败' : '下载失败',
            text2: isShaError
              ? 'APK 完整性校验未通过，已删除该文件，请勿安装'
              : 'APK 下载出现错误，请检查网络',
          });
          throw e;
        }
        // 指数退避
        await new Promise(r => setTimeout(r, APK_DOWNLOAD_RETRY_BASE_DELAY_MS * attempt));
      }
    }
    // 同上，理论不会到这里
    throw new Error('Download failed');
  }

  /**
   * 校验下载的 APK 的 SHA256。
   * 期望值从 `${downloadUrl}.sha256` 获取（GitHub Release 附件）。
   * - 期望值拉取失败 / 格式无效 / 与实际哈希不一致：全部抛错并由调用方删除文件（fail-closed），
   *   绝不降级安装。发布流程必须在 GitHub Release 中附带 .sha256 文件。
   */
  private async verifyApkSha256(fileUri: string, downloadUrl: string): Promise<void> {
    let expected = "";
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), SHA256_FETCH_TIMEOUT_MS);
      let text = "";
      try {
        const resp = await fetch(`${downloadUrl}.sha256`, { signal: controller.signal });
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}`);
        }
        // 超时须覆盖到响应体读完，且计时器在所有路径（含 fetch 抛错）都清理。
        // 体读取走共享工具：带 4KB 体积上限（sha256 文件正常约 100 字节），
        // 超限返回 null，fail-closed 中止更新；裸 resp.text() 无上限，
        // 被劫持的端点返回超大文本会占满内存。
        const limited = await readTextWithLimit(resp, MAX_SHA256_FILE_BYTES, SHA256_FETCH_TIMEOUT_MS, controller.signal);
        if (limited === null) {
          throw new Error("SHA256_TOO_LARGE");
        }
        text = limited.trim();
      } finally {
        clearTimeout(timeoutId);
      }
      // 兼容 "hash  filename" 和纯 hash 两种格式
      expected = text.split(/\s+/)[0].toLowerCase();
    } catch (e) {
      logger.error('Failed to fetch .sha256, aborting update (fail-closed)', e);
      Toast.show({
        type: 'error',
        text1: '安全校验失败',
        text2: '无法获取该版本的 SHA256 校验文件，已中止更新',
      });
      throw new Error('SHA256: cannot obtain expected hash for APK, update aborted');
    }

    if (!expected || !/^[0-9a-f]{64}$/.test(expected)) {
      logger.error('Invalid SHA256 in .sha256 file, aborting update (fail-closed)', expected);
      Toast.show({
        type: 'error',
        text1: '安全校验失败',
        text2: 'SHA256 校验文件内容无效，已中止更新',
      });
      throw new Error('SHA256: invalid expected hash format, update aborted');
    }

    // 分块读取文件并计算 SHA256（避免一次性加载大文件进内存）
    const actual = await this.sha256OfFile(fileUri);
    logger.debug(`APK SHA256 expected=${expected} actual=${actual}`);
    if (actual !== expected) {
      throw new Error(`SHA256 mismatch: expected ${expected}, got ${actual}`);
    }
  }

  /**
   * 计算文件的 SHA256（纯 JS 实现，真流式分块读取）。
   * 说明：expo-crypto 的 digestStringAsync 只能对字符串做哈希，
   * 对二进制文件内容做 UTF-8 编码后再哈希会得到错误结果，
   * 因此这里用标准 SHA256 算法直接处理字节数组。
   * 实现为增量式：readableStream 约 1KB 一块流式读入，按 64 字节块送入
   * 哈希状态（不足一块的尾部暂存 leftover），峰值内存与文件大小无关。
   * 注意：旧注释称“每次读取 1MB base64 块”已过期——实现从未用过 base64，
   * 块大小也由流实现决定（约 1KB），特此修正（L6）。
   */
  private async sha256OfFile(fileUri: string): Promise<string> {
    const file = new File(fileUri);
    if (!file.exists) {
      throw new Error('Cannot get file info for SHA256');
    }
    const fileInfo = file.info();
    if (fileInfo.size === undefined) {
      throw new Error('Cannot get file info for SHA256');
    }
    const fileSize = fileInfo.size;

    // SHA256 常量与初始值
    const K = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

    const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
    const w = new Uint32Array(64);
    const processBlock = (block: Uint8Array) => {
      const view = new DataView(block.buffer, block.byteOffset, 64);
      for (let i = 0; i < 16; i++) {
        w[i] = view.getUint32(i * 4, false);
      }
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + temp1) >>> 0;
        d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    };

    // 增量读取：expo-file-system 58 用 readableStream 流式读（默认约 1KB 一块），
    // leftover 保存不足 64 字节的尾部。整块直接从 chunk 切片送入 processBlock
    // （零拷贝）；只有 leftover 非空时才拼一块 64 字节临时块。原来每块都
    // new Uint8Array(leftover + chunk) 全量拼接拷贝，几十 MB 的 APK 要经过
    // 数万次拷贝，在电视弱硬件上耗时较长（L6）。
    let leftover = new Uint8Array(0);
    let processedBytes = 0;
    const reader = file.readableStream().getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        let chunk = value;
        processedBytes += chunk.length;
        // 先用 chunk 的头部把 leftover 补满一块（64 字节）
        if (leftover.length > 0) {
          const need = 64 - leftover.length;
          if (chunk.length >= need) {
            const block = new Uint8Array(64);
            block.set(leftover);
            block.set(chunk.subarray(0, need), leftover.length);
            processBlock(block);
            chunk = chunk.subarray(need);
            leftover = new Uint8Array(0);
          } else {
            // chunk 不够补一块：并进 leftover，等下一块（最多 63 字节拷贝）
            const merged = new Uint8Array(leftover.length + chunk.length);
            merged.set(leftover);
            merged.set(chunk, leftover.length);
            leftover = merged;
            continue;
          }
        }
        // 整块直接切片处理，零拷贝
        const fullBlocks = Math.floor(chunk.length / 64);
        for (let b = 0; b < fullBlocks; b++) {
          processBlock(chunk.subarray(b * 64, b * 64 + 64));
        }
        // 尾部不足一块：slice 拷贝留到下一轮（不直接存 subarray 视图，
        // 流实现可能复用底层 buffer，视图会被后续读取覆盖）
        const tail = chunk.subarray(fullBlocks * 64);
        leftover = tail.length > 0 ? tail.slice() : new Uint8Array(0);
      }
    } finally {
      // 读中途抛错时取消 reader：只 releaseLock 不 cancel，底层流不会被
      // 释放（expo-file-system 的流实现可能因此泄漏文件句柄）。正常读完
      // 时 cancel 是空操作。cancel 自身失败也不影响主流程。
      try {
        if (typeof (reader as unknown as { cancel?: unknown }).cancel === 'function') {
          await (reader as unknown as { cancel: () => Promise<void> }).cancel();
        }
      } catch {
        // 忽略：流已关闭等
      }
      reader.releaseLock();
    }

    // 字节数完整性第二道闸：实际送入哈希的字节数必须与文件大小严格一致，
    // 否则说明分块读取/解码出了偏差，哈希不可信，直接抛错
    if (processedBytes !== fileSize) {
      throw new Error(`SHA256: processed ${processedBytes} bytes, expected ${fileSize}`);
    }

    // SHA256 填充（按规范构造）：leftover 后补 0x80、再补零，使总长 ≡ 56 (mod 64)，
    // 最后 8 字节写入 64 位大端比特长度；leftover ≥ 56 时自然落成两块。
    // 长度字段必须位于最终块的最后 8 字节，写错位置只有长度为 0 时碰巧无差异。
    const bitLen = fileSize * 8;
    const afterMarker = leftover.length + 1; // 含 0x80
    const zeroPad = (56 - (afterMarker % 64) + 64) % 64;
    const tailLen = afterMarker + zeroPad + 8;
    const tail = new Uint8Array(tailLen);
    tail.set(leftover);
    tail[leftover.length] = 0x80;
    const dv = new DataView(tail.buffer);
    dv.setUint32(tailLen - 4, bitLen >>> 0, false);
    dv.setUint32(tailLen - 8, Math.floor(bitLen / 0x100000000), false);
    for (let b = 0; b < tailLen / 64; b++) {
      processBlock(tail.subarray(b * 64, b * 64 + 64));
    }

    return [h0, h1, h2, h3, h4, h5, h6, h7]
      .map(v => v.toString(16).padStart(8, '0'))
      .join('');
  }

  /** --------------------------------------------------------------
   *  4️⃣ 安装 APK（只在 Android 可用，使用 expo-intent-launcher）
   * --------------------------------------------------------------- */
  async installApk(fileUri: string): Promise<void> {
    // 平台检查放最前面：iOS 上 getContentUriAsync 本来就会失败，
    // 先拦下来才能给用户看“iOS 无法安装 APK”的明确提示，而不是
    // 一条看不懂的底层错误
    if (Platform.OS !== 'android') {
      Toast.show({
        type: 'error',
        text1: '安装失败',
        text2: 'iOS 设备无法直接安装 APK',
      });
      throw new Error('APK install not supported on iOS');
    }

    // ① 先确认文件存在
    const file = new File(fileUri);
    if (!file.exists) {
      throw new Error(`APK not found at ${fileUri}`);
    }

    // ② 把 file:// 转成 content://，Expo‑FileSystem 已经实现了 FileProvider
    const contentUri = await getContentUriAsync(fileUri);

    // ③ 拉起系统安装器
    try {
      // FLAG_ACTIVITY_NEW_TASK = 0x10000000：从非 Activity 上下文拉起安装器必须带，
      // 否则系统可能拒绝启动；FLAG_GRANT_READ_URI_PERMISSION = 0x00000001：
      // 授权安装器读取 content:// URI。旧写法 `1 | 0x00000010` 的注释把 1 误写成
      // NEW_TASK，实际 flags 为 17（READ + 无关的 FLAG_EXCLUDE_STOPPED_PACKAGES），
      // 并未设置 NEW_TASK（L11）。
      const flags = 0x10000000 | 0x00000001;

      await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
        data: contentUri,          // 必须是 content://
        type: ANDROID_MIME_TYPE,   // application/vnd.android.package-archive
        flags,
      });
    } catch (e) {
      // 统一错误提示
      const errMsg = e instanceof Error ? e.message : String(e);
      if (errMsg.includes('Activity not found')) {
        Toast.show({
          type: 'error',
          text1: '安装失败',
          text2: '系统没有找到可以打开 APK 的应用，请检查系统设置',
        });
      } else if (errMsg.includes('permission')) {
        Toast.show({
          type: 'error',
          text1: '安装失败',
          text2: '请在设置里允许“未知来源”安装',
        });
      } else {
        Toast.show({
          type: 'error',
          text1: '安装失败',
          // Release 签名刚从公开 debug key 换成专用 release key：旧版本用户
          // 直接覆盖安装会因签名不一致失败，需卸载旧版后重装一次
          text2: '未知错误，请稍后重试。旧版本升级失败时，可能是签名变更导致，请先卸载旧版再安装',
        });
      }
      throw e;
    }
  }

  /** --------------------------------------------------------------
   *  5️⃣ 版本比对工具（支持 -beta / -rc 等后缀）
   * --------------------------------------------------------------- */
  compareVersions(v1: string, v2: string): number {
    // 数字部分相等时，带预发布后缀（-beta/-alpha/-rc）的版本低于正式版：
    // 旧实现直接剥掉后缀，1.7.0-beta 与 1.7.0 被判相等，beta 用户永远收不到
    // 正式版更新提示。两边都有后缀时按后缀字典序比较（beta.1 < beta.2）。
    const parse = (v: string) => {
      const [num, pre] = v.split('-', 2);
      return {
        parts: num.split('.').map(s => {
          const n = parseInt(s, 10);
          return isNaN(n) ? 0 : n;
        }),
        pre: pre ?? '',
      };
    };
    const a = parse(v1);
    const b = parse(v2);
    for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i++) {
      const n1 = a.parts[i] ?? 0;
      const n2 = b.parts[i] ?? 0;
      if (n1 > n2) return 1;
      if (n1 < n2) return -1;
    }
    if (a.pre === b.pre) return 0;
    if (a.pre === '') return 1; // 正式版高于预发布版
    if (b.pre === '') return -1;
    return a.pre < b.pre ? -1 : 1;
  }
  getCurrentVersion(): string {
    return currentVersion;
  }
  isUpdateAvailable(remoteVersion: string): boolean {
    return this.compareVersions(remoteVersion, currentVersion) > 0;
  }
}

/* 单例导出 */
export default UpdateService.getInstance();
