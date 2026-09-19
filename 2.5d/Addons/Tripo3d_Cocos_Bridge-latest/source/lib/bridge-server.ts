// Bridge WebSocket server for receiving Tripo assets, importing them into Cocos, and placing models into the scene.

import fs from 'fs';
import path from 'path';
import type { IncomingMessage } from 'http';
import unzipper from 'unzipper';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import {
  CHUNK_SIZE,
  ERROR_INVALID_JSON,
  ERROR_PROCESSING,
  HEARTBEAT_TIMEOUT_MS,
  MSG_FILE_TRANSFER,
  MSG_HANDSHAKE,
  MSG_PING,
  SERVER_HOST,
  SERVER_PORT,
  SUPPORTED_FORMATS,
  createHandshakeAck,
  createPong,
  createFileTransferAck,
  createTransferComplete,
  createImportComplete,
  safeParseJson,
  normalizeRawData,
  findJsonEnd,
  unwrapPropertyString,
  getDisplayFileName,
} from './protocol';
import {
  sanitizeBaseName,
  ensureUniqueDirectory,
  sanitizeArchiveEntry,
  getArchiveCommonRoot,
  stripArchiveCommonRoot,
  normalizeIncomingFileType,
  findPrimaryModelFile,
} from './file-utils';
import { MaterialManager } from './material';
import type { BridgeState } from './state';
import { FileTransferManager } from './file-transfer-manager';

// ————— types —————

type AssetInfoLike = {
  uuid: string;
  url: string;
  file: string;
  type: string;
  importer: string;
  instantiation?: string;
  imported: boolean;
  invalid: boolean;
  isDirectory: boolean;
};

type SceneNodeLike = {
  uuid?: string | { value?: unknown };
  name?: string | { value?: unknown };
};

type AssetSearchResult = {
  asset: AssetInfoLike | null;
  totalCandidates: number;
  instantiableCandidates: number;
};

export class BridgeServer {
  private readonly transferManager = new FileTransferManager();
  private readonly materialManager: MaterialManager;
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastPingAt = 0;
  private readonly assetEventResolvers = new Set<() => void>();
  private readonly loggedProtocolWarnings = new Set<string>();

  constructor(private readonly state: BridgeState) {
    this.materialManager = new MaterialManager(
      (msg) => this.state.addLog(msg),
      (fsPath) => this.getAssetDbPath(fsPath),
      (fsPath) => this.tryRefreshAssets(fsPath),
    );
  }

  // ————— public api —————

