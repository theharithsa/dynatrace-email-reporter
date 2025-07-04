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
    // Start root span, print trace and span ID, DO NOT END!
    logger.info(`🔷 Root span: ${step}`);
    const rootSpan = tracer.startSpan(step);
    rootSpan.setAttribute('ci.job', step);
    rootSpan.setAttribute('ci.type', 'root');
    const rootContext = trace.setSpan(context.active(), rootSpan);
    // Store root context in global for child calls (for one-liner CLI it's ephemeral)
    global._ROOT_SPAN = rootSpan; // Not used across CLI runs; for mono-process only

    // Output for GitHub Actions
    const spanContext = rootSpan.spanContext();
    console.log(`trace_id=${spanContext.traceId}`);
    console.log(`parent_span_id=${spanContext.spanId}`);

    // Instead of ending now, keep spanId for the end step!
    await sdk.shutdown();

  } else if (command === 'start-child') {
    // Use parentSpan context for child
    if (!traceIdArg || !parentSpanId) {
      logger.error('❌ Missing trace-id or parent-span-id');
      console.log(`trace_id=${traceIdArg || ''}`);
      console.log(`span_id=`);
      process.exit(1);
    }
    logger.info(`🟢 Child span: ${step}`);

    // Create a fake span context for parent
    const parentSpanContext = {
      traceId: traceIdArg,
      spanId: parentSpanId,
      traceFlags: 1
    };
    // Wrap parent context
    const parentCtx = trace.setSpanContext(ROOT_CONTEXT, parentSpanContext);

    let childSpan, childSpanContext;
    context.with(parentCtx, () => {
      childSpan = tracer.startSpan(step);
      childSpan.setAttribute('ci.step', step);
      childSpan.setAttribute('ci.type', 'child');
      childSpanContext = childSpan.spanContext();
      // Output for GitHub Actions
      console.log(`trace_id=${childSpanContext.traceId}`);
      console.log(`span_id=${childSpanContext.spanId}`);
      childSpan.end();
    });

    await logToDynatrace({
      timestamp: Date.now(),
      loglevel: 'INFO',
      trace_id: traceIdArg,
      span_id: childSpanContext?.spanId || '',
      service: 'github-ci-pipeline',
      message: `Step Completed: ${step}`,
      step,
      status: 'completed'
    });

    await sdk.shutdown();

  } else if (command === 'end') {
    // End root span by creating a "span" with the same IDs (no true parent resume in OTel JS CLI style)
    if (!traceIdArg || !parentSpanId) {
      logger.error('❌ Missing trace-id or span-id for root span');
      process.exit(1);
    }
    logger.info(`🛑 Ending root span: ${step}`);
    const parentSpanContext = {
      traceId: traceIdArg,
      spanId: parentSpanId,
      traceFlags: 1
    };
    const parentCtx = trace.setSpanContext(ROOT_CONTEXT, parentSpanContext);
    context.with(parentCtx, () => {
      const fakeRoot = tracer.startSpan(`${step}-end`);
      fakeRoot.setAttribute('ci.job', step);
      fakeRoot.setAttribute('ci.type', 'root-end');
      fakeRoot.end();
    });

    await logToDynatrace({
      timestamp: Date.now(),
      loglevel: 'INFO',
      trace_id: traceIdArg,
      span_id: parentSpanId,
      service: 'github-ci-pipeline',
      message: `Root Trace Ended: ${step}`,
      step,
      status: 'root-end'
    });

    await sdk.shutdown();
  }
})();
