// trace-cli.js
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { Resource } from '@opentelemetry/resources';
import otelApi from '@opentelemetry/api';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import winston from 'winston';

const { trace, context, ROOT_CONTEXT } = otelApi;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });

const args = process.argv.slice(2);
const command = args[0];

const getArg = (name) => {
  const arg = args.find(arg => arg.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : null;
};

const step = getArg('step') || 'Unnamed Step';
const endpoint = getArg('endpoint') || 'ci';
const traceId = getArg('trace-id');
const parentSpanId = getArg('parent-span-id');
const spanId = getArg('span-id');

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
      'service.name': 'github-ci-pipeline',
    }),
  });

  await sdk.start();
  const tracer = trace.getTracer('cli-tracer');

  if (command === 'start') {
    const span = tracer.startSpan(endpoint);
    span.setAttribute('step', step);
    span.setAttribute('ci.job', endpoint);
    span.setAttribute('status', 'started');
    const spanContext = span.spanContext();

    console.log(`trace_id=${spanContext.traceId}`);
    console.log(`parent_span_id=${spanContext.spanId}`);

    span.end();
  }

  else if (command === 'start-child') {
    if (!traceId || !parentSpanId) {
      console.error('Missing trace-id or parent-span-id');
      process.exit(1);
    }

    const ctx = otelApi.trace.setSpanContext(ROOT_CONTEXT, {
      traceId,
      spanId: parentSpanId,
      traceFlags: 1,
    });

    const childSpan = tracer.startSpan(step, undefined, ctx);
    childSpan.setAttribute('step', step);
    childSpan.setAttribute('ci.job', endpoint);
    childSpan.setAttribute('status', 'in-progress');

    console.log(`trace_id=${traceId}`);
    console.log(`parent_span_id=${parentSpanId}`);
    console.log(`span_id=${childSpan.spanContext().spanId}`);
  }

  else if (command === 'end-child') {
    if (!traceId || !spanId) {
      console.error('Missing trace-id or span-id for ending span.');
      process.exit(1);
    }

    const ctx = otelApi.trace.setSpanContext(ROOT_CONTEXT, {
      traceId,
      spanId,
      traceFlags: 1,
    });

    const endSpan = tracer.startSpan(`${step}`, undefined, ctx);
    endSpan.setAttribute('step', step);
    endSpan.setAttribute('status', 'completed');
    endSpan.end();

    await logToDynatrace({
      timestamp: Date.now(),
      loglevel: 'INFO',
      trace_id: traceId,
      span_id: spanId,
      service: 'github-ci-pipeline',
      message: `Step completed: ${step}`,
      step,
      status: 'success',
      'log.source': 'trace-cli.js'
    });
  }

  else if (command === 'end') {
    if (!traceId) {
      console.error('Missing trace-id to end.');
      process.exit(1);
    }

    const endSpan = tracer.startSpan(`${step}-end`);
    endSpan.setAttribute('ci.job', endpoint);
    endSpan.setAttribute('status', 'trace-end');
    endSpan.end();

    await logToDynatrace({
      timestamp: Date.now(),
      loglevel: 'INFO',
      trace_id: traceId,
      span_id: endSpan.spanContext().spanId,
      service: 'github-ci-pipeline',
      message: `Trace ended: ${step}`,
      step,
      status: 'trace-end',
      'log.source': 'trace-cli.js'
    });
  }

  await sdk.shutdown();
})();
