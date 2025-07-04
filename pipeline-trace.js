// pipeline-trace.js
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import * as otelApi from '@opentelemetry/api';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });

const { trace, context } = otelApi;

// OTLP Exporter for Dynatrace
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

async function main() {
  await sdk.start();
  const tracer = trace.getTracer('github-ci-tracer');
  const rootSpan = tracer.startSpan('Deploy');
  await context.with(trace.setSpan(context.active(), rootSpan), async () => {
    try {
      // ---- Unzip Artifact ----
      const unzipSpan = tracer.startSpan('Unzip Artifact');
      await context.with(trace.setSpan(context.active(), unzipSpan), async () => {
        const unzipStart = Date.now();
        try {
          await execAsync('unzip -o release.zip');
          unzipSpan.setAttribute('status', 'success');
        } catch (err) {
          unzipSpan.setAttribute('status', 'failed');
          unzipSpan.recordException(err);
        }
        unzipSpan.setAttribute('duration.ms', Date.now() - unzipStart);
        unzipSpan.end();
      });

      // ---- Azure Deployment ----
      const deploySpan = tracer.startSpan('Azure Deployment');
      await context.with(trace.setSpan(context.active(), deploySpan), async () => {
        const deployStart = Date.now();
        try {
          // Option 1: Using Azure CLI directly
          await execAsync('az webapp deployment source config-zip --resource-group YOUR_RESOURCE_GROUP --name gen3emailreporting --src release.zip');
          // Option 2: Using publish profile via kudu api or zipdeploy if you prefer
          deploySpan.setAttribute('status', 'success');
        } catch (err) {
          deploySpan.setAttribute('status', 'failed');
          deploySpan.recordException(err);
        }
        deploySpan.setAttribute('duration.ms', Date.now() - deployStart);
        deploySpan.end();
      });

      rootSpan.setAttribute('status', 'success');
    } catch (err) {
      rootSpan.setAttribute('status', 'failed');
      rootSpan.recordException(err);
    } finally {
      rootSpan.end();
      await sdk.shutdown();
    }
  });
}

main();
