// trace-cli.js
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

// Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()} - ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

// Timer utils
const timers = {};
const startTimer = (label) => (timers[label] = Date.now());
const stopTimer = (label) => Date.now() - (timers[label] || Date.now());

// CLI args
const args = process.argv.slice(2);
const command = args[0];
const getArg = (key) => {
  const match = args.find((a) => a.startsWith(`--${key}=`));
  return match ? match.split('=')[1] : null;
};

const step = getArg('step') || 'Unnamed';
const traceIdArg = getArg('trace-id');
const parentSpanId = getArg('parent-span-id');
const spanIdArg = getArg('span-id');

// Send logs to Dynatrace
async function logToDynatrace(payload) {
  try {
    const res = await fetch(process.env.DYNATRACE_LOG_INGEST_URL, {
      method: 'POST',
      headers: {
        Authorization: `Api-Token ${process.env.DYNATRACE_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify([payload])
    });
    if (!res.ok) throw new Error(`Dynatrace responded ${res.status}: ${await res.text()}`);
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
      [SemanticResourceAttributes.SERVICE_NAME]: 'github-ci-pipeline'
    })
  });
  await sdk.start();

  const tracer = trace.getTracer('github-ci-tracer');

  if (command === 'start') {
    logger.info(`🔷 Starting root span for ${step}`);
    startTimer(step);

    const span = tracer.startSpan(step);
    span.setAttribute('ci.job', step);

    const spanContext = span.spanContext();
    // Print ONLY these lines for GitHub Actions output extraction!
    console.log(`trace_id=${spanContext.traceId}`);
    console.log(`parent_span_id=${spanContext.spanId}`);

    // Do NOT end the span now.
    await sdk.shutdown();

  } else if (command === 'start-child') {
    if (!traceIdArg || !parentSpanId) {
      logger.error('❌ Missing trace-id or parent-span-id');
      // Always print for YAML output
      console.log(`trace_id=${traceIdArg || ''}`);
      console.log(`span_id=`);
      process.exit(1);
    }
    logger.info(`🟢 Starting child span: ${step}`);
    startTimer(step);

    let span, spanContext;
    context.with(
      trace.setSpanContext(ROOT_CONTEXT, {
        traceId: traceIdArg,
        spanId: parentSpanId,
        traceFlags: 1
      }),
      () => {
        span = tracer.startSpan(step);
        spanContext = span.spanContext();
        // Print ONLY for GitHub Actions
        console.log(`trace_id=${spanContext.traceId}`);
        console.log(`span_id=${spanContext.spanId}`);
      }
    );

    await sdk.shutdown();

  } else if (command === 'end-child') {
    if (!traceIdArg || !spanIdArg) {
      logger.error('❌ Missing trace-id or span-id');
      console.log(`trace_id=${traceIdArg || ''}`);
      console.log(`span_id=${spanIdArg || ''}`);
      process.exit(1);
    }
    logger.info(`🔴 Ending child span: ${step}`);
    const duration = stopTimer(step);

    context.with(
      trace.setSpanContext(ROOT_CONTEXT, {
        traceId: traceIdArg,
        spanId: spanIdArg,
        traceFlags: 1
      }),
      () => {
        const span = tracer.startSpan(`${step} - end`);
        span.setAttribute('step.duration.ms', duration);
        span.setAttribute('ci.step', step);
        span.end();
      }
    );

    // Only these lines for debug/output extraction
    console.log(`trace_id=${traceIdArg}`);
    console.log(`span_id=${spanIdArg}`);

    await logToDynatrace({
      timestamp: Date.now(),
      loglevel: 'INFO',
      trace_id: traceIdArg,
      span_id: spanIdArg,
      service: 'github-ci-pipeline',
      message: `Step Completed: ${step}`,
      step,
      step_duration_ms: duration,
      status: 'completed'
    });

    await sdk.shutdown();

  } else if (command === 'end') {
    if (!traceIdArg || !spanIdArg) {
      logger.error('❌ Missing trace-id or root span-id for root span');
      console.log(`trace_id=${traceIdArg || ''}`);
      console.log(`span_id=${spanIdArg || ''}`);
      process.exit(1);
    }
    logger.info(`🛑 Ending root span: ${step}`);

    context.with(
      trace.setSpanContext(ROOT_CONTEXT, {
        traceId: traceIdArg,
        spanId: spanIdArg,
        traceFlags: 1
      }),
      () => {
        const span = tracer.startSpan(`${step} - end`);
        span.setAttribute('ci.trace.root', step);
        span.setAttribute('ci.trace.end', true);
        span.end();
      }
    );

    // Print only for GitHub Actions (optional)
    console.log(`trace_id=${traceIdArg}`);
    console.log(`span_id=${spanIdArg}`);

    await logToDynatrace({
      timestamp: Date.now(),
      loglevel: 'INFO',
      trace_id: traceIdArg,
      span_id: spanIdArg,
      service: 'github-ci-pipeline',
      message: `Root Trace Ended: ${step}`,
      step,
      status: 'root-end'
    });

    await sdk.shutdown();
  }
})();
