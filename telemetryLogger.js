// telemetryLogger.js
import { trace } from '@opentelemetry/api';
import winston from 'winston';

const logger = winston.createLogger({
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} ${level}: ${message}`)
  ),
  transports: [new winston.transports.File({ filename: 'trace.log' })],
});

export function logTracedOperation(operationName, fn) {
  const tracer = trace.getTracer('dynatrace-email-reporter');

  return async (...args) => {
    const span = tracer.startSpan(operationName);
    const start = Date.now();

    try {
      const result = await fn(...args);
      const duration = Date.now() - start;

      logger.info(`[Trace] ✅ ${operationName} completed in ${duration}ms`);
      return result;
    } catch (error) {
      logger.error(`[Trace] ❌ ${operationName} failed: ${error.message}`);
      throw error;
    } finally {
      span.end(); // Ends span, triggers export
    }
  };
}
