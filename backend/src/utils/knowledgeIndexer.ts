/**
 * KnowledgeIndexer
 *
 * Handles the full pipeline for indexing a PDF manual into Vertex AI Search:
 *
 *   1. Upload the PDF buffer to a GCS bucket
 *   2. Call Discovery Engine ImportDocuments (Long-Running Operation)
 *   3. Return the LRO operation name so the caller can poll for completion
 *
 * Why GCS staging?
 *   Vertex AI Search's ImportDocuments API only accepts GCS URIs for
 *   unstructured content (PDFs). There is no inline binary upload path.
 *   We stage the file in GCS, trigger the import, then the Discovery Engine
 *   service reads and indexes the PDF server-side.
 *
 * Data flow:
 *   multer buffer
 *     → GCS: gs://${bucket}/guardianeye-manuals/${docId}.pdf
 *     → ImportDocuments(gcsSource, dataSchema='content')
 *     → LRO operation name (returned to caller for polling)
 */

import { Storage } from '@google-cloud/storage';
import { v1 as DiscoveryEngine } from '@google-cloud/discoveryengine';
import { v4 as uuidv4 } from 'uuid';
import { logger } from './logger';

export interface IndexJobResult {
  jobId: string;           // UUID we generate — used as the poll key
  operationName: string;   // Full Discovery Engine LRO name for status checks
  gcsUri: string;          // Where the file was staged
  filename: string;
  status: 'indexing';
}

export interface IndexJobStatus {
  jobId: string;
  operationName: string;
  done: boolean;
  error?: string;
  successCount?: number;
  failureCount?: number;
}

export class KnowledgeIndexer {
  private storage: Storage;
  private docClient: DiscoveryEngine.DocumentServiceClient;
  private projectId: string;
  private dataStoreId: string;
  private bucketName: string;

  // parent resource path for the default branch of the data store
  private get branchPath(): string {
    return `projects/${this.projectId}/locations/global/collections/default_collection/dataStores/${this.dataStoreId}/branches/default_branch`;
  }

  constructor() {
    this.projectId = process.env.GOOGLE_CLOUD_PROJECT || '';
    this.dataStoreId = process.env.VERTEX_SEARCH_DATASTORE_ID || '';
    this.bucketName = process.env.GCS_BUCKET_NAME || `${this.projectId}-guardianeye-manuals`;

    this.storage = new Storage({ projectId: this.projectId });
    this.docClient = new DiscoveryEngine.DocumentServiceClient();
  }

  get isConfigured(): boolean {
    return Boolean(this.projectId && this.dataStoreId);
  }

  /**
   * Upload a PDF buffer to GCS, then kick off a Vertex AI Search import.
   * Returns immediately with a job ID — indexing runs asynchronously.
   */
  async indexPdf(
    fileBuffer: Buffer,
    originalFilename: string
  ): Promise<IndexJobResult> {
    if (!this.isConfigured) {
      throw new Error(
        'KnowledgeIndexer not configured: set GOOGLE_CLOUD_PROJECT and VERTEX_SEARCH_DATASTORE_ID'
      );
    }

    const docId = uuidv4();
    const safeFilename = originalFilename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const gcsPath = `guardianeye-manuals/${docId}-${safeFilename}`;
    const gcsUri = `gs://${this.bucketName}/${gcsPath}`;

    // ── Step 1: Upload PDF to GCS ──────────────────────────────────────────
    await this.uploadToGcs(fileBuffer, gcsPath);
    logger.info(`KnowledgeIndexer: uploaded ${safeFilename} → ${gcsUri}`);

    // ── Step 2: Trigger Discovery Engine import (LRO) ──────────────────────
    const [operation] = await this.docClient.importDocuments({
      parent: this.branchPath,
      gcsSource: {
        inputUris: [gcsUri],
        // 'content' schema = raw unstructured files (PDF, HTML, TXT…)
        // This tells Vertex Search to treat the file as document content
        // rather than expecting a JSON metadata envelope.
        dataSchema: 'content',
      },
      // INCREMENTAL: add/update documents; never delete existing ones
      reconciliationMode: 'INCREMENTAL',
      // Let Discovery Engine generate stable document IDs from file paths
      autoGenerateIds: true,
    });

    const operationName = operation.name || '';
    logger.info(`KnowledgeIndexer: import LRO started → ${operationName}`);

    return {
      jobId: docId,
      operationName,
      gcsUri,
      filename: safeFilename,
      status: 'indexing',
    };
  }

  /**
   * Poll the LRO for completion status.
   * Used by GET /api/knowledge/jobs/:jobId
   */
  async getJobStatus(operationName: string): Promise<IndexJobStatus> {
    try {
      // getOperation is exposed via the operations client on DocumentServiceClient
      const operationsClient = this.docClient.operationsClient;
      const [operation] = await operationsClient.getOperation({ name: operationName });

      if (!operation.done) {
        return { jobId: '', operationName, done: false };
      }

      if (operation.error) {
        return {
          jobId: '',
          operationName,
          done: true,
          error: operation.error.message || 'Unknown error',
        };
      }

      // Parse the ImportDocumentsResponse from the Any proto
      const response = operation.response;
      const successCount = (response?.value as any)?.successCount ?? 0;
      const failureCount = (response?.value as any)?.failureCount ?? 0;

      return { jobId: '', operationName, done: true, successCount, failureCount };
    } catch (err) {
      logger.error('KnowledgeIndexer getJobStatus error:', err);
      throw err;
    }
  }

  private async uploadToGcs(buffer: Buffer, gcsPath: string): Promise<void> {
    // Ensure bucket exists (idempotent)
    const bucket = this.storage.bucket(this.bucketName);
    const [exists] = await bucket.exists();
    if (!exists) {
      await bucket.create({ location: 'US' });
      logger.info(`KnowledgeIndexer: created GCS bucket ${this.bucketName}`);
    }

    const file = bucket.file(gcsPath);
    await file.save(buffer, {
      metadata: { contentType: 'application/pdf' },
      resumable: false,   // buffer is already in memory; no need for resumable upload
    });
  }
}
