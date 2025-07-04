// trace-cli.js
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { trace, context, propagation } from '@opentelemetry/api';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import winston from 'winston';
import fs from 'fs';
import { randomUUID } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });

const args = process.argv.slice(2);
const command = args[0];
const stepArg = args.find(arg => arg.startsWith('--step='));
const step = stepArg ? stepArg.split('=')[1] : 'Unnamed Step';

const CONTEXT_FILE = path.join(__dirname, '.trace-context.json');

// Winston logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) =>
      `[${timestamp}] ${level.toUpperCase()} - ${message}`
    )
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/pipeline.log' }),
    new winston.transports.Console(),
  ],
});

// Track duration
const timers = {};
function startTimer(label) {
  timers[label] = Date.now();
}
function stopTimer(label) {
  const ms = Date.now() - (timers[label] || Date.now());
  logger.info(`${label} took ${ms} ms`);
  return ms;
}

// Save & load context
function saveContext(traceId, parentSpanId) {
  fs.writeFileSync(CONTEXT_FILE, JSON.stringify({ traceId, parentSpanId }, null, 2));
}

function loadContext() {
  if (!fs.existsSync(CONTEXT_FILE)) return null;
  return JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf-8'));
}

// Log to Dynatrace
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
  let span, spanCtx;

  if (command === 'start') {
    logger.info(`📍 Starting span: ${step}`);
    startTimer('step_duration');

    // Reuse traceId if present
    if (contextData?.traceId) {
      span = tracer.startSpan(step, {
        links: [
          {
            context: {
              traceId: contextData.traceId,
              spanId: contextData.parentSpanId || contextData.traceId.slice(0, 16), // fallback
              traceFlags: 1,
            },
          },
        ],
      });
    } else {
      span = tracer.startSpan(step);
    }

    span.setAttribute('step', step);
    span.setAttribute('ci.job', 'build-and-deploy');
    span.setAttribute('status', 'started');

    // Save context for next span
    const spanContext = span.spanContext();
    saveContext(spanContext.traceId, spanContext.spanId);

  } else if (command === 'end') {
    logger.info(`📍 Ending span: ${step}`);
    const duration = stopTimer('step_duration');

    span = tracer.startSpan(step);
    span.setAttribute('step', step);
    span.setAttribute('ci.job', 'build-and-deploy');
    span.setAttribute('status', 'completed');
    span.end();

    const payload = {
      timestamp: Date.now(),
      loglevel: 'INFO',
      trace_id: span.spanContext().traceId,
      span_id: span.spanContext().spanId,
      service: 'github-ci-pipeline',
      message: `CI Step Completed: ${step}`,
      step,
      step_duration_ms: duration,
      status: 'success',
      'log.source': '/v1/api/trace-cli.js',
    };

    await logToDynatrace(payload);
  }

  await sdk.shutdown();
})();
