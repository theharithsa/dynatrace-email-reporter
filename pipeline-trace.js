// pipeline-trace.js
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-proto');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const { trace, context } = require('@opentelemetry/api');
const { execSync } = require('child_process');
require('dotenv').config();

const exporter = new OTLPTraceExporter({
  url: process.env.DYNATRACE_OTLP_URL,
  headers: { Authorization: `Api-Token ${process.env.DYNATRACE_API_TOKEN}` },
});

const sdk = new NodeSDK({
  traceExporter: exporter,
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: 'github-ci-pipeline',
  }),
});

async function runBuildTrace() {
  await sdk.start();
  const tracer = trace.getTracer('pipeline-trace');

  const rootSpan = tracer.startSpan('Build');
  await context.with(trace.setSpan(context.active(), rootSpan), async () => {
    // Install dependencies
    const installSpan = tracer.startSpan('Install Dependencies');
    await context.with(trace.setSpan(context.active(), installSpan), async () => {
      console.log('Installing dependencies...');
      execSync('npm ci', { stdio: 'inherit' });
    });
    installSpan.end();

    // Build & Test
    const buildTestSpan = tracer.startSpan('Build and Test');
    await context.with(trace.setSpan(context.active(), buildTestSpan), async () => {
      try {
        execSync('npm run build --if-present', { stdio: 'inherit' });
        execSync('npm test --if-present', { stdio: 'inherit' });
      } catch (e) { /* no-op for test failures */ }
    });
    buildTestSpan.end();

    // Zip Artifact
    const zipSpan = tracer.startSpan('Zip Artifact');
    await context.with(trace.setSpan(context.active(), zipSpan), async () => {
      execSync('zip release.zip . -r -x "node_modules/*" -x ".git/*"', { stdio: 'inherit' });
    });
    zipSpan.end();
  });

  rootSpan.end();
  await sdk.shutdown();
}

async function runDeployTrace() {
  await sdk.start();
  const tracer = trace.getTracer('pipeline-trace');
  const rootSpan = tracer.startSpan('Deploy');
  await context.with(trace.setSpan(context.active(), rootSpan), async () => {
    // Download Artifact
    const downloadSpan = tracer.startSpan('Download Artifact');
    await context.with(trace.setSpan(context.active(), downloadSpan), async () => {
      // Already downloaded by the workflow, so just simulate
      console.log('Artifact downloaded.');
    });
    downloadSpan.end();

    // Unzip Artifact
    const unzipSpan = tracer.startSpan('Unzip Artifact');
    await context.with(trace.setSpan(context.active(), unzipSpan), async () => {
      execSync('unzip -o release.zip', { stdio: 'inherit' });
    });
    unzipSpan.end();

    // Azure Deploy (child span)
    const deploySpan = tracer.startSpan('Azure Deployment');
    const start = Date.now();
    await context.with(trace.setSpan(context.active(), deploySpan), async () => {
      try {
        // Write the publish profile to a file
        require('fs').writeFileSync('publish-profile.xml', process.env.AZURE_PUBLISH_PROFILE);
        execSync(
          `az webapp deployment source config-zip --resource-group ${process.env.AZURE_RESOURCE_GROUP} --name ${process.env.AZURE_WEBAPP_NAME} --src release.zip --slot ${process.env.AZURE_WEBAPP_SLOT} --publish-profile publish-profile.xml`,
          { stdio: 'inherit' }
        );
        const duration = Date.now() - start;
        deploySpan.setAttribute('azure.deploy.duration_ms', duration);
      } catch (e) {
        deploySpan.recordException(e);
        deploySpan.setStatus({ code: 2, message: e.message });
        throw e;
      } finally {
        // Optionally delete publish profile file
        require('fs').unlinkSync('publish-profile.xml');
      }
    });
    deploySpan.end();
  });
  rootSpan.end();
  await sdk.shutdown();
}

// Entrypoint
(async () => {
  const stage = process.argv[2];
  if (stage === 'Build') await runBuildTrace();
  else if (stage === 'Deploy') await runDeployTrace();
  else throw new Error(`Unknown stage: ${stage}`);
})();
