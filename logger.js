// logger.js
import winston from 'winston';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) =>
      `[${timestamp}] ${level.toUpperCase()} - ${message}`
    )
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/report.log' }),
    new winston.transports.Console(),
  ],
});

// Sends logs to Dynatrace and logs status
export async function logToDynatrace(level, message, traceId, spanId ) {
  try {
    const payload = [
      {
        content: message,
        level,
        timestamp: Date.now(),
        trace_id: traceId,
        span_id: spanId,  // This is critical for log-trace correlation
        service: 'dynatrace-email-reporter',
        'dt.entity.host':'HOST-69CF503A58882ED2'
      },
    ];

    const res = await fetch(process.env.DYNATRACE_LOG_INGEST_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Api-Token ${process.env.DYNATRACE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      logger.info(`[Dynatrace] ✅ Log sent successfully | traceId: ${traceId}`);
    } else {
      const errorText = await res.text();
      logger.error(`[Dynatrace] ❌ Failed to ingest log | traceId: ${traceId} | ${res.status}: ${errorText}`);
    }
  } catch (err) {
    logger.error(`[Dynatrace] ❌ Exception during log ingestion | traceId: ${traceId} | ${err.message}`);
  }
}

export default logger;
