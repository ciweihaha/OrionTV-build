import TcpSocket from 'react-native-tcp-socket';
import NetInfo from '@react-native-community/netinfo';
import { Logger } from '@/utils/Logger';
import { utf8ByteLength } from '@/utils/utf8ByteLength';

const logger = Logger.withTag('TCPHttpServer');

const PORT = 12346;
// 单连接空闲超时（毫秒，L2）：客户端只建连不发完整请求时，30 秒未收全
// 即关闭连接，防慢速连接占位耗尽。
const CONNECTION_IDLE_TIMEOUT_MS = 30_000;
// 并发连接上限（L2）：超限直接拒绝新连接（不进处理流程）。
const MAX_CONNECTIONS = 10;

interface HttpRequest {
  method: string;
  url: string;
  headers: { [key: string]: string };
  body: string;
  // 客户端 IP（L3：配对失败锁定按 IP 分离计数；拿不到时为 undefined，
  // 调用方按 "unknown" 归并处理）
  remoteAddress?: string;
}

interface HttpResponse {
  statusCode: number;
  headers: { [key: string]: string };
  body: string;
}

type RequestHandler = (request: HttpRequest) => HttpResponse | Promise<HttpResponse>;

class TCPHttpServer {
  private server: TcpSocket.Server | null = null;
  private isRunning = false;
  private requestHandler: RequestHandler | null = null;
  // 启动中的 Promise：start() 是异步的，isRunning 只在 listen 回调里才置 true，
  // 两次并发 start() 都会通过 isRunning 检查并各建一个 server（后一个 EADDRINUSE，
  // 且 this.server 会被覆盖导致第一个泄漏）。调用方虽有 guard，这里也防一道。
  private startingPromise: Promise<string> | null = null;
  // 当前活跃连接（L2：并发上限计数，连接关闭时移除）
  private activeSockets = new Set<TcpSocket.Socket>();

  constructor() {
    this.server = null;
  }

  private parseHttpRequest(data: string, remoteAddress?: string): HttpRequest | null {
    try {
      const lines = data.split('\r\n');
      const requestLine = lines[0].split(' ');
      
      if (requestLine.length < 3) {
        return null;
      }

      const method = requestLine[0];
      const url = requestLine[1];
      const headers: { [key: string]: string } = {};
      
      let bodyStartIndex = -1;
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line === '') {
          bodyStartIndex = i + 1;
          break;
        }
        const colonIndex = line.indexOf(':');
        if (colonIndex > 0) {
          const key = line.substring(0, colonIndex).trim().toLowerCase();
          const value = line.substring(colonIndex + 1).trim();
          headers[key] = value;
        }
      }

      const body = bodyStartIndex > 0 ? lines.slice(bodyStartIndex).join('\r\n') : '';

