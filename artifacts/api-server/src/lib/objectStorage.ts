import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import { File, Storage } from '@google-cloud/storage';
import { and, eq } from 'drizzle-orm';
import {
  db,
  objectUploadsTable,
} from '@workspace/db';

import {
  canAccessObject,
  getObjectAclPolicy,
  ObjectAclPolicy,
  ObjectPermission,
  objectAclPolicyFromMetadata,
  setObjectAclPolicy,
} from './objectAcl';

const REPLIT_SIDECAR_ENDPOINT = 'http://127.0.0.1:1106';

export const objectStorageClient = new Storage({
  credentials: {
    audience: 'replit',
    subject_token_type: 'access_token',
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: 'external_account',
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: 'json',
        subject_token_field_name: 'access_token',
      },
    },
    universe_domain: 'googleapis.com',
  },
  projectId: '',
});

export class ObjectNotFoundError extends Error {
  constructor() {
    super('Object not found');
    this.name = 'ObjectNotFoundError';
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

export class ObjectAclOwnershipError extends Error {
  constructor(message = 'Private object is not owned by this user') {
    super(message);
    this.name = 'ObjectAclOwnershipError';
    Object.setPrototypeOf(this, ObjectAclOwnershipError.prototype);
  }
}

export class ObjectStorageService {
  constructor() {}

  getPublicObjectSearchPaths(): Array<string> {
    const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS || '';
    const paths = Array.from(
      new Set(
        pathsStr
          .split(',')
          .map((path) => path.trim())
          .filter((path) => path.length > 0),
      ),
    );
    if (paths.length === 0) {
      throw new Error(
        "PUBLIC_OBJECT_SEARCH_PATHS not set. Create a bucket in 'Object Storage' " +
          'tool and set PUBLIC_OBJECT_SEARCH_PATHS env var (comma-separated paths).',
      );
    }
    return paths;
  }

  getPrivateObjectDir(): string {
    const dir = process.env.PRIVATE_OBJECT_DIR || '';
    if (!dir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          'tool and set PRIVATE_OBJECT_DIR env var.',
      );
    }
    return dir;
  }

  async searchPublicObject(filePath: string): Promise<File | null> {
    for (const searchPath of this.getPublicObjectSearchPaths()) {
      const fullPath = `${searchPath}/${filePath}`;

      const { bucketName, objectName } = parseObjectPath(fullPath);
      const bucket = objectStorageClient.bucket(bucketName);
      const file = bucket.file(objectName);

      const [exists] = await file.exists();
      if (exists) {
        return file;
      }
    }

    return null;
  }

  async downloadObject(
    file: File,
    cacheTtlSec: number = 3600,
  ): Promise<Response> {
    const [metadata] = await file.getMetadata();
    const aclPolicy = await getObjectAclPolicy(file);
    const isPublic = aclPolicy?.visibility === 'public';

    const nodeStream = file.createReadStream();
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;

    const headers: Record<string, string> = {
      'Content-Type':
        (metadata.contentType as string) || 'application/octet-stream',
      'Cache-Control': `${isPublic ? 'public' : 'private'}, max-age=${cacheTtlSec}`,
    };
    if (metadata.size) {
      headers['Content-Length'] = String(metadata.size);
    }

    return new Response(webStream, { headers });
  }

  async getObjectEntityUploadURL(): Promise<string> {
    const privateObjectDir = this.getPrivateObjectDir();
    if (!privateObjectDir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          'tool and set PRIVATE_OBJECT_DIR env var.',
      );
    }

    const objectId = randomUUID();
    const fullPath = `${privateObjectDir}/uploads/${objectId}`;

    const { bucketName, objectName } = parseObjectPath(fullPath);

    return signObjectURL({
      bucketName,
      objectName,
      method: 'PUT',
      ttlSec: 900,
    });
  }

