import TCPHttpServer from "./tcpHttpServer";
import * as Crypto from "expo-crypto";
import { Logger } from '@/utils/Logger';

const logger = Logger.withTag('RemoteControl');

// 配对码有效期：服务器每次启动时重新生成
const PAIRING_CODE_LENGTH = 4;

/**
 * 恒定时间字符串比较（L3）：RN 里没有 crypto.timingSafeEqual，不引新依赖，
 * 手写按位比较。固定遍历 max(len) 全长、不提前返回；长度不同时也先按固定
 * 长度比较完再返回 false（长度差混入 diff），避免长度本身泄露比较进度。
 * 注意：JS 引擎优化无法保证严格恒定时间，但配对码只有 4 位数字、且有按 IP
 * 失败锁定兜底，此处防御已足够。
 */
function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    // charCodeAt 越界返回 NaN，`|| 0` 归一为 0，保证两边始终按同一长度比较
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

const getRemotePageHTML = () => {
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <title>OrionTV Remote</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; background-color: #121212; color: white; }
      h3 { color: #eee; }
      #container { display: flex; flex-direction: column; align-items: center; width: 90%; max-width: 400px; }
      #text, #code { width: 100%; padding: 15px; font-size: 16px; border-radius: 8px; border: 1px solid #333; background-color: #2a2a2a; color: white; margin-bottom: 20px; box-sizing: border-box; }
      button { width: 100%; padding: 15px; font-size: 18px; font-weight: bold; border: none; border-radius: 8px; background-color: #007AFF; color: white; cursor: pointer; }
      button:active { background-color: #0056b3; }
      button:disabled { background-color: #444; }
      #pairSection { width: 100%; }
      #inputSection { width: 100%; display: none; flex-direction: column; align-items: center; }
      .hint { color: #888; font-size: 14px; margin-bottom: 20px; text-align: center; }
    </style>
  </head>
  <body>
    <div id="container">
      <div id="pairSection" style="display: block; width: 100%;">
        <h3>配对验证</h3>
        <p class="hint">请输入电视屏幕上显示的 ${PAIRING_CODE_LENGTH} 位配对码</p>
        <input id="code" placeholder="配对码" inputmode="numeric" maxlength="${PAIRING_CODE_LENGTH}" />
        <button onclick="pair()">配对</button>
      </div>
      <div id="inputSection">
        <h3>向电视发送文本</h3>
        <input id="text" placeholder="请输入..." />
        <button onclick="send()">发送</button>
      </div>
    </div>
    <script>
      let pairingCode = "";
      // 已配对过的浏览器直接进输入页：服务端每次都返回配对页（它不知道浏览器状态），
      // 由前端从 sessionStorage 恢复上次配对成功的码
      const savedCode = sessionStorage.getItem("orion_pair_code");
      if (savedCode) {
        pairingCode = savedCode;
        document.getElementById("pairSection").style.display = "none";
        document.getElementById("inputSection").style.display = "flex";
      }
      function pair() {
        const input = document.getElementById("code");
        const code = input.value.trim();
        if (!code) return;
        fetch('/handshake', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Pairing-Code': code },
          body: JSON.stringify({})
        }).then(r => {
          if (r.ok) {
            pairingCode = code;
            sessionStorage.setItem("orion_pair_code", code);
            document.getElementById("pairSection").style.display = "none";
            document.getElementById("inputSection").style.display = "flex";
          } else {
            alert("配对码错误，请重试");
          }
        }).catch(err => console.warn('Pair failed:', err));
      }
      function send() {
        const input = document.getElementById("text");
        const value = input.value;
        if (value) {
          fetch("/message", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Pairing-Code': pairingCode },
            body: JSON.stringify({ message: value })
          })
          .then(r => {
            if (!r.ok) {
              // 配对码已失效（电视重启后配对码会变）：清掉旧码，回到配对页重配，
              // 否则用户会一直停在输入页、消息悄悄被拒
              sessionStorage.removeItem("orion_pair_code");
              pairingCode = "";
              document.getElementById("pairSection").style.display = "block";
              document.getElementById("inputSection").style.display = "none";
              alert("配对已失效，请重新输入配对码");
            } else {
              // 只有发送成功才清空输入框：失败时留着文字，用户重配后能直接再发
              input.value = '';
            }
          })
          .catch(err => console.warn('Message send failed:', err));
        }
      }
    </script>
  </body>
  </html>
  `;
};

class RemoteControlService {
  private httpServer: TCPHttpServer;
  private onMessage: (message: string) => void = () => {};
  private onHandshake: () => void = () => {};
  // 配对码：每次启动服务器时重新生成，防止局域网未授权访问
  private pairingCode: string = "";
  /** 防暴力破解：同一 IP 连续失败 5 次后锁定该 IP 60 秒（L3：按客户端 IP
   * 分离计数——原先是全局计数，攻击者故意输错 5 次就能锁住合法用户） */
  private static readonly MAX_PAIRING_ATTEMPTS = 5;
  private static readonly PAIRING_LOCKOUT_MS = 60_000;
  // 跟踪的 IP 条目上限：超过时清理已过期锁定的条目，防扫描导致 Map 无限增长
  private static readonly MAX_TRACKED_IPS = 100;
  private pairingAttemptsByIp = new Map<string, { failures: number; lockoutUntil: number }>();

  constructor() {
    this.httpServer = new TCPHttpServer();
    this.setupRequestHandler();
  }

  private generatePairingCode(): string {
    // 安全：配对码是局域网访问凭证，必须用密码学安全随机数；
    // Math.random() 可预测（xorshift128+），此处禁用。
    // 拒绝采样：丢弃 250-255，消除 %10 的模偏差
    let code = "";
    while (code.length < PAIRING_CODE_LENGTH) {
      const bytes = Crypto.getRandomBytes(PAIRING_CODE_LENGTH * 2);
      for (let i = 0; i < bytes.length && code.length < PAIRING_CODE_LENGTH; i++) {
        const b = bytes[i];
        if (b < 250) {
          code += (b % 10).toString();
        }
      }
    }
    return code;
  }

  /** 获取当前配对码（供 TV 界面显示） */
  public getPairingCode(): string {
    return this.pairingCode;
  }

  private isPairingValid(request: { headers?: Record<string, string>; remoteAddress?: string }): boolean {
    // 按客户端 IP 分离计数：拿不到 IP 时归并到 "unknown"（正常情况下 TCP 层
    // 总能拿到对端地址，见 tcpHttpServer 的 remoteAddress）
    const clientIp = request.remoteAddress || "unknown";
    const now = Date.now();
    let state = this.pairingAttemptsByIp.get(clientIp);
    if (state) {
      // 锁定期内直接拒绝，不做比较（防计时/枚举）
      if (now < state.lockoutUntil) {
        return false;
      }
      // 锁定已过期且无待计失败：条目已无用，删掉防 Map 无限增长
      if (state.failures === 0) {
        this.pairingAttemptsByIp.delete(clientIp);
        state = undefined;
      }
    }
    const headers = request.headers || {};
    // 头部名做大小写不敏感匹配
    const code = headers["x-pairing-code"] || headers["X-Pairing-Code"] || "";
    // 恒定时间比较（L3）：配对码为空（服务未启动）时直接判无效，不比较
    const valid = this.pairingCode !== "" && timingSafeEqual(code, this.pairingCode);
    if (valid) {
      this.pairingAttemptsByIp.delete(clientIp);
    } else {
      const failures = (state?.failures ?? 0) + 1;
      if (failures >= RemoteControlService.MAX_PAIRING_ATTEMPTS) {
        this.pairingAttemptsByIp.set(clientIp, {
          failures: 0,
          lockoutUntil: now + RemoteControlService.PAIRING_LOCKOUT_MS,
        });
        logger.info(`[RemoteControl] Pairing locked out for ${clientIp} for 60s after repeated failures`);
      } else {
        this.pairingAttemptsByIp.set(clientIp, { failures, lockoutUntil: 0 });
      }
      // 偶发清理：IP 条目过多时清掉已过期锁定的，避免扫描导致 Map 无限增长
      if (this.pairingAttemptsByIp.size > RemoteControlService.MAX_TRACKED_IPS) {
        for (const [ip, s] of this.pairingAttemptsByIp) {
          if (s.failures === 0 && now >= s.lockoutUntil) {
            this.pairingAttemptsByIp.delete(ip);
          }
        }
      }
    }
    return valid;
  }

  private setupRequestHandler() {
    this.httpServer.setRequestHandler((request) => {
      logger.debug("[RemoteControl] Received request:", request.method, request.url);

      try {
        if (request.method === "GET" && request.url === "/") {
          // 已配对过的浏览器（sessionStorage 有码）直接进输入页，否则显示配对页
          // 服务端无法知道浏览器状态，统一返回配对页，由前端 sessionStorage 决定
          return {
            statusCode: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
            body: getRemotePageHTML(),
          };
        } else if (request.method === "POST" && request.url === "/message") {
          if (!this.isPairingValid(request)) {
            return {
              statusCode: 403,
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ error: "Invalid pairing code" }),
            };
          }
          try {
            const parsedBody = JSON.parse(request.body || "{}");
            const message = parsedBody.message;
            // 消息长度上限：远程键盘输入文本，10KB 已远超正常使用（R13）
            const MAX_MESSAGE_LENGTH = 10 * 1024;
            if (typeof message === "string" && message.length > 0) {
              if (message.length > MAX_MESSAGE_LENGTH) {
                logger.info(`[RemoteControl] Message too long (${message.length} chars), rejected`);
                return {
                  statusCode: 413,
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ error: "Message too long" }),
                };
              }
              this.onMessage(message);
            }
            return {
              statusCode: 200,
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status: "ok" }),
            };
          } catch (parseError) {
            logger.info("[RemoteControl] Failed to parse message body:", parseError);
            return {
              statusCode: 400,
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ error: "Invalid JSON" }),
            };
          }
        } else if (request.method === "POST" && request.url === "/handshake") {
          if (!this.isPairingValid(request)) {
            return {
              statusCode: 403,
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ error: "Invalid pairing code" }),
            };
          }
          this.onHandshake();
          return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "ok" }),
          };
        } else {
          return {
            statusCode: 404,
            headers: { "Content-Type": "text/plain" },
            body: "Not Found",
          };
        }
      } catch (error) {
        logger.info("[RemoteControl] Request handler error:", error);
        return {
          statusCode: 500,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Internal Server Error" }),
        };
      }
    });
  }

  public init(actions: { onMessage: (message: string) => void; onHandshake: () => void }) {
    this.onMessage = actions.onMessage;
    this.onHandshake = actions.onHandshake;
  }

  public async startServer(): Promise<string> {
    logger.debug("[RemoteControl] Attempting to start server...");

    try {
      // 每次启动生成新的配对码
      this.pairingCode = this.generatePairingCode();
      this.pairingAttemptsByIp.clear();
      logger.debug(`[RemoteControl] Pairing code generated`);
      const url = await this.httpServer.start();
      logger.debug(`[RemoteControl] Server started successfully at: ${url}`);
      return url;
    } catch (error) {
      logger.info("[RemoteControl] Failed to start server:", error);
      throw new Error(error instanceof Error ? error.message : "Failed to start server");
    }
  }

  public stopServer() {
    logger.debug("[RemoteControl] Stopping server...");
    this.pairingCode = "";
    this.httpServer.stop();
  }

  public isRunning(): boolean {
    return this.httpServer.getIsRunning();
  }
}

export const remoteControlService = new RemoteControlService();
