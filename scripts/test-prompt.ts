#!/usr/bin/env tsx
/**
 * Quick smoke test for PromptEnvelopeBuilder auto PDF resolution and compression
 */
import 'dotenv/config';
import path from 'path';
import { PromptEnvelopeBuilder, DEFAULT_BUILDER_CONFIG } from '../prompt-injector/buildEnvelope.js';
import type { InjectorInput } from '../prompt-injector/contracts/prompt-envelope.v1.js';

async function main() {
  const builder = new PromptEnvelopeBuilder({ enableLogging: true });
  const input: InjectorInput = {
    grade: '11',
    subject: 'Physics',
    chapter: 'Gravitation',
    standard: 'ncert',
    difficulty: 'comfort'
  };
  const envelope = await builder.buildPromptEnvelope(input);
  console.log('PromptEnvelope:', JSON.stringify(envelope, null, 2));
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});