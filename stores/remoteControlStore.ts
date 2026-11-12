import { create } from 'zustand';
import { remoteControlService } from '@/services/remoteControlService';
import { Logger } from '@/utils/Logger';

const logger = Logger.withTag('RemoteControlStore');

/**
 * 进行中的启动：startServer 要先 await NetInfo 再建 socket，两次并发调用
 * 都会通过 isServerRunning 检查、抢同一个端口，导致一个 EADDRINUSE、
 * 另一个的 socket 引用被覆盖后永远关不掉。同一时间只允许一次启动，
 * 并发调用共用同一个 promise。
 */
let startingPromise: Promise<void> | null = null;
/** 启动还没完成时用户就关了远程输入：启动完成后立刻把刚起的服务停掉 */
let stopRequestedDuringStart = false;
/** 用户最新意图：开→关→开时，第二次 start 加入的是会被 flag 停掉的
 * 旧 promise，必须在它结束后按最新意图重起一次，否则开关开着、服务已死 */
let desiredRunning = false;

interface RemoteControlState {
  isServerRunning: boolean;
  serverUrl: string | null;
  pairingCode: string | null;
  error: string | null;
  startServer: () => Promise<void>;
  stopServer: () => void;
  isModalVisible: boolean;
  showModal: (targetPage?: string) => void;
  hideModal: () => void;
  lastMessage: string | null;
  /** 收到上一条远程消息的时间戳：消息内容本身不再拼时间戳后缀，
   * 连续发两次相同内容时靠这个字段让订阅方感知到变化 */
  lastMessageAt: number | null;
  targetPage: string | null;
  setMessage: (message: string, targetPage?: string) => void;
  clearMessage: () => void;
}

export const useRemoteControlStore = create<RemoteControlState>((set, get) => ({
  isServerRunning: false,
  serverUrl: null,
  pairingCode: null,
  error: null,
  isModalVisible: false,
  lastMessage: null,
  lastMessageAt: null,
  targetPage: null,

  startServer: async () => {
    desiredRunning = true;
    if (get().isServerRunning) {
      return;
    }
    if (startingPromise) {
      // 启动进行中且已被关过：这个 promise 完成后会被 flag 停掉，加入的
      // 这次启动必须在它结束后再重起一次（且只在用户最新意图仍是开启时）。
      if (stopRequestedDuringStart) {
        return startingPromise.then(() => {
          if (desiredRunning) {
            return get().startServer();
          }
        });
      }
      return startingPromise;
    }
    startingPromise = (async () => {
      remoteControlService.init({
        onMessage: (message: string) => {
          logger.debug('Received message:', message);
          const currentState = get();
          // Use the current targetPage from the store
          set({ lastMessage: message, lastMessageAt: Date.now(), targetPage: currentState.targetPage });
        },
        onHandshake: () => {
          logger.debug('Handshake successful');
          set({ isModalVisible: false })
        },
      });
      try {
        const url = await remoteControlService.startServer();
        const pairingCode = remoteControlService.getPairingCode();
        if (stopRequestedDuringStart) {
          // 启动期间用户已关掉远程输入：刚起的服务立刻停掉，不能留在后台跑
          remoteControlService.stopServer();
          return;
        }
        logger.info('Server started, URL:', url);
        set({ isServerRunning: true, serverUrl: url, pairingCode, error: null });
      } catch {
        if (!stopRequestedDuringStart) {
          const errorMessage = '启动失败，请强制退应用后重试。';
          logger.error('Failed to start server:', errorMessage);
          set({ error: errorMessage });
        }
      } finally {
        startingPromise = null;
        stopRequestedDuringStart = false;
      }
    })();
    return startingPromise;
  },

  stopServer: () => {
    desiredRunning = false;
    if (startingPromise) {
      // 启动还没完成：让它完成后立刻停，stop 本身不等启动结果
      stopRequestedDuringStart = true;
      return;
    }
    if (get().isServerRunning) {
      remoteControlService.stopServer();
      set({ isServerRunning: false, serverUrl: null, pairingCode: null });
    }
  },

  showModal: (targetPage?: string) => set({ isModalVisible: true, targetPage }),
  hideModal: () => set({ isModalVisible: false, targetPage: null }),

  setMessage: (message: string, targetPage?: string) => {
    set({ lastMessage: message, lastMessageAt: Date.now(), targetPage });
  },

  clearMessage: () => {
    set({ lastMessage: null, lastMessageAt: null, targetPage: null });
  },
}));