# 📘 Document 1: Application Overview – Dynatrace Email Reporter

## 🔹 Purpose
This application provides a RESTful API that:
- Accepts JSON payload via `/v1/api/send-report`
- Generates an Excel file from the data
- Emails it to configured recipients
- Captures execution trace with OpenTelemetry (OTel)
- Sends structured logs and traces to Dynatrace

## 🔹 Components
- `index.js` – Main API server, request handling
- `tracer.js` – OTel SDK initialization
- `logger.js` – Winston logger and Dynatrace log ingestion
- `excelGenerator.js` – Excel file creation (not shown)
- `emailSender.js` – Email dispatch logic (not shown)
- `.env` – Contains API URLs and tokens
- `logs/` – Stores exported trace logs
- `data/` – Stores generated Excel files

## 🔹 Flow Diagram
1. Incoming POST `/v1/api/send-report`
2. OTel span starts
3. Excel is generated → Span logs time
4. Email is sent → Span logs time
5. Single structured JSON log is pushed to Dynatrace
6. Span ends → Trace is ingested to Dynatrace

## 🔹 API Usage
**Request:**
```
POST /v1/api/send-report
Headers:
  x-email-to: user@example.com
  x-email-subject: Dynatrace Report
  x-email-from-name: Platform
Body:
  {
    "key": "value"
  }
```

**Response:**
```
✅ Report sent. Trace ID: <trace-id>
```

---