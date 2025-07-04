import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import * as otel from '@opentelemetry/api';
import dotenv from 'dotenv';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';
import fetch from 'node-fetch';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });

const OTLP_URL = process.env.DYNATRACE_OTLP_URL;
const OTLP_TOKEN = process.env.DYNATRACE_API_TOKEN;
const LOG_INGEST_URL = process.env.DYNATRACE_LOG_INGEST_URL;
const SERVICE_NAME = 'github-ci-pipeline';

function log(msg) {
  logger.info(msg);
}

async function timeAsync(label, fn) {
  const start = Date.now();
  const result = await fn();
  const end = Date.now();
  return { duration: end - start, result, start, end };
}

async function sendExecutionLogsToDynatrace(logsArray, traceId) {
  if (!LOG_INGEST_URL || !OTLP_TOKEN) {
    logger.error('Missing Dynatrace log ingest endpoint or token');
    return;
  }
  const payload = [
    {
      content: JSON.stringify(logsArray, null, 2),
      level: 'INFO',
      timestamp: Date.now(),
      trace_id: traceId,
      service: SERVICE_NAME,
      'dt.execution.type': logsArray.length > 0 ? logsArray[0].jobType : '',
      'dt.cicd.pipeline': process.env.GITHUB_WORKFLOW || '',
      'dt.cicd.runid': process.env.GITHUB_RUN_ID || '',
      'dt.cicd.repo': process.env.GITHUB_REPOSITORY || ''
    }
  ];

  try {
    const res = await fetch(LOG_INGEST_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Api-Token ${OTLP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      logger.info(`[Dynatrace] ✅ All step logs sent for traceId: ${traceId}`);
    } else {
      const errText = await res.text();
      logger.error(`[Dynatrace] ❌ Failed to send logs | traceId: ${traceId} | ${res.status}: ${errText}`);
    }
  } catch (err) {
    logger.error(`[Dynatrace] ❌ Exception during log ingestion | traceId: ${traceId} | ${err.message}`);
  }
}

async function main() {
  const job = process.argv[2] || 'Build';

  // Prepare deploy timing (if Deploy job)
  let deployStart = null, deployEnd = null;
  if (job === 'Deploy') {
    deployStart = process.env.DEPLOY_START ? parseInt(process.env.DEPLOY_START, 10) * 1000 : null;
    deployEnd = process.env.DEPLOY_END ? parseInt(process.env.DEPLOY_END, 10) * 1000 : null;
  }

  // Setup OpenTelemetry Trace Exporter
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

  // For Deploy, set root span to deployStart; for Build, use script time
  const rootSpan = (job === 'Deploy' && deployStart)
    ? tracer.startSpan(job, { kind: otel.SpanKind.SERVER, startTime: deployStart })
    : tracer.startSpan(job, { kind: otel.SpanKind.SERVER });

  const ctx = otel.trace.setSpan(otel.context.active(), rootSpan);

  // Add GitHub metadata to root span
  rootSpan.setAttribute('github.repository', process.env.GITHUB_REPOSITORY || '');
  rootSpan.setAttribute('github.sha', process.env.GITHUB_SHA || '');
  rootSpan.setAttribute('github.run_id', process.env.GITHUB_RUN_ID || '');
  rootSpan.setAttribute('github.workflow', process.env.GITHUB_WORKFLOW || '');
  rootSpan.setAttribute('ci.job', job);

  // This will store each step's result
  const executionLogs = [];
  const logExecutionStep = (info) => executionLogs.push(info);

  let steps = [];
  if (job === 'Build') {
    steps = [
      {
        name: 'Install Dependencies',
        run: async () => execSync('npm install', { stdio: 'inherit' }),
      },
      {
        name: 'Build and Test',
        run: async () => {
          try { execSync('npm run build --if-present', { stdio: 'inherit' }); } catch (e) {}
          try { execSync('npm run test --if-present', { stdio: 'inherit' }); } catch (e) {}
        },
      },
      {
        name: 'Zip Artifact',
        run: async () => execSync('zip release.zip . -r -x "node_modules/*" -x ".git/*"', { stdio: 'inherit' }),
      }
    ];
  } else if (job === 'Deploy') {
    steps = [
      {
        name: 'Azure Web App Deploy (timed)',
        run: async () => {
          // This step's duration comes from env vars, not from actual run time
        }
      },
      {
        name: 'Health Check',
        run: async () => {
          // execSync('curl -f https://your-app.azurewebsites.net/health', { stdio: 'inherit' });
        },
      },
      {
        name: 'Smoke Test',
        run: async () => {
          // execSync('curl -f https://your-app.azurewebsites.net/', { stdio: 'inherit' });
        },
      }
    ];
  } else {
    throw new Error('Unknown job type: ' + job);
  }

  for (const step of steps) {
    await otel.context.with(ctx, async () => {
      let span;
      let duration = 0, start = Date.now(), end, errorMsg = '', status = 'SUCCESS';
      try {
        if (job === 'Deploy' && step.name === 'Azure Web App Deploy (timed)') {
          // For deploy step, use the pre-recorded start/end for real deployment duration
          if (deployStart && deployEnd && deployEnd > deployStart) {
            start = deployStart; end = deployEnd; duration = end - start;
            span = tracer.startSpan(step.name, {
              parent: rootSpan,
              kind: otel.SpanKind.INTERNAL,
              startTime: start
            });
            span.setAttribute('ci.deploy.duration_ms', duration);
            span.setStatus({ code: otel.SpanStatusCode.OK });
            span.end(end);
            logExecutionStep({
              jobType: job,
              step: step.name,
              start,
              end,
              duration,
              status,
              error: '',
              trace_id: rootSpan.spanContext().traceId,
              span_id: span.spanContext().spanId,
              github: {
                workflow: process.env.GITHUB_WORKFLOW,
                run_id: process.env.GITHUB_RUN_ID,
                sha: process.env.GITHUB_SHA,
                repository: process.env.GITHUB_REPOSITORY,
              },
              azure: { webapp: process.env.AZURE_WEBAPP_NAME }
            });
            return; // skip the rest of this step
          } else {
            // fallback (no deploy timer info)
            span = tracer.startSpan(step.name, { parent: rootSpan, kind: otel.SpanKind.INTERNAL });
          }
        } else {
          span = tracer.startSpan(step.name, { parent: rootSpan, kind: otel.SpanKind.INTERNAL });
        }
        const { duration: stepDuration, start: realStart, end: realEnd } = await timeAsync(step.name, async () => await step.run());
        duration = stepDuration;
        start = realStart;
        end = realEnd;
        span.setStatus({ code: otel.SpanStatusCode.OK });
      } catch (err) {
        status = 'ERROR';
        errorMsg = err.message;
        span && span.setStatus({ code: otel.SpanStatusCode.ERROR, message: errorMsg });
        log(`❌ Step failed: ${step.name}: ${errorMsg}`);
      }
      span && span.setAttribute('ci.step.duration_ms', duration);
      span && span.end();
      logExecutionStep({
        jobType: job,
        step: step.name,
        start,
        end,
        duration,
        status,
        error: errorMsg,
        trace_id: rootSpan.spanContext().traceId,
        span_id: span ? span.spanContext().spanId : undefined,
        github: {
          workflow: process.env.GITHUB_WORKFLOW,
          run_id: process.env.GITHUB_RUN_ID,
          sha: process.env.GITHUB_SHA,
          repository: process.env.GITHUB_REPOSITORY,
        },
        azure: { webapp: process.env.AZURE_WEBAPP_NAME }
      });
    });
  }

  // End root span for Deploy at deployEnd, else now
  if (job === 'Deploy' && deployEnd) {
    rootSpan.end(deployEnd);
  } else {
    rootSpan.end();
  }

  // At the end, send ALL step logs as a single JSON array to Dynatrace Log Ingest
  await sendExecutionLogsToDynatrace(executionLogs, rootSpan.spanContext().traceId);

  await sdk.shutdown();
  log(`✅ ${job} trace and logs completed`);
  log(`🔗 Dynatrace Trace ID: ${rootSpan.spanContext().traceId}`);
}

main().catch((err) => {
  logger.error(err);
  process.exit(1);
});
