"use strict";
// Bridge WebSocket server for receiving Tripo assets, importing them into Cocos, and placing models into the scene.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BridgeServer = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const unzipper_1 = __importDefault(require("unzipper"));
const ws_1 = require("ws");
const protocol_1 = require("./protocol");
const file_utils_1 = require("./file-utils");
const material_1 = require("./material");
const file_transfer_manager_1 = require("./file-transfer-manager");
class BridgeServer {
    constructor(state) {
        this.state = state;
        this.transferManager = new file_transfer_manager_1.FileTransferManager();
        this.wss = null;
        this.client = null;
        this.heartbeatTimer = null;
        this.lastPingAt = 0;
        this.assetEventResolvers = new Set();
        this.loggedProtocolWarnings = new Set();
        this.materialManager = new material_1.MaterialManager((msg) => this.state.addLog(msg), (fsPath) => this.getAssetDbPath(fsPath), (fsPath) => this.tryRefreshAssets(fsPath));
    }
    // ————— public api —————
    start() {
        if (this.wss) {
            this.state.addLog('Server already running.');
            return this.state.snapshot();
        }
        this.wss = new ws_1.WebSocketServer({
            host: protocol_1.SERVER_HOST,
            port: protocol_1.SERVER_PORT,
            maxPayload: protocol_1.CHUNK_SIZE + 1024 * 1024,
        });
        this.wss.on('connection', (socket, request) => {
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
            socket.on('message', (data, isBinary) => {
                try {
                    this.handleMessage(socket, (0, protocol_1.normalizeRawData)(data), isBinary);
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    this.state.addLog(`Message handling failed: ${message}`);
                    this.safeSend(socket, (0, protocol_1.createFileTransferAck)('', 0, false, protocol_1.ERROR_PROCESSING));
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
            socket.on('error', (error) => {
                this.state.addLog(`Socket error: ${error.message}`);
            });
        });
        this.wss.on('listening', () => {
            this.state.set({ serverRunning: true, port: protocol_1.SERVER_PORT });
            this.state.addLog(`Server listening on ws://${protocol_1.SERVER_HOST}:${protocol_1.SERVER_PORT}`);
        });
        this.wss.on('error', (error) => {
            var _a;
            const isPortInUse = error.message.includes('EADDRINUSE');
            if (isPortInUse) {
                this.stopHeartbeatMonitor();
                (_a = this.wss) === null || _a === void 0 ? void 0 : _a.close();
                this.wss = null;
                this.state.set({ portInUse: true, serverRunning: false });
                this.state.addLog(`Port ${protocol_1.SERVER_PORT} is already in use. Please stop the server using the port or use a different port.`);
            }
            else {
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
    handleMessage(socket, buffer, isBinary) {
        this.lastPingAt = Date.now();
        if (!isBinary) {
            const message = (0, protocol_1.safeParseJson)(buffer.toString('utf8'));
            if (!message) {
                this.logProtocolWarningOnce('invalid-json-text', 'Invalid JSON text message.');
                return;
            }
            if (message.type === protocol_1.MSG_HANDSHAKE) {
                const payload = message.payload || {};
                this.state.addLog(`Handshake from ${payload.clientName || 'unknown client'}.`);
                this.safeSend(socket, (0, protocol_1.createHandshakeAck)());
            }
            else if (message.type === protocol_1.MSG_PING) {
                this.lastPingAt = Date.now();
                this.safeSend(socket, (0, protocol_1.createPong)());
            }
            return;
        }
        const jsonEnd = (0, protocol_1.findJsonEnd)(buffer);
        if (jsonEnd <= 0) {
            this.logProtocolWarningOnce('invalid-binary-packet', 'Invalid binary packet: JSON header not found.', 'json-header-not-found');
            this.safeSend(socket, (0, protocol_1.createFileTransferAck)('', 0, false, protocol_1.ERROR_INVALID_JSON));
            return;
        }
        const header = (0, protocol_1.safeParseJson)(buffer.subarray(0, jsonEnd).toString('utf8'));
        if (!header) {
            this.logProtocolWarningOnce('invalid-binary-packet', 'Invalid binary packet JSON header.', 'json-header-invalid');
            this.safeSend(socket, (0, protocol_1.createFileTransferAck)('', 0, false, protocol_1.ERROR_INVALID_JSON));
            return;
        }
        if (header.type === protocol_1.MSG_PING) {
            this.lastPingAt = Date.now();
            this.safeSend(socket, (0, protocol_1.createPong)());
            return;
        }
        if (header.type !== protocol_1.MSG_FILE_TRANSFER)
            return;
        void this.handleFileTransfer(socket, header.payload || {}, buffer.subarray(jsonEnd)).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            this.state.addLog(`Unexpected file transfer error: ${message}`);
        });
    }
    async handleFileTransfer(socket, payload, chunkData) {
        const fileId = String(payload.fileId || '');
        const fileName = String(payload.fileName || 'model');
        const fileType = (0, file_utils_1.normalizeIncomingFileType)(fileName, String(payload.fileType || ''));
        const chunkIndex = Number(payload.chunkIndex || 0);
        const chunkTotal = Number(payload.chunkTotal || 1);
        if (!fileId || !protocol_1.SUPPORTED_FORMATS.has(fileType)) {
            const rejectionMessage = `Unsupported transfer payload for ${fileName}. Supported formats: ${[...protocol_1.SUPPORTED_FORMATS].join(', ')}.`;
            const rejectionDetail = `${fileName}|${fileType || 'unknown'}|${fileId ? 'with-id' : 'missing-id'}`;
            this.logProtocolWarningOnce('unsupported-transfer-payload', rejectionMessage, rejectionDetail);
            this.safeSend(socket, (0, protocol_1.createFileTransferAck)(fileId, chunkIndex, false, protocol_1.ERROR_PROCESSING));
            if (fileId)
                this.safeSend(socket, (0, protocol_1.createImportComplete)(fileId, false, rejectionMessage, ''));
            return;
        }
        this.transferManager.addChunk(fileId, fileName, fileType, chunkIndex, chunkTotal, chunkData);
        this.state.set({
            currentFile: (0, protocol_1.getDisplayFileName)(fileName),
            progress: Number(((chunkIndex + 1) / chunkTotal).toFixed(4)),
        });
        this.safeSend(socket, (0, protocol_1.createFileTransferAck)(fileId, chunkIndex, true));
        if (!this.transferManager.isComplete(fileId))
            return;
        this.safeSend(socket, (0, protocol_1.createTransferComplete)(fileId));
        try {
            const fileBuffer = this.transferManager.assembleFile(fileId);
            const savedPath = await this.extractIncomingArchive(fileName, fileType, fileBuffer);
            this.transferManager.removeSession(fileId);
            const displayFileName = (0, protocol_1.getDisplayFileName)(fileName);
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
                }
                else {
                    this.state.addLog('Model saved but could not be placed in scene.');
                    completionMessage = fileType === 'zip'
                        ? 'ZIP extracted into project assets, but the model was not added to the current scene.'
                        : `${fileType.toUpperCase()} saved into project assets, but the model was not added to the current scene.`;
                }
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.state.addLog(`Scene placement failed: ${message}`);
                completionMessage = fileType === 'zip'
                    ? `ZIP extracted into project assets, but scene placement failed: ${message}`
                    : `${fileType.toUpperCase()} saved into project assets, but scene placement failed: ${message}`;
            }
            this.safeSend(socket, (0, protocol_1.createImportComplete)(fileId, true, completionMessage, savedPath));
        }
        catch (error) {
            this.transferManager.removeSession(fileId);
            const message = error instanceof Error ? error.message : String(error);
            this.state.addLog(`Failed to save transfer: ${message}`);
            this.safeSend(socket, (0, protocol_1.createImportComplete)(fileId, false, message, ''));
        }
    }
    async tryRefreshAssets(savedPath) {
        if (!globalThis.Editor || !Editor.Message || !Editor.Message.request)
            return false;
        const refreshTarget = fs_1.default.existsSync(savedPath) && fs_1.default.statSync(savedPath).isDirectory()
            ? savedPath
            : path_1.default.dirname(savedPath);
        const dbPath = this.getAssetDbPath(refreshTarget);
        const candidates = [
            ['asset-db', 'refresh-asset', dbPath],
            ['asset-db', 'refresh-asset', 'db://assets/TripoModels'],
            ['asset-db', 'refresh', 'db://assets/TripoModels'],
        ];
        for (const [pkg, msg, target] of candidates) {
            try {
                await Editor.Message.request(pkg, msg, target);
                return true;
            }
            catch {
                continue;
            }
        }
        this.state.addLog('Asset refresh: all strategies failed.');
        return false;
    }
    async tryPlaceImportedModelInScene(savedPath, displayName) {
        if (!globalThis.Editor || !Editor.Message || !Editor.Message.request)
            return null;
        const asset = await this.waitForInstantiableAsset(savedPath);
        if (!asset) {
            this.state.addLog('No instantiable model asset found.');
            return null;
        }
        const sceneTree = await Editor.Message.request('scene', 'query-node-tree');
        const sceneRootUuid = (0, protocol_1.unwrapPropertyString)(sceneTree === null || sceneTree === void 0 ? void 0 : sceneTree.uuid);
        if (!sceneRootUuid)
            throw new Error('No open scene is available.');
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
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.state.addLog(`Material assignment failed: ${message}`);
        }
        return { assetUrl: asset.url };
    }
    async waitForInstantiableAsset(savedPath, timeoutMs = 15000) {
        const assetPathExists = fs_1.default.existsSync(savedPath);
        const assetIsDirectory = assetPathExists && fs_1.default.statSync(savedPath).isDirectory();
        const searchDir = assetIsDirectory ? savedPath : path_1.default.dirname(savedPath);
        const exactAssetDbPath = assetPathExists && !assetIsDirectory ? this.getAssetDbPath(savedPath) : '';
        const searchDirDbPath = this.getAssetDbPath(searchDir);
        const startedAt = Date.now();
        while ((Date.now() - startedAt) < timeoutMs) {
            const result = await this.findBestInstantiableAsset(exactAssetDbPath, searchDirDbPath);
            if (result.asset)
                return result.asset;
            await this.waitForAssetEventOrTimeout(Math.min(3000, timeoutMs - (Date.now() - startedAt)));
        }
        this.state.addLog('Timed out waiting for asset import.');
        return null;
    }
    async findBestInstantiableAsset(exactAssetDbPath, searchDirDbPath) {
        const candidates = [];
        const fields = ['uuid', 'url', 'file', 'type', 'importer', 'instantiation', 'imported', 'invalid', 'isDirectory'];
        if (exactAssetDbPath) {
            const exact = await Editor.Message.request('asset-db', 'query-asset-info', exactAssetDbPath, fields);
            if (exact)
                candidates.push(exact);
        }
        const scanned = [];
        for (const pattern of [`${searchDirDbPath}/*`, `${searchDirDbPath}/**`, `${searchDirDbPath}/**/*`]) {
            try {
                const assets = await Editor.Message.request('asset-db', 'query-assets', { pattern }, fields);
                scanned.push(...assets);
            }
            catch {
                continue;
            }
        }
        const seen = new Set();
        const unique = [...candidates, ...scanned].filter((a) => {
            if (!(a === null || a === void 0 ? void 0 : a.uuid) || seen.has(a.uuid))
                return false;
            seen.add(a.uuid);
            return true;
        });
        const ready = unique
            .filter((a) => a.imported && !a.invalid && !a.isDirectory && this.isInstantiableAsset(a))
            .sort((a, b) => this.getAssetPlacementScore(b) - this.getAssetPlacementScore(a));
        return { asset: ready[0] || null, totalCandidates: unique.length, instantiableCandidates: ready.length };
    }
    // ————— internal —————
    buildProtocolWarningKey(scope, detail = '') {
        return `${scope}:${String(detail || '').trim().toLowerCase()}`;
    }
    logProtocolWarningOnce(scope, message, detail = '') {
        const key = this.buildProtocolWarningKey(scope, detail);
        if (this.loggedProtocolWarnings.has(key))
            return;
        this.loggedProtocolWarnings.add(key);
        this.state.addLog(message);
    }
    safeSend(socket, payload) {
        if (!socket || socket.readyState !== ws_1.WebSocket.OPEN)
            return;
        socket.send(JSON.stringify(payload));
    }
    getProjectPath() {
        if (globalThis.Editor && Editor.Project && Editor.Project.path) {
            return Editor.Project.path;
        }
        return process.cwd();
    }
    getModelRootDir() {
        return path_1.default.join(this.getProjectPath(), 'assets', 'TripoModels');
    }
    getAssetDbPath(targetPath) {
        const projectPath = this.getProjectPath();
        const relativePath = path_1.default.relative(projectPath, targetPath).replace(/\\/g, '/');
        if (!relativePath || relativePath.startsWith('..')) {
            throw new Error(`Path is outside the current project: ${targetPath}`);
        }
        return `db://${relativePath}`;
    }
    async extractIncomingArchive(fileName, fileType, fileBuffer) {
        const modelRootDir = this.getModelRootDir();
        fs_1.default.mkdirSync(modelRootDir, { recursive: true });
        const baseName = (0, file_utils_1.sanitizeBaseName)(fileName);
        const uniqueDirName = (0, file_utils_1.ensureUniqueDirectory)(modelRootDir, baseName);
        const targetDir = path_1.default.join(modelRootDir, uniqueDirName);
        fs_1.default.mkdirSync(targetDir, { recursive: true });
        if (fileType !== 'zip') {
            let targetFileName = path_1.default.basename(fileName || `${baseName}.${fileType || 'bin'}`);
            if (!path_1.default.extname(targetFileName) && fileType) {
                targetFileName = `${targetFileName}.${fileType}`;
            }
            const destination = path_1.default.join(targetDir, targetFileName || `${baseName}.${fileType || 'bin'}`);
            fs_1.default.writeFileSync(destination, fileBuffer);
            this.state.addLog(`Saved ${fileType || 'binary'} file.`);
            return destination;
        }
        this.state.addLog('Extracting ZIP...');
        return this.extractZipWithUnzipper(targetDir, fileBuffer);
    }
    async extractZipWithUnzipper(targetDir, fileBuffer) {
        const directory = await unzipper_1.default.Open.buffer(fileBuffer);
        if (directory.files.length === 0)
            throw new Error('ZIP archive is empty.');
        const commonRoot = (0, file_utils_1.getArchiveCommonRoot)(directory.files.map((e) => ({
            entryName: e.path,
            isDirectory: e.type === 'Directory',
        })));
        for (const entry of directory.files) {
            const safeEntry = (0, file_utils_1.sanitizeArchiveEntry)(entry.path);
            const relEntry = (0, file_utils_1.stripArchiveCommonRoot)(safeEntry, commonRoot);
            if (!relEntry)
                continue;
            const destination = path_1.default.join(targetDir, relEntry);
            if (entry.type === 'Directory') {
                fs_1.default.mkdirSync(destination, { recursive: true });
                continue;
            }
            fs_1.default.mkdirSync(path_1.default.dirname(destination), { recursive: true });
            fs_1.default.writeFileSync(destination, await entry.buffer());
        }
        const primaryModelFile = (0, file_utils_1.findPrimaryModelFile)(targetDir);
        if (primaryModelFile) {
            this.state.addLog(`Primary model file: ${path_1.default.basename(primaryModelFile)}`);
            return primaryModelFile;
        }
        return targetDir;
    }
    waitForAssetEventOrTimeout(ms) {
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
    isInstantiableAsset(asset) {
        return !!asset.instantiation || asset.type === 'cc.Prefab' || asset.type.endsWith('Prefab');
    }
    getAssetPlacementScore(asset) {
        let score = 0;
        if (asset.type === 'cc.Prefab')
            score += 1000;
        if (asset.instantiation)
            score += 500;
        const ext = path_1.default.extname(asset.file || asset.url || '').toLowerCase();
        score += ({ '.prefab': 400, '.fbx': 300, '.glb': 280, '.gltf': 260, '.obj': 240 }[ext] || 0);
        if (asset.importer.includes('model'))
            score += 100;
        return score;
    }
    startHeartbeatMonitor() {
        this.stopHeartbeatMonitor();
        this.heartbeatTimer = setInterval(() => {
            if (!this.client)
                return;
            if (Date.now() - this.lastPingAt > protocol_1.HEARTBEAT_TIMEOUT_MS) {
                this.state.addLog('Heartbeat timeout, closing client connection.');
                this.client.close(1001, 'Heartbeat timeout');
            }
        }, 5000);
    }
    stopHeartbeatMonitor() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }
}
exports.BridgeServer = BridgeServer;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYnJpZGdlLXNlcnZlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL3NvdXJjZS9saWIvYnJpZGdlLXNlcnZlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUEsb0hBQW9IOzs7Ozs7QUFFcEgsNENBQW9CO0FBQ3BCLGdEQUF3QjtBQUV4Qix3REFBZ0M7QUFDaEMsMkJBQWdEO0FBRWhELHlDQXFCb0I7QUFDcEIsNkNBUXNCO0FBQ3RCLHlDQUE2QztBQUU3QyxtRUFBOEQ7QUEyQjlELE1BQWEsWUFBWTtJQVV2QixZQUE2QixLQUFrQjtRQUFsQixVQUFLLEdBQUwsS0FBSyxDQUFhO1FBVDlCLG9CQUFlLEdBQUcsSUFBSSwyQ0FBbUIsRUFBRSxDQUFDO1FBRXJELFFBQUcsR0FBMkIsSUFBSSxDQUFDO1FBQ25DLFdBQU0sR0FBcUIsSUFBSSxDQUFDO1FBQ2hDLG1CQUFjLEdBQTBCLElBQUksQ0FBQztRQUM3QyxlQUFVLEdBQUcsQ0FBQyxDQUFDO1FBQ04sd0JBQW1CLEdBQUcsSUFBSSxHQUFHLEVBQWMsQ0FBQztRQUM1QywyQkFBc0IsR0FBRyxJQUFJLEdBQUcsRUFBVSxDQUFDO1FBRzFELElBQUksQ0FBQyxlQUFlLEdBQUcsSUFBSSwwQkFBZSxDQUN4QyxDQUFDLEdBQUcsRUFBRSxFQUFFLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLEVBQy9CLENBQUMsTUFBTSxFQUFFLEVBQUUsQ0FBQyxJQUFJLENBQUMsY0FBYyxDQUFDLE1BQU0sQ0FBQyxFQUN2QyxDQUFDLE1BQU0sRUFBRSxFQUFFLENBQUMsSUFBSSxDQUFDLGdCQUFnQixDQUFDLE1BQU0sQ0FBQyxDQUMxQyxDQUFDO0lBQ0osQ0FBQztJQUVELHlCQUF5QjtJQUV6QixLQUFLO1FBQ0gsSUFBSSxJQUFJLENBQUMsR0FBRyxFQUFFLENBQUM7WUFDYixJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyx5QkFBeUIsQ0FBQyxDQUFDO1lBQzdD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MUIsSUFBSSxJQUFJLENBQUMsY0FBYyxFQUFFLENBQUM7WUFDeEIsYUFBYSxDQUFDLElBQUksQ0FBQyxjQUFjLENBQUMsQ0FBQztZQUNuQyxJQUFJLENBQUMsY0FBYyxHQUFHLElBQUksQ0FBQztRQUM3QixDQUFDO0lBQ0gsQ0FBQztDQUNGO0FBNWZELG9DQTRmQyIsInNvdXJjZXNDb250ZW50IjpbIi8vIEJyaWRnZSBXZWJTb2NrZXQgc2VydmVyIGZvciByZWNlaXZpbmcgVHJpcG8gYXNzZXRzLCBpbXBvcnRpbmcgdGhlbSBpbnRvIENvY29zLCBhbmQgcGxhY2luZyBtb2RlbHMgaW50byB0aGUgc2NlbmUuXG5cbmltcG9ydCBmcyBmcm9tICdmcyc7XG5pbXBvcnQgcGF0aCBmcm9tICdwYXRoJztcbmltcG9ydCB0eXBlIHsgSW5jb21pbmdNZXNzYWdlIH0gZnJvbSAnaHR0cCc7XG5pbXBvcnQgdW56aXBwZXIgZnJvbSAndW56aXBwZXInO1xuaW1wb3J0IHsgV2ViU29ja2V0LCBXZWJTb2NrZXRTZXJ2ZXIgfSBmcm9tICd3cyc7XG5pbXBvcnQgdHlwZSB7IFJhd0RhdGEgfSBmcm9tICd3cyc7XG5pbXBvcnQge1xuICBDSFVOS19TSVpFLFxuICBFUlJPUl9JTlZBTElEX0pTT04sXG4gIEVSUk9SX1BST0NFU1NJTkcsXG4gIEhFQVJUQkVBVF9USU1FT1VUX01TLFxuICBNU0dfRklMRV9UUkFOU0ZFUixcbiAgTVNHX0hBTkRTSEFLRSxcbiAgTVNHX1BJTkcsXG4gIFNFUlZFUl9IT1NULFxuICBTRVJWRVJfUE9SVCxcbiAgU1VQUE9SVEVEX0ZPUk1BVFMsXG4gIGNyZWF0ZUhhbmRzaGFrZUFjayxcbiAgY3JlYXRlUG9uZyxcbiAgY3JlYXRlRmlsZVRyYW5zZmVyQWNrLFxuICBjcmVhdGVUcmFuc2ZlckNvbXBsZXRlLFxuICBjcmVhdGVJbXBvcnRDb21wbGV0ZSxcbiAgc2FmZVBhcnNlSnNvbixcbiAgbm9ybWFsaXplUmF3RGF0YSxcbiAgZmluZEpzb25FbmQsXG4gIHVud3JhcFByb3BlcnR5U3RyaW5nLFxuICBnZXREaXNwbGF5RmlsZU5hbWUsXG59IGZyb20gJy4vcHJvdG9jb2wnO1xuaW1wb3J0IHtcbiAgc2FuaXRpemVCYXNlTmFtZSxcbiAgZW5zdXJlVW5pcXVlRGlyZWN0b3J5LFxuICBzYW5pdGl6ZUFyY2hpdmVFbnRyeSxcbiAgZ2V0QXJjaGl2ZUNvbW1vblJvb3QsXG4gIHN0cmlwQXJjaGl2ZUNvbW1vblJvb3QsXG4gIG5vcm1hbGl6ZUluY29taW5nRmlsZVR5cGUsXG4gIGZpbmRQcmltYXJ5TW9kZWxGaWxlLFxufSBmcm9tICcuL2ZpbGUtdXRpbHMnO1xuaW1wb3J0IHsgTWF0ZXJpYWxNYW5hZ2VyIH0gZnJvbSAnLi9tYXRlcmlhbCc7XG5pbXBvcnQgdHlwZSB7IEJyaWRnZVN0YXRlIH0gZnJvbSAnLi9zdGF0ZSc7XG5pbXBvcnQgeyBGaWxlVHJhbnNmZXJNYW5hZ2VyIH0gZnJvbSAnLi9maWxlLXRyYW5zZmVyLW1hbmFnZXInO1xuXG4vLyDigJTigJTigJTigJTigJQgdHlwZXMg4oCU4oCU4oCU4oCU4oCUXG5cbnR5cGUgQXNzZXRJbmZvTGlrZSA9IHtcbiAgdXVpZDogc3RyaW5nO1xuICB1cmw6IHN0cmluZztcbiAgZmlsZTogc3RyaW5nO1xuICB0eXBlOiBzdHJpbmc7XG4gIGltcG9ydGVyOiBzdHJpbmc7XG4gIGluc3RhbnRpYXRpb24/OiBzdHJpbmc7XG4gIGltcG9ydGVkOiBib29sZWFuO1xuICBpbnZhbGlkOiBib29sZWFuO1xuICBpc0RpcmVjdG9yeTogYm9vbGVhbjtcbn07XG5cbnR5cGUgU2NlbmVOb2RlTGlrZSA9IHtcbiAgdXVpZD86IHN0cmluZyB8IHsgdmFsdWU/OiB1bmtub3duIH07XG4gIG5hbWU/OiBzdHJpbmcgfCB7IHZhbHVlPzogdW5rbm93biB9O1xufTtcblxudHlwZSBBc3NldFNlYXJjaFJlc3VsdCA9IHtcbiAgYXNzZXQ6IEFzc2V0SW5mb0xpa2UgfCBudWxsO1xuICB0b3RhbENhbmRpZGF0ZXM6IG51bWJlcjtcbiAgaW5zdGFudGlhYmxlQ2FuZGlkYXRlczogbnVtYmVyO1xufTtcblxuZXhwb3J0IGNsYXNzIEJyaWRnZVNlcnZlciB7XG4gIHByaXZhdGUgcmVhZG9ubHkgdHJhbnNmZXJNYW5hZ2VyID0gbmV3IEZpbGVUcmFuc2Zlck1hbmFnZXIoKTtcbiAgcHJpdmF0ZSByZWFkb25seSBtYXRlcmlhbE1hbmFnZXI6IE1hdGVyaWFsTWFuYWdlcjtcbiAgcHJpdmF0ZSB3c3M6IFdlYlNvY2tldFNlcnZlciB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIGNsaWVudDogV2ViU29ja2V0IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgaGVhcnRiZWF0VGltZXI6IE5vZGVKUy5UaW1lb3V0IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgbGFzdFBpbmdBdCA9IDA7XG4gIHByaXZhdGUgcmVhZG9ubHkgYXNzZXRFdmVudFJlc29sdmVycyA9IG5ldyBTZXQ8KCkgPT4gdm9pZD4oKTtcbiAgcHJpdmF0ZSByZWFkb25seSBsb2dnZWRQcm90b2NvbFdhcm5pbmdzID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cbiAgY29uc3RydWN0b3IocHJpdmF0ZSByZWFkb25seSBzdGF0ZTogQnJpZGdlU3RhdGUpIHtcbiAgICB0aGlzLm1hdGVyaWFsTWFuYWdlciA9IG5ldyBNYXRlcmlhbE1hbmFnZXIoXG4gICAgICAobXNnKSA9PiB0aGlzLnN0YXRlLmFkZExvZyhtc2cpLFxuICAgICAgKGZzUGF0aCkgPT4gdGhpcy5nZXRBc3NldERiUGF0aChmc1BhdGgpLFxuICAgICAgKGZzUGF0aCkgPT4gdGhpcy50cnlSZWZyZXNoQXNzZXRzKGZzUGF0aCksXG4gICAgKTtcbiAgfVxuXG4gIC8vIOKAlOKAlOKAlOKAlOKAlCBwdWJsaWMgYXBpIOKAlOKAlOKAlOKAlOKAlFxuXG4gIHN0YXJ0KCkge1xuICAgIGlmICh0aGlzLndzcykge1xuICAgICAgdGhpcy5zdGF0ZS5hZGRMb2coJ1NlcnZlciBhbHJlYWR5IHJ1bm5pbmcuJyk7XG4gICAgICByZXR1cm4gdGhpcy5zdGF0ZS5zbmFwc2hvdCgpO1xuICAgIH1cblxuICAgIHRoaXMud3NzID0gbmV3IFdlYlNvY2tldFNlcnZlcih7XG4gICAgICBob3N0OiBTRVJWRVJfSE9TVCxcbiAgICAgIHBvcnQ6IFNFUlZFUl9QT1JULFxuICAgICAgbWF4UGF5bG9hZDogQ0hVTktfU0laRSArIDEwMjQgKiAxMDI0LFxuICAgIH0pO1xuXG4gICAgdGhpcy53c3Mub24oJ2Nvbm5lY3Rpb24nLCAoc29ja2V0OiBXZWJTb2NrZXQsIHJlcXVlc3Q6IEluY29taW5nTWVzc2FnZSkgPT4ge1xuICAgICAgaWYgKHRoaXMuY2xpZW50ICYmIHRoaXMuY2xpZW50ICE9PSBzb2NrZXQpIHtcbiAgICAgICAgdGhpcy5jbGllbnQuY2xvc2UoMTAwMCwgJ05ldyBjbGllbnQgY29ubmVjdGVkJyk7XG4gICAgICB9XG5cbiAgICAgIHRoaXMuY2xpZW50ID0gc29ja2V0O1xuICAgICAgdGhpcy5sb2dnZWRQcm90b2NvbFdhcm5pbmdzLmNsZWFyKCk7XG4gICAgICB0aGlzLmxhc3RQaW5nQXQgPSBEYXRlLm5vdygpO1xuICAgICAgdGhpcy5zdGF0ZS5zZXQoe1xuICAgICAgICBjb25uZWN0ZWQ6IHRydWUsXG4gICAgICAgIGNsaWVudE5hbWU6IHJlcXVlc3Quc29ja2V0LnJlbW90ZUFkZHJlc3MgfHwgJ1RyaXBvIFN0dWRpbycsXG4gICAgICB9KTtcbiAgICAgIHRoaXMuc3RhdGUuYWRkTG9nKCdDbGllbnQgY29ubmVjdGVkLicpO1xuXG4gICAgICBzb2NrZXQub24oJ21lc3NhZ2UnLCAoZGF0YTogUmF3RGF0YSwgaXNCaW5hcnk6IGJvb2xlYW4pID0+IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICB0aGlzLmhhbmRsZU1lc3NhZ2Uoc29ja2V0LCBub3JtYWxpemVSYXdEYXRhKGRhdGEpLCBpc0JpbmFyeSk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgY29uc3QgbWVzc2FnZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbiAgICAgICAgICB0aGlzLnN0YXRlLmFkZExvZyhgTWVzc2FnZSBoYW5kbGluZyBmYWlsZWQ6ICR7bWVzc2FnZX1gKTtcbiAgICAgICAgICB0aGlzLnNhZmVTZW5kKHNvY2tldCwgY3JlYXRlRmlsZVRyYW5zZmVyQWNrKCcnLCAwLCBmYWxzZSwgRVJST1JfUFJPQ0VTU0lORykpO1xuICAgICAgICB9XG4gICAgICB9KTtcblxuICAgICAgc29ja2V0Lm9uKCdjbG9zZScsICgpID0+IHtcbiAgICAgICAgaWYgKHRoaXMuY2xpZW50ID09PSBzb2NrZXQpIHtcbiAgICAgICAgICB0aGlzLmNsaWVudCA9IG51bGw7XG4gICAgICAgICAgdGhpcy5sb2dnZWRQcm90b2NvbFdhcm5pbmdzLmNsZWFyKCk7XG4gICAgICAgICAgdGhpcy5zdGF0ZS5zZXQoeyBjb25uZWN0ZWQ6IGZhbHNlLCBjbGllbnROYW1lOiAnJywgY3VycmVudEZpbGU6ICcnLCBwcm9ncmVzczogMCB9KTtcbiAgICAgICAgICB0aGlzLnN0YXRlLmFkZExvZygnQ2xpZW50IGRpc2Nvbm5lY3RlZC4nKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG5cbiAgICAgIHNvY2tldC5vbignZXJyb3InLCAoZXJyb3I6IEVycm9yKSA9PiB7XG4gICAgICAgIHRoaXMuc3RhdGUuYWRkTG9nKGBTb2NrZXQgZXJyb3I6ICR7ZXJyb3IubWVzc2FnZX1gKTtcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGhpcy53c3Mub24oJ2xpc3RlbmluZycsICgpID0+IHtcbiAgICAgIHRoaXMuc3RhdGUuc2V0KHsgc2VydmVyUnVubmluZzogdHJ1ZSwgcG9ydDogU0VSVkVSX1BPUlQgfSk7XG4gICAgICB0aGlzLnN0YXRlLmFkZExvZyhgU2VydmVyIGxpc3RlbmluZyBvbiB3czovLyR7U0VSVkVSX0hPU1R9OiR7U0VSVkVSX1BPUlR9YCk7XG4gICAgfSk7XG5cbiAgICB0aGlzLndzcy5vbignZXJyb3InLCAoZXJyb3I6IEVycm9yKSA9PiB7XG4gICAgICBjb25zdCBpc1BvcnRJblVzZSA9IGVycm9yLm1lc3NhZ2UuaW5jbHVkZXMoJ0VBRERSSU5VU0UnKTtcbiAgICAgIGlmIChpc1BvcnRJblVzZSkge1xuICAgICAgICB0aGlzLnN0b3BIZWFydGJlYXRNb25pdG9yKCk7XG4gICAgICAgIHRoaXMud3NzPy5jbG9zZSgpO1xuICAgICAgICB0aGlzLndzcyA9IG51bGw7XG4gICAgICAgIHRoaXMuc3RhdGUuc2V0KHsgcG9ydEluVXNlOiB0cnVlLCBzZXJ2ZXJSdW5uaW5nOiBmYWxzZSB9KTtcbiAgICAgICAgdGhpcy5zdGF0ZS5hZGRMb2coYFBvcnQgJHtTRVJWRVJfUE9SVH0gaXMgYWxyZWFkeSBpbiB1c2UuIFBsZWFzZSBzdG9wIHRoZSBzZXJ2ZXIgdXNpbmcgdGhlIHBvcnQgb3IgdXNlIGEgZGlmZmVyZW50IHBvcnQuYCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aGlzLnN0YXRlLmFkZExvZyhgU2VydmVyIGVycm9yOiAke2Vycm9yLm1lc3NhZ2V9YCk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICB0aGlzLnN0YXJ0SGVhcnRiZWF0TW9uaXRvcigpO1xuICAgIHJldHVybiB0aGlzLnN0YXRlLnNuYXBzaG90KCk7XG4gIH1cblxuICBzdG9wKCkge1xuICAgIHRoaXMuc3RvcEhlYXJ0YmVhdE1vbml0b3IoKTtcbiAgICB0aGlzLnRyYW5zZmVyTWFuYWdlci5jbGVhcigpO1xuICAgIHRoaXMubG9nZ2VkUHJvdG9jb2xXYXJuaW5ncy5jbGVhcigpO1xuXG4gICAgaWYgKHRoaXMuY2xpZW50KSB7XG4gICAgICB0aGlzLmNsaWVudC5jbG9zZSgxMDAwLCAnQnJpZGdlIHN0b3BwZWQnKTtcbiAgICAgIHRoaXMuY2xpZW50ID0gbnVsbDtcbiAgICB9XG5cbiAgICBpZiAodGhpcy53c3MpIHtcbiAgICAgIHRoaXMud3NzLmNsb3NlKCk7XG4gICAgICB0aGlzLndzcyA9IG51bGw7XG4gICAgfVxuXG4gICAgdGhpcy5zdGF0ZS5zZXQoe1xuICAgICAgc2VydmVyUnVubmluZzogZmFsc2UsXG4gICAgICBjb25uZWN0ZWQ6IGZhbHNlLFxuICAgICAgY2xpZW50TmFtZTogJycsXG4gICAgICBjdXJyZW50RmlsZTogJycsXG4gICAgICBwcm9ncmVzczogMCxcbiAgICAgIHBvcnRJblVzZTogZmFsc2UsXG4gICAgfSk7XG4gICAgdGhpcy5zdGF0ZS5hZGRMb2coJ1NlcnZlciBzdG9wcGVkLicpO1xuICAgIHJldHVybiB0aGlzLnN0YXRlLnNuYXBzaG90KCk7XG4gIH1cblxuICBxdWVyeVN0YXRlKCkge1xuICAgIHJldHVybiB0aGlzLnN0YXRlLnNuYXBzaG90KCk7XG4gIH1cblxuICBjbGVhckxvZ3MoKSB7XG4gICAgdGhpcy5zdGF0ZS5jbGVhckxvZ3MoKTtcbiAgICB0aGlzLmxvZ2dlZFByb3RvY29sV2FybmluZ3MuY2xlYXIoKTtcbiAgICByZXR1cm4gdGhpcy5zdGF0ZS5zbmFwc2hvdCgpO1xuICB9XG5cbiAgbm90aWZ5QXNzZXRFdmVudCgpIHtcbiAgICBmb3IgKGNvbnN0IHJlc29sdmVyIG9mIHRoaXMuYXNzZXRFdmVudFJlc29sdmVycykge1xuICAgICAgcmVzb2x2ZXIoKTtcbiAgICB9XG4gIH1cblxuICAvLyDigJTigJTigJTigJTigJQgaW1wbCDigJTigJTigJTigJTigJRcblxuICBwcml2YXRlIGhhbmRsZU1lc3NhZ2Uoc29ja2V0OiBXZWJTb2NrZXQsIGJ1ZmZlcjogQnVmZmVyLCBpc0JpbmFyeTogYm9vbGVhbikge1xuICAgIHRoaXMubGFzdFBpbmdBdCA9IERhdGUubm93KCk7XG5cbiAgICBpZiAoIWlzQmluYXJ5KSB7XG4gICAgICBjb25zdCBtZXNzYWdlID0gc2FmZVBhcnNlSnNvbihidWZmZXIudG9TdHJpbmcoJ3V0ZjgnKSk7XG4gICAgICBpZiAoIW1lc3NhZ2UpIHtcbiAgICAgICAgdGhpcy5sb2dQcm90b2NvbFdhcm5pbmdPbmNlKCdpbnZhbGlkLWpzb24tdGV4dCcsICdJbnZhbGlkIEpTT04gdGV4dCBtZXNzYWdlLicpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBpZiAobWVzc2FnZS50eXBlID09PSBNU0dfSEFORFNIQUtFKSB7XG4gICAgICAgIGNvbnN0IHBheWxvYWQgPSBtZXNzYWdlLnBheWxvYWQgfHwge307XG4gICAgICAgIHRoaXMuc3RhdGUuYWRkTG9nKGBIYW5kc2hha2UgZnJvbSAke3BheWxvYWQuY2xpZW50TmFtZSB8fCAndW5rbm93biBjbGllbnQnfS5gKTtcbiAgICAgICAgdGhpcy5zYWZlU2VuZChzb2NrZXQsIGNyZWF0ZUhhbmRzaGFrZUFjaygpKTtcbiAgICAgIH0gZWxzZSBpZiAobWVzc2FnZS50eXBlID09PSBNU0dfUElORykge1xuICAgICAgICB0aGlzLmxhc3RQaW5nQXQgPSBEYXRlLm5vdygpO1xuICAgICAgICB0aGlzLnNhZmVTZW5kKHNvY2tldCwgY3JlYXRlUG9uZygpKTtcbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCBqc29uRW5kID0gZmluZEpzb25FbmQoYnVmZmVyKTtcbiAgICBpZiAoanNvbkVuZCA8PSAwKSB7XG4gICAgICB0aGlzLmxvZ1Byb3RvY29sV2FybmluZ09uY2UoJ2ludmFsaWQtYmluYXJ5LXBhY2tldCcsICdJbnZhbGlkIGJpbmFyeSBwYWNrZXQ6IEpTT04gaGVhZGVyIG5vdCBmb3VuZC4nLCAnanNvbi1oZWFkZXItbm90LWZvdW5kJyk7XG4gICAgICB0aGlzLnNhZmVTZW5kKHNvY2tldCwgY3JlYXRlRmlsZVRyYW5zZmVyQWNrKCcnLCAwLCBmYWxzZSwgRVJST1JfSU5WQUxJRF9KU09OKSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgaGVhZGVyID0gc2FmZVBhcnNlSnNvbihidWZmZXIuc3ViYXJyYXkoMCwganNvbkVuZCkudG9TdHJpbmcoJ3V0ZjgnKSk7XG4gICAgaWYgKCFoZWFkZXIpIHtcbiAgICAgIHRoaXMubG9nUHJvdG9jb2xXYXJuaW5nT25jZSgnaW52YWxpZC1iaW5hcnktcGFja2V0JywgJ0ludmFsaWQgYmluYXJ5IHBhY2tldCBKU09OIGhlYWRlci4nLCAnanNvbi1oZWFkZXItaW52YWxpZCcpO1xuICAgICAgdGhpcy5zYWZlU2VuZChzb2NrZXQsIGNyZWF0ZUZpbGVUcmFuc2ZlckFjaygnJywgMCwgZmFsc2UsIEVSUk9SX0lOVkFMSURfSlNPTikpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmIChoZWFkZXIudHlwZSA9PT0gTVNHX1BJTkcpIHtcbiAgICAgIHRoaXMubGFzdFBpbmdBdCA9IERhdGUubm93KCk7XG4gICAgICB0aGlzLnNhZmVTZW5kKHNvY2tldCwgY3JlYXRlUG9uZygpKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAoaGVhZGVyLnR5cGUgIT09IE1TR19GSUxFX1RSQU5TRkVSKSByZXR1cm47XG5cbiAgICB2b2lkIHRoaXMuaGFuZGxlRmlsZVRyYW5zZmVyKHNvY2tldCwgaGVhZGVyLnBheWxvYWQgfHwge30sIGJ1ZmZlci5zdWJhcnJheShqc29uRW5kKSkuY2F0Y2goKGVycm9yOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCBtZXNzYWdlID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xuICAgICAgdGhpcy5zdGF0ZS5hZGRMb2coYFVuZXhwZWN0ZWQgZmlsZSB0cmFuc2ZlciBlcnJvcjogJHttZXNzYWdlfWApO1xuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBoYW5kbGVGaWxlVHJhbnNmZXIoc29ja2V0OiBXZWJTb2NrZXQsIHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIGFueT4sIGNodW5rRGF0YTogQnVmZmVyKSB7XG4gICAgY29uc3QgZmlsZUlkID0gU3RyaW5nKHBheWxvYWQuZmlsZUlkIHx8ICcnKTtcbiAgICBjb25zdCBmaWxlTmFtZSA9IFN0cmluZyhwYXlsb2FkLmZpbGVOYW1lIHx8ICdtb2RlbCcpO1xuICAgIGNvbnN0IGZpbGVUeXBlID0gbm9ybWFsaXplSW5jb21pbmdGaWxlVHlwZShmaWxlTmFtZSwgU3RyaW5nKHBheWxvYWQuZmlsZVR5cGUgfHwgJycpKTtcbiAgICBjb25zdCBjaHVua0luZGV4ID0gTnVtYmVyKHBheWxvYWQuY2h1bmtJbmRleCB8fCAwKTtcbiAgICBjb25zdCBjaHVua1RvdGFsID0gTnVtYmVyKHBheWxvYWQuY2h1bmtUb3RhbCB8fCAxKTtcblxuICAgIGlmICghZmlsZUlkIHx8ICFTVVBQT1JURURfRk9STUFUUy5oYXMoZmlsZVR5cGUpKSB7XG4gICAgICBjb25zdCByZWplY3Rpb25NZXNzYWdlID0gYFVuc3VwcG9ydGVkIHRyYW5zZmVyIHBheWxvYWQgZm9yICR7ZmlsZU5hbWV9LiBTdXBwb3J0ZWQgZm9ybWF0czogJHtbLi4uU1VQUE9SVEVEX0ZPUk1BVFNdLmpvaW4oJywgJyl9LmA7XG4gICAgICBjb25zdCByZWplY3Rpb25EZXRhaWwgPSBgJHtmaWxlTmFtZX18JHtmaWxlVHlwZSB8fCAndW5rbm93bid9fCR7ZmlsZUlkID8gJ3dpdGgtaWQnIDogJ21pc3NpbmctaWQnfWA7XG4gICAgICB0aGlzLmxvZ1Byb3RvY29sV2FybmluZ09uY2UoJ3Vuc3VwcG9ydGVkLXRyYW5zZmVyLXBheWxvYWQnLCByZWplY3Rpb25NZXNzYWdlLCByZWplY3Rpb25EZXRhaWwpO1xuICAgICAgdGhpcy5zYWZlU2VuZChzb2NrZXQsIGNyZWF0ZUZpbGVUcmFuc2ZlckFjayhmaWxlSWQsIGNodW5rSW5kZXgsIGZhbHNlLCBFUlJPUl9QUk9DRVNTSU5HKSk7XG4gICAgICBpZiAoZmlsZUlkKSB0aGlzLnNhZmVTZW5kKHNvY2tldCwgY3JlYXRlSW1wb3J0Q29tcGxldGUoZmlsZUlkLCBmYWxzZSwgcmVqZWN0aW9uTWVzc2FnZSwgJycpKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICB0aGlzLnRyYW5zZmVyTWFuYWdlci5hZGRDaHVuayhmaWxlSWQsIGZpbGVOYW1lLCBmaWxlVHlwZSwgY2h1bmtJbmRleCwgY2h1bmtUb3RhbCwgY2h1bmtEYXRhKTtcbiAgICB0aGlzLnN0YXRlLnNldCh7XG4gICAgICBjdXJyZW50RmlsZTogZ2V0RGlzcGxheUZpbGVOYW1lKGZpbGVOYW1lKSxcbiAgICAgIHByb2dyZXNzOiBOdW1iZXIoKChjaHVua0luZGV4ICsgMSkgLyBjaHVua1RvdGFsKS50b0ZpeGVkKDQpKSxcbiAgICB9KTtcbiAgICB0aGlzLnNhZmVTZW5kKHNvY2tldCwgY3JlYXRlRmlsZVRyYW5zZmVyQWNrKGZpbGVJZCwgY2h1bmtJbmRleCwgdHJ1ZSkpO1xuXG4gICAgaWYgKCF0aGlzLnRyYW5zZmVyTWFuYWdlci5pc0NvbXBsZXRlKGZpbGVJZCkpIHJldHVybjtcblxuICAgIHRoaXMuc2FmZVNlbmQoc29ja2V0LCBjcmVhdGVUcmFuc2ZlckNvbXBsZXRlKGZpbGVJZCkpO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGZpbGVCdWZmZXIgPSB0aGlzLnRyYW5zZmVyTWFuYWdlci5hc3NlbWJsZUZpbGUoZmlsZUlkKTtcbiAgICAgIGNvbnN0IHNhdmVkUGF0aCA9IGF3YWl0IHRoaXMuZXh0cmFjdEluY29taW5nQXJjaGl2ZShmaWxlTmFtZSwgZmlsZVR5cGUsIGZpbGVCdWZmZXIpO1xuICAgICAgdGhpcy50cmFuc2Zlck1hbmFnZXIucmVtb3ZlU2Vzc2lvbihmaWxlSWQpO1xuICAgICAgY29uc3QgZGlzcGxheUZpbGVOYW1lID0gZ2V0RGlzcGxheUZpbGVOYW1lKGZpbGVOYW1lKTtcblxuICAgICAgdGhpcy5zdGF0ZS5zZXQoeyBwcm9ncmVzczogMSwgbGFzdFNhdmVkUGF0aDogc2F2ZWRQYXRoIH0pO1xuICAgICAgdGhpcy5zdGF0ZS5hZGRMb2coZmlsZVR5cGUgPT09ICd6aXAnID8gJ0V4dHJhY3RlZCBaSVAgdG8gYXNzZXRzLicgOiBgU2F2ZWQgJHtmaWxlVHlwZS50b1VwcGVyQ2FzZSgpfSB0byBhc3NldHMuYCk7XG5cbiAgICAgIGF3YWl0IHRoaXMudHJ5UmVmcmVzaEFzc2V0cyhzYXZlZFBhdGgpO1xuXG4gICAgICBsZXQgY29tcGxldGlvbk1lc3NhZ2UgPSBmaWxlVHlwZSA9PT0gJ3ppcCdcbiAgICAgICAgPyAnWklQIGV4dHJhY3RlZCBpbnRvIHByb2plY3QgYXNzZXRzLidcbiAgICAgICAgOiBgJHtmaWxlVHlwZS50b1VwcGVyQ2FzZSgpfSBzYXZlZCBpbnRvIHByb2plY3QgYXNzZXRzLmA7XG5cbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHBsYWNlbWVudCA9IGF3YWl0IHRoaXMudHJ5UGxhY2VJbXBvcnRlZE1vZGVsSW5TY2VuZShzYXZlZFBhdGgsIGRpc3BsYXlGaWxlTmFtZSk7XG4gICAgICAgIGlmIChwbGFjZW1lbnQpIHtcbiAgICAgICAgICB0aGlzLnN0YXRlLmFkZExvZygnTW9kZWwgaW1wb3J0ZWQgYW5kIGFkZGVkIHRvIHNjZW5lLicpO1xuICAgICAgICAgIGNvbXBsZXRpb25NZXNzYWdlID0gJ01vZGVsIGltcG9ydGVkIGFuZCBhZGRlZCB0byB0aGUgY3VycmVudCBzY2VuZS4nO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRoaXMuc3RhdGUuYWRkTG9nKCdNb2RlbCBzYXZlZCBidXQgY291bGQgbm90IGJlIHBsYWNlZCBpbiBzY2VuZS4nKTtcbiAgICAgICAgICBjb21wbGV0aW9uTWVzc2FnZSA9IGZpbGVUeXBlID09PSAnemlwJ1xuICAgICAgICAgICAgPyAnWklQIGV4dHJhY3RlZCBpbnRvIHByb2plY3QgYXNzZXRzLCBidXQgdGhlIG1vZGVsIHdhcyBub3QgYWRkZWQgdG8gdGhlIGN1cnJlbnQgc2NlbmUuJ1xuICAgICAgICAgICAgOiBgJHtmaWxlVHlwZS50b1VwcGVyQ2FzZSgpfSBzYXZlZCBpbnRvIHByb2plY3QgYXNzZXRzLCBidXQgdGhlIG1vZGVsIHdhcyBub3QgYWRkZWQgdG8gdGhlIGN1cnJlbnQgc2NlbmUuYDtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgY29uc3QgbWVzc2FnZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbiAgICAgICAgdGhpcy5zdGF0ZS5hZGRMb2coYFNjZW5lIHBsYWNlbWVudCBmYWlsZWQ6ICR7bWVzc2FnZX1gKTtcbiAgICAgICAgY29tcGxldGlvbk1lc3NhZ2UgPSBmaWxlVHlwZSA9PT0gJ3ppcCdcbiAgICAgICAgICA/IGBaSVAgZXh0cmFjdGVkIGludG8gcHJvamVjdCBhc3NldHMsIGJ1dCBzY2VuZSBwbGFjZW1lbnQgZmFpbGVkOiAke21lc3NhZ2V9YFxuICAgICAgICAgIDogYCR7ZmlsZVR5cGUudG9VcHBlckNhc2UoKX0gc2F2ZWQgaW50byBwcm9qZWN0IGFzc2V0cywgYnV0IHNjZW5lIHBsYWNlbWVudCBmYWlsZWQ6ICR7bWVzc2FnZX1gO1xuICAgICAgfVxuXG4gICAgICB0aGlzLnNhZmVTZW5kKHNvY2tldCwgY3JlYXRlSW1wb3J0Q29tcGxldGUoZmlsZUlkLCB0cnVlLCBjb21wbGV0aW9uTWVzc2FnZSwgc2F2ZWRQYXRoKSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIHRoaXMudHJhbnNmZXJNYW5hZ2VyLnJlbW92ZVNlc3Npb24oZmlsZUlkKTtcbiAgICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG4gICAgICB0aGlzLnN0YXRlLmFkZExvZyhgRmFpbGVkIHRvIHNhdmUgdHJhbnNmZXI6ICR7bWVzc2FnZX1gKTtcbiAgICAgIHRoaXMuc2FmZVNlbmQoc29ja2V0LCBjcmVhdGVJbXBvcnRDb21wbGV0ZShmaWxlSWQsIGZhbHNlLCBtZXNzYWdlLCAnJykpO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgdHJ5UmVmcmVzaEFzc2V0cyhzYXZlZFBhdGg6IHN0cmluZyk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICAgIGlmICghZ2xvYmFsVGhpcy5FZGl0b3IgfHwgIUVkaXRvci5NZXNzYWdlIHx8ICFFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KSByZXR1cm4gZmFsc2U7XG5cbiAgICBjb25zdCByZWZyZXNoVGFyZ2V0ID0gZnMuZXhpc3RzU3luYyhzYXZlZFBhdGgpICYmIGZzLnN0YXRTeW5jKHNhdmVkUGF0aCkuaXNEaXJlY3RvcnkoKVxuICAgICAgPyBzYXZlZFBhdGhcbiAgICAgIDogcGF0aC5kaXJuYW1lKHNhdmVkUGF0aCk7XG4gICAgY29uc3QgZGJQYXRoID0gdGhpcy5nZXRBc3NldERiUGF0aChyZWZyZXNoVGFyZ2V0KTtcbiAgICBjb25zdCBjYW5kaWRhdGVzOiBBcnJheTxbc3RyaW5nLCBzdHJpbmcsIHN0cmluZ10+ID0gW1xuICAgICAgWydhc3NldC1kYicsICdyZWZyZXNoLWFzc2V0JywgZGJQYXRoXSxcbiAgICAgIFsnYXNzZXQtZGInLCAncmVmcmVzaC1hc3NldCcsICdkYjovL2Fzc2V0cy9Ucmlwb01vZGVscyddLFxuICAgICAgWydhc3NldC1kYicsICdyZWZyZXNoJywgJ2RiOi8vYXNzZXRzL1RyaXBvTW9kZWxzJ10sXG4gICAgXTtcblxuICAgIGZvciAoY29uc3QgW3BrZywgbXNnLCB0YXJnZXRdIG9mIGNhbmRpZGF0ZXMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QocGtnLCBtc2csIHRhcmdldCk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgIH1cblxuICAgIHRoaXMuc3RhdGUuYWRkTG9nKCdBc3NldCByZWZyZXNoOiBhbGwgc3RyYXRlZ2llcyBmYWlsZWQuJyk7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyB0cnlQbGFjZUltcG9ydGVkTW9kZWxJblNjZW5lKHNhdmVkUGF0aDogc3RyaW5nLCBkaXNwbGF5TmFtZTogc3RyaW5nKSB7XG4gICAgaWYgKCFnbG9iYWxUaGlzLkVkaXRvciB8fCAhRWRpdG9yLk1lc3NhZ2UgfHwgIUVkaXRvci5NZXNzYWdlLnJlcXVlc3QpIHJldHVybiBudWxsO1xuXG4gICAgY29uc3QgYXNzZXQgPSBhd2FpdCB0aGlzLndhaXRGb3JJbnN0YW50aWFibGVBc3NldChzYXZlZFBhdGgpO1xuICAgIGlmICghYXNzZXQpIHtcbiAgICAgIHRoaXMuc3RhdGUuYWRkTG9nKCdObyBpbnN0YW50aWFibGUgbW9kZWwgYXNzZXQgZm91bmQuJyk7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG5cbiAgICBjb25zdCBzY2VuZVRyZWUgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdxdWVyeS1ub2RlLXRyZWUnKSBhcyB1bmtub3duIGFzIFNjZW5lTm9kZUxpa2UgfCBudWxsO1xuICAgIGNvbnN0IHNjZW5lUm9vdFV1aWQgPSB1bndyYXBQcm9wZXJ0eVN0cmluZyhzY2VuZVRyZWU/LnV1aWQpO1xuICAgIGlmICghc2NlbmVSb290VXVpZCkgdGhyb3cgbmV3IEVycm9yKCdObyBvcGVuIHNjZW5lIGlzIGF2YWlsYWJsZS4nKTtcblxuICAgIGNvbnN0IGNyZWF0ZWROb2RlVXVpZCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ2NyZWF0ZS1ub2RlJywge1xuICAgICAgcGFyZW50OiBzY2VuZVJvb3RVdWlkLFxuICAgICAgbmFtZTogZGlzcGxheU5hbWUsXG4gICAgICBhc3NldFV1aWQ6IGFzc2V0LnV1aWQsXG4gICAgICB0eXBlOiBhc3NldC50eXBlLFxuICAgICAgbmFtZUluY3JlYXNlOiB0cnVlLFxuICAgICAgcG9zaXRpb246IHsgeDogMCwgeTogMCwgejogMCB9LFxuICAgICAgc25hcHNob3Q6IHRydWUsXG4gICAgICB1bmxpbmtQcmVmYWI6IGZhbHNlLFxuICAgIH0pO1xuXG4gICAgdGhpcy5zdGF0ZS5hZGRMb2coYE5vZGUgY3JlYXRlZDogJHtkaXNwbGF5TmFtZX1gKTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCBtYXRSZXN1bHQgPSBhd2FpdCB0aGlzLm1hdGVyaWFsTWFuYWdlci5lbnN1cmVEZWZhdWx0TWF0ZXJpYWwoc2F2ZWRQYXRoLCBTdHJpbmcoY3JlYXRlZE5vZGVVdWlkKSk7XG4gICAgICBpZiAobWF0UmVzdWx0LmFwcGxpZWQgPiAwKSB7XG4gICAgICAgIHRoaXMuc3RhdGUuYWRkTG9nKGBNYXRlcmlhbCBhcHBsaWVkIHRvICR7bWF0UmVzdWx0LmFwcGxpZWR9IHNsb3QocykuYCk7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG4gICAgICB0aGlzLnN0YXRlLmFkZExvZyhgTWF0ZXJpYWwgYXNzaWdubWVudCBmYWlsZWQ6ICR7bWVzc2FnZX1gKTtcbiAgICB9XG5cbiAgICByZXR1cm4geyBhc3NldFVybDogYXNzZXQudXJsIH07XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHdhaXRGb3JJbnN0YW50aWFibGVBc3NldChzYXZlZFBhdGg6IHN0cmluZywgdGltZW91dE1zID0gMTUwMDApIHtcbiAgICBjb25zdCBhc3NldFBhdGhFeGlzdHMgPSBmcy5leGlzdHNTeW5jKHNhdmVkUGF0aCk7XG4gICAgY29uc3QgYXNzZXRJc0RpcmVjdG9yeSA9IGFzc2V0UGF0aEV4aXN0cyAmJiBmcy5zdGF0U3luYyhzYXZlZFBhdGgpLmlzRGlyZWN0b3J5KCk7XG4gICAgY29uc3Qgc2VhcmNoRGlyID0gYXNzZXRJc0RpcmVjdG9yeSA/IHNhdmVkUGF0aCA6IHBhdGguZGlybmFtZShzYXZlZFBhdGgpO1xuICAgIGNvbnN0IGV4YWN0QXNzZXREYlBhdGggPSBhc3NldFBhdGhFeGlzdHMgJiYgIWFzc2V0SXNEaXJlY3RvcnkgPyB0aGlzLmdldEFzc2V0RGJQYXRoKHNhdmVkUGF0aCkgOiAnJztcbiAgICBjb25zdCBzZWFyY2hEaXJEYlBhdGggPSB0aGlzLmdldEFzc2V0RGJQYXRoKHNlYXJjaERpcik7XG4gICAgY29uc3Qgc3RhcnRlZEF0ID0gRGF0ZS5ub3coKTtcblxuICAgIHdoaWxlICgoRGF0ZS5ub3coKSAtIHN0YXJ0ZWRBdCkgPCB0aW1lb3V0TXMpIHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRoaXMuZmluZEJlc3RJbnN0YW50aWFibGVBc3NldChleGFjdEFzc2V0RGJQYXRoLCBzZWFyY2hEaXJEYlBhdGgpO1xuICAgICAgaWYgKHJlc3VsdC5hc3NldCkgcmV0dXJuIHJlc3VsdC5hc3NldDtcbiAgICAgIGF3YWl0IHRoaXMud2FpdEZvckFzc2V0RXZlbnRPclRpbWVvdXQoTWF0aC5taW4oMzAwMCwgdGltZW91dE1zIC0gKERhdGUubm93KCkgLSBzdGFydGVkQXQpKSk7XG4gICAgfVxuXG4gICAgdGhpcy5zdGF0ZS5hZGRMb2coJ1RpbWVkIG91dCB3YWl0aW5nIGZvciBhc3NldCBpbXBvcnQuJyk7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGZpbmRCZXN0SW5zdGFudGlhYmxlQXNzZXQoZXhhY3RBc3NldERiUGF0aDogc3RyaW5nLCBzZWFyY2hEaXJEYlBhdGg6IHN0cmluZyk6IFByb21pc2U8QXNzZXRTZWFyY2hSZXN1bHQ+IHtcbiAgICBjb25zdCBjYW5kaWRhdGVzOiBBc3NldEluZm9MaWtlW10gPSBbXTtcbiAgICBjb25zdCBmaWVsZHM6IChrZXlvZiBBc3NldEluZm9MaWtlKVtdID0gWyd1dWlkJywgJ3VybCcsICdmaWxlJywgJ3R5cGUnLCAnaW1wb3J0ZXInLCAnaW5zdGFudGlhdGlvbicsICdpbXBvcnRlZCcsICdpbnZhbGlkJywgJ2lzRGlyZWN0b3J5J107XG5cbiAgICBpZiAoZXhhY3RBc3NldERiUGF0aCkge1xuICAgICAgY29uc3QgZXhhY3QgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdhc3NldC1kYicsICdxdWVyeS1hc3NldC1pbmZvJywgZXhhY3RBc3NldERiUGF0aCwgZmllbGRzKSBhcyBBc3NldEluZm9MaWtlIHwgbnVsbDtcbiAgICAgIGlmIChleGFjdCkgY2FuZGlkYXRlcy5wdXNoKGV4YWN0KTtcbiAgICB9XG5cbiAgICBjb25zdCBzY2FubmVkOiBBc3NldEluZm9MaWtlW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IHBhdHRlcm4gb2YgW2Ake3NlYXJjaERpckRiUGF0aH0vKmAsIGAke3NlYXJjaERpckRiUGF0aH0vKipgLCBgJHtzZWFyY2hEaXJEYlBhdGh9LyoqLypgXSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgYXNzZXRzID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnYXNzZXQtZGInLCAncXVlcnktYXNzZXRzJywgeyBwYXR0ZXJuIH0sIGZpZWxkcykgYXMgQXNzZXRJbmZvTGlrZVtdO1xuICAgICAgICBzY2FubmVkLnB1c2goLi4uYXNzZXRzKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgY29uc3QgdW5pcXVlID0gWy4uLmNhbmRpZGF0ZXMsIC4uLnNjYW5uZWRdLmZpbHRlcigoYSkgPT4ge1xuICAgICAgaWYgKCFhPy51dWlkIHx8IHNlZW4uaGFzKGEudXVpZCkpIHJldHVybiBmYWxzZTtcbiAgICAgIHNlZW4uYWRkKGEudXVpZCk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9KTtcblxuICAgIGNvbnN0IHJlYWR5ID0gdW5pcXVlXG4gICAgICAuZmlsdGVyKChhKSA9PiBhLmltcG9ydGVkICYmICFhLmludmFsaWQgJiYgIWEuaXNEaXJlY3RvcnkgJiYgdGhpcy5pc0luc3RhbnRpYWJsZUFzc2V0KGEpKVxuICAgICAgLnNvcnQoKGEsIGIpID0+IHRoaXMuZ2V0QXNzZXRQbGFjZW1lbnRTY29yZShiKSAtIHRoaXMuZ2V0QXNzZXRQbGFjZW1lbnRTY29yZShhKSk7XG5cbiAgICByZXR1cm4geyBhc3NldDogcmVhZHlbMF0gfHwgbnVsbCwgdG90YWxDYW5kaWRhdGVzOiB1bmlxdWUubGVuZ3RoLCBpbnN0YW50aWFibGVDYW5kaWRhdGVzOiByZWFkeS5sZW5ndGggfTtcbiAgfVxuXG4gIC8vIOKAlOKAlOKAlOKAlOKAlCBpbnRlcm5hbCDigJTigJTigJTigJTigJRcblxuICBwcml2YXRlIGJ1aWxkUHJvdG9jb2xXYXJuaW5nS2V5KHNjb3BlOiBzdHJpbmcsIGRldGFpbCA9ICcnKSB7XG4gICAgcmV0dXJuIGAke3Njb3BlfToke1N0cmluZyhkZXRhaWwgfHwgJycpLnRyaW0oKS50b0xvd2VyQ2FzZSgpfWA7XG4gIH1cblxuICBwcml2YXRlIGxvZ1Byb3RvY29sV2FybmluZ09uY2Uoc2NvcGU6IHN0cmluZywgbWVzc2FnZTogc3RyaW5nLCBkZXRhaWwgPSAnJykge1xuICAgIGNvbnN0IGtleSA9IHRoaXMuYnVpbGRQcm90b2NvbFdhcm5pbmdLZXkoc2NvcGUsIGRldGFpbCk7XG4gICAgaWYgKHRoaXMubG9nZ2VkUHJvdG9jb2xXYXJuaW5ncy5oYXMoa2V5KSkgcmV0dXJuO1xuICAgIHRoaXMubG9nZ2VkUHJvdG9jb2xXYXJuaW5ncy5hZGQoa2V5KTtcbiAgICB0aGlzLnN0YXRlLmFkZExvZyhtZXNzYWdlKTtcbiAgfVxuXG4gIHByaXZhdGUgc2FmZVNlbmQoc29ja2V0OiBXZWJTb2NrZXQgfCBudWxsLCBwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCBhbnk+KSB7XG4gICAgaWYgKCFzb2NrZXQgfHwgc29ja2V0LnJlYWR5U3RhdGUgIT09IFdlYlNvY2tldC5PUEVOKSByZXR1cm47XG4gICAgc29ja2V0LnNlbmQoSlNPTi5zdHJpbmdpZnkocGF5bG9hZCkpO1xuICB9XG5cbiAgcHJpdmF0ZSBnZXRQcm9qZWN0UGF0aCgpIHtcbiAgICBpZiAoZ2xvYmFsVGhpcy5FZGl0b3IgJiYgRWRpdG9yLlByb2plY3QgJiYgRWRpdG9yLlByb2plY3QucGF0aCkge1xuICAgICAgcmV0dXJuIEVkaXRvci5Qcm9qZWN0LnBhdGg7XG4gICAgfVxuICAgIHJldHVybiBwcm9jZXNzLmN3ZCgpO1xuICB9XG5cbiAgcHJpdmF0ZSBnZXRNb2RlbFJvb3REaXIoKSB7XG4gICAgcmV0dXJuIHBhdGguam9pbih0aGlzLmdldFByb2plY3RQYXRoKCksICdhc3NldHMnLCAnVHJpcG9Nb2RlbHMnKTtcbiAgfVxuXG4gIHByaXZhdGUgZ2V0QXNzZXREYlBhdGgodGFyZ2V0UGF0aDogc3RyaW5nKSB7XG4gICAgY29uc3QgcHJvamVjdFBhdGggPSB0aGlzLmdldFByb2plY3RQYXRoKCk7XG4gICAgY29uc3QgcmVsYXRpdmVQYXRoID0gcGF0aC5yZWxhdGl2ZShwcm9qZWN0UGF0aCwgdGFyZ2V0UGF0aCkucmVwbGFjZSgvXFxcXC9nLCAnLycpO1xuICAgIGlmICghcmVsYXRpdmVQYXRoIHx8IHJlbGF0aXZlUGF0aC5zdGFydHNXaXRoKCcuLicpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFBhdGggaXMgb3V0c2lkZSB0aGUgY3VycmVudCBwcm9qZWN0OiAke3RhcmdldFBhdGh9YCk7XG4gICAgfVxuICAgIHJldHVybiBgZGI6Ly8ke3JlbGF0aXZlUGF0aH1gO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBleHRyYWN0SW5jb21pbmdBcmNoaXZlKGZpbGVOYW1lOiBzdHJpbmcsIGZpbGVUeXBlOiBzdHJpbmcsIGZpbGVCdWZmZXI6IEJ1ZmZlcikge1xuICAgIGNvbnN0IG1vZGVsUm9vdERpciA9IHRoaXMuZ2V0TW9kZWxSb290RGlyKCk7XG4gICAgZnMubWtkaXJTeW5jKG1vZGVsUm9vdERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgICBjb25zdCBiYXNlTmFtZSA9IHNhbml0aXplQmFzZU5hbWUoZmlsZU5hbWUpO1xuICAgIGNvbnN0IHVuaXF1ZURpck5hbWUgPSBlbnN1cmVVbmlxdWVEaXJlY3RvcnkobW9kZWxSb290RGlyLCBiYXNlTmFtZSk7XG4gICAgY29uc3QgdGFyZ2V0RGlyID0gcGF0aC5qb2luKG1vZGVsUm9vdERpciwgdW5pcXVlRGlyTmFtZSk7XG4gICAgZnMubWtkaXJTeW5jKHRhcmdldERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgICBpZiAoZmlsZVR5cGUgIT09ICd6aXAnKSB7XG4gICAgICBsZXQgdGFyZ2V0RmlsZU5hbWUgPSBwYXRoLmJhc2VuYW1lKGZpbGVOYW1lIHx8IGAke2Jhc2VOYW1lfS4ke2ZpbGVUeXBlIHx8ICdiaW4nfWApO1xuICAgICAgaWYgKCFwYXRoLmV4dG5hbWUodGFyZ2V0RmlsZU5hbWUpICYmIGZpbGVUeXBlKSB7XG4gICAgICAgIHRhcmdldEZpbGVOYW1lID0gYCR7dGFyZ2V0RmlsZU5hbWV9LiR7ZmlsZVR5cGV9YDtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGRlc3RpbmF0aW9uID0gcGF0aC5qb2luKHRhcmdldERpciwgdGFyZ2V0RmlsZU5hbWUgfHwgYCR7YmFzZU5hbWV9LiR7ZmlsZVR5cGUgfHwgJ2Jpbid9YCk7XG4gICAgICBmcy53cml0ZUZpbGVTeW5jKGRlc3RpbmF0aW9uLCBmaWxlQnVmZmVyKTtcbiAgICAgIHRoaXMuc3RhdGUuYWRkTG9nKGBTYXZlZCAke2ZpbGVUeXBlIHx8ICdiaW5hcnknfSBmaWxlLmApO1xuICAgICAgcmV0dXJuIGRlc3RpbmF0aW9uO1xuICAgIH1cblxuICAgIHRoaXMuc3RhdGUuYWRkTG9nKCdFeHRyYWN0aW5nIFpJUC4uLicpO1xuICAgIHJldHVybiB0aGlzLmV4dHJhY3RaaXBXaXRoVW56aXBwZXIodGFyZ2V0RGlyLCBmaWxlQnVmZmVyKTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgZXh0cmFjdFppcFdpdGhVbnppcHBlcih0YXJnZXREaXI6IHN0cmluZywgZmlsZUJ1ZmZlcjogQnVmZmVyKSB7XG4gICAgY29uc3QgZGlyZWN0b3J5ID0gYXdhaXQgdW56aXBwZXIuT3Blbi5idWZmZXIoZmlsZUJ1ZmZlcik7XG4gICAgaWYgKGRpcmVjdG9yeS5maWxlcy5sZW5ndGggPT09IDApIHRocm93IG5ldyBFcnJvcignWklQIGFyY2hpdmUgaXMgZW1wdHkuJyk7XG5cbiAgICBjb25zdCBjb21tb25Sb290ID0gZ2V0QXJjaGl2ZUNvbW1vblJvb3QoZGlyZWN0b3J5LmZpbGVzLm1hcCgoZSkgPT4gKHtcbiAgICAgIGVudHJ5TmFtZTogZS5wYXRoLFxuICAgICAgaXNEaXJlY3Rvcnk6IGUudHlwZSA9PT0gJ0RpcmVjdG9yeScsXG4gICAgfSkpKTtcblxuICAgIGZvciAoY29uc3QgZW50cnkgb2YgZGlyZWN0b3J5LmZpbGVzKSB7XG4gICAgICBjb25zdCBzYWZlRW50cnkgPSBzYW5pdGl6ZUFyY2hpdmVFbnRyeShlbnRyeS5wYXRoKTtcbiAgICAgIGNvbnN0IHJlbEVudHJ5ID0gc3RyaXBBcmNoaXZlQ29tbW9uUm9vdChzYWZlRW50cnksIGNvbW1vblJvb3QpO1xuICAgICAgaWYgKCFyZWxFbnRyeSkgY29udGludWU7XG5cbiAgICAgIGNvbnN0IGRlc3RpbmF0aW9uID0gcGF0aC5qb2luKHRhcmdldERpciwgcmVsRW50cnkpO1xuICAgICAgaWYgKGVudHJ5LnR5cGUgPT09ICdEaXJlY3RvcnknKSB7XG4gICAgICAgIGZzLm1rZGlyU3luYyhkZXN0aW5hdGlvbiwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICBmcy5ta2RpclN5bmMocGF0aC5kaXJuYW1lKGRlc3RpbmF0aW9uKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICBmcy53cml0ZUZpbGVTeW5jKGRlc3RpbmF0aW9uLCBhd2FpdCBlbnRyeS5idWZmZXIoKSk7XG4gICAgfVxuXG4gICAgY29uc3QgcHJpbWFyeU1vZGVsRmlsZSA9IGZpbmRQcmltYXJ5TW9kZWxGaWxlKHRhcmdldERpcik7XG4gICAgaWYgKHByaW1hcnlNb2RlbEZpbGUpIHtcbiAgICAgIHRoaXMuc3RhdGUuYWRkTG9nKGBQcmltYXJ5IG1vZGVsIGZpbGU6ICR7cGF0aC5iYXNlbmFtZShwcmltYXJ5TW9kZWxGaWxlKX1gKTtcbiAgICAgIHJldHVybiBwcmltYXJ5TW9kZWxGaWxlO1xuICAgIH1cbiAgICByZXR1cm4gdGFyZ2V0RGlyO1xuICB9XG5cbiAgcHJpdmF0ZSB3YWl0Rm9yQXNzZXRFdmVudE9yVGltZW91dChtczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgICBjb25zdCBzZXR0bGUgPSAoKSA9PiB7XG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgIHRoaXMuYXNzZXRFdmVudFJlc29sdmVycy5kZWxldGUoc2V0dGxlKTtcbiAgICAgICAgcmVzb2x2ZSgpO1xuICAgICAgfTtcbiAgICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dChzZXR0bGUsIG1zKTtcbiAgICAgIHRoaXMuYXNzZXRFdmVudFJlc29sdmVycy5hZGQoc2V0dGxlKTtcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgaXNJbnN0YW50aWFibGVBc3NldChhc3NldDogQXNzZXRJbmZvTGlrZSkge1xuICAgIHJldHVybiAhIWFzc2V0Lmluc3RhbnRpYXRpb24gfHwgYXNzZXQudHlwZSA9PT0gJ2NjLlByZWZhYicgfHwgYXNzZXQudHlwZS5lbmRzV2l0aCgnUHJlZmFiJyk7XG4gIH1cblxuICBwcml2YXRlIGdldEFzc2V0UGxhY2VtZW50U2NvcmUoYXNzZXQ6IEFzc2V0SW5mb0xpa2UpIHtcbiAgICBsZXQgc2NvcmUgPSAwO1xuICAgIGlmIChhc3NldC50eXBlID09PSAnY2MuUHJlZmFiJykgc2NvcmUgKz0gMTAwMDtcbiAgICBpZiAoYXNzZXQuaW5zdGFudGlhdGlvbikgc2NvcmUgKz0gNTAwO1xuICAgIGNvbnN0IGV4dCA9IHBhdGguZXh0bmFtZShhc3NldC5maWxlIHx8IGFzc2V0LnVybCB8fCAnJykudG9Mb3dlckNhc2UoKTtcbiAgICBzY29yZSArPSAoeyAnLnByZWZhYic6IDQwMCwgJy5mYngnOiAzMDAsICcuZ2xiJzogMjgwLCAnLmdsdGYnOiAyNjAsICcub2JqJzogMjQwIH1bZXh0XSB8fCAwKTtcbiAgICBpZiAoYXNzZXQuaW1wb3J0ZXIuaW5jbHVkZXMoJ21vZGVsJykpIHNjb3JlICs9IDEwMDtcbiAgICByZXR1cm4gc2NvcmU7XG4gIH1cblxuICBwcml2YXRlIHN0YXJ0SGVhcnRiZWF0TW9uaXRvcigpIHtcbiAgICB0aGlzLnN0b3BIZWFydGJlYXRNb25pdG9yKCk7XG4gICAgdGhpcy5oZWFydGJlYXRUaW1lciA9IHNldEludGVydmFsKCgpID0+IHtcbiAgICAgIGlmICghdGhpcy5jbGllbnQpIHJldHVybjtcbiAgICAgIGlmIChEYXRlLm5vdygpIC0gdGhpcy5sYXN0UGluZ0F0ID4gSEVBUlRCRUFUX1RJTUVPVVRfTVMpIHtcbiAgICAgICAgdGhpcy5zdGF0ZS5hZGRMb2coJ0hlYXJ0YmVhdCB0aW1lb3V0LCBjbG9zaW5nIGNsaWVudCBjb25uZWN0aW9uLicpO1xuICAgICAgICB0aGlzLmNsaWVudC5jbG9zZSgxMDAxLCAnSGVhcnRiZWF0IHRpbWVvdXQnKTtcbiAgICAgIH1cbiAgICB9LCA1MDAwKTtcbiAgfVxuXG4gIHByaXZhdGUgc3RvcEhlYXJ0YmVhdE1vbml0b3IoKSB7XG4gICAgaWYgKHRoaXMuaGVhcnRiZWF0VGltZXIpIHtcbiAgICAgIGNsZWFySW50ZXJ2YWwodGhpcy5oZWFydGJlYXRUaW1lcik7XG4gICAgICB0aGlzLmhlYXJ0YmVhdFRpbWVyID0gbnVsbDtcbiAgICB9XG4gIH1cbn1cbiJdfQ==