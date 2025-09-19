import crypto from 'crypto';
import { Scaffold, SectionContext, SectionContextPayload, ValidationResult, ModuleError } from '@content-engine/m2-scaffold';

/**
 * ScaffoldToContextAdapter: Transforms M2 Scaffold output into M3 SectionContext input
 * This adapter enables true module decoupling by adapting between different contracts
 */
export class ScaffoldToContextAdapter {

  /**
   * Transform a Scaffold into an array of SectionContext objects
   * Each section becomes an independent context for M3 processing
   */
  transform(scaffold: Scaffold): SectionContext[] {
    const contexts: SectionContext[] = [];
    const correlationId = scaffold.envelope.correlationId;

    // Initialize running state for first section
    let runningState = this.initializeRunningState(scaffold);

    for (let i = 0; i < scaffold.payload.sections.length; i++) {
      const section = scaffold.payload.sections[i];

      // Create context payload for this section
      const contextPayload: SectionContextPayload = {
        context: {
          chapterId: scaffold.payload.meta.chapterSlug,
          sectionId: section.id,
          sectionTitle: section.title,
          difficulty: scaffold.payload.meta.difficulty,
          subject: scaffold.payload.meta.subject,
          assetMarkers: section.where_assets_go,
          transitions: section.transitions,
          conceptSequence: section.concept_sequence
        },
        runningState: { ...runningState }
      };

      // Create versioned envelope
      const envelope = this.createEnvelope(contextPayload, correlationId, i);

      // Create SectionContext
      const sectionContext: SectionContext = {
        envelope,
        payload: contextPayload
      };

      contexts.push(sectionContext);

      // Update running state for next section
      runningState = this.updateRunningState(runningState, section, scaffold);
    }

    return contexts;
  }

  /**
   * Initialize running state for the first section
   */
  private initializeRunningState(scaffold: Scaffold) {
    const globalContext = scaffold.payload.global_context || {};

    return {
      recap_150w: this.generateInitialRecap(scaffold),
      introduced_terms: [],
      used_assets: [],
      open_threads: this.extractOpenThreads(globalContext),
      style_guard: {
        difficulty: scaffold.payload.meta.difficulty,
        tone: this.determineTone(scaffold.payload.meta.difficulty, scaffold.payload.meta.subject)
      }
    };
  }

  /**
   * Generate initial recap for the chapter
   */
  private generateInitialRecap(scaffold: Scaffold): string {
    const meta = scaffold.payload.meta;
    const objectives = scaffold.payload.global_context?.learning_objectives || [];

    let recap = `This chapter on "${meta.title}" introduces ${meta.subject.toLowerCase()} concepts at the ${meta.difficulty} level. `;

    if (objectives.length > 0) {
      recap += `Key learning objectives include: ${objectives.slice(0, 3).join(', ')}. `;
    }

    recap += `We will explore these topics through structured sections, building understanding progressively from fundamental concepts to practical applications.`;

    // Ensure recap is within bounds (50-1200 characters)
    if (recap.length < 50) {
      recap += ' Each section will provide detailed explanations, examples, and opportunities for practice to ensure thorough comprehension.';
    }

    return recap.slice(0, 1200);
  }

  /**
   * Extract open threads from global context
   */
  private extractOpenThreads(globalContext: any): string[] {
    const threads: string[] = [];

    if (globalContext.common_misconceptions) {
      threads.push(...globalContext.common_misconceptions.map((m: string) => `Address misconception: ${m}`));
    }

    if (globalContext.prerequisite_knowledge) {
      threads.push(...globalContext.prerequisite_knowledge.map((p: string) => `Verify prerequisite: ${p}`));
    }

    return threads.slice(0, 10); // Limit to max 10 threads
  }

  /**
   * Determine appropriate tone based on difficulty and subject
   */
  private determineTone(difficulty: string, subject: string): string {
    const subjectTones = {
      'Physics': 'analytical and precise',
      'Chemistry': 'exploratory and methodical',
      'Mathematics': 'logical and systematic'
    };

    const difficultyModifiers = {
      'comfort': 'accessible and encouraging',
      'hustle': 'challenging yet supportive',
      'advanced': 'rigorous and scholarly'
    };

    return `${subjectTones[subject as keyof typeof subjectTones]}, ${difficultyModifiers[difficulty as keyof typeof difficultyModifiers]}`;
  }

