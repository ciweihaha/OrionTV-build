import { utf8ByteLength } from "../utils/utf8ByteLength";

/**
 * 带体积上限与独立体超时的响应体读取（M6/L5）。
 *
 * 背景：RN 下已收到响应头后的 response.text()/json() 无法被 fetch 的
 * AbortSignal 中断（api.ts 的 readJsonLimited 注释已确认），所以体读取
 * 必须像 api.ts 那样用 Promise.race 另设独立超时，否则慢速滴流的服务端
 * 能让调用挂起远超标称时间。m3u.ts / m3u8.ts / updateService.ts 共用本
 * 工具，超时与体积上限语义与 api.ts 的 readJsonLimited 保持一致。
 *
 * - 超限：readTextWithLimit 返回 null（调用方 fail-closed，见 m3u.ts）；
 *   readJsonWithLimit 抛 RESPONSE_TOO_LARGE（调用方按错误处理）。
 * - 体超时：抛 name 为 TimeoutError、message 以 RESPONSE_TIMEOUT 开头的
 *   Error（与 api.ts 一致）。无流分支（RN 真机主路径）超时后底层 text()
 *   仍在后台继续跑，调用方立即拿到超时错误、不再无限挂起——这是平台限制，
 *   不是本函数的 bug（同 api.ts 的 OTV-1 注释）。
 * - signal：可选。流式分支监听 abort → 取消 reader 并抛 AbortError；
 *   无流分支无法取消，调用方取消后仍要等 text() 结算或体超时（同 OTV-2）。
 */

/**
 * 流式读取响应体文本，超限返回 null。
 * Content-Length 预检：诚实偏大的声明在读体前即返回 null；缺失或谎报的
 * 声明仍由后续字节校验兜底（与 api.ts / m3u.ts 的 early reject 一致）。
 */
export async function readTextWithLimit(
  response: Response,
  maxBytes: number,
  bodyTimeoutMs: number,
  signal?: AbortSignal,
): Promise<string | null> {
  if (signal?.aborted) {
    const err = new Error("The user aborted a request.");
    err.name = "AbortError";
    throw err;
  }
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return null;
  }

  let activeReader: { cancel: () => Promise<void> } | null = null;
  const cancelReader = () => {
    if (!activeReader) return;
    try {
      const p = activeReader.cancel();
      if (p && typeof (p as unknown as { catch?: unknown }).catch === "function") {
        (p as unknown as { catch: (fn: () => void) => void }).catch(() => {});
      }
    } catch {
      // reader 已释放等，忽略
    }
  };

  const readBody = async (): Promise<string | null> => {
    const reader = response.body?.getReader();
    if (!reader) {
      return response.text();
    }
    activeReader = reader;
    const decoder = new TextDecoder();
    let totalBytes = 0;
    const chunks: string[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel();
          return null;
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
      chunks.push(decoder.decode());
      return chunks.join("");
    } finally {
      reader.releaseLock();
    }
  };

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  let text: string | null;
  try {
    text = await Promise.race([
      readBody(),
      new Promise<string>((_, reject) => {
        timeoutId = setTimeout(() => {
          cancelReader();
          const err = new Error(`RESPONSE_TIMEOUT: body read exceeded ${bodyTimeoutMs}ms`);
          err.name = "TimeoutError";
          reject(err);
        }, bodyTimeoutMs);
      }),
      ...(signal
        ? [
            new Promise<string>((_, reject) => {
              const onAbort = () => {
                // 流式分支：取消 reader 并以 AbortError 结算。无流分支
                // activeReader 为 null，取消无法中断 text()，此处不拒绝，
                // 等待体读取完成或体超时结算（同 api.ts OTV-2）。
                if (activeReader) {
                  cancelReader();
                  const err = new Error("The user aborted a request.");
                  err.name = "AbortError";
                  reject(err);
                }
              };
              removeAbortListener = () => signal.removeEventListener("abort", onAbort);
              signal.addEventListener("abort", onAbort, { once: true });
            }),
          ]
        : []),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (removeAbortListener) removeAbortListener();
  }
  if (text === null) {
    return null;
  }
  // 无流分支事后字节校验：text.length 是 UTF-16 码元数，对多字节文本会低估，
  // 一律按 UTF-8 字节算（与 api.ts / m3u.ts 的 OTV-3 一致）。
  return utf8ByteLength(text) <= maxBytes ? text : null;
}

/**
 * 带体积上限与独立体超时的 JSON 读取：超限抛 RESPONSE_TOO_LARGE，
 * 体超时抛 RESPONSE_TIMEOUT（语义与 api.ts 的 readJsonLimited 一致）。
 */
export async function readJsonWithLimit<T = any>(
  response: Response,
  maxBytes: number,
  bodyTimeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const text = await readTextWithLimit(response, maxBytes, bodyTimeoutMs, signal);
  if (text === null) {
    throw new Error(`RESPONSE_TOO_LARGE: body exceeded ${maxBytes} bytes`);
  }
  if (!text.trim()) return null as unknown as T;
  return JSON.parse(text) as T;
}
