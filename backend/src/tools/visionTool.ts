/**
 * VisionTool — GuardianEye Vision Specialist
 *
 * Analyzes camera frames for:
 *   - Object identification and spatial positioning
 *   - Component state detection (e.g., "red LED is on", "screw is loose")
 *   - Safety hazard detection (smoke, sparks, exposed wires)
 *   - Text/label recognition (part numbers, warning labels)
 *
 * Uses Gemini Vision with a dedicated spatial-reasoning prompt.
 */

import { VertexAI, GenerativeModel } from '@google-cloud/vertexai';
import { logger } from '../utils/logger';
import { SpatialAnnotation } from '../agents/orchestrator';

export interface VisionInput {
  imageData: string;
  mimeType: 'image/jpeg' | 'image/webp';
  focusQuery: string;
  requireSpatial?: boolean;
}

export interface VisionResult {
  description: string;
  annotations: SpatialAnnotation[];
  detectedComponents: DetectedComponent[];
  safetyFlags: SafetyFlag[];
  readableText: string[];
  confidence: number;
}

export interface DetectedComponent {
  name: string;
  position: string;
  state?: string;
  color?: string;
  partNumber?: string;
}

export interface SafetyFlag {
  type: 'ELECTRICAL_HAZARD' | 'HEAT_HAZARD' | 'CHEMICAL_HAZARD' | 'SHARP_OBJECT' | 'PINCH_POINT' | 'OTHER';
  description: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  position?: string;
}

const VISION_SYSTEM_PROMPT = `You are a precision visual analysis system for GuardianEye. Your job is to analyze camera frames and return structured JSON.

SPATIAL GRID REFERENCE:
Divide the image into a 3x3 grid:
- Row 1 (top):    top-left | top-center | top-right
- Row 2 (middle): center-left | center | center-right  
- Row 3 (bottom): bottom-left | bottom-center | bottom-right

For each detected component, specify its grid position AND a more precise description (e.g., "top-right corner, near the gold connector pins").

ALWAYS return valid JSON in this exact schema:
{
  "description": "Brief natural-language scene description for TTS",
  "annotations": [
    { "label": "Component name", "position": "top-right", "boundingBox": null }
  ],
  "detectedComponents": [
    { "name": "string", "position": "string", "state": "string", "color": "string", "partNumber": "string or null" }
  ],
  "safetyFlags": [
    { "type": "ELECTRICAL_HAZARD", "description": "string", "severity": "HIGH", "position": "string" }
  ],
  "readableText": ["any text visible in the image"],
  "confidence": 0.0
}

PRIORITY: Safety flags MUST be reported first. If you see smoke, sparks, exposed wiring under voltage, or dangerous conditions, set severity to CRITICAL.`;

export class VisionTool {
  private model: GenerativeModel;

  constructor(projectId: string, location: string) {
    const vertexAI = new VertexAI({ project: projectId, location });

    // Use flash for speed — vision analysis must be low-latency
    this.model = vertexAI.getGenerativeModel({
      model: 'gemini-2.0-flash-exp',
      systemInstruction: VISION_SYSTEM_PROMPT,
      generationConfig: {
        temperature: 0.1,         // Deterministic for safety
        maxOutputTokens: 1024,
        responseMimeType: 'application/json',
      },
    });
  }

  async execute(input: VisionInput): Promise<VisionResult> {
    const startTime = Date.now();

    try {
      const prompt = input.requireSpatial
        ? `Analyze this image. Focus on: "${input.focusQuery}". 
           Map every relevant component to the 3x3 spatial grid.
           Describe positions as a helpful guide would — e.g., "The blue capacitor is at the top-right corner".`
        : `Analyze this image. Focus on: "${input.focusQuery}".
           Identify all relevant components and their states.`;

      const result = await this.model.generateContent({
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: input.mimeType,
                  data: input.imageData,
                },
              },
              { text: prompt },
            ],
          },
        ],
      });

      const rawText = result.response.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      // Strip markdown code fences Gemini sometimes wraps JSON in
      const responseText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      const parsed: VisionResult = JSON.parse(responseText);

      const latency = Date.now() - startTime;
      logger.debug(`VisionTool completed in ${latency}ms, confidence: ${parsed.confidence}`);

      // Critical safety flag short-circuit
      const criticalFlags = parsed.safetyFlags?.filter(f => f.severity === 'CRITICAL') || [];
      if (criticalFlags.length > 0) {
        logger.warn('CRITICAL safety hazard detected:', criticalFlags);
        // Prepend safety warning to description
        parsed.description = `⚠️ SAFETY ALERT: ${criticalFlags[0].description}. ${parsed.description}`;
      }

      return parsed;

    } catch (error) {
      logger.error('VisionTool error:', error);
      return {
        description: 'Unable to analyze the scene at this moment.',
        annotations: [],
        detectedComponents: [],
        safetyFlags: [],
        readableText: [],
        confidence: 0,
      };
    }
  }
}
