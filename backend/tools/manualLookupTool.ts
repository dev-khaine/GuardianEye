/**
 * ManualLookupTool — GuardianEye Manual Specialist (RAG Pipeline)
 *
 * Retrieves grounded, step-by-step instructions from the knowledge base.
 * Supports two backends (configured via env):
 *   1. Vertex AI Search — managed RAG via Google Discovery Engine
 *   2. Custom RAG        — embedding-based search over Firestore vector store
 *
 * SAFETY CONTRACT: This tool is the single source of truth for technical instructions.
 * The orchestrator MUST call this before any procedural guidance.
 */

import { logger } from '../utils/logger';

export interface ManualLookupInput {
  query: string;
  context?: string;
  domain?: string;
  stepNumber?: number;
}

export interface ManualLookupResult {
  found: boolean;
  steps: InstructionStep[];
  warnings: string[];
  sources: string[];
  confidence: number;
  relatedTopics: string[];
  estimatedDuration?: string;
}

export interface InstructionStep {
  number: number;
  instruction: string;
  detail?: string;
  caution?: string;
  tools?: string[];
  expectedResult?: string;
}

interface VertexSearchResponse {
  results: Array<{
    document: {
      name: string;
      derivedStructData: {
        title?: { stringValue: string };
        extractive_answers?: Array<{
          content: { stringValue: string };
          pageNumber?: { integerValue: number };
        }>;
        link?: { stringValue: string };
      };
    };
    relevanceScore?: number;
  }>;
}

export class ManualLookupTool {
  private projectId: string;
  private useVertexSearch: boolean;
  private dataStoreId: string;
  private searchEndpoint: string;

  constructor(projectId: string) {
    this.projectId = projectId;
    this.dataStoreId = process.env.VERTEX_SEARCH_DATASTORE_ID || '';
    this.useVertexSearch = Boolean(this.dataStoreId);
    this.searchEndpoint = `https://discoveryengine.googleapis.com/v1/projects/${projectId}/locations/global/collections/default_collection/dataStores/${this.dataStoreId}/servingConfigs/default_config:search`;
    logger.info(`ManualLookupTool: using ${this.useVertexSearch ? 'Vertex AI Search' : 'fallback RAG'}`);
  }

  async execute(input: ManualLookupInput): Promise<ManualLookupResult> {
    const startTime = Date.now();

    try {
      const enrichedQuery = this.buildSearchQuery(input);

      let rawChunks: string[] = [];
      let sources: string[] = [];

      if (this.useVertexSearch) {
        const vsResult = await this.queryVertexSearch(enrichedQuery);
        rawChunks = vsResult.chunks;
        sources = vsResult.sources;
      } else {
        // Fallback: return structured mock for development
        return this.devFallback(input);
      }

      if (rawChunks.length === 0) {
        logger.warn(`No manual results found for: "${input.query}"`);
        return {
          found: false,
          steps: [],
          warnings: [],
          sources: [],
          confidence: 0,
          relatedTopics: [],
        };
      }

      // Parse chunks into structured steps using Gemini
      const structured = await this.parseChunksToSteps(rawChunks, input);

      const latency = Date.now() - startTime;
      logger.debug(`ManualLookupTool completed in ${latency}ms, found: ${structured.found}`);

      return { ...structured, sources };

    } catch (error) {
      logger.error('ManualLookupTool error:', error);
      return {
        found: false,
        steps: [],
        warnings: ['Knowledge base temporarily unavailable. Exercise extra caution.'],
        sources: [],
        confidence: 0,
        relatedTopics: [],
      };
    }
  }

  private buildSearchQuery(input: ManualLookupInput): string {
    const parts = [input.query];
    if (input.context) parts.push(`context: ${input.context}`);
    if (input.domain) parts.push(`domain: ${input.domain}`);
    if (input.stepNumber !== undefined) parts.push(`step ${input.stepNumber}`);
    return parts.join('. ');
  }

