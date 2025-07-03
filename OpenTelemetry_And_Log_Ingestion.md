# 📗 Document 2: OpenTelemetry Tracing & Dynatrace Logs Integration

## 🔹 Overview
The application integrates OpenTelemetry for distributed tracing and sends structured logs to Dynatrace using their Log Ingest API.

## 🔹 Tracing Configuration (`tracer.js`)
- Uses `@opentelemetry/sdk-node` for auto-instrumentation
- Sends traces to Dynatrace over OTLP HTTP
- Exporter: `@opentelemetry/exporter-trace-otlp-http`
- Span metadata (trace_id, span_id) is captured per request

## 🔹 Logging Configuration (`logger.js`)
- Uses `winston` for local file and console logging
- Custom function `logToDynatrace()` to push logs via HTTP POST
- Each log contains:
  - `trace_id`, `span_id`
  - `service name`, `level`, `timestamp`
  - Optional: `request_payload`, `headers`, durations

## 🔹 Log Format in Dynatrace
```json
{
  "trace_id": "abc123",
  "span_id": "def456",
  "level": "INFO",
  "message": "Excel generated in 23 ms",
  "request_payload": {...},
  "request_headers": {...},
  "service": "dynatrace-email-reporter"
}
```

## 🔹 Best Practices
- Always set both `trace_id` and `span_id` for correlation
- Use `context.with()` when working with async functions
- Group log events into a single record per request when possible