// 远程输入服务端响应写回回归测试（v1.7.12）：
// 2026-11-19 上午平板实测：POST /message、POST /handshake 一律收不到 HTTP
// 响应（curl 000 / fetch 挂起），手机配对页一直转圈；但服务端 handler
// 本身已跑完——消息确实落进了输入框。根因在 tcpHttpServer：
// safeWrite(response) 后立刻 safeEnd()，而 react-native-tcp-socket 的
// write 是异步桥接（'written' 回调才算写完），无参 end() 则立即发 FIN，
// FIN 常抢在写回之前，响应就丢了。修法：响应体直接交给 end(data)
// （库内先 write、等 'written' 再发 FIN），write + 无参 end 不再成对出现。
// 另：上午还观察到“每启动约 1 个请求后不再响应”，本测试覆盖连续两个连接
// 各得一次完整响应（若服务端只处理首个连接即回归）。

import TCPHttpServer from "../tcpHttpServer";

jest.mock("@/utils/Logger", () => {
  const stub = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const mockLogger = { withTag: () => stub };
  return { __esModule: true, default: mockLogger, Logger: mockLogger };
});

jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: {
    fetch: jest.fn(async () => ({
      type: "wifi",
      details: { ipAddress: "192.168.1.23" },
    })),
  },
}));

/** 假 socket：只实现 tcpHttpServer 用到的那几个方法 */
class FakeSocket {
  handlers = new Map<string, ((...args: any[]) => void)[]>();
  remoteAddress = "192.168.1.7";
  write = jest.fn();
  end = jest.fn();
  destroy = jest.fn();

  on(event: string, cb: (...args: any[]) => void) {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
    return this;
  }

  emit(event: string, ...args: any[]) {
    for (const cb of this.handlers.get(event) ?? []) {
      cb(...args);
    }
  }
}

type ConnectionHandler = (socket: FakeSocket) => void;

const mockCreateServer = jest.fn();
const mockListen = jest.fn((_opts: any, cb: () => void) => {
  cb();
});
const mockServerOn = jest.fn();
const mockServerClose = jest.fn();

jest.mock("react-native-tcp-socket", () => ({
  __esModule: true,
  default: {
    createServer: (...args: any[]) => mockCreateServer(...args),
  },
}));

