/**
 * 统一日志管理器
 * 开发环境：console 输出完整日志（级别可配）。
 * 生产环境：不接任何崩溃上报服务（无 DSN、不引新依赖），warn/error 落盘到
 * 本地轮转日志文件（缓存目录 oriontv.log，200KB 上限，超了截断保留最新
 * 部分；debug/info 仍不输出）。取回方式见 docs/security-notes.md。
 */

import { File, Paths } from "expo-file-system";
import { utf8ByteLength } from "./utf8ByteLength";

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

interface LoggerOptions {
  tag?: string;
  level?: LogLevel;
}

// 日志级别全局共享：withTag 产生的新实例也要受 setMinLevel 控制
//（原来 minLevel 是实例字段，调 setMinLevel 只改根实例，各模块的
// tagged logger 各自一份旧值，级别过滤等于失效）
let sharedMinLevel: LogLevel = LogLevel.DEBUG;

// ---------- 生产环境本地日志落盘（L17） ----------
// 日志文件：应用缓存目录下的 oriontv.log（Paths.cache）。
// 轮转策略：内存里只保留最近若干行（行数与字节双上限），每次落盘整文件
// 覆盖写，超限时丢掉最旧的行、保留最新部分。
const LOG_FILE_NAME = "oriontv.log";
const MAX_LOG_FILE_BYTES = 200 * 1024;
const MAX_LOG_LINES = 500;

let fileLogLines: string[] = [];
let fileLogBytes = 0;
// 首次落盘时是否已从磁盘读回上次残留的日志（保证跨重启不断档）
let fileLogSeeded = false;
// 串行落盘队列：File.write 是整文件覆盖，并发写会互相丢数据
let fileLogChain: Promise<void> = Promise.resolve();

function trimFileLogLines(): void {
  while (
    fileLogLines.length > 1 &&
    (fileLogLines.length > MAX_LOG_LINES || fileLogBytes > MAX_LOG_FILE_BYTES)
  ) {
    const dropped = fileLogLines.shift();
    if (dropped !== undefined) {
      fileLogBytes -= utf8ByteLength(dropped) + 1;
    }
  }
}

