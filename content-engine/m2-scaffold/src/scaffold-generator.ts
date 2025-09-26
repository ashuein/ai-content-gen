import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { DocPlan, DocPlanPayload } from '../../m1-plan/src/index.js';
import { Scaffold, ScaffoldPayload, ScaffoldSection, ModuleError, Result, Ok, Err, ValidationResult } from './types.js';

/**
 * M2-ScaffoldGenerator: Transforms DocPlan into detailed content scaffolding
 * with section structure and asset placement markers
 */
export class ScaffoldGenerator {
  private ajv: Ajv;
  private schema: any;

  constructor() {
    this.ajv = new Ajv({ strict: false, allErrors: true, validateSchema: false });
    addFormats(this.ajv);

    // Load Scaffold schema and register by $id
    const schemaPath = new URL('../schemas/scaffold.v1.schema.json', import.meta.url);
    this.schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));

    // Add schema by $id for proper referencing
    this.ajv.addSchema(this.schema, this.schema.$id);
  }

  /**
   * Main entry point: generate Scaffold from DocPlan
   */
  async generateScaffold(docPlan: DocPlan): Promise<Result<Scaffold, ModuleError[]>> {
    try {
      const correlationId = docPlan.envelope.correlationId;

      // Step 1: Validate input DocPlan compatibility
      const compatibilityResult = this.validateInputCompatibility(docPlan);
      if (!compatibilityResult.valid) {
        return Err([{
          code: 'E-M2-INPUT-INCOMPATIBLE',
          module: 'M2',
          data: compatibilityResult.errors,
          correlationId
        }]);
      }

      // Step 2: Generate scaffold content
      const payload = await this.generateScaffoldContent(docPlan.payload);

      // Step 3: Run validation gates
      const validationResult = await this.validateScaffold(payload, correlationId);
      if (!validationResult.valid) {
        return Err(validationResult.errors || []);
      }

      // Step 4: Create versioned envelope
      const envelope = this.createEnvelope(payload, correlationId);

      // Step 5: Final schema validation
      const scaffold: Scaffold = { envelope, payload };

      // FINAL DEBUG: Check scaffold before validation
      console.log(`[M2-DEBUG] About to validate scaffold with ${scaffold.payload.sections.length} sections`);
      for (let i = 0; i < scaffold.payload.sections.length; i++) {
        const sec = scaffold.payload.sections[i];
        console.log(`[M2-DEBUG] Pre-validation section ${i} (${sec.id}): where_assets_go =`, typeof sec.where_assets_go, sec.where_assets_go?.length || 'UNDEFINED');
      }

      const schemaValidation = this.validateSchema(scaffold);
      if (!schemaValidation.valid) {
        return Err([{
          code: 'E-M2-SCHEMA-SCAFFOLD',
          module: 'M2',
          data: schemaValidation.errors,
          correlationId
        }]);
      }

      return Ok(scaffold);

    } catch (error) {
      return Err([{
        code: 'E-M2-GENERATION-FAILED',
        module: 'M2',
        data: { error: error instanceof Error ? error.message : String(error) },
        correlationId: docPlan.envelope.correlationId
      }]);
    }
  }

  /**
   * Validate input DocPlan version compatibility
   */
  private validateInputCompatibility(docPlan: DocPlan): ValidationResult {
    const producerVersion = docPlan.envelope.version;
    const supportedVersions = ['1.0.0', '1.1.0']; // M2 can handle these versions

    if (!supportedVersions.some(v => this.isVersionCompatible(producerVersion, v))) {
      return {
        valid: false,
        errors: [`Unsupported DocPlan version: ${producerVersion}. Supported: ${supportedVersions.join(', ')}`]
      };
    }

    return { valid: true };
  }

  /**
   * Simple semantic version compatibility check
   */
  private isVersionCompatible(provided: string, supported: string): boolean {
    const [pMajor, pMinor] = provided.split('.').map(Number);
    const [sMajor, sMinor] = supported.split('.').map(Number);

    // Major version must match, minor version can be equal or lower
    return pMajor === sMajor && pMinor <= sMinor;
  }

  /**
   * Generate scaffold content from DocPlan
   */
  private async generateScaffoldContent(docPlan: DocPlanPayload): Promise<ScaffoldPayload> {
    // Generate chapter slug from title
    const chapterSlug = this.generateChapterSlug(docPlan.meta.title);

    // Group beats into sections (logical grouping)
    const sections = this.groupBeatsIntoSections(docPlan.beats, docPlan.meta.difficulty);

    return {
      meta: {
        title: docPlan.meta.title,
        subject: docPlan.meta.subject,
        grade: docPlan.meta.grade,
        difficulty: docPlan.meta.difficulty,
        chapterSlug
      },
      sections,
      global_context: {
        learning_objectives: docPlan.learning_objectives,
        prerequisite_knowledge: this.inferPrerequisites(docPlan),
        common_misconceptions: docPlan.misconceptions,
        assessment_strategy: this.generateAssessmentStrategy(docPlan.assessment_outline)
      }
    };
  }

  /**
   * Generate URL-safe chapter slug
   */
  private generateChapterSlug(title: string): string {
    return title
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // Remove diacritical marks
      .replace(/[^a-z0-9\s-]/g, '') // Keep only alphanumeric, spaces, hyphens
      .replace(/\s+/g, '-') // Replace spaces with hyphens
      .replace(/-+/g, '-') // Replace multiple hyphens with single
      .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens
  }

  /**
   * Group beats into logical sections for better content flow
   */
  private groupBeatsIntoSections(beats: any[], difficulty: string): ScaffoldSection[] {
    const sections: ScaffoldSection[] = [];
    const beatsPerSection = difficulty === 'advanced' ? 2 : 3; // More granular for advanced content

    let sectionCounter = 1;

    console.log(`[M2-DEBUG] Starting to process ${beats.length} beats with ${beatsPerSection} beats per section`);
    for (let i = 0; i < beats.length; i += beatsPerSection) {
      const sectionBeats = beats.slice(i, i + beatsPerSection);
      const sectionId = `sec-${sectionCounter.toString().padStart(2, '0')}`;
      console.log(`[M2-DEBUG] Processing section ${sectionId}, beats ${i}-${i + beatsPerSection - 1}:`, sectionBeats.map(b => b.id));

      // Generate section title from primary beat
      const primaryBeat = sectionBeats[0];
      const sectionTitle = this.generateSectionTitle(primaryBeat.headline, sectionCounter);

      // Collect all asset suggestions from beats in this section
      const assetMarkers = this.generateAssetMarkers(sectionBeats);
      console.log(`[M2-DEBUG] Section ${sectionId}: assetMarkers =`, assetMarkers, 'type:', typeof assetMarkers, 'isArray:', Array.isArray(assetMarkers));

      // Generate transitions
      const transitions = this.generateSectionTransitions(sectionBeats, sectionCounter, beats.length);
      console.log(`[M2-DEBUG] Section ${sectionId}: transitions =`, transitions);

      // Generate concept sequence
      const conceptSequence = this.generateConceptSequence(sectionBeats);
      console.log(`[M2-DEBUG] Section ${sectionId}: conceptSequence =`, conceptSequence, 'length:', conceptSequence?.length);

      // FORCE where_assets_go to be an array - NEVER undefined
      // Triple-check to ensure we never get undefined
      const finalAssetMarkers = Array.isArray(assetMarkers) ? assetMarkers : [];
      console.log(`[M2-DEBUG] FINAL assetMarkers for ${sectionId}:`, finalAssetMarkers, 'type:', typeof finalAssetMarkers, 'isArray:', Array.isArray(finalAssetMarkers));

      const section = {
        id: sectionId,
        title: sectionTitle,
        beatIds: sectionBeats.map(b => b.id),
        where_assets_go: finalAssetMarkers, // Guaranteed to be an array
        transitions: transitions || { in: "Default intro", out: "Default outro" },
        concept_sequence: conceptSequence || ["default-concept"],
        estimated_length: this.estimateSectionLength(sectionBeats, difficulty)
      };

      console.log(`[M2-DEBUG] About to push section:`, JSON.stringify(section, null, 2));
      sections.push(section);

      sectionCounter++;
    }

    // SAFEGUARD: Ensure ALL sections have valid where_assets_go arrays
    console.log(`[M2-DEBUG] Validating and fixing ${sections.length} sections before return`);
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      if (!section.where_assets_go || !Array.isArray(section.where_assets_go)) {
        console.log(`[M2-DEBUG] FIXING section ${section.id}: where_assets_go was`, section.where_assets_go);
        section.where_assets_go = []; // Force to empty array
      }
      if (!section.transitions || !section.transitions.in || !section.transitions.out) {
        console.log(`[M2-DEBUG] FIXING section ${section.id}: transitions was`, section.transitions);
        section.transitions = { in: "Default intro", out: "Default outro" };
      }
      if (!section.concept_sequence || !Array.isArray(section.concept_sequence)) {
        console.log(`[M2-DEBUG] FIXING section ${section.id}: concept_sequence was`, section.concept_sequence);
        section.concept_sequence = ["default-concept"];
      }
      if (!section.estimated_length) {
        section.estimated_length = 400;
      }
      console.log(`[M2-DEBUG] Section ${section.id} validated: where_assets_go.length=${section.where_assets_go.length}`);
    }

    return sections;
  }

  /**
   * Generate section title from beat headline
   */
  private generateSectionTitle(beatHeadline: string, sectionNumber: number): string {
    // Clean up beat headline to make it section-appropriate
    const cleaned = beatHeadline
      .replace(/^(beat-|section-)/i, '')
      .replace(/^\d+\.?\s*/, '') // Remove leading numbers
      .trim();

    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }

  /**
   * Convert asset suggestions to placement markers
   */
  private generateAssetMarkers(beats: any[]): string[] {
    const markers: string[] = [];
    console.log(`[M2-DEBUG] generateAssetMarkers called with beats:`, beats, 'length:', beats?.length);

    // Handle the case where beats is null/undefined
    if (!beats || !Array.isArray(beats)) {
      console.log(`[M2-DEBUG] beats is null/undefined or not array, returning empty array`);
      return markers; // Return empty array instead of undefined
    }

    for (const beat of beats) {
      // Check if assets_suggested exists and is an array
      if (beat && beat.assets_suggested && Array.isArray(beat.assets_suggested)) {
        for (const asset of beat.assets_suggested) {
          if (asset && typeof asset === 'string') {
            // Convert "eq:force-equation" to "{{eq:force-equation}}"
            markers.push(`{{${asset}}}`);
          }
        }
      }
    }

    console.log(`[M2-DEBUG] generateAssetMarkers returning:`, markers, 'length:', markers.length);
    return markers; // Always returns an array, never undefined
  }

  /**
   * Generate smooth transitions between sections
   */
  private generateSectionTransitions(beats: any[], sectionNumber: number, totalBeats: number) {
    const isFirst = sectionNumber === 1;
    const isLast = sectionNumber * 3 >= totalBeats; // Rough estimate

    let inTransition: string;
    let outTransition: string;

    if (isFirst) {
      inTransition = "We begin our exploration by establishing the fundamental concepts that will serve as building blocks for our understanding.";
    } else {
      inTransition = "Building upon our previous discussion, we now turn our attention to the more sophisticated aspects of this topic.";
    }

    if (isLast) {
      outTransition = "With these concepts firmly established, we are now prepared to tackle more complex applications and real-world scenarios.";
    } else {
      outTransition = "These insights set the stage for our next area of focus, where we will deepen our understanding further.";
    }

    return { in: inTransition, out: outTransition };
  }

  /**
   * Generate ordered concept sequence for section
   */
  private generateConceptSequence(beats: any[]): string[] {
    const concepts: string[] = [];

    for (const beat of beats) {
      // Extract key concepts from beat outcomes
      for (const outcome of beat.outcomes || []) {
        // Simple concept extraction (in production, this would use NLP)
        let concept = outcome
          .replace(/^(understand|learn|apply|analyze|evaluate)/i, '')
          .trim()
          .toLowerCase();

        // Truncate to max 100 characters per schema requirement
        if (concept.length > 100) {
          concept = concept.substring(0, 97) + '...';
        }

        if (concept.length > 3 && !concepts.includes(concept)) {
          concepts.push(concept);
        }
      }
    }

    return concepts.slice(0, 8); // Limit to max 8 concepts per section
  }

  /**
   * Estimate section length based on complexity
   */
  private estimateSectionLength(beats: any[], difficulty: string): number {
    const baseLength = 400; // Base words per beat
    const difficultyMultiplier: { [key: string]: number } = {
      'comfort': 1.0,
      'hustle': 1.3,
      'advanced': 1.6
    };

    const multiplier = difficultyMultiplier[difficulty] || 1.0;
    const assetCount = beats.reduce((sum, beat) => sum + (beat.assets_suggested?.length || 0), 0);
    const assetBonus = assetCount * 100; // Additional words for each asset

    const estimatedLength = Math.round(beats.length * baseLength * multiplier + assetBonus);

    // Ensure length is within schema bounds (200-2000)
    return Math.max(200, Math.min(2000, estimatedLength));
  }

  /**
   * Infer prerequisite knowledge from beat structure
   */
  private inferPrerequisites(docPlan: DocPlanPayload): string[] {
    const prerequisites: string[] = [];

    // Add subject-specific prerequisites
    switch (docPlan.meta.subject) {
      case 'Physics':
        prerequisites.push('Basic algebra', 'Understanding of mathematical functions');
        break;
      case 'Chemistry':
        prerequisites.push('Atomic structure', 'Basic chemical bonding concepts');
        break;
      case 'Mathematics':
        prerequisites.push('Arithmetic operations', 'Basic algebraic manipulation');
        break;
    }

    // Add difficulty-specific prerequisites
    if (docPlan.meta.difficulty === 'advanced') {
      prerequisites.push('Calculus concepts', 'Advanced problem-solving skills');
    }

    return prerequisites;
  }

  /**
   * Generate assessment strategy from outline
   */
  private generateAssessmentStrategy(assessmentOutline?: string[]): string {
    if (!assessmentOutline || assessmentOutline.length === 0) {
      return 'Formative assessment through practice problems and conceptual questions, followed by summative evaluation.';
    }

    let strategy = `Assessment strategy includes: ${assessmentOutline.join(', ')}. Focus on both conceptual understanding and practical application.`;

    // Truncate to max 500 characters per schema requirement
    if (strategy.length > 500) {
      strategy = strategy.substring(0, 497) + '...';
    }

    return strategy;
  }

  /**
   * Run validation gates G1-G3 for M2
   */
  private async validateScaffold(payload: ScaffoldPayload, correlationId: string): Promise<ValidationResult & { errors?: ModuleError[] }> {
    const errors: ModuleError[] = [];

    // G1: Asset marker reference validation
    const markerValidation = this.validateAssetMarkers(payload.sections);
    if (!markerValidation.valid) {
      errors.push({
        code: 'E-M2-SCAFFOLD-MARKERS',
        module: 'M2',
        data: markerValidation.data,
        correlationId
      });
    }

    // G2: Section flow validation
    const flowValidation = this.validateSectionFlow(payload.sections);
    if (!flowValidation.valid) {
      errors.push({
        code: 'E-M2-SECTION-FLOW',
        module: 'M2',
        data: flowValidation.data,
        correlationId
      });
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }

  /**
   * Validate asset marker format and references
   */
  private validateAssetMarkers(sections: ScaffoldSection[]): ValidationResult {
    const errors: string[] = [];
    const validMarkerPattern = /^\{\{(eq|plot|diagram|widget|chem):[a-z0-9_-]+\}\}$/;

    for (const section of sections) {
      for (const marker of section.where_assets_go) {
        if (!validMarkerPattern.test(marker)) {
          errors.push(`Section ${section.id} has invalid asset marker: ${marker}`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
      data: errors.length > 0 ? { invalidMarkers: errors } : undefined
    };
  }

  /**
   * Validate section flow and transitions
   */
  private validateSectionFlow(sections: ScaffoldSection[]): ValidationResult {
    const errors: string[] = [];

    // Check for proper section ID sequence
    for (let i = 0; i < sections.length; i++) {
      const expectedId = `sec-${(i + 1).toString().padStart(2, '0')}`;
      if (sections[i].id !== expectedId) {
        errors.push(`Section ${i + 1} has incorrect ID: expected ${expectedId}, got ${sections[i].id}`);
      }
    }

    // Check for empty concept sequences
    for (const section of sections) {
      if (section.concept_sequence.length === 0) {
        errors.push(`Section ${section.id} has empty concept sequence`);
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
      data: errors.length > 0 ? { flowErrors: errors } : undefined
    };
  }

  /**
   * Create versioned envelope with content hash
   */
  private createEnvelope(payload: ScaffoldPayload, correlationId: string) {
    const contentHash = this.generateContentHash(payload);

    return {
      version: "1.0.0",
      producer: "M2-ScaffoldGenerator",
      timestamp: new Date().toISOString(),
      correlationId,
      contentHash,
      compatible: ["1.0.0"]
    };
  }

  /**
   * Generate SHA256 content hash for deterministic caching
   */
  private generateContentHash(payload: ScaffoldPayload): string {
    const normalized = this.normalizeObject(payload);
    const content = JSON.stringify(normalized);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    return `sha256:${hash}`;
  }

  /**
   * Normalize object for consistent hashing
   */
  private normalizeObject(obj: any): any {
    if (typeof obj === 'string') {
      return obj.normalize('NFC').replace(/\s+/g, ' ').trim();
    }
    if (Array.isArray(obj)) {
      return obj.map(item => this.normalizeObject(item));
    }
    if (obj && typeof obj === 'object') {
      const sorted: Record<string, any> = {};
      Object.keys(obj).sort().forEach(key => {
        sorted[key] = this.normalizeObject(obj[key]);
      });
      return sorted;
    }
    return obj;
  }

  /**
   * Validate final Scaffold against schema (G1)
   */
  private validateSchema(scaffold: Scaffold): ValidationResult {
    const validate = this.ajv.getSchema('scaffold.v1.schema.json');
    if (!validate) {
      return {
        valid: false,
        errors: ['Schema not found']
      };
    }

    const valid = validate(scaffold);
    if (!valid) {
      // Convert AJV errors to readable strings
      const errorMessages = (validate.errors || []).map(err => {
        const path = err.instancePath || 'root';
        const property = err.propertyName ? `"${err.propertyName}"` : '';
        return `${path}${property}: ${err.message} (received: ${JSON.stringify(err.data)})`;
      });

      return {
        valid: false,
        errors: errorMessages
      };
    }

    return { valid: true };
  }
}