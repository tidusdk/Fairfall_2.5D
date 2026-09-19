"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MaterialManager = void 0;
exports.buildDefaultMaterialJson = buildDefaultMaterialJson;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const protocol_1 = require("./protocol");
function normalizeAssetRef(value) {
    return String(value || '').trim().replace(/\\/g, '/').toLowerCase();
}
function buildDefaultMaterialJson(effectUuid, materialName, textures) {
    const defines = {};
    const props = {};
    const texRef = (uuid) => ({ __uuid__: uuid, __expectedType__: 'cc.Texture2D' });
    if (textures === null || textures === void 0 ? void 0 : textures.baseColor) {
        defines.USE_ALBEDO_MAP = true;
        props.mainTexture = texRef(textures.baseColor);
    }
    if (textures === null || textures === void 0 ? void 0 : textures.normal) {
        defines.USE_NORMAL_MAP = true;
        props.normalMap = texRef(textures.normal);
    }
    if (textures === null || textures === void 0 ? void 0 : textures.metallic) {
        defines.USE_METALLIC_MAP = true;
        props.metallicMap = texRef(textures.metallic);
    }
    if (textures === null || textures === void 0 ? void 0 : textures.roughness) {
        defines.USE_ROUGHNESS_MAP = true;
        props.roughnessMap = texRef(textures.roughness);
    }
    const passState = {
        rasterizerState: {},
        depthStencilState: {},
        blendState: { targets: [{}] },
    };
    const material = {
        __type__: 'cc.Material',
        _name: materialName,
        _objFlags: 0,
        _native: '',
        _effectAsset: { __uuid__: effectUuid, __expectedType__: 'cc.EffectAsset' },
        _techIdx: 0,
        _defines: [defines, {}, {}, {}],
        _states: [passState, passState, passState, passState],
        _props: [props, {}, {}, {}],
    };
    return JSON.stringify(material, null, 2);
}
function classifyTextureType(name) {
    if (/base.?color/i.test(name))
        return 'baseColor';
    if (/normal/i.test(name))
        return 'normal';
    if (/metallic/i.test(name))
        return 'metallic';
    if (/roughness/i.test(name))
        return 'roughness';
    return null;
}
class MaterialManager {
    constructor(addLog, getAssetDbPath, refreshAssets) {
        this.addLog = addLog;
        this.getAssetDbPath = getAssetDbPath;
        this.refreshAssets = refreshAssets;
    }
    async ensureDefaultMaterial(savedPath, nodeUuid) {
        var _a, _b;
        if (!globalThis.Editor || !Editor.Message || !Editor.Message.request) {
            return { applied: 0 };
        }
        // Resolve imported-metallic-roughness effect UUID
        const effectPath = 'db://internal/effects/util/dcc/imported-metallic-roughness.effect';
        let effectUuid = '';
        try {
            const info = await Editor.Message.request('asset-db', 'query-asset-info', effectPath, ['uuid']);
            if (info === null || info === void 0 ? void 0 : info.uuid)
                effectUuid = info.uuid;
        }
        catch { /* not available */ }
        if (!effectUuid) {
            this.addLog('PBR effect not found, skipping material setup.');
            return { applied: 0 };
        }
        const assetExists = fs_1.default.existsSync(savedPath);
        const assetIsDir = assetExists && fs_1.default.statSync(savedPath).isDirectory();
        const modelDir = assetIsDir ? savedPath : path_1.default.dirname(savedPath);
        // Try to overwrite the FBX's internal material directly
        const fbxInfo = this.parseFbxMeta(modelDir);
        if (fbxInfo) {
            const overwritten = await this.tryOverwriteFbxMaterial(fbxInfo, effectUuid);
            if (overwritten) {
                this.addLog(`Overwrote ${fbxInfo.materials.length} FBX internal material(s) to imported-metallic-roughness.`);
                return { applied: fbxInfo.materials.length };
            }
        }
        // Fallback: create a separate .mtl and assign it
        this.addLog('Could not overwrite FBX material, creating separate .mtl.');
        const fallbackTextures = (_b = (_a = fbxInfo === null || fbxInfo === void 0 ? void 0 : fbxInfo.materials) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.textures;
        return this.createAndApplyMtl(modelDir, nodeUuid, effectUuid, fallbackTextures);
    }
    /**
     * Read the FBX .meta to extract internal material UUID, db URL, and texture UUIDs.
     */
    parseFbxMeta(modelDir) {
        var _a, _b, _c, _d, _e, _f;
        const fbxFiles = fs_1.default.readdirSync(modelDir).filter((f) => /\.fbx$/i.test(f));
        if (fbxFiles.length === 0)
            return null;
        const fbxFileName = fbxFiles[0];
        const metaPath = path_1.default.join(modelDir, `${fbxFileName}.meta`);
        if (!fs_1.default.existsSync(metaPath))
            return null;
        let meta;
        try {
            meta = JSON.parse(fs_1.default.readFileSync(metaPath, 'utf8'));
        }
        catch {
            return null;
        }
        const subMetas = (meta === null || meta === void 0 ? void 0 : meta.subMetas) || {};
        // Build db:// base URL for the FBX
        const fbxFilePath = path_1.default.join(modelDir, fbxFileName);
        let fbxDbPath = '';
        try {
            fbxDbPath = this.getAssetDbPath(fbxFilePath);
        }
        catch {
            return null;
        }
        // Collect materials, images, textures from subMetas
        const matEntries = [];
        const imgEntries = [];
        const texEntries = [];
        for (const [, sub] of Object.entries(subMetas)) {
            if (!(sub === null || sub === void 0 ? void 0 : sub.uuid) || !(sub === null || sub === void 0 ? void 0 : sub.importer))
                continue;
            if (sub.importer === 'gltf-material') {
                matEntries.push({ uuid: sub.uuid, name: sub.name || '', gltfIndex: (_b = (_a = sub.userData) === null || _a === void 0 ? void 0 : _a.gltfIndex) !== null && _b !== void 0 ? _b : 0 });
            }
            else if (sub.importer === 'gltf-embeded-image') {
                imgEntries.push({ uuid: sub.uuid, name: sub.name || '', gltfIndex: (_d = (_c = sub.userData) === null || _c === void 0 ? void 0 : _c.gltfIndex) !== null && _d !== void 0 ? _d : 0 });
            }
            else if (sub.importer === 'texture') {
                texEntries.push({ uuid: sub.uuid, name: sub.name || '', imageUuid: (_f = (_e = sub.userData) === null || _e === void 0 ? void 0 : _e.imageUuidOrDatabaseUri) !== null && _f !== void 0 ? _f : '' });
            }
        }
        if (matEntries.length === 0)
            return null;
        // Sort materials and images by gltfIndex
        matEntries.sort((a, b) => a.gltfIndex - b.gltfIndex);
        imgEntries.sort((a, b) => a.gltfIndex - b.gltfIndex);
        // image UUID → texture UUID (texture wraps image)
        const imgToTex = {};
        for (const tex of texEntries) {
            const ref = normalizeAssetRef(tex.imageUuid);
            if (ref)
                imgToTex[ref] = tex.uuid;
        }
        const getImageLookupKeys = (img) => {
            const keys = [normalizeAssetRef(img.uuid), normalizeAssetRef(`${fbxDbPath}/${img.name}`)];
            return keys.filter(Boolean);
        };
        const getImageTextureUuid = (img) => {
            return getImageLookupKeys(img).map((key) => imgToTex[key]).find(Boolean);
        };
        const globalTextures = {};
        const typedImages = new Map();
        for (const img of imgEntries) {
            const type = classifyTextureType(img.name);
            if (!type)
                continue;
            const texUuid = getImageTextureUuid(img);
            if (!texUuid)
                continue;
            if (!globalTextures[type]) {
                globalTextures[type] = texUuid;
            }
            const bucket = typedImages.get(type) || [];
            bucket.push({ gltfIndex: img.gltfIndex, textureUuid: texUuid });
            typedImages.set(type, bucket);
        }
        for (const entries of typedImages.values()) {
            entries.sort((a, b) => a.gltfIndex - b.gltfIndex);
        }
        // Group images per material by matching image name prefix to material name
        const materials = [];
        for (let mi = 0; mi < matEntries.length; mi++) {
            const mat = matEntries[mi];
            const matNameLower = mat.name.toLowerCase();
            const textures = {};
            for (const img of imgEntries) {
                if (!img.name.toLowerCase().startsWith(matNameLower))
                    continue;
                const type = classifyTextureType(img.name);
                const texUuid = getImageTextureUuid(img);
                if (type && texUuid)
                    textures[type] = texUuid;
            }
            if (Object.keys(textures).length === 0) {
                for (const [type, entries] of typedImages.entries()) {
                    if (entries.length === matEntries.length) {
                        const ordinalMatch = entries[mi];
                        if (ordinalMatch) {
                            textures[type] = ordinalMatch.textureUuid;
                            continue;
                        }
                    }
                    const exactMatch = entries.find((entry) => entry.gltfIndex === mat.gltfIndex);
                    if (exactMatch) {
                        textures[type] = exactMatch.textureUuid;
                    }
                }
            }
            if (Object.keys(textures).length === 0 && matEntries.length === 1) {
                Object.assign(textures, globalTextures);
            }
            materials.push({
                materialUuid: mat.uuid,
                materialDbUrl: `${fbxDbPath}/${mat.name}`,
                textures,
            });
            this.addLog(`Material[${mi}] ${mat.name}: ${Object.entries(textures).map(([k, v]) => `${k}=${v.slice(-5)}`).join(', ')}`);
        }
        return { materials };
    }
    /**
     * Overwrite the FBX's internal material sub-asset with imported-metallic-roughness.
     */
    async tryOverwriteFbxMaterial(info, effectUuid) {
        let successCount = 0;
        for (const mat of info.materials) {
            const materialContent = buildDefaultMaterialJson(effectUuid, 'tripo-pbr', mat.textures);
            // Try save-asset on the material sub-asset URL
            try {
                await Editor.Message.request('asset-db', 'save-asset', mat.materialDbUrl, materialContent);
                successCount++;
                this.addLog(`Overwrote material: ${mat.materialDbUrl}`);
                continue;
            }
            catch (err) {
                this.addLog(`save-asset failed for ${mat.materialDbUrl}: ${err instanceof Error ? err.message : String(err)}`);
            }
            // Try save-asset by UUID
            try {
                await Editor.Message.request('asset-db', 'save-asset', mat.materialUuid, materialContent);
                successCount++;
                this.addLog(`Overwrote material by UUID: ${mat.materialUuid}`);
                continue;
            }
            catch (err) {
                this.addLog(`save-asset by UUID failed for ${mat.materialUuid}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        return successCount > 0;
    }
    /**
     * Fallback: create a standalone .mtl file and assign it to the node.
     */
    async createAndApplyMtl(modelDir, nodeUuid, effectUuid, textures) {
        if (!textures || Object.keys(textures).length === 0) {
            textures = this.discoverTextureUuids(modelDir);
        }
        const fbxFiles = fs_1.default.readdirSync(modelDir).filter((f) => /\.fbx$/i.test(f));
        const materialName = fbxFiles.length > 0
            ? path_1.default.basename(fbxFiles[0], path_1.default.extname(fbxFiles[0]))
            : 'default-material';
        const mtlFilePath = path_1.default.join(modelDir, `${materialName}.mtl`);
        const mtlDbPath = this.getAssetDbPath(mtlFilePath);
        try {
            fs_1.default.writeFileSync(mtlFilePath, buildDefaultMaterialJson(effectUuid, materialName, textures), 'utf8');
            this.addLog(`Created material: ${path_1.default.basename(mtlFilePath)}`);
            await this.refreshAssets(mtlFilePath);
        }
        catch (err) {
            this.addLog(`Failed to create material: ${err instanceof Error ? err.message : String(err)}`);
            return { applied: 0 };
        }
        let materialUuid = '';
        for (let attempt = 0; attempt < 10; attempt++) {
            try {
                const matInfo = await Editor.Message.request('asset-db', 'query-asset-info', mtlDbPath, ['uuid', 'imported']);
                if ((matInfo === null || matInfo === void 0 ? void 0 : matInfo.uuid) && matInfo.imported) {
                    materialUuid = matInfo.uuid;
                    break;
                }
            }
            catch { /* not ready */ }
            await (0, protocol_1.delay)(500);
        }
        if (!materialUuid) {
            this.addLog('Material not yet imported.');
            return { applied: 0 };
        }
        let applied = 0;
        try {
            applied = await this.applyMaterialToNode(nodeUuid, materialUuid);
        }
        catch (err) {
            this.addLog(`Failed to apply material: ${err instanceof Error ? err.message : String(err)}`);
        }
        return { applied };
    }
    discoverTextureUuids(modelDir) {
        const fbxFiles = fs_1.default.readdirSync(modelDir).filter((f) => /\.fbx$/i.test(f));
        if (fbxFiles.length > 0) {
            const metaPath = path_1.default.join(modelDir, `${fbxFiles[0]}.meta`);
            if (fs_1.default.existsSync(metaPath)) {
                try {
                    const meta = JSON.parse(fs_1.default.readFileSync(metaPath, 'utf8'));
                    const result = this.discoverFromSubMetas((meta === null || meta === void 0 ? void 0 : meta.subMetas) || {});
                    if (Object.keys(result).length > 0)
                        return result;
                }
                catch { /* fall through */ }
            }
        }
        return this.discoverFromFbmDirectories(modelDir);
    }
    discoverFromSubMetas(subMetas) {
        const result = {};
        const nameMapping = [
            { key: 'baseColor', pattern: /base.?color/i },
            { key: 'normal', pattern: /normal(map)?/i },
            { key: 'metallic', pattern: /metallic/i },
            { key: 'roughness', pattern: /roughness/i },
        ];
        for (const [, sub] of Object.entries(subMetas)) {
            if ((sub === null || sub === void 0 ? void 0 : sub.importer) !== 'texture' || !(sub === null || sub === void 0 ? void 0 : sub.uuid) || !(sub === null || sub === void 0 ? void 0 : sub.name))
                continue;
            for (const { key, pattern } of nameMapping) {
                if (!result[key] && pattern.test(sub.name)) {
                    result[key] = sub.uuid;
                    break;
                }
            }
        }
        return result;
    }
    discoverFromFbmDirectories(modelDir) {
        const result = {};
        const fbmDirs = fs_1.default.readdirSync(modelDir)
            .filter((f) => /\.fbm$/i.test(f) && fs_1.default.statSync(path_1.default.join(modelDir, f)).isDirectory());
        if (fbmDirs.length === 0)
            return result;
        const images = [];
        for (const fbmDir of fbmDirs) {
            const fbmPath = path_1.default.join(modelDir, fbmDir);
            for (const f of fs_1.default.readdirSync(fbmPath).filter((name) => /\.(png|jpg|jpeg|tga|bmp)$/i.test(name))) {
                images.push({ file: f, dir: fbmPath });
            }
        }
        if (images.length === 0)
            return result;
        const mapping = [
            { key: 'baseColor', suffix: /_basecolor\./i },
            { key: 'normal', suffix: /_normal\./i },
            { key: 'metallic', suffix: /_metallic\./i },
            { key: 'roughness', suffix: /_roughness\./i },
        ];
        for (const { file, dir } of images) {
            for (const { key, suffix } of mapping) {
                if (result[key] || !suffix.test(file))
                    continue;
                const metaPath = `${path_1.default.join(dir, file)}.meta`;
                if (fs_1.default.existsSync(metaPath)) {
                    try {
                        const meta = JSON.parse(fs_1.default.readFileSync(metaPath, 'utf8'));
                        for (const [, sub] of Object.entries(meta.subMetas || {})) {
                            if (sub === null || sub === void 0 ? void 0 : sub.uuid) {
                                result[key] = sub.uuid;
                                break;
                            }
                        }
                    }
                    catch { /* skip */ }
                }
                break;
            }
        }
        const assigned = Object.keys(result);
        if (assigned.length > 0) {
            this.addLog(`Found ${images.length} texture(s), assigned: ${assigned.join(', ')}.`);
        }
        return result;
    }
    async applyMaterialToNode(nodeUuid, materialUuid) {
        var _a, _b;
        const nodeDump = await Editor.Message.request('scene', 'query-node', nodeUuid);
        if (!nodeDump)
            throw new Error(`Node dump not found for uuid=${nodeUuid}`);
        let applied = await this.setMaterialOnComponents(nodeUuid, nodeDump, materialUuid);
        const childrenRaw = nodeDump.children;
        const children = Array.isArray(childrenRaw) ? childrenRaw
            : (Array.isArray(childrenRaw === null || childrenRaw === void 0 ? void 0 : childrenRaw.value) ? childrenRaw.value : []);
        for (const child of children) {
            const childUuid = typeof child === 'string' ? child
                : (((_a = child === null || child === void 0 ? void 0 : child.value) === null || _a === void 0 ? void 0 : _a.uuid) || ((_b = child === null || child === void 0 ? void 0 : child.uuid) === null || _b === void 0 ? void 0 : _b.value) || (child === null || child === void 0 ? void 0 : child.uuid) || '');
            if (childUuid) {
                try {
                    applied += await this.applyMaterialToNode(childUuid, materialUuid);
                }
                catch { /* skip */ }
            }
        }
        return applied;
    }
    async setMaterialOnComponents(nodeUuid, nodeDump, materialUuid) {
        const components = nodeDump.__comps__ || [];
        let applied = 0;
        for (let ci = 0; ci < components.length; ci++) {
            const comp = components[ci];
            const compType = (comp === null || comp === void 0 ? void 0 : comp.type) || (comp === null || comp === void 0 ? void 0 : comp.__type__) || '';
            if (!compType.includes('MeshRenderer'))
                continue;
            const compValue = (comp === null || comp === void 0 ? void 0 : comp.value) || {};
            const materialsRaw = (compValue === null || compValue === void 0 ? void 0 : compValue.sharedMaterials) || (compValue === null || compValue === void 0 ? void 0 : compValue.materials) || (compValue === null || compValue === void 0 ? void 0 : compValue._materials);
            const materials = (materialsRaw === null || materialsRaw === void 0 ? void 0 : materialsRaw.value) || [];
            if (materials.length === 0) {
                try {
                    await Editor.Message.request('scene', 'set-property', {
                        uuid: nodeUuid,
                        path: `__comps__.${ci}.sharedMaterials`,
                        dump: { type: 'Array', value: [{ type: 'cc.Material', value: { uuid: materialUuid } }] },
                    });
                    applied++;
                }
                catch { /* skip */ }
                continue;
            }
            for (let mi = 0; mi < materials.length; mi++) {
                try {
                    await Editor.Message.request('scene', 'set-property', {
                        uuid: nodeUuid,
                        path: `__comps__.${ci}.sharedMaterials.${mi}`,
                        dump: { type: 'cc.Material', value: { uuid: materialUuid } },
                    });
                    applied++;
                }
                catch { /* skip */ }
            }
        }
        return applied;
    }
}
exports.MaterialManager = MaterialManager;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWF0ZXJpYWwuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zb3VyY2UvbGliL21hdGVyaWFsLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7OztBQXlCQSw0REE2QkM7QUF0REQsNENBQW9CO0FBQ3BCLGdEQUF3QjtBQUN4Qix5Q0FBbUM7QUFtQm5DLFNBQVMsaUJBQWlCLENBQUMsS0FBYTtJQUN0QyxPQUFPLE1BQU0sQ0FBQyxLQUFLLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxHQUFHLENBQUMsQ0FBQyxXQUFXLEVBQUUsQ0FBQztBQUN0RSxDQUFDO0FBRUQsU0FBZ0Isd0JBQXdCLENBQUMsVUFBa0IsRUFBRSxZQUFvQixFQUFFLFFBQXVCO0lBQ3hHLE1BQU0sT0FBTyxHQUE0QixFQUFFLENBQUM7SUFDNUMsTUFBTSxLQUFLLEdBQXdCLEVBQUUsQ0FBQztJQUV0QyxNQUFNLE1BQU0sR0FBRyxDQUFDLElBQVksRUFBRSxFQUFFLENBQUMsQ0FBQyxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUUsZ0JBQWdCLEVBQUUsY0FBYyxFQUFFLENBQUMsQ0FBQztJQUV4RixJQUFJLFFBQVEsYUFBUixRQUFRLHVCQUFSLFFBQVEsQ0FBRSxTQUFTLEVBQUUsQ0FBQztRQUFDLE9BQU8sQ0FBQyxjQUFjLEdBQUcsSUFBSSxDQUFDO1FBQUMsS0FBSyxDQUFDLFdBQVcsR0FBRyxNQUFNLENBQUMsUUFBUSxDQUFDLFNBQVMsQ0FBQyxDQUFDO0lBQUMsQ0FBQztJQUMzRyxJQUFJLFFBQVEsYUFBUixRQUFRLHVCQUFSLFFBQVEsQ0FBRSxNQUFNLEVBQUUsQ0FBQztRQUFDLE9BQU8sQ0FBQyxjQUFjLEdBQUcsSUFBSSxDQUFDO1FBQUMsS0FBSyxDQUFDLFNBQVMsR0FBRyxNQUFNLENBQUMsUUFBUSxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQUMsQ0FBQztJQUNuRyxJQUFJLFFBQVEsYUFBUixRQUFRLHVC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QVksRUFBRSxFQUFFLENBQUMsRUFBRTtxQkFDekYsQ0FBQyxDQUFDO29CQUNILE9BQU8sRUFBRSxDQUFDO2dCQUNaLENBQUM7Z0JBQUMsTUFBTSxDQUFDLENBQUMsVUFBVSxDQUFDLENBQUM7Z0JBQ3RCLFNBQVM7WUFDWCxDQUFDO1lBRUQsS0FBSyxJQUFJLEVBQUUsR0FBRyxDQUFDLEVBQUUsRUFBRSxHQUFHLFNBQVMsQ0FBQyxNQUFNLEVBQUUsRUFBRSxFQUFFLEVBQUUsQ0FBQztnQkFDN0MsSUFBSSxDQUFDO29CQUNILE1BQU0sTUFBTSxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsT0FBTyxFQUFFLGNBQWMsRUFBRTt3QkFDcEQsSUFBSSxFQUFFLFFBQVE7d0JBQ2QsSUFBSSxFQUFFLGFBQWEsRUFBRSxvQkFBb0IsRUFBRSxFQUFFO3dCQUM3QyxJQUFJLEVBQUUsRUFBRSxJQUFJLEVBQUUsYUFBYSxFQUFFLEtBQUssRUFBRSxFQUFFLElBQUksRUFBRSxZQUFZLEVBQUUsRUFBRTtxQkFDN0QsQ0FBQyxDQUFDO29CQUNILE9BQU8sRUFBRSxDQUFDO2dCQUNaLENBQUM7Z0JBQUMsTUFBTSxDQUFDLENBQUMsVUFBVSxDQUFDLENBQUM7WUFDeEIsQ0FBQztRQUNILENBQUM7UUFDRCxPQUFPLE9BQU8sQ0FBQztJQUNqQixDQUFDO0NBQ0Y7QUE1WUQsMENBNFlDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IGZzIGZyb20gJ2ZzJztcbmltcG9ydCBwYXRoIGZyb20gJ3BhdGgnO1xuaW1wb3J0IHsgZGVsYXkgfSBmcm9tICcuL3Byb3RvY29sJztcblxudHlwZSBUZXh0dXJlVXVpZHMgPSB7XG4gIGJhc2VDb2xvcj86IHN0cmluZztcbiAgbm9ybWFsPzogc3RyaW5nO1xuICBtZXRhbGxpYz86IHN0cmluZztcbiAgcm91Z2huZXNzPzogc3RyaW5nO1xufTtcblxudHlwZSBGYnhNYXRlcmlhbEVudHJ5ID0ge1xuICBtYXRlcmlhbFV1aWQ6IHN0cmluZztcbiAgbWF0ZXJpYWxEYlVybDogc3RyaW5nO1xuICB0ZXh0dXJlczogVGV4dHVyZVV1aWRzO1xufTtcblxudHlwZSBGYnhNYXRlcmlhbEluZm8gPSB7XG4gIG1hdGVyaWFsczogRmJ4TWF0ZXJpYWxFbnRyeVtdO1xufTtcblxuZnVuY3Rpb24gbm9ybWFsaXplQXNzZXRSZWYodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBTdHJpbmcodmFsdWUgfHwgJycpLnRyaW0oKS5yZXBsYWNlKC9cXFxcL2csICcvJykudG9Mb3dlckNhc2UoKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkRGVmYXVsdE1hdGVyaWFsSnNvbihlZmZlY3RVdWlkOiBzdHJpbmcsIG1hdGVyaWFsTmFtZTogc3RyaW5nLCB0ZXh0dXJlcz86IFRleHR1cmVVdWlkcyk6IHN0cmluZyB7XG4gIGNvbnN0IGRlZmluZXM6IFJlY29yZDxzdHJpbmcsIGJvb2xlYW4+ID0ge307XG4gIGNvbnN0IHByb3BzOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0ge307XG5cbiAgY29uc3QgdGV4UmVmID0gKHV1aWQ6IHN0cmluZykgPT4gKHsgX191dWlkX186IHV1aWQsIF9fZXhwZWN0ZWRUeXBlX186ICdjYy5UZXh0dXJlMkQnIH0pO1xuXG4gIGlmICh0ZXh0dXJlcz8uYmFzZUNvbG9yKSB7IGRlZmluZXMuVVNFX0FMQkVET19NQVAgPSB0cnVlOyBwcm9wcy5tYWluVGV4dHVyZSA9IHRleFJlZih0ZXh0dXJlcy5iYXNlQ29sb3IpOyB9XG4gIGlmICh0ZXh0dXJlcz8ubm9ybWFsKSB7IGRlZmluZXMuVVNFX05PUk1BTF9NQVAgPSB0cnVlOyBwcm9wcy5ub3JtYWxNYXAgPSB0ZXhSZWYodGV4dHVyZXMubm9ybWFsKTsgfVxuICBpZiAodGV4dHVyZXM/Lm1ldGFsbGljKSB7IGRlZmluZXMuVVNFX01FVEFMTElDX01BUCA9IHRydWU7IHByb3BzLm1ldGFsbGljTWFwID0gdGV4UmVmKHRleHR1cmVzLm1ldGFsbGljKTsgfVxuICBpZiAodGV4dHVyZXM/LnJvdWdobmVzcykgeyBkZWZpbmVzLlVTRV9ST1VHSE5FU1NfTUFQID0gdHJ1ZTsgcHJvcHMucm91Z2huZXNzTWFwID0gdGV4UmVmKHRleHR1cmVzLnJvdWdobmVzcyk7IH1cblxuICBjb25zdCBwYXNzU3RhdGUgPSB7XG4gICAgcmFzdGVyaXplclN0YXRlOiB7fSxcbiAgICBkZXB0aFN0ZW5jaWxTdGF0ZToge30sXG4gICAgYmxlbmRTdGF0ZTogeyB0YXJnZXRzOiBbe31dIH0sXG4gIH07XG5cbiAgY29uc3QgbWF0ZXJpYWwgPSB7XG4gICAgX190eXBlX186ICdjYy5NYXRlcmlhbCcsXG4gICAgX25hbWU6IG1hdGVyaWFsTmFtZSxcbiAgICBfb2JqRmxhZ3M6IDAsXG4gICAgX25hdGl2ZTogJycsXG4gICAgX2VmZmVjdEFzc2V0OiB7IF9fdXVpZF9fOiBlZmZlY3RVdWlkLCBfX2V4cGVjdGVkVHlwZV9fOiAnY2MuRWZmZWN0QXNzZXQnIH0sXG4gICAgX3RlY2hJZHg6IDAsXG4gICAgX2RlZmluZXM6IFtkZWZpbmVzLCB7fSwge30sIHt9XSxcbiAgICBfc3RhdGVzOiBbcGFzc1N0YXRlLCBwYXNzU3RhdGUsIHBhc3NTdGF0ZSwgcGFzc1N0YXRlXSxcbiAgICBfcHJvcHM6IFtwcm9wcywge30sIHt9LCB7fV0sXG4gIH07XG4gIHJldHVybiBKU09OLnN0cmluZ2lmeShtYXRlcmlhbCwgbnVsbCwgMik7XG59XG5cbmZ1bmN0aW9uIGNsYXNzaWZ5VGV4dHVyZVR5cGUobmFtZTogc3RyaW5nKToga2V5b2YgVGV4dHVyZVV1aWRzIHwgbnVsbCB7XG4gIGlmICgvYmFzZS4/Y29sb3IvaS50ZXN0KG5hbWUpKSByZXR1cm4gJ2Jhc2VDb2xvcic7XG4gIGlmICgvbm9ybWFsL2kudGVzdChuYW1lKSkgcmV0dXJuICdub3JtYWwnO1xuICBpZiAoL21ldGFsbGljL2kudGVzdChuYW1lKSkgcmV0dXJuICdtZXRhbGxpYyc7XG4gIGlmICgvcm91Z2huZXNzL2kudGVzdChuYW1lKSkgcmV0dXJuICdyb3VnaG5lc3MnO1xuICByZXR1cm4gbnVsbDtcbn1cblxuZXhwb3J0IGNsYXNzIE1hdGVyaWFsTWFuYWdlciB7XG4gIGNvbnN0cnVjdG9yKFxuICAgIHByaXZhdGUgcmVhZG9ubHkgYWRkTG9nOiAobXNnOiBzdHJpbmcpID0+IHZvaWQsXG4gICAgcHJpdmF0ZSByZWFkb25seSBnZXRBc3NldERiUGF0aDogKGZzUGF0aDogc3RyaW5nKSA9PiBzdHJpbmcsXG4gICAgcHJpdmF0ZSByZWFkb25seSByZWZyZXNoQXNzZXRzOiAoZnNQYXRoOiBzdHJpbmcpID0+IFByb21pc2U8Ym9vbGVhbj4sXG4gICkge31cblxuICBhc3luYyBlbnN1cmVEZWZhdWx0TWF0ZXJpYWwoc2F2ZWRQYXRoOiBzdHJpbmcsIG5vZGVVdWlkOiBzdHJpbmcpOiBQcm9taXNlPHsgYXBwbGllZDogbnVtYmVyIH0+IHtcbiAgICBpZiAoIWdsb2JhbFRoaXMuRWRpdG9yIHx8ICFFZGl0b3IuTWVzc2FnZSB8fCAhRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCkge1xuICAgICAgcmV0dXJuIHsgYXBwbGllZDogMCB9O1xuICAgIH1cblxuICAgIC8vIFJlc29sdmUgaW1wb3J0ZWQtbWV0YWxsaWMtcm91Z2huZXNzIGVmZmVjdCBVVUlEXG4gICAgY29uc3QgZWZmZWN0UGF0aCA9ICdkYjovL2ludGVybmFsL2VmZmVjdHMvdXRpbC9kY2MvaW1wb3J0ZWQtbWV0YWxsaWMtcm91Z2huZXNzLmVmZmVjdCc7XG4gICAgbGV0IGVmZmVjdFV1aWQgPSAnJztcbiAgICB0cnkge1xuICAgICAgY29uc3QgaW5mbyA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3F1ZXJ5LWFzc2V0LWluZm8nLCBlZmZlY3RQYXRoLCBbJ3V1aWQnXSkgYXMgeyB1dWlkPzogc3RyaW5nIH0gfCBudWxsO1xuICAgICAgaWYgKGluZm8/LnV1aWQpIGVmZmVjdFV1aWQgPSBpbmZvLnV1aWQ7XG4gICAgfSBjYXRjaCB7IC8qIG5vdCBhdmFpbGFibGUgKi8gfVxuXG4gICAgaWYgKCFlZmZlY3RVdWlkKSB7XG4gICAgICB0aGlzLmFkZExvZygnUEJSIGVmZmVjdCBub3QgZm91bmQsIHNraXBwaW5nIG1hdGVyaWFsIHNldHVwLicpO1xuICAgICAgcmV0dXJuIHsgYXBwbGllZDogMCB9O1xuICAgIH1cblxuICAgIGNvbnN0IGFzc2V0RXhpc3RzID0gZnMuZXhpc3RzU3luYyhzYXZlZFBhdGgpO1xuICAgIGNvbnN0IGFzc2V0SXNEaXIgPSBhc3NldEV4aXN0cyAmJiBmcy5zdGF0U3luYyhzYXZlZFBhdGgpLmlzRGlyZWN0b3J5KCk7XG4gICAgY29uc3QgbW9kZWxEaXIgPSBhc3NldElzRGlyID8gc2F2ZWRQYXRoIDogcGF0aC5kaXJuYW1lKHNhdmVkUGF0aCk7XG5cbiAgICAvLyBUcnkgdG8gb3ZlcndyaXRlIHRoZSBGQlgncyBpbnRlcm5hbCBtYXRlcmlhbCBkaXJlY3RseVxuICAgIGNvbnN0IGZieEluZm8gPSB0aGlzLnBhcnNlRmJ4TWV0YShtb2RlbERpcik7XG4gICAgaWYgKGZieEluZm8pIHtcbiAgICAgIGNvbnN0IG92ZXJ3cml0dGVuID0gYXdhaXQgdGhpcy50cnlPdmVyd3JpdGVGYnhNYXRlcmlhbChmYnhJbmZvLCBlZmZlY3RVdWlkKTtcbiAgICAgIGlmIChvdmVyd3JpdHRlbikge1xuICAgICAgICB0aGlzLmFkZExvZyhgT3Zlcndyb3RlICR7ZmJ4SW5mby5tYXRlcmlhbHMubGVuZ3RofSBGQlggaW50ZXJuYWwgbWF0ZXJpYWwocykgdG8gaW1wb3J0ZWQtbWV0YWxsaWMtcm91Z2huZXNzLmApO1xuICAgICAgICByZXR1cm4geyBhcHBsaWVkOiBmYnhJbmZvLm1hdGVyaWFscy5sZW5ndGggfTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBGYWxsYmFjazogY3JlYXRlIGEgc2VwYXJhdGUgLm10bCBhbmQgYXNzaWduIGl0XG4gICAgdGhpcy5hZGRMb2coJ0NvdWxkIG5vdCBvdmVyd3JpdGUgRkJYIG1hdGVyaWFsLCBjcmVhdGluZyBzZXBhcmF0ZSAubXRsLicpO1xuICAgIGNvbnN0IGZhbGxiYWNrVGV4dHVyZXMgPSBmYnhJbmZvPy5tYXRlcmlhbHM/LlswXT8udGV4dHVyZXM7XG4gICAgcmV0dXJuIHRoaXMuY3JlYXRlQW5kQXBwbHlNdGwobW9kZWxEaXIsIG5vZGVVdWlkLCBlZmZlY3RVdWlkLCBmYWxsYmFja1RleHR1cmVzKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZWFkIHRoZSBGQlggLm1ldGEgdG8gZXh0cmFjdCBpbnRlcm5hbCBtYXRlcmlhbCBVVUlELCBkYiBVUkwsIGFuZCB0ZXh0dXJlIFVVSURzLlxuICAgKi9cbiAgcHJpdmF0ZSBwYXJzZUZieE1ldGEobW9kZWxEaXI6IHN0cmluZyk6IEZieE1hdGVyaWFsSW5mbyB8IG51bGwge1xuICAgIGNvbnN0IGZieEZpbGVzID0gZnMucmVhZGRpclN5bmMobW9kZWxEaXIpLmZpbHRlcigoZikgPT4gL1xcLmZieCQvaS50ZXN0KGYpKTtcbiAgICBpZiAoZmJ4RmlsZXMubGVuZ3RoID09PSAwKSByZXR1cm4gbnVsbDtcblxuICAgIGNvbnN0IGZieEZpbGVOYW1lID0gZmJ4RmlsZXNbMF07XG4gICAgY29uc3QgbWV0YVBhdGggPSBwYXRoLmpvaW4obW9kZWxEaXIsIGAke2ZieEZpbGVOYW1lfS5tZXRhYCk7XG4gICAgaWYgKCFmcy5leGlzdHNTeW5jKG1ldGFQYXRoKSkgcmV0dXJuIG51bGw7XG5cbiAgICBsZXQgbWV0YTogYW55O1xuICAgIHRyeSB7IG1ldGEgPSBKU09OLnBhcnNlKGZzLnJlYWRGaWxlU3luYyhtZXRhUGF0aCwgJ3V0ZjgnKSk7IH0gY2F0Y2ggeyByZXR1cm4gbnVsbDsgfVxuXG4gICAgY29uc3Qgc3ViTWV0YXM6IFJlY29yZDxzdHJpbmcsIGFueT4gPSBtZXRhPy5zdWJNZXRhcyB8fCB7fTtcblxuICAgIC8vIEJ1aWxkIGRiOi8vIGJhc2UgVVJMIGZvciB0aGUgRkJYXG4gICAgY29uc3QgZmJ4RmlsZVBhdGggPSBwYXRoLmpvaW4obW9kZWxEaXIsIGZieEZpbGVOYW1lKTtcbiAgICBsZXQgZmJ4RGJQYXRoID0gJyc7XG4gICAgdHJ5IHsgZmJ4RGJQYXRoID0gdGhpcy5nZXRBc3NldERiUGF0aChmYnhGaWxlUGF0aCk7IH0gY2F0Y2ggeyByZXR1cm4gbnVsbDsgfVxuXG4gICAgLy8gQ29sbGVjdCBtYXRlcmlhbHMsIGltYWdlcywgdGV4dHVyZXMgZnJvbSBzdWJNZXRhc1xuICAgIGNvbnN0IG1hdEVudHJpZXM6IEFycmF5PHsgdXVpZDogc3RyaW5nOyBuYW1lOiBzdHJpbmc7IGdsdGZJbmRleDogbnVtYmVyIH0+ID0gW107XG4gICAgY29uc3QgaW1nRW50cmllczogQXJyYXk8eyB1dWlkOiBzdHJpbmc7IG5hbWU6IHN0cmluZzsgZ2x0ZkluZGV4OiBudW1iZXIgfT4gPSBbXTtcbiAgICBjb25zdCB0ZXhFbnRyaWVzOiBBcnJheTx7IHV1aWQ6IHN0cmluZzsgbmFtZTogc3RyaW5nOyBpbWFnZVV1aWQ6IHN0cmluZyB9PiA9IFtdO1xuXG4gICAgZm9yIChjb25zdCBbLCBzdWJdIG9mIE9iamVjdC5lbnRyaWVzKHN1Yk1ldGFzKSkge1xuICAgICAgaWYgKCFzdWI/LnV1aWQgfHwgIXN1Yj8uaW1wb3J0ZXIpIGNvbnRpbnVlO1xuICAgICAgaWYgKHN1Yi5pbXBvcnRlciA9PT0gJ2dsdGYtbWF0ZXJpYWwnKSB7XG4gICAgICAgIG1hdEVudHJpZXMucHVzaCh7IHV1aWQ6IHN1Yi51dWlkLCBuYW1lOiBzdWIubmFtZSB8fCAnJywgZ2x0ZkluZGV4OiBzdWIudXNlckRhdGE/LmdsdGZJbmRleCA/PyAwIH0pO1xuICAgICAgfSBlbHNlIGlmIChzdWIuaW1wb3J0ZXIgPT09ICdnbHRmLWVtYmVkZWQtaW1hZ2UnKSB7XG4gICAgICAgIGltZ0VudHJpZXMucHVzaCh7IHV1aWQ6IHN1Yi51dWlkLCBuYW1lOiBzdWIubmFtZSB8fCAnJywgZ2x0ZkluZGV4OiBzdWIudXNlckRhdGE/LmdsdGZJbmRleCA/PyAwIH0pO1xuICAgICAgfSBlbHNlIGlmIChzdWIuaW1wb3J0ZXIgPT09ICd0ZXh0dXJlJykge1xuICAgICAgICB0ZXhFbnRyaWVzLnB1c2goeyB1dWlkOiBzdWIudXVpZCwgbmFtZTogc3ViLm5hbWUgfHwgJycsIGltYWdlVXVpZDogc3ViLnVzZXJEYXRhPy5pbWFnZVV1aWRPckRhdGFiYXNlVXJpID8/ICcnIH0pO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChtYXRFbnRyaWVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG5cbiAgICAvLyBTb3J0IG1hdGVyaWFscyBhbmQgaW1hZ2VzIGJ5IGdsdGZJbmRleFxuICAgIG1hdEVudHJpZXMuc29ydCgoYSwgYikgPT4gYS5nbHRmSW5kZXggLSBiLmdsdGZJbmRleCk7XG4gICAgaW1nRW50cmllcy5zb3J0KChhLCBiKSA9PiBhLmdsdGZJbmRleCAtIGIuZ2x0ZkluZGV4KTtcblxuICAgIC8vIGltYWdlIFVVSUQg4oaSIHRleHR1cmUgVVVJRCAodGV4dHVyZSB3cmFwcyBpbWFnZSlcbiAgICBjb25zdCBpbWdUb1RleDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICAgIGZvciAoY29uc3QgdGV4IG9mIHRleEVudHJpZXMpIHtcbiAgICAgIGNvbnN0IHJlZiA9IG5vcm1hbGl6ZUFzc2V0UmVmKHRleC5pbWFnZVV1aWQpO1xuICAgICAgaWYgKHJlZikgaW1nVG9UZXhbcmVmXSA9IHRleC51dWlkO1xuICAgIH1cblxuICAgIGNvbnN0IGdldEltYWdlTG9va3VwS2V5cyA9IChpbWc6IHsgdXVpZDogc3RyaW5nOyBuYW1lOiBzdHJpbmcgfSk6IHN0cmluZ1tdID0+IHtcbiAgICAgIGNvbnN0IGtleXMgPSBbbm9ybWFsaXplQXNzZXRSZWYoaW1nLnV1aWQpLCBub3JtYWxpemVBc3NldFJlZihgJHtmYnhEYlBhdGh9LyR7aW1nLm5hbWV9YCldO1xuICAgICAgcmV0dXJuIGtleXMuZmlsdGVyKEJvb2xlYW4pO1xuICAgIH07XG5cbiAgICBjb25zdCBnZXRJbWFnZVRleHR1cmVVdWlkID0gKGltZzogeyB1dWlkOiBzdHJpbmc7IG5hbWU6IHN0cmluZyB9KTogc3RyaW5nIHwgdW5kZWZpbmVkID0+IHtcbiAgICAgIHJldHVybiBnZXRJbWFnZUxvb2t1cEtleXMoaW1nKS5tYXAoKGtleSkgPT4gaW1nVG9UZXhba2V5XSkuZmluZChCb29sZWFuKTtcbiAgICB9O1xuXG4gICAgY29uc3QgZ2xvYmFsVGV4dHVyZXM6IFRleHR1cmVVdWlkcyA9IHt9O1xuICAgIGNvbnN0IHR5cGVkSW1hZ2VzID0gbmV3IE1hcDxrZXlvZiBUZXh0dXJlVXVpZHMsIEFycmF5PHsgZ2x0ZkluZGV4OiBudW1iZXI7IHRleHR1cmVVdWlkOiBzdHJpbmcgfT4+KCk7XG4gICAgZm9yIChjb25zdCBpbWcgb2YgaW1nRW50cmllcykge1xuICAgICAgY29uc3QgdHlwZSA9IGNsYXNzaWZ5VGV4dHVyZVR5cGUoaW1nLm5hbWUpO1xuICAgICAgaWYgKCF0eXBlKSBjb250aW51ZTtcblxuICAgICAgY29uc3QgdGV4VXVpZCA9IGdldEltYWdlVGV4dHVyZVV1aWQoaW1nKTtcbiAgICAgIGlmICghdGV4VXVpZCkgY29udGludWU7XG5cbiAgICAgIGlmICghZ2xvYmFsVGV4dHVyZXNbdHlwZV0pIHtcbiAgICAgICAgZ2xvYmFsVGV4dHVyZXNbdHlwZV0gPSB0ZXhVdWlkO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBidWNrZXQgPSB0eXBlZEltYWdlcy5nZXQodHlwZSkgfHwgW107XG4gICAgICBidWNrZXQucHVzaCh7IGdsdGZJbmRleDogaW1nLmdsdGZJbmRleCwgdGV4dHVyZVV1aWQ6IHRleFV1aWQgfSk7XG4gICAgICB0eXBlZEltYWdlcy5zZXQodHlwZSwgYnVja2V0KTtcbiAgICB9XG5cbiAgICBmb3IgKGNvbnN0IGVudHJpZXMgb2YgdHlwZWRJbWFnZXMudmFsdWVzKCkpIHtcbiAgICAgIGVudHJpZXMuc29ydCgoYSwgYikgPT4gYS5nbHRmSW5kZXggLSBiLmdsdGZJbmRleCk7XG4gICAgfVxuXG4gICAgLy8gR3JvdXAgaW1hZ2VzIHBlciBtYXRlcmlhbCBieSBtYXRjaGluZyBpbWFnZSBuYW1lIHByZWZpeCB0byBtYXRlcmlhbCBuYW1lXG4gICAgY29uc3QgbWF0ZXJpYWxzOiBGYnhNYXRlcmlhbEVudHJ5W10gPSBbXTtcblxuICAgIGZvciAobGV0IG1pID0gMDsgbWkgPCBtYXRFbnRyaWVzLmxlbmd0aDsgbWkrKykge1xuICAgICAgY29uc3QgbWF0ID0gbWF0RW50cmllc1ttaV07XG4gICAgICBjb25zdCBtYXROYW1lTG93ZXIgPSBtYXQubmFtZS50b0xvd2VyQ2FzZSgpO1xuXG4gICAgICBjb25zdCB0ZXh0dXJlczogVGV4dHVyZVV1aWRzID0ge307XG4gICAgICBmb3IgKGNvbnN0IGltZyBvZiBpbWdFbnRyaWVzKSB7XG4gICAgICAgIGlmICghaW1nLm5hbWUudG9Mb3dlckNhc2UoKS5zdGFydHNXaXRoKG1hdE5hbWVMb3dlcikpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCB0eXBlID0gY2xhc3NpZnlUZXh0dXJlVHlwZShpbWcubmFtZSk7XG4gICAgICAgIGNvbnN0IHRleFV1aWQgPSBnZXRJbWFnZVRleHR1cmVVdWlkKGltZyk7XG4gICAgICAgIGlmICh0eXBlICYmIHRleFV1aWQpIHRleHR1cmVzW3R5cGVdID0gdGV4VXVpZDtcbiAgICAgIH1cblxuICAgICAgaWYgKE9iamVjdC5rZXlzKHRleHR1cmVzKS5sZW5ndGggPT09IDApIHtcbiAgICAgICAgZm9yIChjb25zdCBbdHlwZSwgZW50cmllc10gb2YgdHlwZWRJbWFnZXMuZW50cmllcygpKSB7XG4gICAgICAgICAgaWYgKGVudHJpZXMubGVuZ3RoID09PSBtYXRFbnRyaWVzLmxlbmd0aCkge1xuICAgICAgICAgICAgY29uc3Qgb3JkaW5hbE1hdGNoID0gZW50cmllc1ttaV07XG4gICAgICAgICAgICBpZiAob3JkaW5hbE1hdGNoKSB7XG4gICAgICAgICAgICAgIHRleHR1cmVzW3R5cGVdID0gb3JkaW5hbE1hdGNoLnRleHR1cmVVdWlkO1xuICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG5cbiAgICAgICAgICBjb25zdCBleGFjdE1hdGNoID0gZW50cmllcy5maW5kKChlbnRyeSkgPT4gZW50cnkuZ2x0ZkluZGV4ID09PSBtYXQuZ2x0ZkluZGV4KTtcbiAgICAgICAgICBpZiAoZXhhY3RNYXRjaCkge1xuICAgICAgICAgICAgdGV4dHVyZXNbdHlwZV0gPSBleGFjdE1hdGNoLnRleHR1cmVVdWlkO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBpZiAoT2JqZWN0LmtleXModGV4dHVyZXMpLmxlbmd0aCA9PT0gMCAmJiBtYXRFbnRyaWVzLmxlbmd0aCA9PT0gMSkge1xuICAgICAgICBPYmplY3QuYXNzaWduKHRleHR1cmVzLCBnbG9iYWxUZXh0dXJlcyk7XG4gICAgICB9XG5cbiAgICAgIG1hdGVyaWFscy5wdXNoKHtcbiAgICAgICAgbWF0ZXJpYWxVdWlkOiBtYXQudXVpZCxcbiAgICAgICAgbWF0ZXJpYWxEYlVybDogYCR7ZmJ4RGJQYXRofS8ke21hdC5uYW1lfWAsXG4gICAgICAgIHRleHR1cmVzLFxuICAgICAgfSk7XG5cbiAgICAgIHRoaXMuYWRkTG9nKGBNYXRlcmlhbFske21pfV0gJHttYXQubmFtZX06ICR7T2JqZWN0LmVudHJpZXModGV4dHVyZXMpLm1hcCgoW2ssIHZdKSA9PiBgJHtrfT0ke3Yuc2xpY2UoLTUpfWApLmpvaW4oJywgJyl9YCk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHsgbWF0ZXJpYWxzIH07XG4gIH1cblxuICAvKipcbiAgICogT3ZlcndyaXRlIHRoZSBGQlgncyBpbnRlcm5hbCBtYXRlcmlhbCBzdWItYXNzZXQgd2l0aCBpbXBvcnRlZC1tZXRhbGxpYy1yb3VnaG5lc3MuXG4gICAqL1xuICBwcml2YXRlIGFzeW5jIHRyeU92ZXJ3cml0ZUZieE1hdGVyaWFsKGluZm86IEZieE1hdGVyaWFsSW5mbywgZWZmZWN0VXVpZDogc3RyaW5nKTogUHJvbWlzZTxib29sZWFuPiB7XG4gICAgbGV0IHN1Y2Nlc3NDb3VudCA9IDA7XG5cbiAgICBmb3IgKGNvbnN0IG1hdCBvZiBpbmZvLm1hdGVyaWFscykge1xuICAgICAgY29uc3QgbWF0ZXJpYWxDb250ZW50ID0gYnVpbGREZWZhdWx0TWF0ZXJpYWxKc29uKGVmZmVjdFV1aWQsICd0cmlwby1wYnInLCBtYXQudGV4dHVyZXMpO1xuXG4gICAgICAvLyBUcnkgc2F2ZS1hc3NldCBvbiB0aGUgbWF0ZXJpYWwgc3ViLWFzc2V0IFVSTFxuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnYXNzZXQtZGInLCAnc2F2ZS1hc3NldCcsIG1hdC5tYXRlcmlhbERiVXJsLCBtYXRlcmlhbENvbnRlbnQpO1xuICAgICAgICBzdWNjZXNzQ291bnQrKztcbiAgICAgICAgdGhpcy5hZGRMb2coYE92ZXJ3cm90ZSBtYXRlcmlhbDogJHttYXQubWF0ZXJpYWxEYlVybH1gKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgdGhpcy5hZGRMb2coYHNhdmUtYXNzZXQgZmFpbGVkIGZvciAke21hdC5tYXRlcmlhbERiVXJsfTogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCk7XG4gICAgICB9XG5cbiAgICAgIC8vIFRyeSBzYXZlLWFzc2V0IGJ5IFVVSURcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3NhdmUtYXNzZXQnLCBtYXQubWF0ZXJpYWxVdWlkLCBtYXRlcmlhbENvbnRlbnQpO1xuICAgICAgICBzdWNjZXNzQ291bnQrKztcbiAgICAgICAgdGhpcy5hZGRMb2coYE92ZXJ3cm90ZSBtYXRlcmlhbCBieSBVVUlEOiAke21hdC5tYXRlcmlhbFV1aWR9YCk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIHRoaXMuYWRkTG9nKGBzYXZlLWFzc2V0IGJ5IFVVSUQgZmFpbGVkIGZvciAke21hdC5tYXRlcmlhbFV1aWR9OiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gc3VjY2Vzc0NvdW50ID4gMDtcbiAgfVxuXG4gIC8qKlxuICAgKiBGYWxsYmFjazogY3JlYXRlIGEgc3RhbmRhbG9uZSAubXRsIGZpbGUgYW5kIGFzc2lnbiBpdCB0byB0aGUgbm9kZS5cbiAgICovXG4gIHByaXZhdGUgYXN5bmMgY3JlYXRlQW5kQXBwbHlNdGwoXG4gICAgbW9kZWxEaXI6IHN0cmluZywgbm9kZVV1aWQ6IHN0cmluZywgZWZmZWN0VXVpZDogc3RyaW5nLCB0ZXh0dXJlcz86IFRleHR1cmVVdWlkcyxcbiAgKTogUHJvbWlzZTx7IGFwcGxpZWQ6IG51bWJlciB9PiB7XG4gICAgaWYgKCF0ZXh0dXJlcyB8fCBPYmplY3Qua2V5cyh0ZXh0dXJlcykubGVuZ3RoID09PSAwKSB7XG4gICAgICB0ZXh0dXJlcyA9IHRoaXMuZGlzY292ZXJUZXh0dXJlVXVpZHMobW9kZWxEaXIpO1xuICAgIH1cblxuICAgIGNvbnN0IGZieEZpbGVzID0gZnMucmVhZGRpclN5bmMobW9kZWxEaXIpLmZpbHRlcigoZikgPT4gL1xcLmZieCQvaS50ZXN0KGYpKTtcbiAgICBjb25zdCBtYXRlcmlhbE5hbWUgPSBmYnhGaWxlcy5sZW5ndGggPiAwXG4gICAgICA/IHBhdGguYmFzZW5hbWUoZmJ4RmlsZXNbMF0sIHBhdGguZXh0bmFtZShmYnhGaWxlc1swXSkpXG4gICAgICA6ICdkZWZhdWx0LW1hdGVyaWFsJztcbiAgICBjb25zdCBtdGxGaWxlUGF0aCA9IHBhdGguam9pbihtb2RlbERpciwgYCR7bWF0ZXJpYWxOYW1lfS5tdGxgKTtcbiAgICBjb25zdCBtdGxEYlBhdGggPSB0aGlzLmdldEFzc2V0RGJQYXRoKG10bEZpbGVQYXRoKTtcblxuICAgIHRyeSB7XG4gICAgICBmcy53cml0ZUZpbGVTeW5jKG10bEZpbGVQYXRoLCBidWlsZERlZmF1bHRNYXRlcmlhbEpzb24oZWZmZWN0VXVpZCwgbWF0ZXJpYWxOYW1lLCB0ZXh0dXJlcyksICd1dGY4Jyk7XG4gICAgICB0aGlzLmFkZExvZyhgQ3JlYXRlZCBtYXRlcmlhbDogJHtwYXRoLmJhc2VuYW1lKG10bEZpbGVQYXRoKX1gKTtcbiAgICAgIGF3YWl0IHRoaXMucmVmcmVzaEFzc2V0cyhtdGxGaWxlUGF0aCk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICB0aGlzLmFkZExvZyhgRmFpbGVkIHRvIGNyZWF0ZSBtYXRlcmlhbDogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCk7XG4gICAgICByZXR1cm4geyBhcHBsaWVkOiAwIH07XG4gICAgfVxuXG4gICAgbGV0IG1hdGVyaWFsVXVpZCA9ICcnO1xuICAgIGZvciAobGV0IGF0dGVtcHQgPSAwOyBhdHRlbXB0IDwgMTA7IGF0dGVtcHQrKykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgbWF0SW5mbyA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3F1ZXJ5LWFzc2V0LWluZm8nLCBtdGxEYlBhdGgsIFsndXVpZCcsICdpbXBvcnRlZCddKSBhcyB7IHV1aWQ/OiBzdHJpbmc7IGltcG9ydGVkPzogYm9vbGVhbiB9IHwgbnVsbDtcbiAgICAgICAgaWYgKG1hdEluZm8/LnV1aWQgJiYgbWF0SW5mby5pbXBvcnRlZCkgeyBtYXRlcmlhbFV1aWQgPSBtYXRJbmZvLnV1aWQ7IGJyZWFrOyB9XG4gICAgICB9IGNhdGNoIHsgLyogbm90IHJlYWR5ICovIH1cbiAgICAgIGF3YWl0IGRlbGF5KDUwMCk7XG4gICAgfVxuXG4gICAgaWYgKCFtYXRlcmlhbFV1aWQpIHtcbiAgICAgIHRoaXMuYWRkTG9nKCdNYXRlcmlhbCBub3QgeWV0IGltcG9ydGVkLicpO1xuICAgICAgcmV0dXJuIHsgYXBwbGllZDogMCB9O1xuICAgIH1cblxuICAgIGxldCBhcHBsaWVkID0gMDtcbiAgICB0cnkge1xuICAgICAgYXBwbGllZCA9IGF3YWl0IHRoaXMuYXBwbHlNYXRlcmlhbFRvTm9kZShub2RlVXVpZCwgbWF0ZXJpYWxVdWlkKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHRoaXMuYWRkTG9nKGBGYWlsZWQgdG8gYXBwbHkgbWF0ZXJpYWw6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWApO1xuICAgIH1cbiAgICByZXR1cm4geyBhcHBsaWVkIH07XG4gIH1cblxuICBwcml2YXRlIGRpc2NvdmVyVGV4dHVyZVV1aWRzKG1vZGVsRGlyOiBzdHJpbmcpOiBUZXh0dXJlVXVpZHMge1xuICAgIGNvbnN0IGZieEZpbGVzID0gZnMucmVhZGRpclN5bmMobW9kZWxEaXIpLmZpbHRlcigoZikgPT4gL1xcLmZieCQvaS50ZXN0KGYpKTtcbiAgICBpZiAoZmJ4RmlsZXMubGVuZ3RoID4gMCkge1xuICAgICAgY29uc3QgbWV0YVBhdGggPSBwYXRoLmpvaW4obW9kZWxEaXIsIGAke2ZieEZpbGVzWzBdfS5tZXRhYCk7XG4gICAgICBpZiAoZnMuZXhpc3RzU3luYyhtZXRhUGF0aCkpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBtZXRhID0gSlNPTi5wYXJzZShmcy5yZWFkRmlsZVN5bmMobWV0YVBhdGgsICd1dGY4JykpO1xuICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IHRoaXMuZGlzY292ZXJGcm9tU3ViTWV0YXMobWV0YT8uc3ViTWV0YXMgfHwge30pO1xuICAgICAgICAgIGlmIChPYmplY3Qua2V5cyhyZXN1bHQpLmxlbmd0aCA+IDApIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH0gY2F0Y2ggeyAvKiBmYWxsIHRocm91Z2ggKi8gfVxuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gdGhpcy5kaXNjb3ZlckZyb21GYm1EaXJlY3Rvcmllcyhtb2RlbERpcik7XG4gIH1cblxuICBwcml2YXRlIGRpc2NvdmVyRnJvbVN1Yk1ldGFzKHN1Yk1ldGFzOiBSZWNvcmQ8c3RyaW5nLCBhbnk+KTogVGV4dHVyZVV1aWRzIHtcbiAgICBjb25zdCByZXN1bHQ6IFRleHR1cmVVdWlkcyA9IHt9O1xuICAgIGNvbnN0IG5hbWVNYXBwaW5nOiBBcnJheTx7IGtleToga2V5b2YgVGV4dHVyZVV1aWRzOyBwYXR0ZXJuOiBSZWdFeHAgfT4gPSBbXG4gICAgICB7IGtleTogJ2Jhc2VDb2xvcicsIHBhdHRlcm46IC9iYXNlLj9jb2xvci9pIH0sXG4gICAgICB7IGtleTogJ25vcm1hbCcsIHBhdHRlcm46IC9ub3JtYWwobWFwKT8vaSB9LFxuICAgICAgeyBrZXk6ICdtZXRhbGxpYycsIHBhdHRlcm46IC9tZXRhbGxpYy9pIH0sXG4gICAgICB7IGtleTogJ3JvdWdobmVzcycsIHBhdHRlcm46IC9yb3VnaG5lc3MvaSB9LFxuICAgIF07XG5cbiAgICBmb3IgKGNvbnN0IFssIHN1Yl0gb2YgT2JqZWN0LmVudHJpZXMoc3ViTWV0YXMpKSB7XG4gICAgICBpZiAoc3ViPy5pbXBvcnRlciAhPT0gJ3RleHR1cmUnIHx8ICFzdWI/LnV1aWQgfHwgIXN1Yj8ubmFtZSkgY29udGludWU7XG4gICAgICBmb3IgKGNvbnN0IHsga2V5LCBwYXR0ZXJuIH0gb2YgbmFtZU1hcHBpbmcpIHtcbiAgICAgICAgaWYgKCFyZXN1bHRba2V5XSAmJiBwYXR0ZXJuLnRlc3Qoc3ViLm5hbWUpKSB7XG4gICAgICAgICAgcmVzdWx0W2tleV0gPSBzdWIudXVpZDtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG5cbiAgcHJpdmF0ZSBkaXNjb3ZlckZyb21GYm1EaXJlY3Rvcmllcyhtb2RlbERpcjogc3RyaW5nKTogVGV4dHVyZVV1aWRzIHtcbiAgICBjb25zdCByZXN1bHQ6IFRleHR1cmVVdWlkcyA9IHt9O1xuXG4gICAgY29uc3QgZmJtRGlycyA9IGZzLnJlYWRkaXJTeW5jKG1vZGVsRGlyKVxuICAgICAgLmZpbHRlcigoZikgPT4gL1xcLmZibSQvaS50ZXN0KGYpICYmIGZzLnN0YXRTeW5jKHBhdGguam9pbihtb2RlbERpciwgZikpLmlzRGlyZWN0b3J5KCkpO1xuICAgIGlmIChmYm1EaXJzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHJlc3VsdDtcblxuICAgIGNvbnN0IGltYWdlczogQXJyYXk8eyBmaWxlOiBzdHJpbmc7IGRpcjogc3RyaW5nIH0+ID0gW107XG4gICAgZm9yIChjb25zdCBmYm1EaXIgb2YgZmJtRGlycykge1xuICAgICAgY29uc3QgZmJtUGF0aCA9IHBhdGguam9pbihtb2RlbERpciwgZmJtRGlyKTtcbiAgICAgIGZvciAoY29uc3QgZiBvZiBmcy5yZWFkZGlyU3luYyhmYm1QYXRoKS5maWx0ZXIoKG5hbWUpID0+IC9cXC4ocG5nfGpwZ3xqcGVnfHRnYXxibXApJC9pLnRlc3QobmFtZSkpKSB7XG4gICAgICAgIGltYWdlcy5wdXNoKHsgZmlsZTogZiwgZGlyOiBmYm1QYXRoIH0pO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAoaW1hZ2VzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHJlc3VsdDtcblxuICAgIGNvbnN0IG1hcHBpbmc6IEFycmF5PHsga2V5OiBrZXlvZiBUZXh0dXJlVXVpZHM7IHN1ZmZpeDogUmVnRXhwIH0+ID0gW1xuICAgICAgeyBrZXk6ICdiYXNlQ29sb3InLCBzdWZmaXg6IC9fYmFzZWNvbG9yXFwuL2kgfSxcbiAgICAgIHsga2V5OiAnbm9ybWFsJywgc3VmZml4OiAvX25vcm1hbFxcLi9pIH0sXG4gICAgICB7IGtleTogJ21ldGFsbGljJywgc3VmZml4OiAvX21ldGFsbGljXFwuL2kgfSxcbiAgICAgIHsga2V5OiAncm91Z2huZXNzJywgc3VmZml4OiAvX3JvdWdobmVzc1xcLi9pIH0sXG4gICAgXTtcblxuICAgIGZvciAoY29uc3QgeyBmaWxlLCBkaXIgfSBvZiBpbWFnZXMpIHtcbiAgICAgIGZvciAoY29uc3QgeyBrZXksIHN1ZmZpeCB9IG9mIG1hcHBpbmcpIHtcbiAgICAgICAgaWYgKHJlc3VsdFtrZXldIHx8ICFzdWZmaXgudGVzdChmaWxlKSkgY29udGludWU7XG4gICAgICAgIGNvbnN0IG1ldGFQYXRoID0gYCR7cGF0aC5qb2luKGRpciwgZmlsZSl9Lm1ldGFgO1xuICAgICAgICBpZiAoZnMuZXhpc3RzU3luYyhtZXRhUGF0aCkpIHtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgbWV0YSA9IEpTT04ucGFyc2UoZnMucmVhZEZpbGVTeW5jKG1ldGFQYXRoLCAndXRmOCcpKTtcbiAgICAgICAgICAgIGZvciAoY29uc3QgWywgc3ViXSBvZiBPYmplY3QuZW50cmllcyhtZXRhLnN1Yk1ldGFzIHx8IHt9KSBhcyBbc3RyaW5nLCBhbnldW10pIHtcbiAgICAgICAgICAgICAgaWYgKHN1Yj8udXVpZCkgeyByZXN1bHRba2V5XSA9IHN1Yi51dWlkOyBicmVhazsgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gY2F0Y2ggeyAvKiBza2lwICovIH1cbiAgICAgICAgfVxuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBhc3NpZ25lZCA9IE9iamVjdC5rZXlzKHJlc3VsdCk7XG4gICAgaWYgKGFzc2lnbmVkLmxlbmd0aCA+IDApIHtcbiAgICAgIHRoaXMuYWRkTG9nKGBGb3VuZCAke2ltYWdlcy5sZW5ndGh9IHRleHR1cmUocyksIGFzc2lnbmVkOiAke2Fzc2lnbmVkLmpvaW4oJywgJyl9LmApO1xuICAgIH1cbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBhcHBseU1hdGVyaWFsVG9Ob2RlKG5vZGVVdWlkOiBzdHJpbmcsIG1hdGVyaWFsVXVpZDogc3RyaW5nKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgICBjb25zdCBub2RlRHVtcCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3F1ZXJ5LW5vZGUnLCBub2RlVXVpZCkgYXMgYW55O1xuICAgIGlmICghbm9kZUR1bXApIHRocm93IG5ldyBFcnJvcihgTm9kZSBkdW1wIG5vdCBmb3VuZCBmb3IgdXVpZD0ke25vZGVVdWlkfWApO1xuXG4gICAgbGV0IGFwcGxpZWQgPSBhd2FpdCB0aGlzLnNldE1hdGVyaWFsT25Db21wb25lbnRzKG5vZGVVdWlkLCBub2RlRHVtcCwgbWF0ZXJpYWxVdWlkKTtcblxuICAgIGNvbnN0IGNoaWxkcmVuUmF3ID0gbm9kZUR1bXAuY2hpbGRyZW47XG4gICAgY29uc3QgY2hpbGRyZW46IGFueVtdID0gQXJyYXkuaXNBcnJheShjaGlsZHJlblJhdykgPyBjaGlsZHJlblJhd1xuICAgICAgOiAoQXJyYXkuaXNBcnJheShjaGlsZHJlblJhdz8udmFsdWUpID8gY2hpbGRyZW5SYXcudmFsdWUgOiBbXSk7XG5cbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIGNoaWxkcmVuKSB7XG4gICAgICBjb25zdCBjaGlsZFV1aWQ6IHN0cmluZyA9IHR5cGVvZiBjaGlsZCA9PT0gJ3N0cmluZycgPyBjaGlsZFxuICAgICAgICA6IChjaGlsZD8udmFsdWU/LnV1aWQgfHwgY2hpbGQ/LnV1aWQ/LnZhbHVlIHx8IGNoaWxkPy51dWlkIHx8ICcnKTtcbiAgICAgIGlmIChjaGlsZFV1aWQpIHtcbiAgICAgICAgdHJ5IHsgYXBwbGllZCArPSBhd2FpdCB0aGlzLmFwcGx5TWF0ZXJpYWxUb05vZGUoY2hpbGRVdWlkLCBtYXRlcmlhbFV1aWQpOyB9IGNhdGNoIHsgLyogc2tpcCAqLyB9XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBhcHBsaWVkO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBzZXRNYXRlcmlhbE9uQ29tcG9uZW50cyhub2RlVXVpZDogc3RyaW5nLCBub2RlRHVtcDogYW55LCBtYXRlcmlhbFV1aWQ6IHN0cmluZyk6IFByb21pc2U8bnVtYmVyPiB7XG4gICAgY29uc3QgY29tcG9uZW50czogYW55W10gPSBub2RlRHVtcC5fX2NvbXBzX18gfHwgW107XG4gICAgbGV0IGFwcGxpZWQgPSAwO1xuXG4gICAgZm9yIChsZXQgY2kgPSAwOyBjaSA8IGNvbXBvbmVudHMubGVuZ3RoOyBjaSsrKSB7XG4gICAgICBjb25zdCBjb21wID0gY29tcG9uZW50c1tjaV07XG4gICAgICBjb25zdCBjb21wVHlwZTogc3RyaW5nID0gY29tcD8udHlwZSB8fCBjb21wPy5fX3R5cGVfXyB8fCAnJztcbiAgICAgIGlmICghY29tcFR5cGUuaW5jbHVkZXMoJ01lc2hSZW5kZXJlcicpKSBjb250aW51ZTtcblxuICAgICAgY29uc3QgY29tcFZhbHVlID0gY29tcD8udmFsdWUgfHwge307XG4gICAgICBjb25zdCBtYXRlcmlhbHNSYXcgPSBjb21wVmFsdWU/LnNoYXJlZE1hdGVyaWFscyB8fCBjb21wVmFsdWU/Lm1hdGVyaWFscyB8fCBjb21wVmFsdWU/Ll9tYXRlcmlhbHM7XG4gICAgICBjb25zdCBtYXRlcmlhbHM6IGFueVtdID0gbWF0ZXJpYWxzUmF3Py52YWx1ZSB8fCBbXTtcblxuICAgICAgaWYgKG1hdGVyaWFscy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdzZXQtcHJvcGVydHknLCB7XG4gICAgICAgICAgICB1dWlkOiBub2RlVXVpZCxcbiAgICAgICAgICAgIHBhdGg6IGBfX2NvbXBzX18uJHtjaX0uc2hhcmVkTWF0ZXJpYWxzYCxcbiAgICAgICAgICAgIGR1bXA6IHsgdHlwZTogJ0FycmF5JywgdmFsdWU6IFt7IHR5cGU6ICdjYy5NYXRlcmlhbCcsIHZhbHVlOiB7IHV1aWQ6IG1hdGVyaWFsVXVpZCB9IH1dIH0sXG4gICAgICAgICAgfSk7XG4gICAgICAgICAgYXBwbGllZCsrO1xuICAgICAgICB9IGNhdGNoIHsgLyogc2tpcCAqLyB9XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICBmb3IgKGxldCBtaSA9IDA7IG1pIDwgbWF0ZXJpYWxzLmxlbmd0aDsgbWkrKykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3NldC1wcm9wZXJ0eScsIHtcbiAgICAgICAgICAgIHV1aWQ6IG5vZGVVdWlkLFxuICAgICAgICAgICAgcGF0aDogYF9fY29tcHNfXy4ke2NpfS5zaGFyZWRNYXRlcmlhbHMuJHttaX1gLFxuICAgICAgICAgICAgZHVtcDogeyB0eXBlOiAnY2MuTWF0ZXJpYWwnLCB2YWx1ZTogeyB1dWlkOiBtYXRlcmlhbFV1aWQgfSB9LFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIGFwcGxpZWQrKztcbiAgICAgICAgfSBjYXRjaCB7IC8qIHNraXAgKi8gfVxuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gYXBwbGllZDtcbiAgfVxufVxuIl19