  start() {
    if (this.wss) {
      this.state.addLog('Server already running.');
      return this.state.snapshot();
    }

    this.wss = new WebSocketServer({
      host: SERVER_HOST,
      port: SERVER_PORT,
      maxPayload: CHUNK_SIZE + 1024 * 1024,
    });

    this.wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
      if (this.client && this.client !== socket) {
        this.client.close(1000, 'New client connected');
      }

      this.client = socket;
      this.loggedProtocolWarnings.clear();
      this.lastPingAt = Date.now();
      this.state.set({
        connected: true,
        clientName: request.socket.remoteAddress || 'Tripo Studio',
      });
      this.state.addLog('Client connected.');

      socket.on('message', (data: RawData, isBinary: boolean) => {
        try {
          this.handleMessage(socket, normalizeRawData(data), isBinary);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.state.addLog(`Message handling failed: ${message}`);
          this.safeSend(socket, createFileTransferAck('', 0, false, ERROR_PROCESSING));
        }
      });

      socket.on('close', () => {
        if (this.client === socket) {
          this.client = null;
          this.loggedProtocolWarnings.clear();
          this.state.set({ connected: false, clientName: '', currentFile: '', progress: 0 });
          this.state.addLog('Client disconnected.');
        }
      });

      socket.on('error', (error: Error) => {
        this.state.addLog(`Socket error: ${error.message}`);
      });
    });

    this.wss.on('listening', () => {
      this.state.set({ serverRunning: true, port: SERVER_PORT });
      this.state.addLog(`Server listening on ws://${SERVER_HOST}:${SERVER_PORT}`);
    });

    this.wss.on('error', (error: Error) => {
      const isPortInUse = error.message.includes('EADDRINUSE');
      if (isPortInUse) {
        this.stopHeartbeatMonitor();
        this.wss?.close();
        this.wss = null;
        this.state.set({ portInUse: true, serverRunning: false });
        this.state.addLog(`Port ${SERVER_PORT} is already in use. Please stop the server using the port or use a different port.`);
      } else {
        this.state.addLog(`Server error: ${error.message}`);
      }
    });

    this.startHeartbeatMonitor();
    return this.state.snapshot();
  }

  stop() {
    this.stopHeartbeatMonitor();
    this.transferManager.clear();
    this.loggedProtocolWarnings.clear();

    if (this.client) {
      this.client.close(1000, 'Bridge stopped');
      this.client = null;
    }

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    this.state.set({
      serverRunning: false,
      connected: false,
      clientName: '',
      currentFile: '',
      progress: 0,
      portInUse: false,
    });
    this.state.addLog('Server stopped.');
    return this.state.snapshot();
  }

  queryState() {
    return this.state.snapshot();
  }

  clearLogs() {
    this.state.clearLogs();
    this.loggedProtocolWarnings.clear();
    return this.state.snapshot();
  }

  notifyAssetEvent() {
    for (const resolver of this.assetEventResolvers) {
      resolver();
    }
  }

  // ————— impl —————

  private handleMessage(socket: WebSocket, buffer: Buffer, isBinary: boolean) {
    this.lastPingAt = Date.now();

    if (!isBinary) {
      const message = safeParseJson(buffer.toString('utf8'));
      if (!message) {
        this.logProtocolWarningOnce('invalid-json-text', 'Invalid JSON text message.');
        return;
      }
      if (message.type === MSG_HANDSHAKE) {
        const payload = message.payload || {};
        this.state.addLog(`Handshake from ${payload.clientName || 'unknown client'}.`);
        this.safeSend(socket, createHandshakeAck());
      } else if (message.type === MSG_PING) {
        this.lastPingAt = Date.now();
        this.safeSend(socket, createPong());
      }
      return;
    }

    const jsonEnd = findJsonEnd(buffer);
    if (jsonEnd <= 0) {
      this.logProtocolWarningOnce('invalid-binary-packet', 'Invalid binary packet: JSON header not found.', 'json-header-not-found');
      this.safeSend(socket, createFileTransferAck('', 0, false, ERROR_INVALID_JSON));
      return;
    }

    const header = safeParseJson(buffer.subarray(0, jsonEnd).toString('utf8'));
    if (!header) {
      this.logProtocolWarningOnce('invalid-binary-packet', 'Invalid binary packet JSON header.', 'json-header-invalid');
      this.safeSend(socket, createFileTransferAck('', 0, false, ERROR_INVALID_JSON));
      return;
    }

    if (header.type === MSG_PING) {
      this.lastPingAt = Date.now();
      this.safeSend(socket, createPong());
      return;
    }

    if (header.type !== MSG_FILE_TRANSFER) return;

    void this.handleFileTransfer(socket, header.payload || {}, buffer.subarray(jsonEnd)).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.state.addLog(`Unexpected file transfer error: ${message}`);
    });
  }

  private async handleFileTransfer(socket: WebSocket, payload: Record<string, any>, chunkData: Buffer) {
    const fileId = String(payload.fileId || '');
    const fileName = String(payload.fileName || 'model');
    const fileType = normalizeIncomingFileType(fileName, String(payload.fileType || ''));
    const chunkIndex = Number(payload.chunkIndex || 0);
    const chunkTotal = Number(payload.chunkTotal || 1);

    if (!fileId || !SUPPORTED_FORMATS.has(fileType)) {
      const rejectionMessage = `Unsupported transfer payload for ${fileName}. Supported formats: ${[...SUPPORTED_FORMATS].join(', ')}.`;
      const rejectionDetail = `${fileName}|${fileType || 'unknown'}|${fileId ? 'with-id' : 'missing-id'}`;
      this.logProtocolWarningOnce('unsupported-transfer-payload', rejectionMessage, rejectionDetail);
      this.safeSend(socket, createFileTransferAck(fileId, chunkIndex, false, ERROR_PROCESSING));
      if (fileId) this.safeSend(socket, createImportComplete(fileId, false, rejectionMessage, ''));
      return;
    }

    this.transferManager.addChunk(fileId, fileName, fileType, chunkIndex, chunkTotal, chunkData);
    this.state.set({
      currentFile: getDisplayFileName(fileName),
      progress: Number(((chunkIndex + 1) / chunkTotal).toFixed(4)),
    });
    this.safeSend(socket, createFileTransferAck(fileId, chunkIndex, true));

    if (!this.transferManager.isComplete(fileId)) return;

    this.safeSend(socket, createTransferComplete(fileId));

    try {
      const fileBuffer = this.transferManager.assembleFile(fileId);
      const savedPath = await this.extractIncomingArchive(fileName, fileType, fileBuffer);
      this.transferManager.removeSession(fileId);
      const displayFileName = getDisplayFileName(fileName);

      this.state.set({ progress: 1, lastSavedPath: savedPath });
      this.state.addLog(fileType === 'zip' ? 'Extracted ZIP to assets.' : `Saved ${fileType.toUpperCase()} to assets.`);

      await this.tryRefreshAssets(savedPath);

      let completionMessage = fileType === 'zip'
        ? 'ZIP extracted into project assets.'
        : `${fileType.toUpperCase()} saved into project assets.`;

      try {
        const placement = await this.tryPlaceImportedModelInScene(savedPath, displayFileName);
        if (placement) {
          this.state.addLog('Model imported and added to scene.');
          completionMessage = 'Model imported and added to the current scene.';
        } else {
          this.state.addLog('Model saved but could not be placed in scene.');
          completionMessage = fileType === 'zip'
            ? 'ZIP extracted into project assets, but the model was not added to the current scene.'
            : `${fileType.toUpperCase()} saved into project assets, but the model was not added to the current scene.`;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.state.addLog(`Scene placement failed: ${message}`);
        completionMessage = fileType === 'zip'
          ? `ZIP extracted into project assets, but scene placement failed: ${message}`
          : `${fileType.toUpperCase()} saved into project assets, but scene placement failed: ${message}`;
      }

      this.safeSend(socket, createImportComplete(fileId, true, completionMessage, savedPath));
    } catch (error) {
      this.transferManager.removeSession(fileId);
      const message = error instanceof Error ? error.message : String(error);
      this.state.addLog(`Failed to save transfer: ${message}`);
      this.safeSend(socket, createImportComplete(fileId, false, message, ''));
    }
  }

  private async tryRefreshAssets(savedPath: string): Promise<boolean> {
    if (!globalThis.Editor || !Editor.Message || !Editor.Message.request) return false;

    const refreshTarget = fs.existsSync(savedPath) && fs.statSync(savedPath).isDirectory()
      ? savedPath
      : path.dirname(savedPath);
    const dbPath = this.getAssetDbPath(refreshTarget);
    const candidates: Array<[string, string, string]> = [
      ['asset-db', 'refresh-asset', dbPath],
      ['asset-db', 'refresh-asset', 'db://assets/TripoModels'],
      ['asset-db', 'refresh', 'db://assets/TripoModels'],
    ];

    for (const [pkg, msg, target] of candidates) {
      try {
        await Editor.Message.request(pkg, msg, target);
        return true;
      } catch {
        continue;
      }
    }

    this.state.addLog('Asset refresh: all strategies failed.');
    return false;
  }

  private async tryPlaceImportedModelInScene(savedPath: string, displayName: string) {
    if (!globalThis.Editor || !Editor.Message || !Editor.Message.request) return null;

    const asset = await this.waitForInstantiableAsset(savedPath);
    if (!asset) {
      this.state.addLog('No instantiable model asset found.');
      return null;
    }

    const sceneTree = await Editor.Message.request('scene', 'query-node-tree') as unknown as SceneNodeLike | null;
    const sceneRootUuid = unwrapPropertyString(sceneTree?.uuid);
    if (!sceneRootUuid) throw new Error('No open scene is available.');

    const createdNodeUuid = await Editor.Message.request('scene', 'create-node', {
      parent: sceneRootUuid,
      name: displayName,
      assetUuid: asset.uuid,
      type: asset.type,
      nameIncrease: true,
      position: { x: 0, y: 0, z: 0 },
      snapshot: true,
      unlinkPrefab: false,
    });

    this.state.addLog(`Node created: ${displayName}`);

    try {
      const matResult = await this.materialManager.ensureDefaultMaterial(savedPath, String(createdNodeUuid));
      if (matResult.applied > 0) {
        this.state.addLog(`Material applied to ${matResult.applied} slot(s).`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state.addLog(`Material assignment failed: ${message}`);
    }

    return { assetUrl: asset.url };
  }

  private async waitForInstantiableAsset(savedPath: string, timeoutMs = 15000) {
    const assetPathExists = fs.existsSync(savedPath);
    const assetIsDirectory = assetPathExists && fs.statSync(savedPath).isDirectory();
    const searchDir = assetIsDirectory ? savedPath : path.dirname(savedPath);
    const exactAssetDbPath = assetPathExists && !assetIsDirectory ? this.getAssetDbPath(savedPath) : '';
    const searchDirDbPath = this.getAssetDbPath(searchDir);
    const startedAt = Date.now();

    while ((Date.now() - startedAt) < timeoutMs) {
      const result = await this.findBestInstantiableAsset(exactAssetDbPath, searchDirDbPath);
      if (result.asset) return result.asset;
      await this.waitForAssetEventOrTimeout(Math.min(3000, timeoutMs - (Date.now() - startedAt)));
    }

    this.state.addLog('Timed out waiting for asset import.');
    return null;
  }

  private async findBestInstantiableAsset(exactAssetDbPath: string, searchDirDbPath: string): Promise<AssetSearchResult> {
    const candidates: AssetInfoLike[] = [];
    const fields: (keyof AssetInfoLike)[] = ['uuid', 'url', 'file', 'type', 'importer', 'instantiation', 'imported', 'invalid', 'isDirectory'];

    if (exactAssetDbPath) {
      const exact = await Editor.Message.request('asset-db', 'query-asset-info', exactAssetDbPath, fields) as AssetInfoLike | null;
      if (exact) candidates.push(exact);
    }

    const scanned: AssetInfoLike[] = [];
    for (const pattern of [`${searchDirDbPath}/*`, `${searchDirDbPath}/**`, `${searchDirDbPath}/**/*`]) {
      try {
        const assets = await Editor.Message.request('asset-db', 'query-assets', { pattern }, fields) as AssetInfoLike[];
        scanned.push(...assets);
      } catch {
        continue;
      }
    }

    const seen = new Set<string>();
    const unique = [...candidates, ...scanned].filter((a) => {
      if (!a?.uuid || seen.has(a.uuid)) return false;
      seen.add(a.uuid);
      return true;
    });

    const ready = unique
      .filter((a) => a.imported && !a.invalid && !a.isDirectory && this.isInstantiableAsset(a))
      .sort((a, b) => this.getAssetPlacementScore(b) - this.getAssetPlacementScore(a));

    return { asset: ready[0] || null, totalCandidates: unique.length, instantiableCandidates: ready.length };
  }

  // ————— internal —————

  private buildProtocolWarningKey(scope: string, detail = '') {
    return `${scope}:${String(detail || '').trim().toLowerCase()}`;
  }

  private logProtocolWarningOnce(scope: string, message: string, detail = '') {
    const key = this.buildProtocolWarningKey(scope, detail);
    if (this.loggedProtocolWarnings.has(key)) return;
    this.loggedProtocolWarnings.add(key);
    this.state.addLog(message);
  }

  private safeSend(socket: WebSocket | null, payload: Record<string, any>) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(payload));
  }

  private getProjectPath() {
    if (globalThis.Editor && Editor.Project && Editor.Project.path) {
      return Editor.Project.path;
    }
    return process.cwd();
  }

  private getModelRootDir() {
    return path.join(this.getProjectPath(), 'assets', 'TripoModels');
  }

  private getAssetDbPath(targetPath: string) {
    const projectPath = this.getProjectPath();
    const relativePath = path.relative(projectPath, targetPath).replace(/\\/g, '/');
    if (!relativePath || relativePath.startsWith('..')) {
      throw new Error(`Path is outside the current project: ${targetPath}`);
    }
    return `db://${relativePath}`;
  }

  private async extractIncomingArchive(fileName: string, fileType: string, fileBuffer: Buffer) {
    const modelRootDir = this.getModelRootDir();
    fs.mkdirSync(modelRootDir, { recursive: true });

    const baseName = sanitizeBaseName(fileName);
    const uniqueDirName = ensureUniqueDirectory(modelRootDir, baseName);
    const targetDir = path.join(modelRootDir, uniqueDirName);
    fs.mkdirSync(targetDir, { recursive: true });

    if (fileType !== 'zip') {
      let targetFileName = path.basename(fileName || `${baseName}.${fileType || 'bin'}`);
      if (!path.extname(targetFileName) && fileType) {
        targetFileName = `${targetFileName}.${fileType}`;
      }
      const destination = path.join(targetDir, targetFileName || `${baseName}.${fileType || 'bin'}`);
      fs.writeFileSync(destination, fileBuffer);
      this.state.addLog(`Saved ${fileType || 'binary'} file.`);
      return destination;
    }

    this.state.addLog('Extracting ZIP...');
    return this.extractZipWithUnzipper(targetDir, fileBuffer);
  }

  private async extractZipWithUnzipper(targetDir: string, fileBuffer: Buffer) {
    const directory = await unzipper.Open.buffer(fileBuffer);
    if (directory.files.length === 0) throw new Error('ZIP archive is empty.');

    const commonRoot = getArchiveCommonRoot(directory.files.map((e) => ({
      entryName: e.path,
      isDirectory: e.type === 'Directory',
    })));

    for (const entry of directory.files) {
      const safeEntry = sanitizeArchiveEntry(entry.path);
      const relEntry = stripArchiveCommonRoot(safeEntry, commonRoot);
      if (!relEntry) continue;

      const destination = path.join(targetDir, relEntry);
      if (entry.type === 'Directory') {
        fs.mkdirSync(destination, { recursive: true });
        continue;
      }

      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, await entry.buffer());
    }

    const primaryModelFile = findPrimaryModelFile(targetDir);
    if (primaryModelFile) {
      this.state.addLog(`Primary model file: ${path.basename(primaryModelFile)}`);
      return primaryModelFile;
    }
    return targetDir;
  }

  private waitForAssetEventOrTimeout(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const settle = () => {
        clearTimeout(timer);
        this.assetEventResolvers.delete(settle);
        resolve();
      };
      const timer = setTimeout(settle, ms);
      this.assetEventResolvers.add(settle);
    });
  }

  private isInstantiableAsset(asset: AssetInfoLike) {
    return !!asset.instantiation || asset.type === 'cc.Prefab' || asset.type.endsWith('Prefab');
  }

  private getAssetPlacementScore(asset: AssetInfoLike) {
    let score = 0;
    if (asset.type === 'cc.Prefab') score += 1000;
    if (asset.instantiation) score += 500;
    const ext = path.extname(asset.file || asset.url || '').toLowerCase();
    score += ({ '.prefab': 400, '.fbx': 300, '.glb': 280, '.gltf': 260, '.obj': 240 }[ext] || 0);
    if (asset.importer.includes('model')) score += 100;
    return score;
  }

  private startHeartbeatMonitor() {
    this.stopHeartbeatMonitor();
    this.heartbeatTimer = setInterval(() => {
      if (!this.client) return;
      if (Date.now() - this.lastPingAt > HEARTBEAT_TIMEOUT_MS) {
        this.state.addLog('Heartbeat timeout, closing client connection.');
        this.client.close(1001, 'Heartbeat timeout');
      }
    }, 5000);
  }

  private stopHeartbeatMonitor() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
