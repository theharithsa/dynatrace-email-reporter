// index.js
import './tracer.js';
import express from 'express';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import { generateExcel } from './excelGenerator.js';
import { sendEmailWithAttachment } from './emailSender.js';
import logger, { logToDynatrace } from './logger.js';
import { trace, context } from '@opentelemetry/api';

dotenv.config();
const app = express();
app.use(express.json());

app.post('/v1/api/send-report', async (req, res) => {
  const tracer = trace.getTracer('dynatrace-email-reporter');
  const span = tracer.startSpan('send-report-handler');
  const ctx = trace.setSpan(context.active(), span);
  const traceId = span.spanContext().traceId;
  const spanId = span.spanContext().spanId;
  const startTime = Date.now();

  try {
    const jsonData = req.body;
    const recipients = req.headers['x-email-to']?.split(',').map(e => e.trim());
    const subject = req.headers['x-email-subject'] || 'Dynatrace Report';
    const fromName = req.headers['x-email-from-name'] || 'Observability Platform';

    if (!recipients || recipients.length === 0) {
      res.status(400).send('❌ Missing x-email-to header.');
      return;
    }

    const filePath = './data/dynatrace-report.xlsx';
    let excelTime = 0, emailTime = 0;

    await context.with(ctx, async () => {
      const excelStart = Date.now();
      await generateExcel(jsonData, filePath);
      excelTime = Date.now() - excelStart;
      logger.info(`[${traceId}] ✅ Excel generated in ${excelTime} ms`);

      const emailStart = Date.now();
      await sendEmailWithAttachment(filePath, recipients, subject, fromName);
      emailTime = Date.now() - emailStart;
      logger.info(`[${traceId}] ✅ Email sent in ${emailTime} ms`);
    });

    const totalTime = Date.now() - startTime;
    logger.info(`[${traceId}] ✅ Request completed in ${totalTime} ms`);

    // ✅ Unified JSON log payload
    const payload = [
      {
        timestamp: Date.now(),
        level: 'INFO',
        content: 'Dynatrace email reporting execution summary',
        trace_id: traceId,
        span_id: spanId,
        service: 'dynatrace-email-reporter',
        'dt.entity.host': 'HOST-69CF503A58882ED2',
        'log.source': 'v1/api/dynatrace-email-report',
        request_headers: req.headers,
        request_payload: jsonData,
        excel_time_ms: excelTime,
        email_time_ms: emailTime,
        total_time_ms: totalTime,
      },
    ];

    const response = await fetch(process.env.DYNATRACE_LOG_INGEST_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Api-Token ${process.env.DYNATRACE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      logger.info(`[Dynatrace] ✅ Batched log sent | traceId: ${traceId}`);
    } else {
      const errorText = await response.text();
      logger.error(`[Dynatrace] ❌ Failed to ingest log | ${response.status}: ${errorText}`);
    }

    span.end();
    res.status(200).send(`✅ Report sent successfully. Trace ID: ${traceId}`);
  } catch (err) {
    span.recordException(err);
    span.setStatus({ code: 2, message: err.message });
    span.end();
    logger.error(`[${traceId}] ❌ Error: ${err.message}`);
    await logToDynatrace('ERROR', `Request failed: ${err.message}`, traceId, spanId);
    res.status(500).send('❌ Failed to send report.');
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
