import express from 'express';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import logger from './logger.js';
import { generateExcel } from './excelGenerator.js';
import { sendEmailWithAttachment } from './emailSender.js';

dotenv.config();
const app = express();
app.use(express.json());

app.post('/send-report', async (req, res) => {
  const requestId = uuidv4();
  const startTime = Date.now();
  logger.info(`[${requestId}] 📥 Received /send-report request`);

  try {
    const jsonData = req.body;
    const recipientsHeader = req.headers['x-email-to'];
    const subjectHeader = req.headers['x-email-subject'] || 'Dynatrace Report';
    const fromNameHeader = req.headers['x-email-from-name'] || 'Observability Platform';

    if (!recipientsHeader) {
      logger.warn(`[${requestId}] ❌ Missing x-email-to header`);
      return res.status(400).send('❌ Missing x-email-to header.');
    }

    const recipients = recipientsHeader.split(',').map(email => email.trim());
    const filePath = './data/dynatrace-report.xlsx';

    const excelStart = Date.now();
    await generateExcel(jsonData, filePath, requestId);
    logger.info(`[${requestId}] ✅ Excel generated in ${Date.now() - excelStart} ms`);

    const emailStart = Date.now();
    await sendEmailWithAttachment(filePath, recipients, subjectHeader, fromNameHeader, requestId);
    logger.info(`[${requestId}] ✅ Email sent in ${Date.now() - emailStart} ms`);

    logger.info(`[${requestId}] 🟢 Request completed in ${Date.now() - startTime} ms`);
    res.status(200).send('✅ Report sent successfully!');
  } catch (error) {
    logger.error(`[${requestId}] ❌ Error: ${error.stack || error}`);
    res.status(500).send('Failed to send report.');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
