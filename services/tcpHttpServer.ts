import TcpSocket from 'react-native-tcp-socket';
import NetInfo from '@react-native-community/netinfo';
import { Logger } from '@/utils/Logger';
import { utf8ByteLength } from '@/utils/utf8ByteLength';

const logger = Logger.withTag('TCPHttpServer');

const PORT = 12346;

interface HttpRequest {
  method: string;
  url: string;
  headers: { [key: string]: string };
  body: string;
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

  constructor() {
    this.server = null;
  }

  private parseHttpRequest(data: string): HttpRequest | null {
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

      return { method, url, headers, body };
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
      500: 'Internal Server Error'
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

    return new Promise((resolve, reject) => {
      try {
        this.server = TcpSocket.createServer((socket: TcpSocket.Socket) => {
          logger.debug('[TCPHttpServer] Client connected');
          
          let requestData = '';
          // 请求体上限按 UTF-8 字节算：requestData.length 是 UTF-16 码元数，
          // 中文正文会少算约 3 倍（与 m3u8.ts 的 R16、storage.ts 的 R42 同类问题）
          let requestByteLength = 0;

          // 请求体上限 1MB，防恶意客户端无限发送耗尽内存
          const MAX_REQUEST_BYTES = 1024 * 1024;
          socket.on('data', async (data: string | Buffer) => {
            // 整段包 try/catch：data 回调是 async，里面任何未接异常
            // （包括 TextEncoder 缺失、socket 异常）在 Hermes 里都会直接闪退。
            // 此前 TextEncoder 的三处调用都在内层 try 之外，GET / 配对页一打开就崩。
            try {
              const chunk = data.toString();
              requestData += chunk;
              requestByteLength += utf8ByteLength(chunk);
              if (requestByteLength > MAX_REQUEST_BYTES) {
                logger.error('[TCPHttpServer] Request too large, closing connection');
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
                const contentLengthMatch = headerSection.match(/content-length:\s*(\d+)/i);
                const contentLength = contentLengthMatch ? parseInt(contentLengthMatch[1], 10) : 0;
                const bodySection = requestData.slice(headerEndIndex + 4);
                if (utf8ByteLength(bodySection) < contentLength) {
                  return; // 等下一个 data 事件把 body 补齐
                }

                try {
                  const request = this.parseHttpRequest(requestData);
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
                requestData = '';
                requestByteLength = 0;
              }
            } catch (error) {
              logger.error('[TCPHttpServer] Unexpected error in data handler:', error);
              this.safeEnd(socket);
              requestData = '';
              requestByteLength = 0;
            }
          });

          socket.on('error', (error: Error) => {
            logger.error('[TCPHttpServer] Socket error:', error);
          });

          socket.on('close', () => {
            logger.debug('[TCPHttpServer] Client disconnected');
          });
        });

        this.server.listen({ port: PORT, host: '0.0.0.0' }, () => {
          logger.debug(`[TCPHttpServer] Server listening on ${ipAddress}:${PORT}`);
          this.isRunning = true;
          resolve(`http://${ipAddress}:${PORT}`);
        });

        this.server.on('error', (error: Error) => {
          logger.error('[TCPHttpServer] Server error:', error);
          this.isRunning = false;
          reject(error);
        });

      } catch (error) {
        logger.error('[TCPHttpServer] Failed to start server:', error);
        reject(error);
      }
    });
  }

  public stop() {
    if (this.server && this.isRunning) {
      this.server.close();
      this.server = null;
      this.isRunning = false;
      logger.debug('[TCPHttpServer] Server stopped');
    }
  }

  public getIsRunning(): boolean {
    return this.isRunning;
  }
}

export default TCPHttpServer;