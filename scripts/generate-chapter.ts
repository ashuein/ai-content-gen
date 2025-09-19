import 'dotenv/config';
import path from 'node:path';
import { ContentPipeline } from '../content-engine/fsm/src/pipeline.js';

/**
 * Integration script: Generate chapter using Content Engine → Output for Renderer
 *
 * This script:
 * 1. Runs the full Content Engine pipeline (M1→M2→M3→M4)
 * 2. Outputs to CR_chapters/, plots/, diagrams/ for renderer compatibility
 * 3. Can be followed by `npm run chapter:build` to create CR_rendered/chapter.json
 */

async function main() {
  const root = process.cwd();

  // Parse command line arguments
  const argv = process.argv.slice(2);
  let title = 'Sample Physics Chapter';
  let subject: 'Physics' | 'Chemistry' | 'Mathematics' = 'Physics';
  let difficulty: 'comfort' | 'hustle' | 'advanced' = 'comfort';

  // Simple argument parsing
  const titleIndex = argv.findIndex(arg => arg === '--title' || arg === '-t');
  if (titleIndex >= 0 && argv[titleIndex + 1]) {
    title = argv[titleIndex + 1];
  }

  const subjectIndex = argv.findIndex(arg => arg === '--subject' || arg === '-s');
  if (subjectIndex >= 0 && argv[subjectIndex + 1]) {
    const subjectArg = argv[subjectIndex + 1];
    if (['Physics', 'Chemistry', 'Mathematics'].includes(subjectArg)) {
      subject = subjectArg as any;
    }
  }

  console.log(`🔬 Generating chapter: "${title}" (${subject}, ${difficulty})`);
  console.log('📋 Running Content Engine pipeline...');

  try {
    // Initialize Content Engine pipeline with repo root output
    const pipeline = new ContentPipeline('.');

    // Create plan request
    const planRequest = {
      title,
      subject,
      grade: 'Class XI',
      difficulty,
      chapter_pdf_url: undefined,
      reference_materials: []
    };

    // Execute full pipeline: M1 → M2 → M3 → M4
    const startTime = Date.now();
    const result = await pipeline.execute(planRequest);
    const duration = Date.now() - startTime;

    if (result.status === 'SUCCESS') {
      console.log(`✅ Content Engine completed successfully in ${duration}ms`);
      console.log(`📄 Chapter written to: ${result.artifacts!.chapterPath}`);
      console.log(`📊 Plot specs: ${result.artifacts!.plotSpecs.length} files`);
      console.log(`📋 Diagram specs: ${result.artifacts!.diagramSpecs.length} files`);

      console.log('\n📝 Files created:');
      console.log(`   • ${result.artifacts!.chapterPath}`);
      result.artifacts!.plotSpecs.forEach(spec => console.log(`   • ${spec}`));
      result.artifacts!.diagramSpecs.forEach(spec => console.log(`   • ${spec}`));

      console.log('\n🎯 Next steps:');
      console.log('   1. Run: npm run chapter:build');
      console.log('   2. Run: npm run dev');
      console.log('   3. Open: http://localhost:5173');

    } else {
      console.error('❌ Content Engine failed:');
      result.errors.forEach(error => {
        console.error(`   [${error.module}] ${error.code}: ${error.data}`);
      });
      process.exit(1);
    }

  } catch (error) {
    console.error('💥 Pipeline execution failed:', error);
    process.exit(1);
  }
}

// Help text
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
Usage: tsx scripts/generate-chapter.ts [options]

Options:
  -t, --title <title>        Chapter title (default: "Sample Physics Chapter")
  -s, --subject <subject>    Subject: Physics, Chemistry, Mathematics (default: Physics)
  -h, --help                 Show this help

Examples:
  tsx scripts/generate-chapter.ts
  tsx scripts/generate-chapter.ts --title "Laws of Motion" --subject Physics
  tsx scripts/generate-chapter.ts -t "Chemical Bonding" -s Chemistry

This script generates content using the Content Engine and outputs files
compatible with the existing renderer pipeline.
`);
  process.exit(0);
}

main().catch((err) => {
  console.error('💥 Script failed:', err);
  process.exit(1);
});