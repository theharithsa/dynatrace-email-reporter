// trace-cli.js
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { trace } from '@opentelemetry/api';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

const LOG_FILE = path.resolve('logs/pipeline.log');
fs.mkdirSync('logs', { recursive: true });

function logToFile(message) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${message}`;
  fs.appendFileSync(LOG_FILE, line + '\n');
  console.log(line);
}

const CLI_STATE_FILE = 'pipeline-span.json';

let executionLog = {
  timestamp: Date.now(),
  level: 'INFO',
  trace_id: '',
  span_id: '',
  service: 'github-ci-pipeline',
  message: 'GitHub Actions pipeline instrumentation summary',
  'log.source': '/v1/api/trace-cli.js',
  cli_execution_time_ms: 0,
  otel_sdk_start_duration_ms: 0,
  otel_span_duration_ms: 0,
  otel_sdk_shutdown_duration_ms: 0,
  ci_job: 'build-and-deploy',
  trigger: 'git-push',
  tool: 'github-actions',
  status: 'success'
};

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

async function sendLogToDynatrace(log) {
  try {
    const res = await fetch(process.env.DYNATRACE_LOG_INGEST_URL, {
      method: 'POST',
      headers: {
        Authorization: `Api-Token ${process.env.DYNATRACE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([log]),
    });

    const text = await res.text();
    if (res.ok) {
      logToFile('✅ Combined log sent to Dynatrace');
    } else {
      logToFile(`❌ Dynatrace ingestion failed: ${res.status} - ${text}`);
    }
  } catch (err) {
    logToFile(`❌ Log ingestion error: ${err.message}`);
  }
}

const arg = process.argv[2];

if (arg === 'start') {
  (async () => {
    const cliStart = Date.now();
    const sdkStart = Date.now();
    await sdk.start();
    executionLog.otel_sdk_start_duration_ms = Date.now() - sdkStart;

    const tracer = trace.getTracer('cli-tracer');
    const span = tracer.startSpan('DynatraceEmailReporter.Build.Pipeline');

    const traceId = span.spanContext().traceId;
    const spanId = span.spanContext().spanId;

    executionLog.trace_id = traceId;
    executionLog.span_id = spanId;

    fs.writeFileSync(CLI_STATE_FILE, JSON.stringify({ traceId, spanId, startTime: Date.now() }));

    await sdk.shutdown();
    executionLog.otel_sdk_shutdown_duration_ms = Date.now() - cliStart;
    executionLog.cli_execution_time_ms = Date.now() - cliStart;
    logToFile('📍 Start span recorded');
    await sendLogToDynatrace(executionLog);
  })();
} else if (arg === 'end') {
  (async () => {
    const cliStart = Date.now();
    const saved = JSON.parse(fs.readFileSync(CLI_STATE_FILE, 'utf-8'));
    const sdkStart = Date.now();
    await sdk.start();
    executionLog.otel_sdk_start_duration_ms = Date.now() - sdkStart;

    const tracer = trace.getTracer('cli-tracer');
    const span = tracer.startSpan('DynatraceEmailReporter.Build.Pipeline', {
      startTime: saved.startTime,
    });
    executionLog.trace_id = saved.traceId;
    executionLog.span_id = saved.spanId;

    span.end();
    executionLog.otel_span_duration_ms = Date.now() - saved.startTime;

    const sdkShutdownStart = Date.now();
    await sdk.shutdown();
    executionLog.otel_sdk_shutdown_duration_ms = Date.now() - sdkShutdownStart;
    executionLog.cli_execution_time_ms = Date.now() - cliStart;

    logToFile('📍 End span recorded');
    await sendLogToDynatrace(executionLog);
  })();
} else {
  logToFile('❌ Invalid argument. Use "start" or "end"');
}
