import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { trace } from '@opentelemetry/api';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import winston from 'winston';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });

// Create logger for writing local logs to logs/pipeline.log
const pipelineLogger = winston.createLogger({
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

const executionLog = {
  timestamp: Date.now(),
  level: 'INFO',
  trace_id: '',
  span_id: '',
  service: 'github-ci-pipeline',
  'log.source': '/v1/api/trace-cli.js',
  message: 'GitHub Actions pipeline instrumentation summary',
  cli_execution_time_ms: 0,
  otel_sdk_start_duration_ms: 0,
  otel_span_duration_ms: 0,
  otel_sdk_shutdown_duration_ms: 0,
  ci_job: 'build-and-deploy',
  trigger: 'git-push',
  tool: 'github-actions',
  status: 'success',
};

const stepTimers = {};

function startTimer(label) {
  stepTimers[label] = Date.now();
}

function stopTimer(label) {
  const duration = Date.now() - stepTimers[label];
  executionLog[label] = duration;
  pipelineLogger.info(`${label} took ${duration} ms`);
}

function logStep(message) {
  const ts = new Date().toISOString();
  pipelineLogger.info(`[${ts}] ${message}`);
}

async function logToDynatraceOnce() {
  try {
    const res = await fetch(process.env.DYNATRACE_LOG_INGEST_URL, {
      method: 'POST',
      headers: {
        Authorization: `Api-Token ${process.env.DYNATRACE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([executionLog]),
    });

    const responseText = await res.text();
    if (res.ok) {
      console.log('🧪 Dynatrace Log Ingest URL:', process.env.DYNATRACE_LOG_INGEST_URL);
      pipelineLogger.info(`✅ Combined log sent to Dynatrace`);
    } else {
      pipelineLogger.error(`❌ Dynatrace Log Ingest failed: ${res.status} - ${responseText}`);
    }
  } catch (err) {
    pipelineLogger.error(`❌ Log ingestion error: ${err.message}`);
    console.log('🧪 Dynatrace Log Ingest URL:', process.env.DYNATRACE_LOG_INGEST_URL);
  }
}

(async () => {
  startTimer('cli_execution_time_ms');
  logStep('🚀 CLI execution started');

  startTimer('otel_sdk_start_duration_ms');
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

  try {
    await sdk.start();
    stopTimer('otel_sdk_start_duration_ms');
    logStep('✅ OpenTelemetry SDK started');

    const tracer = trace.getTracer('cli-tracer');
    startTimer('otel_span_duration_ms');
    const span = tracer.startSpan('DynatraceEmailReporter.Build.Pipeline');
    executionLog.trace_id = span.spanContext().traceId;
    executionLog.span_id = span.spanContext().spanId;
    logStep(`📌 Span started | traceId: ${executionLog.trace_id}, spanId: ${executionLog.span_id}`);

    span.setAttribute('ci.job', executionLog.ci_job);
    span.setAttribute('trigger', executionLog.trigger);
    span.setAttribute('tool', executionLog.tool);
    span.setAttribute('status', executionLog.status);

    span.end();
    stopTimer('otel_span_duration_ms');
    logStep('📍 Span ended');

    startTimer('otel_sdk_shutdown_duration_ms');
    await sdk.shutdown();
    stopTimer('otel_sdk_shutdown_duration_ms');
    logStep('🔌 OpenTelemetry SDK shutdown complete');

  } catch (err) {
    logStep(`❌ Trace CLI error: ${err.message}`);
    executionLog.status = 'failure';
  } finally {
    stopTimer('cli_execution_time_ms');
    await logToDynatraceOnce();
  }
})();
