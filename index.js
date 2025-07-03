import express from 'express';
import dotenv from 'dotenv';
import { generateExcel } from './excelGenerator.js';
import { sendEmailWithAttachment } from './emailSender.js';

dotenv.config();
const app = express();
app.use(express.json());

app.post('/send-report', async (req, res) => {
  try {
    const jsonData = req.body;
    const recipientsHeader = req.headers['x-email-to'];
    const subjectHeader = req.headers['x-email-subject'] || 'Dynatrace Report';
    const fromNameHeader = req.headers['x-email-from-name'] || 'Observability Platform';

    if (!recipientsHeader) {
      return res.status(400).send('❌ Missing x-email-to header.');
    }

    const recipients = recipientsHeader.split(',').map(email => email.trim());
    const filePath = './data/dynatrace-report.xlsx';

    await generateExcel(jsonData, filePath);
    await sendEmailWithAttachment(filePath, recipients, subjectHeader, fromNameHeader);

    res.status(200).send('✅ Report sent successfully!');
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).send('Failed to send report.');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
