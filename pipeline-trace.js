// pipeline-trace.js
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import * as otelApi from '@opentelemetry/api';
import { execSync } from 'child_process';
import dotenv from 'dotenv';

dotenv.config();

const { trace, context } = otelApi;

async function runStep(tracer, parentCtx, name, command) {
  const span = tracer.startSpan(name, undefined, parentCtx);
  try {
    if (command) {
      console.log(`\n> Running: ${command}`);
      execSync(command, { stdio: 'inherit' });
    }
    span.setStatus({ code: 1, message: 'Success' });
  } catch (e) {
    span.setStatus({ code: 2, message: e.message });
    throw e;
  } finally {
    span.end();
  }
}

async function runPipeline(jobType) {
  const exporter = new OTLPTraceExporter({
    url: process.env.DYNATRACE_OTLP_URL,
    headers: { Authorization: `Api-Token ${process.env.DYNATRACE_API_TOKEN}` }
  });
  const sdk = new NodeSDK({
    traceExporter: exporter,
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: 'github-ci-pipeline'
    })
  });

  await sdk.start();
  const tracer = trace.getTracer('github-ci-tracer');

  const rootSpan = tracer.startSpan(jobType);
  const rootCtx = trace.setSpan(context.active(), rootSpan);

  try {
    if (jobType === 'Build') {
      await context.with(rootCtx, async () => {
        await runStep(tracer, context.active(), 'Install Dependencies', 'npm install');
        await runStep(tracer, context.active(), 'Build and Test', 'npm run build --if-present && npm run test --if-present');
        await runStep(tracer, context.active(), 'Zip Artifact', 'zip release.zip . -r -x "node_modules/*" -x ".git/*"');
      });
    } else if (jobType === 'Deploy') {
      await context.with(rootCtx, async () => {
        await runStep(tracer, context.active(), 'Download Artifact', null); // Handled by GitHub Actions
        await runStep(tracer, context.active(), 'Unzip Artifact', 'unzip -o release.zip');
        await runStep(tracer, context.active(), 'Azure Deployment', 'echo "Deploying to Azure..." && echo "Deployment complete."');
      });
    } else {
      throw new Error('Unknown jobType: ' + jobType);
    }
    rootSpan.setStatus({ code: 1, message: 'Success' });
  } catch (e) {
    rootSpan.setStatus({ code: 2, message: e.message });
    throw e;
  } finally {
    rootSpan.end();
    await sdk.shutdown();
  }
}

// Run script based on arg
const jobType = process.argv[2] || '';
if (jobType !== 'Build' && jobType !== 'Deploy') {
  console.error('Usage: node pipeline-trace.js Build|Deploy');
  process.exit(1);
}
runPipeline(jobType).catch(e => {
  console.error('Pipeline failed:', e);
  process.exit(1);
});
