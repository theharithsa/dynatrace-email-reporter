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

const { trace, context, ROOT_CONTEXT, setSpan, SpanKind } = otelApi;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()} - ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

// --- Args ---
const args = process.argv.slice(2);
const command = args[0];
function getArg(key) {
  const match = args.find((a) => a.startsWith(`--${key}=`));
  return match ? match.split('=')[1] : null;
}
const step = getArg('step') || 'Unnamed';
const traceId = getArg('trace-id');
const parentSpanId = getArg('parent-span-id');
const spanId = getArg('span-id');

// --- Dynatrace Log Ingest ---
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

// --- MAIN ---
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
    // ROOT SPAN
    const rootSpan = tracer.startSpan(step);
    const rootCtx = trace.setSpan(context.active(), rootSpan);
    // Print root trace & span for next steps
    const sc = rootSpan.spanContext();
    console.log(`trace_id=${sc.traceId}`);
    console.log(`parent_span_id=${sc.spanId}`);
    // Don't end root here!
    await sdk.shutdown();

  } else if (command === 'start-child') {
    if (!traceId || !parentSpanId) {
      logger.error('❌ Missing trace-id or parent-span-id');
      console.log(`trace_id=`);
      console.log(`span_id=`);
      process.exit(1);
    }
    // --- STITCHED CONTEXT ---
    const parentSpanContext = {
      traceId,
      spanId: parentSpanId,
      traceFlags: 1,
    };
    // OpenTelemetry's way to "continue" a span tree:
    const ctxWithParent = trace.setSpanContext(ROOT_CONTEXT, parentSpanContext);

    let childSpan;
    context.with(ctxWithParent, () => {
      childSpan = tracer.startSpan(step, { kind: SpanKind.INTERNAL });
      const sc = childSpan.spanContext();
      // Print for YAML
      console.log(`trace_id=${sc.traceId}`);
      console.log(`span_id=${sc.spanId}`);
      // Don't end here!
    });

    await sdk.shutdown();

  } else if (command === 'end-child') {
    if (!traceId || !spanId) {
      logger.error('❌ Missing trace-id or span-id');
      console.log(`trace_id=`);
      console.log(`span_id=`);
      process.exit(1);
    }
    const childSpanContext = {
      traceId,
      spanId,
      traceFlags: 1
    };
    const ctxWithParent = trace.setSpanContext(ROOT_CONTEXT, childSpanContext);

    context.with(ctxWithParent, () => {
      const span = tracer.startSpan(step, { kind: SpanKind.INTERNAL });
      span.end();
    });

    await logToDynatrace({
      timestamp: Date.now(),
      loglevel: 'INFO',
      trace_id: traceId,
      span_id: spanId,
      service: 'github-ci-pipeline',
      message: `Step Completed: ${step}`,
      step,
      status: 'completed'
    });

    console.log(`trace_id=${traceId}`);
    console.log(`span_id=${spanId}`);
    await sdk.shutdown();

  } else if (command === 'end') {
    if (!traceId || !parentSpanId) {
      logger.error('❌ Missing trace-id or root span-id');
      console.log(`trace_id=`);
      console.log(`span_id=`);
      process.exit(1);
    }
    // End the root span
    const rootCtx = trace.setSpanContext(ROOT_CONTEXT, {
      traceId,
      spanId: parentSpanId,
      traceFlags: 1
    });

    context.with(rootCtx, () => {
      const span = tracer.startSpan(step, { kind: SpanKind.INTERNAL });
      span.end();
    });

    await logToDynatrace({
      timestamp: Date.now(),
      loglevel: 'INFO',
      trace_id: traceId,
      span_id: parentSpanId,
      service: 'github-ci-pipeline',
      message: `Root Trace Ended: ${step}`,
      step,
      status: 'root-end'
    });

    console.log(`trace_id=${traceId}`);
    console.log(`span_id=${parentSpanId}`);
    await sdk.shutdown();
  }
})();
