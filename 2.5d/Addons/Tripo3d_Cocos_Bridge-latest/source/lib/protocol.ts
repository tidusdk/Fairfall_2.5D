import path from 'path';
import type { RawData } from 'ws';

export const SERVER_HOST = '127.0.0.1';
export const SERVER_PORT = 60660;
export const PROTOCOL_VERSION = '1.0.0';
export const CLIENT_NAME = 'Cocos Creator';
export const CHUNK_SIZE = 5 * 1024 * 1024;
export const HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — Tripo Studio stays idle between transfers

export const MSG_HANDSHAKE = 'handshake';
export const MSG_HANDSHAKE_ACK = 'handshake_ack';
export const MSG_PING = 'ping';
export const MSG_PONG = 'pong';
export const MSG_FILE_TRANSFER = 'file_transfer';
export const MSG_FILE_TRANSFER_ACK = 'file_transfer_ack';
export const MSG_FILE_TRANSFER_COMPLETE = 'file_transfer_complete';
export const MSG_IMPORT_COMPLETE = 'import_complete';

export const ERROR_INVALID_JSON = 1001;
export const ERROR_PROCESSING = 1002;

export const SUPPORTED_FORMATS = new Set(['zip', 'fbx']);

// ── Types ──────────────────────────────────────────────────────────────────────

export type JsonMessage = {
  type?: string;
  payload?: Record<string, any>;
};

// ── Message factories ──────────────────────────────────────────────────────────

export function createHandshakeAck() {
  return {
    type: MSG_HANDSHAKE_ACK,
    payload: {
      success: true,
      clientName: CLIENT_NAME,
      dccVersion: 'Cocos Creator 3.x',
      pluginVersion: PROTOCOL_VERSION,
      protocolVersion: PROTOCOL_VERSION,
    },
  };
}

export function createPong() {
  return { type: MSG_PONG };
}

export function createFileTransferAck(fileId: string, fileIndex: number, success: boolean, code?: number) {
  const payload: Record<string, any> = { success, fileId, fileIndex };
  if (typeof code === 'number') {
    payload.code = code;
  }
  return { type: MSG_FILE_TRANSFER_ACK, payload };
}

export function createTransferComplete(fileId: string) {
  return {
    type: MSG_FILE_TRANSFER_COMPLETE,
    payload: {
      fileId,
      status: 'importing',
      message: 'File transfer complete, saving model data into project assets.',
    },
  };
}

export function createImportComplete(fileId: string, success: boolean, message: string, savedPath: string) {
  return {
    type: MSG_IMPORT_COMPLETE,
    payload: { fileId, success, message, savedPath },
  };
}

// ── Parsing utilities ──────────────────────────────────────────────────────────

export function safeParseJson(text: string): JsonMessage | null {
  try {
    return JSON.parse(text) as JsonMessage;
  } catch {
    return null;
  }
}

export function normalizeRawData(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data.map((c) => Buffer.isBuffer(c) ? c : Buffer.from(c)));
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    const v = data as ArrayBufferView;
    return Buffer.from(v.buffer as ArrayBuffer, v.byteOffset, v.byteLength);
  }
  return Buffer.from(String(data));
}

export function findJsonEnd(buffer: Buffer): number {
  let braceCount = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];
    if (byte >= 128) continue;
    const ch = String.fromCharCode(byte);
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (!inString) {
      if (ch === '{') braceCount++;
      else if (ch === '}' && --braceCount === 0) return i + 1;
    }
  }
  return -1;
}

export function unwrapPropertyString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'value' in value) {
    const v = (value as { value?: unknown }).value;
    return typeof v === 'string' ? v : '';
  }
  return '';
}

export function getDisplayFileName(fileName: string): string {
  const parsed = path.parse(fileName);
  return parsed.name || fileName;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
