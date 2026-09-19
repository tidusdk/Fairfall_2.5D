import packageJSON from '../package.json';
import { BridgeServer } from './lib/bridge-server';
import { BridgeState } from './lib/state';

const state = new BridgeState();
const server = new BridgeServer(state);

let pushTimer: NodeJS.Timeout | null = null;

function pushStateToPanel() {
  if (pushTimer) {
    return;
  }

  pushTimer = setTimeout(() => {
    pushTimer = null;

    try {
      Editor.Message.send(packageJSON.name, 'state-changed', state.snapshot());
    } catch (_error) {
      // Panel may not be open — safe to ignore.
    }
  }, 100);
}

export const methods: Record<string, (...args: any[]) => any> = {
  openPanel() {
    Editor.Panel.open(packageJSON.name);
  },

  queryState() {
    return server.queryState();
  },

  startServer() {
    return server.start();
  },

  stopServer() {
    return server.stop();
  },

  clearLogs() {
    return server.clearLogs();
  },
};

function onAssetBroadcast() {
  server.notifyAssetEvent();
}

export function load() {
  state.onChange = pushStateToPanel;
  (Editor.Message as any).addBroadcastListener('asset-db:asset-add', onAssetBroadcast);
  (Editor.Message as any).addBroadcastListener('asset-db:asset-change', onAssetBroadcast);
  state.addLog('Extension loaded.');
}

export function unload() {
  state.onChange = null;
  (Editor.Message as any).removeBroadcastListener('asset-db:asset-add', onAssetBroadcast);
  (Editor.Message as any).removeBroadcastListener('asset-db:asset-change', onAssetBroadcast);

  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }

  server.stop();
}