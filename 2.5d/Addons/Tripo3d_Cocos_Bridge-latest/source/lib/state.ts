import { SERVER_PORT } from './protocol';

export type BridgeStateSnapshot = {
  serverRunning: boolean;
  connected: boolean;
  clientName: string;
  currentFile: string;
  progress: number;
  lastSavedPath: string;
  logs: string[];
  port: number;
  portInUse: boolean;
};

export class BridgeState {
  serverRunning = false;
  connected = false;
  clientName = '';
  currentFile = '';
  progress = 0;
  lastSavedPath = '';
  logs: string[] = [];
  port = SERVER_PORT;
  portInUse = false;
  onChange: (() => void) | null = null;

  private notifyChange() {
    if (this.onChange) {
      this.onChange();
    }
  }

  reset() {
    this.serverRunning = false;
    this.connected = false;
    this.clientName = '';
    this.currentFile = '';
    this.progress = 0;
    this.lastSavedPath = '';
    this.logs = [];
    this.port = SERVER_PORT;
    this.portInUse = false;
    this.notifyChange();
  }

  set(partial: Partial<BridgeStateSnapshot>) {
    Object.assign(this, partial);
    this.notifyChange();
  }

  addLog(message: string) {
    const line = `[${new Date().toLocaleTimeString()}] ${message}`;
    this.logs.push(line);
    if (this.logs.length > 200) {
      this.logs.splice(0, this.logs.length - 200);
    }
    this.notifyChange();
  }

  clearLogs() {
    this.logs = [];
    this.notifyChange();
  }

  snapshot(): BridgeStateSnapshot {
    return {
      serverRunning: this.serverRunning,
      connected: this.connected,
      clientName: this.clientName,
      currentFile: this.currentFile,
      progress: this.progress,
      lastSavedPath: this.lastSavedPath,
      logs: [...this.logs],
      port: this.port,
      portInUse: this.portInUse,
    };
  }
}