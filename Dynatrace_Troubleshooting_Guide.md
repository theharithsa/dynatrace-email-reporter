# 📕 Document 3: Troubleshooting Guide

## 🔸 Traces Not Appearing in Dynatrace
- ✅ Check OTLP endpoint:
  `https://<env>.live.dynatrace.com/api/v2/otlp/v1/traces`
- ✅ Use Protobuf (not JSON) for OTel export
- ✅ Remove `Content-Type` from OTLP headers
- ✅ Ensure API Token has `Ingest OpenTelemetry traces` scope

## 🔸 Log Not Correlated With Trace
- ❌ Missing `trace_id` and `span_id` in log payload
- ✅ Always extract span context:
```js
const span = trace.getSpan(context.active());
const traceId = span?.spanContext().traceId;
const spanId = span?.spanContext().spanId;
```

## 🔸 415 Unsupported Media Type
- ❌ Don't set `'Content-Type': 'application/json'` for OTLP traces
- ✅ Let exporter auto-set `application/x-protobuf`

## 🔸 fetch is not defined
- ✅ Node 18+ required for native `fetch`
- ❌ If using older Node.js, install: `npm i node-fetch` and `import fetch from 'node-fetch'`

## 🔸 Logs Sending But Not Ingesting
- ✅ Confirm correct log ingest endpoint
- ✅ Validate API token and payload JSON
- ✅ Include mandatory fields: `content`, `timestamp`, `level`

## 🔸 Span Context is Undefined
- ❌ Code running outside OTel context
- ✅ Use `context.with(ctx, async () => { ... })` to wrap operations

## 🔸 Logs Splitting into Multiple Records
- ✅ Send single JSON payload with complete execution info