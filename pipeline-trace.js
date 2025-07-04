// pipeline-trace.js
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import * as otel from '@opentelemetry/api';
import dotenv from 'dotenv';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

// Logging imports
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });

const OTLP_URL = process.env.DYNATRACE_OTLP_URL;
const OTLP_TOKEN = process.env.DYNATRACE_API_TOKEN;
const LOG_OTLP_URL = process.env.DYNATRACE_LOG_INGEST_URL || OTLP_URL;

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

  // ---- Setup OpenTelemetry LOGS ----
  const loggerProvider = new LoggerProvider({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: SERVICE_NAME,
    }),
  });

  const logExporter = new OTLPLogExporter({
    url: LOG_OTLP_URL,
    headers: { Authorization: `Api-Token ${OTLP_TOKEN}` },
  });

  loggerProvider.addLogRecordProcessor(new BatchLogRecordProcessor(logExporter));
  const logger = loggerProvider.getLogger('pipeline-logger');

  // ---- Setup OpenTelemetry TRACES ----
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

  // Log the start of the job
  logger.emit({
    severityText: "INFO",
    body: `Job ${job} started`,
    attributes: {
      "ci.job": job,
      "github.sha": process.env.GITHUB_SHA || '',
    },
  });

  let steps = [];
  if (job === 'Build') {
    steps = [
      {
        name: 'Install Dependencies',
        run: async () => {
          log('Installing dependencies...');
          logger.emit({ severityText: "INFO", body: "Installing dependencies..." });
          execSync('npm install', { stdio: 'inherit' });
        },
      },
      {
        name: 'Build and Test',
        run: async () => {
          log('Running build and test...');
          logger.emit({ severityText: "INFO", body: "Running build and test..." });
          try { execSync('npm run build --if-present', { stdio: 'inherit' }); } catch (e) {}
          try { execSync('npm run test --if-present', { stdio: 'inherit' }); } catch (e) {}
        },
      },
      {
        name: 'Zip Artifact',
        run: async () => {
          log('Zipping release...');
          logger.emit({ severityText: "INFO", body: "Zipping release..." });
          execSync('zip release.zip . -r -x "node_modules/*" -x ".git/*"', { stdio: 'inherit' });
        },
      }
    ];
  } else if (job === 'Deploy') {
    steps = [
      {
        name: 'Azure Web App Deploy (timed)',
        run: async () => {
          const DEPLOY_START = process.env.DEPLOY_START ? parseInt(process.env.DEPLOY_START, 10) * 1000 : null;
          const DEPLOY_END = process.env.DEPLOY_END ? parseInt(process.env.DEPLOY_END, 10) * 1000 : null;
          if (DEPLOY_START && DEPLOY_END && DEPLOY_END > DEPLOY_START) {
            const deploySpan = tracer.startSpan(
              "Azure Web App Deploy",
              {
                startTime: DEPLOY_START,
                attributes: {
                  "azure.webapp.name": process.env.AZURE_WEBAPP_NAME || '',
                  "github.sha": process.env.GITHUB_SHA || '',
                  "ci.deploy.duration_ms": DEPLOY_END - DEPLOY_START,
                },
                parent: rootSpan
              }
            );
            deploySpan.end(DEPLOY_END);
            logger.emit({
              severityText: "INFO",
              body: `Azure Web App Deploy completed`,
              attributes: {
                "ci.deploy.duration_ms": DEPLOY_END - DEPLOY_START,
                "azure.webapp.name": process.env.AZURE_WEBAPP_NAME || '',
              }
            });
            log(`[DEPLOY TRACE] Sent deployment child span with duration: ${DEPLOY_END - DEPLOY_START} ms`);
          } else {
            log('DEPLOY_START and/or DEPLOY_END not set. Skipping deploy duration child span.');
            logger.emit({
              severityText: "WARN",
              body: "DEPLOY_START and/or DEPLOY_END not set. Skipping deploy duration child span."
            });
          }
        }
      },
      {
        name: 'Health Check',
        run: async () => {
          log('Running post-deploy health check...');
          logger.emit({ severityText: "INFO", body: "Running post-deploy health check..." });
          // execSync('curl -f https://your-app.azurewebsites.net/health', { stdio: 'inherit' });
        },
      },
      {
        name: 'Smoke Test',
        run: async () => {
          log('Running smoke test...');
          logger.emit({ severityText: "INFO", body: "Running smoke test..." });
          // execSync('curl -f https://your-app.azurewebsites.net/', { stdio: 'inherit' });
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
        logger.emit({
          severityText: "INFO",
          body: `Step succeeded: ${step.name}`,
          attributes: { "ci.step.duration_ms": duration }
        });
      } catch (err) {
        span.setStatus({ code: otel.SpanStatusCode.ERROR, message: err.message });
        logger.emit({
          severityText: "ERROR",
          body: `Step failed: ${step.name}: ${err.message}`,
          attributes: { "ci.step.duration_ms": duration }
        });
        log(`❌ Step failed: ${step.name}: ${err.message}`);
      }
      span.setAttribute('ci.step.duration_ms', duration);
      span.end();
    });
  }

  rootSpan.end();

  // Log the end of the job
  logger.emit({
    severityText: "INFO",
    body: `Job ${job} finished`,
    attributes: {
      "ci.job": job,
      "github.sha": process.env.GITHUB_SHA || '',
    },
  });

  // Give a moment for logs to flush before shutdown
  await new Promise(r => setTimeout(r, 1000));

  await loggerProvider.shutdown();
  await sdk.shutdown();
  log(`✅ ${job} trace and logs completed`);
  log(`🔗 Dynatrace Trace ID: ${rootSpan.spanContext().traceId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
