// trace-cli.js
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import * as otelApi from '@opentelemetry/api';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import winston from 'winston';

const { trace } = otelApi;
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

// Parse args
const args = process.argv.slice(2);
const command = args[0];
function getArg(key) {
  const match = args.find((a) => a.startsWith(`--${key}=`));
  return match ? match.split('=')[1] : null;
}
const step = getArg('step') || 'Unnamed';
const traceIdArg = getArg('trace-id');
const parentSpanId = getArg('parent-span-id');
const spanIdArg = getArg('span-id');

// Dynatrace log
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
    // Start root span, print traceId and spanId for others to use
    const span = tracer.startSpan(step);
    span.setAttribute('ci.job', step);
    // Output trace_id and span_id for parentage
    const spanContext = span.spanContext();
    console.log(`trace_id=${spanContext.traceId}`);
    console.log(`parent_span_id=${spanContext.spanId}`);
    // DO NOT end root span yet (let "end" command handle it)
    await sdk.shutdown();

  } else if (command === 'start-child') {
    if (!traceIdArg || !parentSpanId) {
      logger.error('❌ Missing trace-id or parent-span-id');
      console.log(`trace_id=${traceIdArg || ''}`);
      console.log(`span_id=`);
      process.exit(1);
    }
    // Start child span with explicit parent context
    const parentSpanContext = {
      traceId: traceIdArg,
      spanId: parentSpanId,
      traceFlags: 1
    };
    const span = tracer.startSpan(step, { parent: parentSpanContext });
    const spanContext = span.spanContext();
    console.log(`trace_id=${spanContext.traceId}`);
    console.log(`span_id=${spanContext.spanId}`);
    // Don't end child span here; "end-child" will do it
    await sdk.shutdown();

  } else if (command === 'end-child') {
    if (!traceIdArg || !spanIdArg) {
      logger.error('❌ Missing trace-id or span-id for end-child');
      console.log(`trace_id=${traceIdArg || ''}`);
      console.log(`span_id=${spanIdArg || ''}`);
      process.exit(1);
    }
    // To end a span by spanId, we must recreate it as the same context and end it
    const parentSpanContext = {
      traceId: traceIdArg,
      spanId: spanIdArg,
      traceFlags: 1
    };
    const span = tracer.startSpan(step, { parent: parentSpanContext });
    span.setAttribute('ci.step', step);
    span.setAttribute('ci.status', 'completed');
    span.end();

    // Log to Dynatrace (optional)
    await logToDynatrace({
      timestamp: Date.now(),
      loglevel: 'INFO',
      trace_id: traceIdArg,
      span_id: spanIdArg,
      service: 'github-ci-pipeline',
      message: `Step Completed: ${step}`,
      step,
      status: 'completed'
    });

    console.log(`trace_id=${traceIdArg}`);
    console.log(`span_id=${spanIdArg}`);
    await sdk.shutdown();

  } else if (command === 'end') {
    if (!traceIdArg || !spanIdArg) {
      logger.error('❌ Missing trace-id or span-id for root span');
      console.log(`trace_id=${traceIdArg || ''}`);
      console.log(`span_id=${spanIdArg || ''}`);
      process.exit(1);
    }
    // Re-create the root span using traceId and spanId and end it
    const rootSpanContext = {
      traceId: traceIdArg,
      spanId: spanIdArg,
      traceFlags: 1
    };
    const span = tracer.startSpan(step, { parent: rootSpanContext });
    span.setAttribute('ci.trace.root', step);
    span.setAttribute('ci.trace.end', true);
    span.end();

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

    console.log(`trace_id=${traceIdArg}`);
    console.log(`span_id=${spanIdArg}`);
    await sdk.shutdown();
  }
})();
 