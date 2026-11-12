import { createHash } from "crypto";
import updateService from "../updateService";

/**
 * sha256OfFile 标准向量测试：
 * 自写 SHA256 曾因 base64 填充未扣 + 最终块长度字段位置错误而算错
 * （仅空输入碰巧匹配）。这里用 node crypto 作参考实现逐一对比。
 */

const mockFiles = new Map<string, Uint8Array>();

/**
 * expo-file-system 58 新 API 的最小 mock：File/Directory/Paths 类，
 * 由 mockFiles 驱动（与旧版 mock 同一份内存文件表）。
 * 注意：类必须定义在 jest.mock 工厂内部——工厂在 updateService 被 import 时
 * 就执行，此时模块顶层的 class 声明尚未求值（写在外面会报 not a constructor）。
 */
jest.mock("expo-file-system", () => {
  class mockFile {
    static downloadFileAsync = jest.fn();
    static createDownloadTask = jest.fn();
    uri: string;
    constructor(...uris: any[]) {
      this.uri = uris
        .map((u: any) => (typeof u === "string" ? u : u.uri))
        .join("");
    }
    get exists(): boolean {
      return mockFiles.has(this.uri);
    }
    info() {
      const data = mockFiles.get(this.uri);
      return data
        ? { exists: true, size: data.length, uri: this.uri }
        : { exists: false };
    }
    delete() {
      mockFiles.delete(this.uri);
    }
    // 模拟真实 readableStream 的 1KB 分块读取
    readableStream() {
      const data = mockFiles.get(this.uri) ?? new Uint8Array(0);
      let offset = 0;
      return {
        getReader: () => ({
          read: async () => {
            if (offset >= data.length) return { done: true, value: undefined };
            const chunk = data.subarray(offset, Math.min(offset + 1024, data.length));
            offset += chunk.length;
            return { done: false, value: chunk };
          },
          releaseLock: () => {},
        }),
      };
    }
    async text() {
      return new TextDecoder().decode(mockFiles.get(this.uri) ?? new Uint8Array(0));
    }
    async base64() {
      return Buffer.from(mockFiles.get(this.uri) ?? new Uint8Array(0)).toString("base64");
    }
    async bytes() {
      return mockFiles.get(this.uri) ?? new Uint8Array(0);
    }
  }

  class mockDirectory {
    uri: string;
    constructor(...uris: any[]) {
      this.uri = uris
        .map((u: any) => (typeof u === "string" ? u : u.uri))
        .join("");
    }
    list() {
      return [];
    }
  }

  return {
    File: mockFile,
    Directory: mockDirectory,
    Paths: { document: new mockDirectory("file:///docs/") },
  };
});

// installApk 用的取 content:// URI 仍走 legacy 子包
jest.mock("expo-file-system/legacy", () => ({
  getContentUriAsync: jest.fn(async (uri: string) => uri),
}));

jest.mock("expo-intent-launcher", () => ({
  startActivityAsync: jest.fn(async () => undefined),
}));

jest.mock("react-native-toast-message", () => ({
  __esModule: true,
  default: { show: jest.fn() },
}));

jest.mock("react-native", () => ({
  Platform: { OS: "android" },
}));

jest.mock(
  "@/utils/Logger",
  () => {
    const loggerStub = {
      withTag: () => ({
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
    };
    return { __esModule: true, default: loggerStub, Logger: loggerStub };
  },
  { virtual: true }
);

function patternBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    b[i] = (i * 31 + 7) % 256;
  }
  return b;
}

function pseudoRandomBytes(n: number, seed: number): Uint8Array {
  let s = seed >>> 0;
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    b[i] = s % 256;
  }
  return b;
}

function referenceSha256(data: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(data)).digest("hex");
}

describe("UpdateService.sha256OfFile 标准向量", () => {
  const cases: [string, Uint8Array][] = [
    ["空输入", new Uint8Array(0)],
    ["abc", new TextEncoder().encode("abc")],
    ["55 字节（单块填充边界内）", patternBytes(55)],
    ["56 字节（填充溢出成两块）", patternBytes(56)],
    ["64 字节（整块）", patternBytes(64)],
    ["1MB（分块读取整边界）", pseudoRandomBytes(1024 * 1024, 42)],
    ["2MB+55（多块 + 尾块 55）", pseudoRandomBytes(2 * 1024 * 1024 + 55, 1337)],
  ];

  it.each(cases)("%s：与参考实现一致", async (_name, data) => {
    const uri = `file:///docs/vector-${data.length}-${_name.length}.bin`;
    mockFiles.set(uri, data);
    const actual = await (updateService as any).sha256OfFile(uri);
    expect(actual).toBe(referenceSha256(data));
    mockFiles.delete(uri);
  });

  it("已知答案：abc 的 SHA256 等于公开标准值", async () => {
    const uri = "file:///docs/vector-abc.bin";
    mockFiles.set(uri, new TextEncoder().encode("abc"));
    const actual = await (updateService as any).sha256OfFile(uri);
    expect(actual).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    mockFiles.delete(uri);
  });

  it("已知答案：空输入的 SHA256 等于公开标准值", async () => {
    const uri = "file:///docs/vector-empty.bin";
    mockFiles.set(uri, new Uint8Array(0));
    const actual = await (updateService as any).sha256OfFile(uri);
    expect(actual).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    mockFiles.delete(uri);
  });
});

function mockFetchResponse(status: number, textBody: string, contentLength?: string) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => (name === "content-length" ? contentLength ?? null : null) },
    body: undefined,
    text: async () => textBody,
  } as unknown as Response;
}

describe("UpdateService.checkVersion 确定性错误不重试（第 4 轮）", () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("版本文件缺 version 字段：一次即抛，不重试 3 次", async () => {
    fetchMock.mockResolvedValue(mockFetchResponse(200, JSON.stringify({ name: "OrionTV" })));
    await expect(updateService.checkVersion()).rejects.toThrow("Invalid version info from server");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("4xx 不重试：一次 404 直接抛", async () => {
    fetchMock.mockResolvedValue(mockFetchResponse(404, "not found"));
    await expect(updateService.checkVersion()).rejects.toThrow("HTTP 404");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("UpdateService.verifyApkSha256 与 assertApkSizeAcceptable（第 4 轮）", () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it(".sha256 超过 4KB：fail-closed 抛错，不继续校验", async () => {
    fetchMock.mockResolvedValue(mockFetchResponse(200, "x".repeat(5000)));
    await expect(
      (updateService as any).verifyApkSha256("file:///docs/test.apk", "https://example.com/app")
    ).rejects.toThrow("SHA256: cannot obtain expected hash");
  });

  it("HEAD 预检失败（网络错误）：放行，不中止下载", async () => {
    fetchMock.mockRejectedValue(new Error("Network request failed"));
    await expect(
      (updateService as any).assertApkSizeAcceptable("https://example.com/app.apk")
    ).resolves.toBeUndefined();
  });

  it("HEAD 预检失败（超时中止）：放行", async () => {
    const err = new Error("The user aborted a request.");
    err.name = "AbortError";
    fetchMock.mockRejectedValue(err);
    await expect(
      (updateService as any).assertApkSizeAcceptable("https://example.com/app.apk")
    ).resolves.toBeUndefined();
  });

  it("HEAD 声明体积超限：仍抛 APK_TOO_LARGE", async () => {
    fetchMock.mockResolvedValue(
      mockFetchResponse(200, "", String(300 * 1024 * 1024))
    );
    await expect(
      (updateService as any).assertApkSizeAcceptable("https://example.com/app.apk")
    ).rejects.toThrow("APK_TOO_LARGE");
  });
});
