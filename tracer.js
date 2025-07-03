// tracer.js
import 'dotenv/config';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import winston from 'winston';

// Logger setup
const logger = winston.createLogger({
  transports: [
    new winston.transports.File({ filename: 'logs/trace-export.log' }),
    new winston.transports.Console()
  ]
});

// ✅ Custom exporter with detailed logging
class CustomLoggingExporter extends OTLPTraceExporter {
  export(spans, resultCallback) {
    console.log('🚀 Exporting spans:', spans.map(span => span.name));
    super.export(spans, (result) => {
      const { code, error } = result;
      logger.info(`🟣 Traces export result: ${JSON.stringify({ code, errorCode: error?.code, message: error?.message })}`);
      resultCallback(result);
    });
  }
}

const sdk = new NodeSDK({
  traceExporter: new CustomLoggingExporter({
    url: process.env.DYNATRACE_OTLP_URL,
    headers: {
      'Authorization': `Api-Token ${process.env.DYNATRACE_API_TOKEN}`,
    }
  }),
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: 'dynatrace-email-reporter'
  }),
  instrumentations: [getNodeAutoInstrumentations()]
});

try {
  await sdk.start();
  logger.info('✅ OpenTelemetry tracer started');
} catch (err) {
  logger.error('❌ Tracer start failed', err);
}

process.on('SIGTERM', async () => {
  try {
    await sdk.shutdown();
    logger.info('🛑 Tracer shutdown complete');
  } catch (err) {
    logger.error('❌ Error during shutdown', err);
  }
});
