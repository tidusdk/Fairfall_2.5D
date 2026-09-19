type TransferSession = {
  fileId: string;
  fileName: string;
  fileType: string;
  totalChunks: number;
  chunks: Map<number, Buffer>;
};

export class FileTransferManager {
  private readonly sessions = new Map<string, TransferSession>();

  addChunk(
    fileId: string,
    fileName: string,
    fileType: string,
    chunkIndex: number,
    chunkTotal: number,
    chunkData: Uint8Array,
  ) {
    if (!this.sessions.has(fileId)) {
      this.sessions.set(fileId, {
        fileId,
        fileName,
        fileType,
        totalChunks: chunkTotal,
        chunks: new Map<number, Buffer>(),
      });
    }

    const session = this.sessions.get(fileId)!;
    session.fileName = fileName;
    session.fileType = fileType;
    session.totalChunks = chunkTotal;
    session.chunks.set(chunkIndex, Buffer.from(chunkData));
    return session;
  }

  isComplete(fileId: string) {
    const session = this.sessions.get(fileId);
    return !!session && session.chunks.size === session.totalChunks;
  }

  assembleFile(fileId: string) {
    const session = this.sessions.get(fileId);
    if (!session) {
      throw new Error(`Missing transfer session: ${fileId}`);
    }

    const parts: Buffer[] = [];
    for (let index = 0; index < session.totalChunks; index += 1) {
      const chunk = session.chunks.get(index);
      if (!chunk) {
        throw new Error(`Missing chunk ${index} for ${fileId}`);
      }
      parts.push(chunk);
    }

    return Buffer.concat(parts);
  }

  removeSession(fileId: string) {
    this.sessions.delete(fileId);
  }

  clear() {
    this.sessions.clear();
  }
}