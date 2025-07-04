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

const { trace, context, ROOT_CONTEXT, setSpanContext } = otelApi;
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

// Parse CLI args
const args = process.argv.slice(2);
const command = args[0];
const getArg = (key) => {
  const match = args.find((a) => a.startsWith(`--${key}=`));
  return match ? match.split('=')[1] : null;
};
const step = getArg('step') || 'Unnamed';
const traceIdArg = getArg('trace-id');
const parentSpanId = getArg('parent-span-id');

// Dynatrace log ingest
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

// Main logic
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
    logger.info(`🔷 Root span: ${step}`);
    const span = tracer.startSpan(step);
    span.setAttribute('ci.job', step);
    span.setAttribute('ci.type', 'root');
    const spanContext = span.spanContext();

    // Output for GitHub Actions
    console.log(`trace_id=${spanContext.traceId}`);
    console.log(`parent_span_id=${spanContext.spanId}`);

    // End root span immediately (since can't persist ref in CI)
    span.end();

    // Optionally log to Dynatrace
    await logToDynatrace({
      timestamp: Date.now(),
      loglevel: 'INFO',
      trace_id: spanContext.traceId,
      span_id: spanContext.spanId,
      service: 'github-ci-pipeline',
      message: `Root Span: ${step}`,
      step,
      status: 'started'
    });

    await sdk.shutdown();

  } else if (command === 'start-child') {
    if (!traceIdArg || !parentSpanId) {
      logger.error('❌ Missing trace-id or parent-span-id');
      // Always print for YAML output
      console.log(`trace_id=${traceIdArg || ''}`);
      console.log(`span_id=`);
      process.exit(1);
    }
    logger.info(`🟢 Child span: ${step}`);

    const parentCtx = setSpanContext(ROOT_CONTEXT, {
      traceId: traceIdArg,
      spanId: parentSpanId,
      traceFlags: 1
    });

    let span, spanContext;
    context.with(parentCtx, () => {
      span = tracer.startSpan(step);
      spanContext = span.spanContext();
      // Output for YAML
      console.log(`trace_id=${spanContext.traceId}`);
      console.log(`span_id=${spanContext.spanId}`);
      span.setAttribute('ci.step', step);
      span.setAttribute('ci.type', 'child');
      span.end();
    });

    // Optionally log to Dynatrace
    await logToDynatrace({
      timestamp: Date.now(),
      loglevel: 'INFO',
      trace_id: traceIdArg,
      span_id: spanContext?.spanId || '',
      service: 'github-ci-pipeline',
      message: `Step Completed: ${step}`,
      step,
      status: 'completed'
    });

    await sdk.shutdown();
  }
})();
