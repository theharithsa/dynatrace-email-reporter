// trace-cli.js
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import otelApi from '@opentelemetry/api'; // Fix for CommonJS module
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import winston from 'winston';
import fs from 'fs';

const { trace, context, ROOT_CONTEXT } = otelApi;
const setSpanContext = trace.setSpanContext;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });

const args = process.argv.slice(2);
const command = args[0];
const stepArg = args.find(arg => arg.startsWith('--step='));
const traceIdArg = args.find(arg => arg.startsWith('--trace-id='));
const parentSpanIdArg = args.find(arg => arg.startsWith('--parent-span-id='));

const step = stepArg ? stepArg.split('=')[1] : 'Unnamed Step';
const traceIdFromInput = traceIdArg ? traceIdArg.split('=')[1] : null;
const parentSpanIdFromInput = parentSpanIdArg ? parentSpanIdArg.split('=')[1] : null;

const CONTEXT_FILE = path.join(__dirname, '.trace-context.json');

// Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) =>
      `[${timestamp}] ${level.toUpperCase()} - ${message}`)
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/pipeline.log' }),
    new winston.transports.Console()
  ]
});

// Timer utils
const timers = {};
function startTimer(label) {
  timers[label] = Date.now();
}
function stopTimer(label) {
  const ms = Date.now() - (timers[label] || Date.now());
  logger.info(`${label} took ${ms} ms`);
  return ms;
}

// Context helpers
function saveContext(traceId, parentSpanId) {
  fs.writeFileSync(CONTEXT_FILE, JSON.stringify({ traceId, parentSpanId }, null, 2));
}
function loadContext() {
  if (!fs.existsSync(CONTEXT_FILE)) return null;
  return JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf-8'));
}

// Dynatrace log
async function logToDynatrace(payload) {
  try {
    const res = await fetch(process.env.DYNATRACE_LOG_INGEST_URL, {
      method: 'POST',
      headers: {
        Authorization: `Api-Token ${process.env.DYNATRACE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([payload]),
    });

    const resultText = await res.text();
    if (res.ok) {
      logger.info('✅ Log sent to Dynatrace');
    } else {
      logger.error(`❌ Dynatrace log error: ${res.status} - ${resultText}`);
    }
  } catch (err) {
    logger.error(`❌ Log ingestion failed: ${err.message}`);
  }
}

(async () => {
  const exporter = new OTLPTraceExporter({
    url: process.env.DYNATRACE_OTLP_URL,
    headers: {
      Authorization: `Api-Token ${process.env.DYNATRACE_API_TOKEN}`,
    },
  });

  const sdk = new NodeSDK({
    traceExporter: exporter,
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: 'github-ci-pipeline',
    }),
  });

  await sdk.start();
  const tracer = trace.getTracer('cli-tracer');

  const contextData = loadContext();
  let span;

  if (command === 'start') {
    logger.info(`📍 Starting root trace: ${step}`);
    startTimer('step_duration');

    span = tracer.startSpan(step);
    span.setAttribute('ci.job', 'build-or-deploy');
    span.setAttribute('status', 'started');

    const spanContext = span.spanContext();
    saveContext(spanContext.traceId, spanContext.spanId);

    // Print to stdout for GitHub Actions output parsing
    console.log(`trace_id=${spanContext.traceId}`);
    console.log(`parent_span_id=${spanContext.spanId}`);

    span.end();

  } else if (command === 'start-child') {
    logger.info(`📍 Starting child span: ${step}`);
    startTimer('step_duration');

    const traceId = traceIdFromInput || contextData?.traceId;
    const parentSpanId = parentSpanIdFromInput || contextData?.parentSpanId;

    if (!traceId || !parentSpanId) {
      logger.error('❌ Missing trace or parent span ID. Provide via --trace-id and --parent-span-id.');
      process.exit(1);
    }

    const parentCtx = setSpanContext(ROOT_CONTEXT, {
      traceId,
      spanId: parentSpanId,
      traceFlags: 1,
    });

    context.with(parentCtx, () => {
      span = tracer.startSpan(step);
      span.setAttribute('ci.job', 'build-or-deploy');
      span.setAttribute('status', 'in-progress');

      const spanContext = span.spanContext();
      saveContext(traceId, spanContext.spanId);
      span.end();
    });

  } else if (command === 'end-child') {
    logger.info(`📍 Ending child span: ${step}`);
    const duration = stopTimer('step_duration');

    const traceId = traceIdFromInput || contextData?.traceId;

    span = tracer.startSpan(`${step} - complete`);
    span.setAttribute('status', 'completed');
    span.setAttribute('ci.job', 'build-or-deploy');
    span.end();

    const payload = {
      timestamp: Date.now(),
      loglevel: 'INFO',
      trace_id: traceId,
      span_id: span.spanContext().spanId,
      service: 'github-ci-pipeline',
      message: `Step Completed: ${step}`,
      step,
      step_duration_ms: duration,
      status: 'success',
      'log.source': '/v1/api/trace-cli.js',
    };

    await logToDynatrace(payload);

  } else if (command === 'end') {
    logger.info(`📍 Ending trace: ${step}`);

    const traceId = traceIdFromInput || contextData?.traceId;

    span = tracer.startSpan(`${step} - trace-end`);
    span.setAttribute('ci.job', 'build-or-deploy');
    span.setAttribute('status', 'trace-end');
    span.end();

    const payload = {
      timestamp: Date.now(),
      loglevel: 'INFO',
      trace_id: traceId,
      span_id: span.spanContext().spanId,
      service: 'github-ci-pipeline',
      message: `Trace ended: ${step}`,
      step,
      status: 'trace-end',
    };

    await logToDynatrace(payload);
  }

  await sdk.shutdown();
})();