  /**
   * Update running state after processing a section
   */
  private updateRunningState(previousState: any, section: any, scaffold: Scaffold) {
    // Simulate state updates that would happen after M3 processing
    const newTerms = this.extractTermsFromSection(section);
    const newAssets = this.extractAssetsFromSection(section);

    return {
      ...previousState,
      recap_150w: this.updateRecap(previousState.recap_150w, section),
      introduced_terms: [
        ...(previousState.introduced_terms || []),
        ...newTerms
      ].slice(0, 50), // Limit to max 50 terms
      used_assets: [
        ...(previousState.used_assets || []),
        ...newAssets
      ].slice(0, 20), // Limit to max 20 assets
      open_threads: this.updateOpenThreads(previousState.open_threads, section)
    };
  }

  /**
   * Extract potential terms from section content
   */
  private extractTermsFromSection(section: any): string[] {
    const terms: string[] = [];

    // Extract from concept sequence
    for (const concept of section.concept_sequence) {
      const words = concept.split(' ').filter(word => word.length > 3);
      terms.push(...words);
    }

    // Extract from asset markers (the concept names)
    for (const marker of section.where_assets_go) {
      const match = marker.match(/\{\{[^:]+:([^}]+)\}\}/);
      if (match) {
        const assetName = match[1].replace(/-/g, ' ');
        terms.push(assetName);
      }
    }

    return [...new Set(terms)].slice(0, 10); // Unique terms, max 10 per section
  }

  /**
   * Extract asset references from section
   */
  private extractAssetsFromSection(section: any): Array<{id: string, type: string, contentHash: string}> {
    const assets: Array<{id: string, type: string, contentHash: string}> = [];

    for (const marker of section.where_assets_go) {
      const match = marker.match(/\{\{([^:]+):([^}]+)\}\}/);
      if (match) {
        const [, type, id] = match;
        assets.push({
          id,
          type: type as any,
          contentHash: this.generateAssetHash(type, id)
        });
      }
    }

    return assets;
  }

  /**
   * Generate placeholder content hash for assets
   */
  private generateAssetHash(type: string, id: string): string {
    const content = `${type}:${id}`;
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    return `sha256:${hash}`;
  }

  /**
   * Update recap with section progress
   */
  private updateRecap(previousRecap: string, section: any): string {
    // For now, return the previous recap
    // In a full implementation, this would accumulate section summaries
    return previousRecap;
  }

  /**
   * Update open threads based on section content
   */
  private updateOpenThreads(previousThreads: string[], section: any): string[] {
    // Remove threads that might be addressed by this section
    let updatedThreads = [...previousThreads];

    // Add new threads based on section content
    if (section.concept_sequence.length > 5) {
      updatedThreads.push(`Complex section ${section.id} may need additional reinforcement`);
    }

    return updatedThreads.slice(0, 10);
  }

  /**
   * Create versioned envelope for SectionContext
   */
  private createEnvelope(payload: SectionContextPayload, correlationId: string, sectionIndex: number) {
    const contentHash = this.generateContentHash(payload);

    return {
      version: "1.0.0",
      producer: "M2-ScaffoldAdapter",
      timestamp: new Date().toISOString(),
      correlationId: `${correlationId}-sec-${sectionIndex}`,
      contentHash,
      compatible: ["1.0.0"]
    };
  }

  /**
   * Generate SHA256 content hash for deterministic caching
   */
  private generateContentHash(payload: SectionContextPayload): string {
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
   * Validate the transformation output
   */
  validateTransformation(contexts: SectionContext[]): ValidationResult {
    const errors: string[] = [];

    // Check that all contexts have valid structure
    for (const context of contexts) {
      if (!context.envelope || !context.payload) {
        errors.push('Invalid SectionContext structure');
        continue;
      }

      // Validate correlation ID format
      if (!context.envelope.correlationId.includes('-sec-')) {
        errors.push(`Invalid correlation ID format: ${context.envelope.correlationId}`);
      }

      // Validate content hash
      if (!context.envelope.contentHash.startsWith('sha256:')) {
        errors.push(`Invalid content hash format: ${context.envelope.contentHash}`);
      }

      // Validate section ID format
      if (!context.payload.context.sectionId.match(/^sec-\d+$/)) {
        errors.push(`Invalid section ID format: ${context.payload.context.sectionId}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }
}