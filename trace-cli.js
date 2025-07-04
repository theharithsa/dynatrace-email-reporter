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
import fs from 'fs';

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
  transports: [
    new winston.transports.File({ filename: 'logs/pipeline.log' }),
    new winston.transports.Console()
  ]
});

// Timer
const timers = {};
function startTimer(label) { timers[label] = Date.now(); }
function stopTimer(label) {
  const ms = Date.now() - (timers[label] || Date.now());
  logger.info(`${label} took ${ms} ms`);
  return ms;
}

// CLI Args
const args = process.argv.slice(2);
const command = args[0];
const getArg = (flag) => {
  const arg = args.find(a => a.startsWith(`--${flag}=`));
  return arg ? arg.split('=')[1] : null;
};

const step = getArg('step') || 'Unnamed Step';
const traceId = getArg('trace-id');
const parentSpanId = getArg('parent-span-id');
const spanId = getArg('span-id');

// Load SDK + Tracer
const exporter = new OTLPTraceExporter({
  url: process.env.DYNATRACE_OTLP_URL,
  headers: { Authorization: `Api-Token ${process.env.DYNATRACE_API_TOKEN}` },
});

const sdk = new NodeSDK({
  traceExporter: exporter,
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: 'github-ci-pipeline',
  }),
});

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

await sdk.start();
const tracer = trace.getTracer('cli-tracer');

if (command === 'start') {
  logger.info(`📍 Starting root trace: ${step}`);
  startTimer('step_duration');
  const span = tracer.startSpan(step);
  span.setAttribute('ci.job', step.toLowerCase());
  span.setAttribute('status', 'started');

  const ctx = trace.setSpan(context.active(), span);
  context.with(ctx, () => {});

  const spanContext = span.spanContext();
  const traceContext = {
    trace_id: spanContext.traceId,
    parent_span_id: spanContext.spanId,
  };

  const encodedContext = Buffer.from(JSON.stringify(traceContext)).toString('base64');
  fs.writeFileSync('.trace_context', encodedContext);

  console.log(`trace_id=${spanContext.traceId}`);
  console.log(`parent_span_id=${spanContext.spanId}`);

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
    const ctx = trace.setSpan(context.active(), span);
    context.with(ctx, () => {});
    const childSpanId = span.spanContext().spanId;

    console.log(`trace_id=${traceId}`);
    console.log(`span_id=${childSpanId}`);

    // Defer ending until end-child
    const encoded = Buffer.from(JSON.stringify({
      traceId,
      spanId: childSpanId,
      step,
    })).toString('base64');
    fs.writeFileSync(`.child-${step.replace(/\s+/g, '_')}`, encoded);
  });

} else if (command === 'end-child') {
  logger.info(`📍 Ending child span: ${step}`);
  const duration = stopTimer('step_duration');

  let actualSpanId = spanId;
  if (!actualSpanId) {
    const file = `.child-${step.replace(/\s+/g, '_')}`;
    if (fs.existsSync(file)) {
      const data = JSON.parse(Buffer.from(fs.readFileSync(file).toString(), 'base64').toString('utf-8'));
      actualSpanId = data.spanId;
    }
  }

  if (!traceId || !actualSpanId) {
    logger.error('❌ Missing trace ID or span ID to end.');
    process.exit(1);
  }

  const spanContext = {
    traceId,
    spanId: actualSpanId,
    traceFlags: 1,
  };

  const endCtx = trace.setSpanContext(ROOT_CONTEXT, spanContext);
  context.with(endCtx, () => {
    const span = tracer.startSpan(`${step} - complete`);
    span.setAttribute('ci.job', 'build-or-deploy');
    span.setAttribute('status', 'completed');
    span.end();
  });

  const payload = {
    timestamp: Date.now(),
    loglevel: 'INFO',
    trace_id: traceId,
    span_id: actualSpanId,
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
  let baseTraceContext = {};
  if (fs.existsSync('.trace_context')) {
    const raw = fs.readFileSync('.trace_context').toString();
    baseTraceContext = JSON.parse(Buffer.from(raw, 'base64').toString('utf-8'));
  }

  const parentCtx = trace.setSpanContext(ROOT_CONTEXT, {
    traceId: baseTraceContext.trace_id,
    spanId: baseTraceContext.parent_span_id,
    traceFlags: 1,
  });

  context.with(parentCtx, () => {
    const span = tracer.startSpan(`${step} Done - trace-end`);
    span.setAttribute('ci.job', step.toLowerCase());
    span.setAttribute('status', 'done');
    span.end();

    logToDynatrace({
      timestamp: Date.now(),
      loglevel: 'INFO',
      trace_id: baseTraceContext.trace_id,
      span_id: span.spanContext().spanId,
      service: 'github-ci-pipeline',
      message: `Trace ended: ${step}`,
      step,
      status: 'completed',
    });
  });

  // Cleanup
  if (fs.existsSync('.trace_context')) fs.unlinkSync('.trace_context');
  fs.readdirSync('.')
    .filter(f => f.startsWith('.child-'))
    .forEach(f => fs.unlinkSync(f));
}

await sdk.shutdown();
