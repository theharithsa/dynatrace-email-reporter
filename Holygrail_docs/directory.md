### **Directory Structure & File Descriptions**

```
.
├── .gitignore
├── Dynatrace_EmailReporter_Overview.md
├── Dynatrace_Troubleshooting_Guide.md
├── emailSender.js
├── excelGenerator.js
├── index.js
├── logger.js
├── OpenTelemetry_And_Log_Ingestion.md
├── package-lock.json
├── package.json
├── pipeline-trace.js
├── telemetryLogger.js
├── trace-cli.js
├── trace.log
├── tracer.js
```

#### **File-by-File Explanation**

| **File**                              | **Purpose/Description**                                                                                                |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `.gitignore`                          | Specifies files/folders for git to ignore (e.g., `node_modules`, logs, secrets).                                       |
| `Dynatrace_EmailReporter_Overview.md` | Markdown documentation giving an overview of this project, its goals, and how it works with Dynatrace.                 |
| `Dynatrace_Troubleshooting_Guide.md`  | Markdown doc for troubleshooting steps and common issues when running/deploying this system.                           |
| `emailSender.js`                      | Module/function for sending emails with (or without) attachments. Used in reporting workflows.                         |
| `excelGenerator.js`                   | Contains logic for generating Excel (xlsx) files based on data, usually for reports.                                   |
| `index.js`                            | Main application entry point (Express server). Handles API requests, triggers Excel and email generation, logs events. |
| `logger.js`                           | Sets up the logging (via `winston`) and contains the function to send logs to Dynatrace Log Ingest API.                |
| `OpenTelemetry_And_Log_Ingestion.md`  | Markdown doc describing how OpenTelemetry tracing and Dynatrace log ingestion are implemented in this project.         |
| `package-lock.json`                   | Records exact version tree of installed npm dependencies (used by `npm ci` for reproducible builds).                   |
| `package.json`                        | Project metadata, scripts, and lists dependencies (for npm).                                                           |
| `pipeline-trace.js`                   | **Key CI/CD tracing script**: Used in GitHub Actions. Runs pipeline steps as OTel spans and ingests logs to Dynatrace. |
| `telemetryLogger.js`                  | (Probably) an alternate or helper module for telemetry logging—might be legacy or experiment.                          |
| `trace-cli.js`                        | Earlier or alternate CLI script for custom trace emission—can trigger spans/logs from the command line or pipelines.   |
| `trace.log`                           | Log output file (generated by `logger.js`/`winston`). Captures step-by-step execution logs locally.                    |
| `tracer.js`                           | Sets up OpenTelemetry tracer for the main Node.js app (`index.js`). Enables traces for app endpoints (API calls, etc). |

---

### **How They All Work Together**

* **`index.js`** = Main REST API server, orchestrates the workflow.

  * Calls `excelGenerator.js` to create Excel report.
  * Calls `emailSender.js` to send emails.
  * Uses `logger.js` for logging both locally and to Dynatrace.
  * Uses `tracer.js` to automatically create OTel traces for API requests.

* **CI/CD Tracing:**

  * **`pipeline-trace.js`** runs in the GitHub Actions workflow. Wraps each pipeline/build/deploy step as an OTel span and sends logs to Dynatrace for full traceability of your build pipeline itself.
  * **`trace-cli.js`** (optional) can be used for custom trace/log emission outside the main workflow.

* **Documentation:**

  * `*.md` files document usage, troubleshooting, and how OTel and Dynatrace integration works.
