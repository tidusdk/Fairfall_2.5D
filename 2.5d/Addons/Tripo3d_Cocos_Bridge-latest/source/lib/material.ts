import fs from 'fs';
import path from 'path';
import { delay } from './protocol';

type TextureUuids = {
  baseColor?: string;
  normal?: string;
  metallic?: string;
  roughness?: string;
};

type FbxMaterialEntry = {
  materialUuid: string;
  materialDbUrl: string;
  textures: TextureUuids;
};

type FbxMaterialInfo = {
  materials: FbxMaterialEntry[];
};

function normalizeAssetRef(value: string): string {
  return String(value || '').trim().replace(/\\/g, '/').toLowerCase();
}

export function buildDefaultMaterialJson(effectUuid: string, materialName: string, textures?: TextureUuids): string {
  const defines: Record<string, boolean> = {};
  const props: Record<string, any> = {};

  const texRef = (uuid: string) => ({ __uuid__: uuid, __expectedType__: 'cc.Texture2D' });

  if (textures?.baseColor) { defines.USE_ALBEDO_MAP = true; props.mainTexture = texRef(textures.baseColor); }
  if (textures?.normal) { defines.USE_NORMAL_MAP = true; props.normalMap = texRef(textures.normal); }
  if (textures?.metallic) { defines.USE_METALLIC_MAP = true; props.metallicMap = texRef(textures.metallic); }
  if (textures?.roughness) { defines.USE_ROUGHNESS_MAP = true; props.roughnessMap = texRef(textures.roughness); }

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

function classifyTextureType(name: string): keyof TextureUuids | null {
  if (/base.?color/i.test(name)) return 'baseColor';
  if (/normal/i.test(name)) return 'normal';
  if (/metallic/i.test(name)) return 'metallic';
  if (/roughness/i.test(name)) return 'roughness';
  return null;
}

export class MaterialManager {
  constructor(
    private readonly addLog: (msg: string) => void,
    private readonly getAssetDbPath: (fsPath: string) => string,
    private readonly refreshAssets: (fsPath: string) => Promise<boolean>,
  ) {}

  async ensureDefaultMaterial(savedPath: string, nodeUuid: string): Promise<{ applied: number }> {
    if (!globalThis.Editor || !Editor.Message || !Editor.Message.request) {
      return { applied: 0 };
    }

    // Resolve imported-metallic-roughness effect UUID
    const effectPath = 'db://internal/effects/util/dcc/imported-metallic-roughness.effect';
    let effectUuid = '';
    try {
      const info = await Editor.Message.request('asset-db', 'query-asset-info', effectPath, ['uuid']) as { uuid?: string } | null;
      if (info?.uuid) effectUuid = info.uuid;
    } catch { /* not available */ }

    if (!effectUuid) {
      this.addLog('PBR effect not found, skipping material setup.');
      return { applied: 0 };
    }

    const assetExists = fs.existsSync(savedPath);
    const assetIsDir = assetExists && fs.statSync(savedPath).isDirectory();
    const modelDir = assetIsDir ? savedPath : path.dirname(savedPath);

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
    const fallbackTextures = fbxInfo?.materials?.[0]?.textures;
    return this.createAndApplyMtl(modelDir, nodeUuid, effectUuid, fallbackTextures);
  }

  /**
   * Read the FBX .meta to extract internal material UUID, db URL, and texture UUIDs.
   */
  private parseFbxMeta(modelDir: string): FbxMaterialInfo | null {
    const fbxFiles = fs.readdirSync(modelDir).filter((f) => /\.fbx$/i.test(f));
    if (fbxFiles.length === 0) return null;

    const fbxFileName = fbxFiles[0];
    const metaPath = path.join(modelDir, `${fbxFileName}.meta`);
    if (!fs.existsSync(metaPath)) return null;

    let meta: any;
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { return null; }

    const subMetas: Record<string, any> = meta?.subMetas || {};

    // Build db:// base URL for the FBX
    const fbxFilePath = path.join(modelDir, fbxFileName);
    let fbxDbPath = '';
    try { fbxDbPath = this.getAssetDbPath(fbxFilePath); } catch { return null; }

    // Collect materials, images, textures from subMetas
    const matEntries: Array<{ uuid: string; name: string; gltfIndex: number }> = [];
    const imgEntries: Array<{ uuid: string; name: string; gltfIndex: number }> = [];
    const texEntries: Array<{ uuid: string; name: string; imageUuid: string }> = [];

    for (const [, sub] of Object.entries(subMetas)) {
      if (!sub?.uuid || !sub?.importer) continue;
      if (sub.importer === 'gltf-material') {
        matEntries.push({ uuid: sub.uuid, name: sub.name || '', gltfIndex: sub.userData?.gltfIndex ?? 0 });
      } else if (sub.importer === 'gltf-embeded-image') {
        imgEntries.push({ uuid: sub.uuid, name: sub.name || '', gltfIndex: sub.userData?.gltfIndex ?? 0 });
      } else if (sub.importer === 'texture') {
        texEntries.push({ uuid: sub.uuid, name: sub.name || '', imageUuid: sub.userData?.imageUuidOrDatabaseUri ?? '' });
      }
    }

    if (matEntries.length === 0) return null;

    // Sort materials and images by gltfIndex
    matEntries.sort((a, b) => a.gltfIndex - b.gltfIndex);
    imgEntries.sort((a, b) => a.gltfIndex - b.gltfIndex);

    // image UUID → texture UUID (texture wraps image)
    const imgToTex: Record<string, string> = {};
    for (const tex of texEntries) {
      const ref = normalizeAssetRef(tex.imageUuid);
      if (ref) imgToTex[ref] = tex.uuid;
    }

    const getImageLookupKeys = (img: { uuid: string; name: string }): string[] => {
      const keys = [normalizeAssetRef(img.uuid), normalizeAssetRef(`${fbxDbPath}/${img.name}`)];
      return keys.filter(Boolean);
    };

    const getImageTextureUuid = (img: { uuid: string; name: string }): string | undefined => {
      return getImageLookupKeys(img).map((key) => imgToTex[key]).find(Boolean);
    };

    const globalTextures: TextureUuids = {};
    const typedImages = new Map<keyof TextureUuids, Array<{ gltfIndex: number; textureUuid: string }>>();
    for (const img of imgEntries) {
      const type = classifyTextureType(img.name);
      if (!type) continue;

      const texUuid = getImageTextureUuid(img);
      if (!texUuid) continue;

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
    const materials: FbxMaterialEntry[] = [];

    for (let mi = 0; mi < matEntries.length; mi++) {
      const mat = matEntries[mi];
      const matNameLower = mat.name.toLowerCase();

      const textures: TextureUuids = {};
      for (const img of imgEntries) {
        if (!img.name.toLowerCase().startsWith(matNameLower)) continue;
        const type = classifyTextureType(img.name);
        const texUuid = getImageTextureUuid(img);
        if (type && texUuid) textures[type] = texUuid;
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
  private async tryOverwriteFbxMaterial(info: FbxMaterialInfo, effectUuid: string): Promise<boolean> {
    let successCount = 0;

    for (const mat of info.materials) {
      const materialContent = buildDefaultMaterialJson(effectUuid, 'tripo-pbr', mat.textures);

      // Try save-asset on the material sub-asset URL
      try {
        await Editor.Message.request('asset-db', 'save-asset', mat.materialDbUrl, materialContent);
        successCount++;
        this.addLog(`Overwrote material: ${mat.materialDbUrl}`);
        continue;
      } catch (err) {
        this.addLog(`save-asset failed for ${mat.materialDbUrl}: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Try save-asset by UUID
      try {
        await Editor.Message.request('asset-db', 'save-asset', mat.materialUuid, materialContent);
        successCount++;
        this.addLog(`Overwrote material by UUID: ${mat.materialUuid}`);
        continue;
      } catch (err) {
        this.addLog(`save-asset by UUID failed for ${mat.materialUuid}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return successCount > 0;
  }

  /**
   * Fallback: create a standalone .mtl file and assign it to the node.
   */
  private async createAndApplyMtl(
    modelDir: string, nodeUuid: string, effectUuid: string, textures?: TextureUuids,
  ): Promise<{ applied: number }> {
    if (!textures || Object.keys(textures).length === 0) {
      textures = this.discoverTextureUuids(modelDir);
    }

    const fbxFiles = fs.readdirSync(modelDir).filter((f) => /\.fbx$/i.test(f));
    const materialName = fbxFiles.length > 0
      ? path.basename(fbxFiles[0], path.extname(fbxFiles[0]))
      : 'default-material';
    const mtlFilePath = path.join(modelDir, `${materialName}.mtl`);
    const mtlDbPath = this.getAssetDbPath(mtlFilePath);

    try {
      fs.writeFileSync(mtlFilePath, buildDefaultMaterialJson(effectUuid, materialName, textures), 'utf8');
      this.addLog(`Created material: ${path.basename(mtlFilePath)}`);
      await this.refreshAssets(mtlFilePath);
    } catch (err) {
      this.addLog(`Failed to create material: ${err instanceof Error ? err.message : String(err)}`);
      return { applied: 0 };
    }

    let materialUuid = '';
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const matInfo = await Editor.Message.request('asset-db', 'query-asset-info', mtlDbPath, ['uuid', 'imported']) as { uuid?: string; imported?: boolean } | null;
        if (matInfo?.uuid && matInfo.imported) { materialUuid = matInfo.uuid; break; }
      } catch { /* not ready */ }
      await delay(500);
    }

    if (!materialUuid) {
      this.addLog('Material not yet imported.');
      return { applied: 0 };
    }

    let applied = 0;
    try {
      applied = await this.applyMaterialToNode(nodeUuid, materialUuid);
    } catch (err) {
      this.addLog(`Failed to apply material: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { applied };
  }

  private discoverTextureUuids(modelDir: string): TextureUuids {
    const fbxFiles = fs.readdirSync(modelDir).filter((f) => /\.fbx$/i.test(f));
    if (fbxFiles.length > 0) {
      const metaPath = path.join(modelDir, `${fbxFiles[0]}.meta`);
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          const result = this.discoverFromSubMetas(meta?.subMetas || {});
          if (Object.keys(result).length > 0) return result;
        } catch { /* fall through */ }
      }
    }
    return this.discoverFromFbmDirectories(modelDir);
  }

  private discoverFromSubMetas(subMetas: Record<string, any>): TextureUuids {
    const result: TextureUuids = {};
    const nameMapping: Array<{ key: keyof TextureUuids; pattern: RegExp }> = [
      { key: 'baseColor', pattern: /base.?color/i },
      { key: 'normal', pattern: /normal(map)?/i },
      { key: 'metallic', pattern: /metallic/i },
      { key: 'roughness', pattern: /roughness/i },
    ];

    for (const [, sub] of Object.entries(subMetas)) {
      if (sub?.importer !== 'texture' || !sub?.uuid || !sub?.name) continue;
      for (const { key, pattern } of nameMapping) {
        if (!result[key] && pattern.test(sub.name)) {
          result[key] = sub.uuid;
          break;
        }
      }
    }
    return result;
  }

  private discoverFromFbmDirectories(modelDir: string): TextureUuids {
    const result: TextureUuids = {};

    const fbmDirs = fs.readdirSync(modelDir)
      .filter((f) => /\.fbm$/i.test(f) && fs.statSync(path.join(modelDir, f)).isDirectory());
    if (fbmDirs.length === 0) return result;

    const images: Array<{ file: string; dir: string }> = [];
    for (const fbmDir of fbmDirs) {
      const fbmPath = path.join(modelDir, fbmDir);
      for (const f of fs.readdirSync(fbmPath).filter((name) => /\.(png|jpg|jpeg|tga|bmp)$/i.test(name))) {
        images.push({ file: f, dir: fbmPath });
      }
    }
    if (images.length === 0) return result;

    const mapping: Array<{ key: keyof TextureUuids; suffix: RegExp }> = [
      { key: 'baseColor', suffix: /_basecolor\./i },
      { key: 'normal', suffix: /_normal\./i },
      { key: 'metallic', suffix: /_metallic\./i },
      { key: 'roughness', suffix: /_roughness\./i },
    ];

    for (const { file, dir } of images) {
      for (const { key, suffix } of mapping) {
        if (result[key] || !suffix.test(file)) continue;
        const metaPath = `${path.join(dir, file)}.meta`;
        if (fs.existsSync(metaPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            for (const [, sub] of Object.entries(meta.subMetas || {}) as [string, any][]) {
              if (sub?.uuid) { result[key] = sub.uuid; break; }
            }
          } catch { /* skip */ }
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

  private async applyMaterialToNode(nodeUuid: string, materialUuid: string): Promise<number> {
    const nodeDump = await Editor.Message.request('scene', 'query-node', nodeUuid) as any;
    if (!nodeDump) throw new Error(`Node dump not found for uuid=${nodeUuid}`);

    let applied = await this.setMaterialOnComponents(nodeUuid, nodeDump, materialUuid);

    const childrenRaw = nodeDump.children;
    const children: any[] = Array.isArray(childrenRaw) ? childrenRaw
      : (Array.isArray(childrenRaw?.value) ? childrenRaw.value : []);

    for (const child of children) {
      const childUuid: string = typeof child === 'string' ? child
        : (child?.value?.uuid || child?.uuid?.value || child?.uuid || '');
      if (childUuid) {
        try { applied += await this.applyMaterialToNode(childUuid, materialUuid); } catch { /* skip */ }
      }
    }
    return applied;
  }

  private async setMaterialOnComponents(nodeUuid: string, nodeDump: any, materialUuid: string): Promise<number> {
    const components: any[] = nodeDump.__comps__ || [];
    let applied = 0;

    for (let ci = 0; ci < components.length; ci++) {
      const comp = components[ci];
      const compType: string = comp?.type || comp?.__type__ || '';
      if (!compType.includes('MeshRenderer')) continue;

      const compValue = comp?.value || {};
      const materialsRaw = compValue?.sharedMaterials || compValue?.materials || compValue?._materials;
      const materials: any[] = materialsRaw?.value || [];

      if (materials.length === 0) {
        try {
          await Editor.Message.request('scene', 'set-property', {
            uuid: nodeUuid,
            path: `__comps__.${ci}.sharedMaterials`,
            dump: { type: 'Array', value: [{ type: 'cc.Material', value: { uuid: materialUuid } }] },
          });
          applied++;
        } catch { /* skip */ }
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
        } catch { /* skip */ }
      }
    }
    return applied;
  }
}