function serializeLogArg(value: any): string {
  if (value instanceof Error) {
    // 错误堆栈是生产定位的关键，落盘时一并保留
    return value.stack || `${value.name}: ${value.message}`;
  }
  if (typeof value === "string") return value;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

function formatFileLine(level: string, tag: string | undefined, message: any, args: any[]): string {
  const timestamp = new Date().toISOString();
  const prefix = tag ? `[${timestamp}][${level}][${tag}]` : `[${timestamp}][${level}]`;
  const parts = [serializeLogArg(message), ...args.map(serializeLogArg)].filter((p) => p !== "");
  return `${prefix} ${parts.join(" ")}`;
}

async function flushFileLog(): Promise<void> {
  try {
    const file = new File(Paths.cache, LOG_FILE_NAME);
    if (!fileLogSeeded) {
      fileLogSeeded = true;
      try {
        if (file.exists) {
          const prev = await file.text();
          if (prev) {
            fileLogLines = [...prev.split("\n"), ...fileLogLines];
            fileLogBytes = utf8ByteLength(fileLogLines.join("\n"));
            trimFileLogLines();
          }
        }
      } catch {
        // 读不到旧日志就从空开始，不影响本次落盘
      }
    }
    await file.write(fileLogLines.join("\n"));
  } catch {
    // 落盘失败静默：日志通道绝不能反过来影响业务逻辑
  }
}

function appendToFileLog(line: string): void {
  fileLogLines.push(line);
  fileLogBytes += utf8ByteLength(line) + 1;
  trimFileLogLines();
  fileLogChain = fileLogChain.then(flushFileLog).catch(() => {
    // flushFileLog 内部已吞错；这里只防链本身断裂
  });
}

class LoggerClass {
  /**
   * 设置最小日志级别
   */
  setMinLevel(level: LogLevel): void {
    if (__DEV__) {
      sharedMinLevel = level;
    }
  }

  /**
   * 格式化日志输出
   */
  private formatMessage(level: string, tag: string | undefined, message: any, ...args: any[]): void {
    if (!__DEV__) return;

    const timestamp = new Date().toISOString().substr(11, 12);
    const prefix = tag ? `[${timestamp}][${level}][${tag}]` : `[${timestamp}][${level}]`;
    
    switch (level) {
      case 'DEBUG':
        console.log(prefix, message, ...args);
        break;
      case 'INFO':
        console.info(prefix, message, ...args);
        break;
      case 'WARN':
        console.warn(prefix, message, ...args);
        break;
      case 'ERROR':
        console.error(prefix, message, ...args);
        break;
    }
  }

  /**
   * 调试级别日志
   */
  debug(message: any, ...args: any[]): void;
  debug(options: LoggerOptions, message: any, ...args: any[]): void;
  debug(optionsOrMessage: LoggerOptions | any, message?: any, ...args: any[]): void {
    if (!__DEV__) return;

    if (sharedMinLevel > LogLevel.DEBUG) return;

    if (optionsOrMessage !== null && typeof optionsOrMessage === 'object' && optionsOrMessage.tag !== undefined) {
      const options = optionsOrMessage as LoggerOptions;
      this.formatMessage('DEBUG', options.tag, message, ...args);
    } else {
      this.formatMessage('DEBUG', undefined, optionsOrMessage, message, ...args);
    }
  }

  /**
   * 信息级别日志
   */
  info(message: any, ...args: any[]): void;
  info(options: LoggerOptions, message: any, ...args: any[]): void;
  info(optionsOrMessage: LoggerOptions | any, message?: any, ...args: any[]): void {
    if (!__DEV__) return;

    if (sharedMinLevel > LogLevel.INFO) return;

    if (optionsOrMessage !== null && typeof optionsOrMessage === 'object' && optionsOrMessage.tag !== undefined) {
      const options = optionsOrMessage as LoggerOptions;
      this.formatMessage('INFO', options.tag, message, ...args);
    } else {
      this.formatMessage('INFO', undefined, optionsOrMessage, message, ...args);
    }
  }

  /**
   * 统一解析重载调用：withTag 传 { tag } 作首参，直接调用时首参就是消息。
   * 返回 { tag, message, args }，供开发 console 与生产落盘共用。
   */
  private parseCall(
    optionsOrMessage: LoggerOptions | any,
    message: any,
    args: any[],
  ): { tag: string | undefined; message: any; args: any[] } {
    if (
      typeof optionsOrMessage === "object" &&
      optionsOrMessage !== null &&
      optionsOrMessage.tag !== undefined
    ) {
      return { tag: (optionsOrMessage as LoggerOptions).tag, message, args };
    }
    // 直接调用：message 是第二个实参；只传一个实参时 message 为 undefined，不塞进 args
    return {
      tag: undefined,
      message: optionsOrMessage,
      args: message === undefined ? args : [message, ...args],
    };
  }

  /**
   * 警告级别日志
   */
  warn(message: any, ...args: any[]): void;
  warn(options: LoggerOptions, message: any, ...args: any[]): void;
  warn(optionsOrMessage: LoggerOptions | any, message?: any, ...args: any[]): void {
    if (!__DEV__) {
      // 生产环境：warn 落盘到本地轮转日志（L17，固定 warn+error，不受
      // setMinLevel 影响）；开发环境的现有行为不要变，见下面分支
      const call = this.parseCall(optionsOrMessage, message, args);
      appendToFileLog(formatFileLine("WARN", call.tag, call.message, call.args));
      return;
    }

    if (sharedMinLevel > LogLevel.WARN) return;

    if (optionsOrMessage !== null && typeof optionsOrMessage === 'object' && optionsOrMessage.tag !== undefined) {
      const options = optionsOrMessage as LoggerOptions;
      this.formatMessage('WARN', options.tag, message, ...args);
    } else {
      this.formatMessage('WARN', undefined, optionsOrMessage, message, ...args);
    }
  }

  /**
   * 错误级别日志
   */
  error(message: any, ...args: any[]): void;
  error(options: LoggerOptions, message: any, ...args: any[]): void;
  error(optionsOrMessage: LoggerOptions | any, message?: any, ...args: any[]): void {
    if (!__DEV__) {
      // 生产环境：error 落盘到本地轮转日志（L17），同 warn
      const call = this.parseCall(optionsOrMessage, message, args);
      appendToFileLog(formatFileLine("ERROR", call.tag, call.message, call.args));
      return;
    }

    if (sharedMinLevel > LogLevel.ERROR) return;

    if (optionsOrMessage !== null && typeof optionsOrMessage === 'object' && optionsOrMessage.tag !== undefined) {
      const options = optionsOrMessage as LoggerOptions;
      this.formatMessage('ERROR', options.tag, message, ...args);
    } else {
      this.formatMessage('ERROR', undefined, optionsOrMessage, message, ...args);
    }
  }

  /**
   * 创建带标签的日志实例
   */
  withTag(tag: string): LoggerClass {
    const taggedLogger = new LoggerClass();
    
    const originalDebug = taggedLogger.debug.bind(taggedLogger);
    const originalInfo = taggedLogger.info.bind(taggedLogger);
    const originalWarn = taggedLogger.warn.bind(taggedLogger);
    const originalError = taggedLogger.error.bind(taggedLogger);

    taggedLogger.debug = (message: any, ...args: any[]) => originalDebug({ tag }, message, ...args);
    taggedLogger.info = (message: any, ...args: any[]) => originalInfo({ tag }, message, ...args);
    taggedLogger.warn = (message: any, ...args: any[]) => originalWarn({ tag }, message, ...args);
    taggedLogger.error = (message: any, ...args: any[]) => originalError({ tag }, message, ...args);

    return taggedLogger;
  }
}

export const Logger = new LoggerClass();
export default Logger;