const flush = async () => {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

describe("TCPHttpServer 响应写回", () => {
  let server: TCPHttpServer;
  let connectionHandler: ConnectionHandler;
  let sockets: FakeSocket[];

  beforeEach(() => {
    jest.clearAllMocks();
    sockets = [];
    mockCreateServer.mockImplementation((handler: ConnectionHandler) => {
      connectionHandler = handler;
      return {
        listen: mockListen,
        on: mockServerOn,
        close: mockServerClose,
      };
    });
    server = new TCPHttpServer();
    // 返回类型显式标注：不标注时各分支对象字面量会被推断成联合类型，
    // 其中 headers: {} 的分支会让 "Content-Type" 变成可选 undefined，
    // 与 HttpResponse 的索引签名冲突（tsc TS2345）。
    type TestResponse = {
      statusCode: number;
      headers: { [key: string]: string };
      body: string;
    };
    server.setRequestHandler(async (req): Promise<TestResponse> => {
      if (req.method === "GET" && req.url === "/") {
        return {
          statusCode: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
          body: "ok",
        };
      }
      if (req.method === "POST" && req.url === "/message") {
        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "ok" }),
        };
      }
      return { statusCode: 404, headers: {}, body: "Not Found" };
    });
  });

  afterEach(() => {
    // 关掉每个假连接（触发服务端 close 处理，清掉 30 秒空闲定时器，
    // 否则 jest 进程会被挂起的定时器拖住不退出）
    for (const s of sockets) {
      s.emit("close");
    }
    server.stop();
  });

  const connect = async () => {
    const url = await server.start();
    expect(url).toBe("http://192.168.1.23:12346");
    const socket = new FakeSocket();
    sockets.push(socket);
    connectionHandler(socket);
    return socket;
  };

  it("GET /：响应经 end(data) 一次写回，write 不被调用", async () => {
    const socket = await connect();
    socket.emit(
      "data",
      "GET / HTTP/1.1\r\nHost: 192.168.1.23:12346\r\nConnection: close\r\n\r\n",
    );
    await flush();

    expect(socket.write).not.toHaveBeenCalled();
    expect(socket.end).toHaveBeenCalledTimes(1);
    const sent = socket.end.mock.calls[0][0] as string;
    expect(sent.startsWith("HTTP/1.1 200 OK\r\n")).toBe(true);
    expect(sent).toContain("Content-Length: 2\r\n");
    expect(sent).toContain("Connection: close\r\n");
    expect(sent.endsWith("\r\n\r\nok")).toBe(true);
  });

  it("连续两个连接各得一次完整响应（回归：只处理首个请求）", async () => {
    const first = await connect();
    first.emit(
      "data",
      "GET / HTTP/1.1\r\nHost: 192.168.1.23:12346\r\n\r\n",
    );
    await flush();
    expect(first.end).toHaveBeenCalledTimes(1);
    expect((first.end.mock.calls[0][0] as string).startsWith("HTTP/1.1 200 OK")).toBe(true);

    const second = new FakeSocket();
    sockets.push(second);
    connectionHandler(second);
    second.emit(
      "data",
      "GET / HTTP/1.1\r\nHost: 192.168.1.23:12346\r\n\r\n",
    );
    await flush();

    expect(second.write).not.toHaveBeenCalled();
    expect(second.end).toHaveBeenCalledTimes(1);
    expect((second.end.mock.calls[0][0] as string).startsWith("HTTP/1.1 200 OK")).toBe(true);
  });

  it("POST /message：body 分两包到达时收全才处理，响应一次写回", async () => {
    const socket = await connect();
    const body = JSON.stringify({ message: "HELLO123" });
    socket.emit(
      "data",
      `POST /message HTTP/1.1\r\nHost: 192.168.1.23:12346\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n{"message":"HE`,
    );
    await flush();
    // body 没收全：还没响应
    expect(socket.end).not.toHaveBeenCalled();

    socket.emit("data", `LLO123"}`);
    await flush();

    expect(socket.write).not.toHaveBeenCalled();
    expect(socket.end).toHaveBeenCalledTimes(1);
    const sent = socket.end.mock.calls[0][0] as string;
    expect(sent.startsWith("HTTP/1.1 200 OK\r\n")).toBe(true);
    expect(sent).toContain('{"status":"ok"}');
  });

  it("start 后 stop 能真正停掉服务（同步 listen 回调下不死循环）", async () => {
    // 回归：mock 的 listen 同步调 cb，回调里的 startingPromise=null
    // 会被 start() 的赋值覆盖回来；旧 stop() 看到已结算的非空 promise
    // 就无限自调度（微任务死循环，jest 挂死、连超时都不触发）。
    const socket = await connect();
    expect(server.getIsRunning()).toBe(true);
    server.stop();
    expect(server.getIsRunning()).toBe(false);
    expect(mockServerClose).toHaveBeenCalledTimes(1);
    socket.emit("close");
  });

  it("chunked 请求回 501，同样经 end(data) 一次写回", async () => {
    const socket = await connect();
    socket.emit(
      "data",
      "POST /message HTTP/1.1\r\nHost: 192.168.1.23:12346\r\nTransfer-Encoding: chunked\r\n\r\n",
    );
    await flush();

    expect(socket.write).not.toHaveBeenCalled();
    expect(socket.end).toHaveBeenCalledTimes(1);
    const sent = socket.end.mock.calls[0][0] as string;
    expect(sent.startsWith("HTTP/1.1 501 Not Implemented\r\n")).toBe(true);
    expect(sent).toContain("chunked transfer encoding is not supported");
  });
});