  async getObjectEntityFile(objectPath: string): Promise<File> {
    if (!objectPath.startsWith('/objects/')) {
      throw new ObjectNotFoundError();
    }

    const parts = objectPath.slice(1).split('/');
    if (parts.length < 2) {
      throw new ObjectNotFoundError();
    }

    const entityId = parts.slice(1).join('/');
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith('/')) {
      entityDir = `${entityDir}/`;
    }
    const objectEntityPath = `${entityDir}${entityId}`;
    const { bucketName, objectName } = parseObjectPath(objectEntityPath);
    const bucket = objectStorageClient.bucket(bucketName);
    const objectFile = bucket.file(objectName);
    const [exists] = await objectFile.exists();
    if (!exists) {
      throw new ObjectNotFoundError();
    }
    return objectFile;
  }

  normalizeObjectEntityPath(rawPath: string): string {
    if (!rawPath.startsWith('https://storage.googleapis.com/')) {
      return rawPath;
    }

    const url = new URL(rawPath);
    const rawObjectPath = url.pathname;

    let objectEntityDir = this.getPrivateObjectDir();
    if (!objectEntityDir.endsWith('/')) {
      objectEntityDir = `${objectEntityDir}/`;
    }

    if (!rawObjectPath.startsWith(objectEntityDir)) {
      return rawObjectPath;
    }

    const entityId = rawObjectPath.slice(objectEntityDir.length);
    return `/objects/${entityId}`;
  }

  async trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: ObjectAclPolicy,
    authenticatedUserId: string,
    tx: ObjectStorageTransaction,
  ): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!normalizedPath.startsWith('/objects/')
      || normalizedPath.includes('?')
      || normalizedPath.includes('#')
      || normalizedPath.includes('\\')
      || normalizedPath.split('/').some((part) => part === '.' || part === '..')) {
      throw new ObjectAclOwnershipError('Photo must be a normalized private object path');
    }
    if (aclPolicy.owner !== authenticatedUserId || aclPolicy.visibility !== 'private') {
      throw new ObjectAclOwnershipError();
    }

    const [provenance] = await tx.select().from(objectUploadsTable)
      .where(eq(objectUploadsTable.objectPath, normalizedPath)).limit(1);
    if (provenance && provenance.userId !== authenticatedUserId) {
      throw new ObjectAclOwnershipError();
    }

    const objectFile = await this.getObjectEntityFile(normalizedPath);
    const existingPolicy = await getObjectAclPolicy(objectFile);
    if (existingPolicy) {
      if (existingPolicy.owner !== authenticatedUserId || existingPolicy.visibility !== 'private') {
        throw new ObjectAclOwnershipError();
      }
      // A same-owner private object is already adopted. Do not rewrite its
      // ACL metadata (which could also erase any valid ACL rules).
      if (provenance) await markUploadAdopted(tx, normalizedPath, authenticatedUserId);
      return normalizedPath;
    }

    if (!provenance) throw new ObjectAclOwnershipError();

    await setObjectAclPolicy(objectFile, aclPolicy);
    await markUploadAdopted(tx, normalizedPath, authenticatedUserId);
    return normalizedPath;
  }

  async getOwnedPrivateObjectEntity(rawPath: string, authenticatedUserId: string) {
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!normalizedPath.startsWith('/objects/')
      || normalizedPath.includes('?')
      || normalizedPath.includes('#')
      || normalizedPath.includes('\\')
      || normalizedPath.split('/').some((part) => part === '.' || part === '..')) {
      throw new ObjectAclOwnershipError('Photo must be a normalized private object path');
    }

    // Existence and ACL/provenance metadata are checked before image bytes are
    // streamed or upload MIME/size metadata is trusted for validation.
    const objectFile = await this.getObjectEntityFile(normalizedPath);
    const existingPolicy = await getObjectAclPolicy(objectFile);
    if (existingPolicy) {
      if (existingPolicy.owner !== authenticatedUserId || existingPolicy.visibility !== 'private') {
        throw new ObjectAclOwnershipError();
      }
    } else {
      const [upload] = await db.select({ objectPath: objectUploadsTable.objectPath })
        .from(objectUploadsTable).where(and(
          eq(objectUploadsTable.objectPath, normalizedPath),
          eq(objectUploadsTable.userId, authenticatedUserId),
        )).limit(1);
      if (!upload) throw new ObjectAclOwnershipError();
    }

    return {
      objectPath: normalizedPath,
      objectFile,
      metadata: (await objectFile.getMetadata())[0],
    };
  }

  async writePrivateDerivedObject(
    authenticatedUserId: string,
    contents: Buffer,
    contentType: string,
  ): Promise<string> {
    const objectId = randomUUID();
    const objectPath = `/objects/memory-images/${objectId}.webp`;
    const objectFile = await this.getObjectEntityFileForWrite(objectPath);
    let saved = false;
    try {
      await objectFile.save(contents, {
        resumable: false,
        metadata: { contentType },
      });
      saved = true;
      await setObjectAclPolicy(objectFile, {
        owner: authenticatedUserId,
        visibility: 'private',
      });
      await db.insert(objectUploadsTable).values({
        objectPath,
        userId: authenticatedUserId,
      });
      return objectPath;
    } catch (error) {
      if (saved) {
        try {
          await objectFile.delete({ ignoreNotFound: true });
        } catch {
          // Preserve the original save/ACL/provenance error; the unique output
          // path can be removed by the storage orphan cleanup job if necessary.
        }
      }
      throw error;
    }
  }

  private async getObjectEntityFileForWrite(objectPath: string): Promise<File> {
    if (!objectPath.startsWith('/objects/memory-images/')) {
      throw new ObjectAclOwnershipError('Derived photo path is invalid');
    }
    const privateObjectDir = this.getPrivateObjectDir();
    const objectName = objectPath.slice('/objects/'.length);
    const fullPath = `${privateObjectDir.replace(/\/+$/, '')}/${objectName}`;
    const { bucketName, objectName: storageObjectName } = parseObjectPath(fullPath);
    return objectStorageClient.bucket(bucketName).file(storageObjectName);
  }

  async canAccessObjectEntity({
    userId,
    objectFile,
    requestedPermission,
  }: {
    userId?: string;
    objectFile: File;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    return canAccessObject({
      userId,
      objectFile,
      requestedPermission: requestedPermission ?? ObjectPermission.READ,
    });
  }

  /**
   * Deletes only canonical private-upload or generated memory-image paths after
   * rechecking location, ownership metadata, and GCS preconditions. The caller is responsible for holding the object's owner's
   * database lock and checking all database references in the same transaction.
   */
  async deletePrivateUploadIfSafe(
    objectPath: string,
    ownerId: string,
  ): Promise<'deleted' | 'missing' | 'protected'> {
    const uploadMatch = /^\/objects\/uploads\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(objectPath);
    const derivedMatch = /^\/objects\/memory-images\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp)$/.exec(objectPath);
    if (!uploadMatch && !derivedMatch) return 'protected';

    const privateObjectDir = this.getPrivateObjectDir();
    const normalizedPrivateDir = privateObjectDir.startsWith('/')
      || privateObjectDir.startsWith('gs://')
      || /^https?:\/\//i.test(privateObjectDir)
      ? privateObjectDir
      : `/${privateObjectDir}`;
    const privatePath = parseConfiguredStoragePath(normalizedPrivateDir);
    if (!privatePath) throw new Error('PRIVATE_OBJECT_DIR is not a safe object path');
    const pathAfterObjectsPrefix = objectPath.slice('/objects/'.length);
    const target = {
      bucketName: privatePath.bucketName,
      objectName: [privatePath.objectName, pathAfterObjectsPrefix].filter(Boolean).join('/'),
    };
    if (this.overlapsPublicSearchPath(target.bucketName, target.objectName)) {
      return 'protected';
    }

    const file = objectStorageClient.bucket(target.bucketName).file(target.objectName);
    const [exists] = await file.exists();
    if (!exists) return 'missing';

    const [metadata] = await file.getMetadata();
    const generation = metadata.generation;
    const metageneration = metadata.metageneration;
    if (generation == null || metageneration == null) {
      throw new Error('Private upload metadata is missing GCS delete preconditions');
    }

    const acl = objectAclPolicyFromMetadata(metadata);
    if (derivedMatch && (
      !acl
      || acl.owner !== ownerId
      || acl.visibility !== 'private'
      || (acl.aclRules != null && (
        !Array.isArray(acl.aclRules)
        || acl.aclRules.length > 0
      ))
    )) {
      return 'protected';
    }
    if (acl && (
      acl.owner !== ownerId
      || acl.visibility !== 'private'
      || (acl.aclRules != null && (
        !Array.isArray(acl.aclRules)
        || acl.aclRules.length > 0
      ))
    )) {
      return 'protected';
    }

    // GCS ACLs are distinct from the app's custom ACL policy. Never delete
    // objects explicitly made public through a legacy GCS ACL.
    const gcsAcl = (metadata as { acl?: Array<{ entity?: string }> }).acl;
    if (gcsAcl?.some(({ entity }) => entity === 'allUsers' || entity === 'allAuthenticatedUsers')) {
      return 'protected';
    }

    await file.delete({
      ignoreNotFound: true,
      ifGenerationMatch: generation,
      ifMetagenerationMatch: metageneration,
    });
    return 'deleted';
  }

  private overlapsPublicSearchPath(bucketName: string, objectName: string): boolean {
    const paths = this.getPublicObjectSearchPaths();
    for (const rawPath of paths) {
      const publicPath = parseConfiguredStoragePath(rawPath);
      if (!publicPath) return true;
      if (publicPath.bucketName !== bucketName) continue;
      if (
        publicPath.objectName === ''
        || objectName === publicPath.objectName
        || objectName.startsWith(`${publicPath.objectName.replace(/\/+$/, '')}/`)
      ) {
        return true;
      }
    }
    return false;
  }
}

type ObjectStorageTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
function parseObjectPath(path: string): {
  bucketName: string;
  objectName: string;
} {
  if (!path.startsWith('/')) {
    path = `/${path}`;
  }
  const pathParts = path.split('/');
  if (pathParts.length < 3) {
    throw new Error('Invalid path: must contain at least a bucket name');
  }

  const bucketName = pathParts[1];
  const objectName = pathParts.slice(2).join('/');

  return {
    bucketName,
    objectName,
  };
}

async function signObjectURL({
  bucketName,
  objectName,
  method,
  ttlSec,
}: {
  bucketName: string;
  objectName: string;
  method: 'GET' | 'PUT' | 'DELETE' | 'HEAD';
  ttlSec: number;
}): Promise<string> {
  const request = {
    bucket_name: bucketName,
    object_name: objectName,
    method,
    expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
  };
  const response = await fetch(
    `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Failed to sign object URL, errorcode: ${response.status}, ` +
        `make sure you're running on Replit`,
    );
  }

  const { signed_url: signedURL } = (await response.json()) as {
    signed_url: string;
  };
  return signedURL;
}

async function markUploadAdopted(
  tx: ObjectStorageTransaction,
  objectPath: string,
  userId: string,
): Promise<void> {
  await tx.update(objectUploadsTable).set({
    unreferencedSince: null,
    lastCleanupAttemptAt: null,
  }).where(and(
    eq(objectUploadsTable.objectPath, objectPath),
    eq(objectUploadsTable.userId, userId),
  ));
}

function parseConfiguredStoragePath(rawPath: string): {
  bucketName: string;
  objectName: string;
} | null {
  try {
    let path = rawPath;
    if (path.startsWith('gs://')) {
      const url = new URL(path);
      if (url.search || url.hash) return null;
      path = `/${url.host}${url.pathname}`;
    } else if (/^https?:\/\//i.test(path)) {
      const url = new URL(path);
      if (url.hostname !== 'storage.googleapis.com' || url.search || url.hash) return null;
      path = url.pathname;
    }
    if (
      !path.startsWith('/')
      || path.includes('?')
      || path.includes('#')
      || path.includes('\\')
      || path.includes('%')
      || path.split('/').some((part) => part === '.' || part === '..')
    ) {
      return null;
    }
    const normalizedPath = path.replace(/\/+$/, '');
    const parts = normalizedPath.slice(1).split('/');
    if (!parts[0]) return null;
    return {
      bucketName: parts[0],
      objectName: parts.slice(1).join('/'),
    };
  } catch {
    return null;
  }
}
