// pipeline-trace.js
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import * as otel from '@opentelemetry/api';
import dotenv from 'dotenv';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });

const OTLP_URL = process.env.DYNATRACE_OTLP_URL;
const OTLP_TOKEN = process.env.DYNATRACE_API_TOKEN;
const SERVICE_NAME = 'github-ci-pipeline';

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function timeAsync(label, fn) {
  const start = Date.now();
  const result = await fn();
  const end = Date.now();
  return { duration: end - start, result };
}

async function main() {
  const job = process.argv[2] || 'Build';

  // OpenTelemetry SDK setup
  const exporter = new OTLPTraceExporter({
    url: OTLP_URL,
    headers: { Authorization: `Api-Token ${OTLP_TOKEN}` }
  });

  const sdk = new NodeSDK({
    traceExporter: exporter,
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: SERVICE_NAME,
    }),
  });

  await sdk.start();
  const tracer = otel.trace.getTracer('pipeline-tracer');

  // Start root trace/span for this job (Build or Deploy)
  const rootSpan = tracer.startSpan(job, { kind: otel.SpanKind.SERVER });
  const ctx = otel.trace.setSpan(otel.context.active(), rootSpan);

  // Add useful GitHub Actions metadata to root span
  rootSpan.setAttribute('github.repository', process.env.GITHUB_REPOSITORY || '');
  rootSpan.setAttribute('github.sha', process.env.GITHUB_SHA || '');
  rootSpan.setAttribute('github.run_id', process.env.GITHUB_RUN_ID || '');
  rootSpan.setAttribute('github.workflow', process.env.GITHUB_WORKFLOW || '');
  rootSpan.setAttribute('ci.job', job);

  let steps = [];
  if (job === 'Build') {
    steps = [
      {
        name: 'Install Dependencies',
        run: async () => {
          log('Installing dependencies...');
          execSync('npm install', { stdio: 'inherit' });
        },
      },
      {
        name: 'Build and Test',
        run: async () => {
          log('Running build and test...');
          try { execSync('npm run build --if-present', { stdio: 'inherit' }); } catch (e) {}
          try { execSync('npm run test --if-present', { stdio: 'inherit' }); } catch (e) {}
        },
      },
      {
        name: 'Zip Artifact',
        run: async () => {
          log('Zipping release...');
          execSync('zip release.zip . -r -x "node_modules/*" -x ".git/*"', { stdio: 'inherit' });
        },
      }
    ];
  } else if (job === 'Deploy') {
    steps = [
      {
        name: 'Unzip Artifact',
        run: async () => {
          log('Unzipping release...');
          execSync('unzip -o release.zip', { stdio: 'inherit' });
        },
      },
      {
        name: 'Azure Deployment',
        run: async () => {
          log('Deploying to Azure Web App using Azure CLI...');
          const resourceGroup = process.env.AZURE_RESOURCE_GROUP;
          const webappName = process.env.AZURE_WEBAPP_NAME;
          const slot = process.env.AZURE_WEBAPP_SLOT || 'Production';
          execSync(
            `az webapp deployment source config-zip --resource-group "${resourceGroup}" --name "${webappName}" --slot "${slot}" --src release.zip`,
            { stdio: 'inherit' }
          );
        },
      }
    ];
  } else {
    throw new Error('Unknown job type: ' + job);
  }

  // Run all steps as child spans
  for (const step of steps) {
    await otel.context.with(ctx, async () => {
      const span = tracer.startSpan(step.name, { parent: rootSpan, kind: otel.SpanKind.INTERNAL });
      let duration = 0;
      try {
        const { duration: stepDuration } = await timeAsync(step.name, async () => await step.run());
        duration = stepDuration;
        span.setStatus({ code: otel.SpanStatusCode.OK });
      } catch (err) {
        span.setStatus({ code: otel.SpanStatusCode.ERROR, message: err.message });
        log(`❌ Step failed: ${step.name}: ${err.message}`);
      }
      span.setAttribute('ci.step.duration_ms', duration);
      span.end();
    });
  }

  rootSpan.end();
  await sdk.shutdown();
  log(`✅ ${job} trace completed`);
  log(`🔗 Dynatrace Trace ID: ${rootSpan.spanContext().traceId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