      return { method, url, headers, body, remoteAddress };
    } catch (error) {
      logger.error('[TCPHttpServer] Error parsing HTTP request:', error);
      return null;
    }
  }

  private formatHttpResponse(response: HttpResponse): string {
    const statusTexts: { [key: number]: string } = {
      200: 'OK',
      400: 'Bad Request',
      403: 'Forbidden',
      404: 'Not Found',
      413: 'Payload Too Large',
      500: 'Internal Server Error',
      501: 'Not Implemented'
    };

    const statusText = statusTexts[response.statusCode] || 'Unknown';
    const headers = {
      // 不用 TextEncoder：部分 Hermes 环境没有它，GET / 配对页一打开就抛错，
      // catch 里回 500 又调同一个方法再抛一次、无人接，直接闪退。改走手写计数。
      'Content-Length': utf8ByteLength(response.body).toString(),
      'Connection': 'close',
      ...response.headers
    };

    let httpResponse = `HTTP/1.1 ${response.statusCode} ${statusText}\r\n`;
    
    for (const [key, value] of Object.entries(headers)) {
      httpResponse += `${key}: ${value}\r\n`;
    }
    
    httpResponse += '\r\n';
    httpResponse += response.body;

    return httpResponse;
  }

  /** socket.write 失败（对端已断开等）绝不能抛回 data 回调，否则闪退 */
  private safeWrite(socket: TcpSocket.Socket, text: string): void {
    try {
      socket.write(text);
    } catch (error) {
      logger.error('[TCPHttpServer] Failed to write response:', error);
    }
  }

  /** socket.end 同上，失败只记日志 */
  private safeEnd(socket: TcpSocket.Socket): void {
    try {
      socket.end();
    } catch (error) {
      logger.error('[TCPHttpServer] Failed to end socket:', error);
    }
  }

  public setRequestHandler(handler: RequestHandler) {
    this.requestHandler = handler;
  }

  public async start(): Promise<string> {
    const netState = await NetInfo.fetch();
    let ipAddress: string | null = null;
    
    if (netState.type === 'wifi' || netState.type === 'ethernet') {
      ipAddress = (netState.details as any)?.ipAddress ?? null;
    }

    if (!ipAddress) {
      throw new Error('无法获取IP地址，请确认设备已连接到WiFi或以太网。');
    }

    if (this.isRunning) {
      logger.debug('[TCPHttpServer] Server is already running.');
      return `http://${ipAddress}:${PORT}`;
    }

    // 启动中：返回同一个 Promise，不重复建 server
    if (this.startingPromise) {
      return this.startingPromise;
    }

    this.startingPromise = new Promise((resolve, reject) => {
      try {
        this.server = TcpSocket.createServer((socket: TcpSocket.Socket) => {
          // 并发上限（L2）：超限直接拒绝，不进处理流程、不占计数
          if (this.activeSockets.size >= MAX_CONNECTIONS) {
            logger.error('[TCPHttpServer] Connection limit reached, rejecting new connection');
            this.safeEnd(socket);
            return;
          }
          this.activeSockets.add(socket);
          logger.debug('[TCPHttpServer] Client connected');

          // 单连接空闲超时（L2）：30 秒内没收全请求就关闭，防只建连不发
          // 完整请求的客户端长期占位。收到数据即重置；连接关闭/响应完成
          // 后清理，避免定时器泄漏。
          let idleTimer: ReturnType<typeof setTimeout> | null = null;
          const clearIdleTimer = () => {
            if (idleTimer !== null) {
              clearTimeout(idleTimer);
              idleTimer = null;
            }
          };
          const armIdleTimer = () => {
            clearIdleTimer();
            idleTimer = setTimeout(() => {
              logger.error('[TCPHttpServer] Connection idle timeout, closing');
              this.safeEnd(socket);
            }, CONNECTION_IDLE_TIMEOUT_MS);
          };
          armIdleTimer();
          const remoteAddress = (socket as { remoteAddress?: string }).remoteAddress;
          
          let requestData = '';
          // 请求体上限按 UTF-8 字节算：requestData.length 是 UTF-16 码元数，
          // 中文正文会少算约 3 倍（与 m3u8.ts 的 R16、storage.ts 的 R42 同类问题）
          let requestByteLength = 0;
          // 流式解码器：多字节 UTF-8 字符（中文、emoji）可能被拆到两个 TCP 包，
          // 逐包 toString() 会把拆开的半个字符解成 U+FFFD 乱码；TextDecoder
          // 的 stream 模式会把不完整序列留到下一包再解。
          const decoder = new TextDecoder();

          // 请求体上限 1MB，防恶意客户端无限发送耗尽内存
          const MAX_REQUEST_BYTES = 1024 * 1024;
          socket.on('data', async (data: string | Buffer) => {
            // 整段包 try/catch：data 回调是 async，里面任何未接异常
            // （包括 TextEncoder 缺失、socket 异常）在 Hermes 里都会直接闪退。
            // 此前 TextEncoder 的三处调用都在内层 try 之外，GET / 配对页一打开就崩。
            try {
              const chunk = typeof data === 'string'
                ? data
                : decoder.decode(data, { stream: true });
              requestData += chunk;
              requestByteLength += utf8ByteLength(chunk);
              armIdleTimer();
              if (requestByteLength > MAX_REQUEST_BYTES) {
                logger.error('[TCPHttpServer] Request too large, closing connection');
                clearIdleTimer();
                this.safeEnd(socket);
                requestData = '';
                requestByteLength = 0;
                return;
              }

              // Check if we have a complete HTTP request
              if (requestData.includes('\r\n\r\n')) {
                // 先看 Content-Length：body 可能还在后面的 TCP 包里（手机 fetch
                // 分包发送时），没收全就处理会拿到截断的 JSON，远程输入静默失败
                const headerEndIndex = requestData.indexOf('\r\n\r\n');
                const headerSection = requestData.slice(0, headerEndIndex);
                // chunked 编码本服务不支持解析（只认 Content-Length）：直接回
                // 501，不按 Content-Length 错解析（L2；实现分块解析超出本次范围）
                const transferEncodingMatch = headerSection.match(/transfer-encoding:\s*([^\r\n]*)/i);
                if (transferEncodingMatch && transferEncodingMatch[1].toLowerCase().includes('chunked')) {
                  logger.error('[TCPHttpServer] Chunked transfer encoding not supported, returning 501');
                  this.safeWrite(socket, this.formatHttpResponse({
                    statusCode: 501,
                    headers: { 'Content-Type': 'text/plain' },
                    body: 'Not Implemented: chunked transfer encoding is not supported'
                  }));
                  clearIdleTimer();
                  this.safeEnd(socket);
                  requestData = '';
                  requestByteLength = 0;
                  return;
                }
                const contentLengthMatch = headerSection.match(/content-length:\s*(\d+)/i);
                const contentLength = contentLengthMatch ? parseInt(contentLengthMatch[1], 10) : 0;
                const bodySection = requestData.slice(headerEndIndex + 4);
                if (utf8ByteLength(bodySection) < contentLength) {
                  return; // 等下一个 data 事件把 body 补齐
                }

                try {
                  // 请求已收全：把解码器里残留的不完整序列刷出来（正常情况
                  // 下没有残留——body 字节数已对齐；有残留说明尾部截断，
                  // 按替换字符处理，不静默丢字节）
                  requestData += decoder.decode();
                  const request = this.parseHttpRequest(requestData, remoteAddress);
                  if (request && this.requestHandler) {
                    const response = await this.requestHandler(request);
                    this.safeWrite(socket, this.formatHttpResponse(response));
                  } else {
                    // Send 400 Bad Request for malformed requests
                    this.safeWrite(socket, this.formatHttpResponse({
                      statusCode: 400,
                      headers: { 'Content-Type': 'text/plain' },
                      body: 'Bad Request'
                    }));
                  }
                } catch (error) {
                  logger.error('[TCPHttpServer] Error handling request:', error);
                  // 500 路径再包一层：formatHttpResponse 自身已不再抛错，
                  // 但二次失败也绝不能逃出回调
                  this.safeWrite(socket, this.formatHttpResponse({
                    statusCode: 500,
                    headers: { 'Content-Type': 'text/plain' },
                    body: 'Internal Server Error'
                  }));
                }

                this.safeEnd(socket);
                clearIdleTimer();
                requestData = '';
                requestByteLength = 0;
              }
            } catch (error) {
              logger.error('[TCPHttpServer] Unexpected error in data handler:', error);
              clearIdleTimer();
              this.safeEnd(socket);
              requestData = '';
              requestByteLength = 0;
            }
          });

          socket.on('error', (error: Error) => {
            logger.error('[TCPHttpServer] Socket error:', error);
          });

          socket.on('close', () => {
            clearIdleTimer();
            this.activeSockets.delete(socket);
            logger.debug('[TCPHttpServer] Client disconnected');
          });
        });

        this.server.listen({ port: PORT, host: '0.0.0.0' }, () => {
          logger.debug(`[TCPHttpServer] Server listening on ${ipAddress}:${PORT}`);
          this.isRunning = true;
          this.startingPromise = null;
          resolve(`http://${ipAddress}:${PORT}`);
        });

        this.server.on('error', (error: Error) => {
          logger.error('[TCPHttpServer] Server error:', error);
          // 只在启动阶段才清状态并 reject：listen 成功后触发的 error
          // （如 EMFILE）服务仍在监听，置 isRunning=false 会让 stop() 失效、
          // 下次 start() 报 EADDRINUSE
          if (!this.isRunning) {
            this.isRunning = false;
            this.startingPromise = null;
            reject(error);
          }
        });

      } catch (error) {
        logger.error('[TCPHttpServer] Failed to start server:', error);
        this.startingPromise = null;
        reject(error);
      }
    });
    return this.startingPromise;
  }

  public stop() {
    // 启动中调用 stop：不能是空操作——否则 listen 回调随后仍把服务拉起来。
    // 等启动完成再停（启动失败时 then 不执行，服务本就没起来，无需处理）。
    if (this.startingPromise) {
      this.startingPromise.then(
        () => this.stop(),
        () => { /* 启动失败，服务没起来，不用停 */ }
      );
      return;
    }
    if (this.server && this.isRunning) {
      this.server.close();
      this.server = null;
      this.isRunning = false;
      // 计数只对正在运行的服务实例有效：停掉后清掉，下次启动重新计数
      //（残留连接的空闲定时器仍会在 30 秒内将其关闭，close 回调里删不存在的
      // 成员是空操作，无影响）
      this.activeSockets.clear();
      logger.debug('[TCPHttpServer] Server stopped');
    }
  }

  public getIsRunning(): boolean {
    return this.isRunning;
  }
}

export default TCPHttpServer;