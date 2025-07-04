// trace-cli.js (FINAL VERSION)

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import otelApi from '@opentelemetry/api';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import winston from 'winston';

const { trace, context, ROOT_CONTEXT } = otelApi;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()} - ${message}`)
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/pipeline.log' }),
    new winston.transports.Console()
  ]
});

const timers = {};
function startTimer(label) { timers[label] = Date.now(); }
function stopTimer(label) {
  const ms = Date.now() - (timers[label] || Date.now());
  logger.info(`${label} took ${ms} ms`);
  return ms;
}

const args = process.argv.slice(2);
const command = args[0];
const getArg = (flag) => {
  const arg = args.find(arg => arg.startsWith(`--${flag}=`));
  return arg ? arg.split('=')[1] : null;
};

const step = getArg('step') || 'Unnamed Step';
const traceId = getArg('trace-id');
const parentSpanId = getArg('parent-span-id');
const spanIdArg = getArg('span-id');

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

    const result = await res.text();
    if (!res.ok) throw new Error(`Dynatrace responded with ${res.status}: ${result}`);
    logger.info('✅ Log sent to Dynatrace');
  } catch (err) {
    logger.error(`❌ Log ingestion failed: ${err.message}`);
  }
}

(async () => {
  const exporter = new OTLPTraceExporter({
    url: process.env.DYNATRACE_OTLP_URL,
    headers: { Authorization: `Api-Token ${process.env.DYNATRACE_API_TOKEN}` }
  });

  const sdk = new NodeSDK({
    traceExporter: exporter,
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: 'github-ci-pipeline',
    }),
  });

  await sdk.start();
  const tracer = trace.getTracer('cli-tracer');

  if (command === 'start') {
    logger.info(`📍 Starting root trace: ${step}`);
    startTimer('step_duration');

    const span = tracer.startSpan(step);
    span.setAttribute('ci.job', 'build-or-deploy');
    span.setAttribute('status', 'started');

    const spanContext = span.spanContext();

    console.log(`trace_id=${spanContext.traceId}`);
    console.log(`parent_span_id=${spanContext.spanId}`);

    // DO NOT end the span here. Store it via global tracer context.
    const ctx = trace.setSpan(context.active(), span);
    context.with(ctx, () => {});

    // Persist span in memory for context (optional)

  } else if (command === 'start-child') {
    logger.info(`📍 Starting child span: ${step}`);
    startTimer('step_duration');

    if (!traceId || !parentSpanId) {
      logger.error('❌ Missing trace ID or parent span ID.');
      process.exit(1);
    }

    const parentCtx = trace.setSpanContext(ROOT_CONTEXT, {
      traceId,
      spanId: parentSpanId,
      traceFlags: 1,
    });

    context.with(parentCtx, () => {
      const span = tracer.startSpan(step);
      const spanContext = span.spanContext();

      console.log(`trace_id=${traceId}`);
      console.log(`span_id=${spanContext.spanId}`);
      // DO NOT end now; user will call `end-child`
    });

  } else if (command === 'end-child') {
    logger.info(`📍 Ending child span: ${step}`);
    const duration = stopTimer('step_duration');

    if (!traceId || !spanIdArg) {
      logger.error('❌ Missing trace ID or span ID to end.');
      process.exit(1);
    }

    const spanContext = {
      traceId,
      spanId: spanIdArg,
      traceFlags: 1,
    };

    const endCtx = trace.setSpanContext(ROOT_CONTEXT, spanContext);
    context.with(endCtx, () => {
      const endSpan = tracer.startSpan(`${step} - complete`);
      endSpan.setAttribute('ci.job', 'build-or-deploy');
      endSpan.setAttribute('status', 'completed');
      endSpan.end();
    });

    const payload = {
      timestamp: Date.now(),
      loglevel: 'INFO',
      trace_id: traceId,
      span_id: spanIdArg,
      service: 'github-ci-pipeline',
      message: `Step Completed: ${step}`,
      step,
      step_duration_ms: duration,
      status: 'success',
      'log.source': '/v1/api/trace-cli.js',
    };

    await logToDynatrace(payload);

  } else if (command === 'end') {
    logger.info(`📍 Ending root span: ${step}`);
    const rootCtx = trace.setSpanContext(ROOT_CONTEXT, {
      traceId,
      spanId: parentSpanId,
      traceFlags: 1,
    });

    context.with(rootCtx, () => {
      const endSpan = tracer.startSpan(`${step} - trace-end`);
      endSpan.setAttribute('ci.job', 'build-or-deploy');
      endSpan.setAttribute('status', 'trace-end');
      endSpan.end();

      logToDynatrace({
        timestamp: Date.now(),
        loglevel: 'INFO',
        trace_id: traceId,
        span_id: parentSpanId,
        service: 'github-ci-pipeline',
        message: `Trace ended: ${step}`,
        step,
        status: 'trace-end',
      });
    });
  }

  await sdk.shutdown();
})();