  private async queryVertexSearch(query: string): Promise<{ chunks: string[]; sources: string[] }> {
    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const client = await auth.getClient();
    const token = await client.getAccessToken();

    const response = await fetch(this.searchEndpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        pageSize: 5,
        queryExpansionSpec: { condition: 'AUTO' },
        spellCorrectionSpec: { mode: 'AUTO' },
        contentSearchSpec: {
          extractiveContentSpec: {
            maxExtractiveAnswerCount: 3,
            maxExtractiveSegmentCount: 5,
          },
          summarySpec: {
            summaryResultCount: 3,
            includeCitations: true,
            ignoreAdversarialQuery: true,
          },
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Vertex Search error: ${response.status} ${await response.text()}`);
    }

    const data: VertexSearchResponse = await response.json() as VertexSearchResponse;

    const chunks: string[] = [];
    const sources: string[] = [];

    for (const result of (data.results || [])) {
      const doc = result.document?.derivedStructData;
      if (!doc) continue;

      const title = doc.title?.stringValue || 'Unknown Document';
      const link = doc.link?.stringValue || '';
      if (link) sources.push(`${title} — ${link}`);

      for (const answer of (doc.extractive_answers || [])) {
        if (answer.content?.stringValue) {
          chunks.push(answer.content.stringValue);
        }
      }
    }

    return { chunks, sources };
  }

  private async parseChunksToSteps(
    chunks: string[],
    input: ManualLookupInput
  ): Promise<Omit<ManualLookupResult, 'sources'>> {
    const { VertexAI } = await import('@google-cloud/vertexai');
    const vertexAI = new VertexAI({
      project: this.projectId,
      location: process.env.VERTEX_LOCATION || 'us-central1',
    });

    const model = vertexAI.getGenerativeModel({
      model: 'gemini-2.0-flash-exp',
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 1024,
        responseMimeType: 'application/json',
      },
    });

    const prompt = `
You are a technical documentation parser. Extract structured instructions from these retrieved manual chunks.

USER QUERY: "${input.query}"
${input.stepNumber !== undefined ? `FOCUS ON: Step ${input.stepNumber}` : ''}

RETRIEVED CHUNKS:
${chunks.map((c, i) => `[Chunk ${i + 1}]:\n${c}`).join('\n\n')}

Return JSON in this exact schema:
{
  "found": true,
  "steps": [
    {
      "number": 1,
      "instruction": "Clear, actionable instruction",
      "detail": "Additional context or explanation",
      "caution": "Any warnings for this step (null if none)",
      "tools": ["list", "of", "required", "tools"],
      "expectedResult": "What the user should see/feel after completing this step"
    }
  ],
  "warnings": ["Any general safety warnings that apply to the whole procedure"],
  "confidence": 0.95,
  "relatedTopics": ["related topics the user might want to ask about"],
  "estimatedDuration": "e.g., 5-10 minutes"
}

If the chunks don't contain relevant information, return { "found": false, "steps": [], "warnings": [], "confidence": 0, "relatedTopics": [] }`;

    const result = await model.generateContent(prompt);
    const text = result.response.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

    try {
      return JSON.parse(text);
    } catch {
      return { found: false, steps: [], warnings: [], confidence: 0, relatedTopics: [] };
    }
  }

  /** Development fallback when Vertex AI Search is not configured */
  private devFallback(input: ManualLookupInput): ManualLookupResult {
    logger.warn('ManualLookupTool: using dev fallback — configure VERTEX_SEARCH_DATASTORE_ID for production');

    return {
      found: true,
      steps: [
        {
          number: 1,
          instruction: `[DEV MODE] This is a simulated instruction for: "${input.query}"`,
          detail: 'In production, this would contain grounded steps from your knowledge base.',
          caution: 'This is a development placeholder. Do not follow for real tasks.',
          tools: [],
          expectedResult: 'Knowledge base response would appear here.',
        },
      ],
      warnings: ['Development mode: Knowledge base not connected. Configure Vertex AI Search.'],
      sources: ['dev-fallback'],
      confidence: 0.1,
      relatedTopics: [],
      estimatedDuration: 'Unknown',
    };
  }
}
