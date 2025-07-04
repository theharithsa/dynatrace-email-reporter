// trace-cli.js
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { trace } from '@opentelemetry/api';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import winston from 'winston';
import fs from 'fs';

dotenv.config();

// Setup Winston logger for local logging
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

// Centralized execution log for Dynatrace
const executionLog = {
  timestamp: Date.now(),
  loglevel: 'INFO',
  trace_id: '',
  span_id: '',
  service: 'github-ci-pipeline',
  content: 'GitHub Actions pipeline instrumentation summary',
  cli_execution_time_ms: 0,
  otel_sdk_start_duration_ms: 0,
  otel_span_duration_ms: 0,
  otel_sdk_shutdown_duration_ms: 0,
  ci_job: 'build-and-deploy',
  trigger: 'git-push',
  tool: 'github-actions',
  status: 'SUCCESS',                    // ✅ CORRECTED
  'log.source': '/v1/api/trace-cli.js',
};

const logStep = (msg) => {
  const ts = new Date().toISOString();
  pipelineLogger.info(`${msg}`);
};

// Send the final execution log to Dynatrace
async function logToDynatraceOnce() {
  try {
    const payload = [executionLog];

    // 🚨 Log the payload to pipeline.log and console
    const prettyPayload = JSON.stringify(payload, null, 2);
    logStep(`📦 Payload being sent to Dynatrace:\n${prettyPayload}`);

    const res = await fetch(process.env.DYNATRACE_LOG_INGEST_URL, {
      method: 'POST',
      headers: {
        Authorization: `Api-Token ${process.env.DYNATRACE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const responseText = await res.text();
    if (res.ok) {
      logStep(`✅ Combined log sent to Dynatrace`);
    } else {
      logStep(`❌ Dynatrace Log Ingest failed: ${res.status} - ${responseText}`);
    }
  } catch (err) {
    logStep(`❌ Exception during log ingestion: ${err.message}`);
  }
}


// Main OTEL + CLI workflow
(async () => {
  const cliStart = Date.now();
  logStep('🚀 CLI execution started');

  const exporter = new OTLPTraceExporter({
    url: process.env.DYNATRACE_OTLP_URL,
    headers: {
      Authorization: `Api-Token ${process.env.DYNATRACE_API_TOKEN}`,
    },
  });

  const sdkStart = Date.now();
  const sdk = new NodeSDK({
    traceExporter: exporter,
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: 'github-ci-pipeline',
    }),
  });

  try {
    await sdk.start();
    executionLog.otel_sdk_start_duration_ms = Date.now() - sdkStart;
    logStep('✅ OpenTelemetry SDK started');

    const tracer = trace.getTracer('cli-tracer');
    const spanStart = Date.now();
    const span = tracer.startSpan('DynatraceEmailReporter.Build.Pipeline');

    const traceId = span.spanContext().traceId;
    const spanId = span.spanContext().spanId;
    executionLog.trace_id = traceId;
    executionLog.span_id = spanId;
    logStep(`📌 Span started | traceId: ${traceId}, spanId: ${spanId}`);

    // Set attributes
    span.setAttribute('ci.job', executionLog.ci_job);
    span.setAttribute('trigger', executionLog.trigger);
    span.setAttribute('tool', executionLog.tool);
    span.setAttribute('status', executionLog.status);

    // End span
    span.end();
    executionLog.otel_span_duration_ms = Date.now() - spanStart;
    logStep('📍 Span ended');

    const shutdownStart = Date.now();
    await sdk.shutdown();
    executionLog.otel_sdk_shutdown_duration_ms = Date.now() - shutdownStart;
    logStep('🔌 OpenTelemetry SDK shutdown complete');
  } catch (err) {
    executionLog.level = 'ERROR';
    executionLog.status = 'FAILED';     // Fallback in case of error
    logStep(`❌ Trace CLI error: ${err.message}`);
  } finally {
    executionLog.cli_execution_time_ms = Date.now() - cliStart;
    await logToDynatraceOnce();
  }
})();
