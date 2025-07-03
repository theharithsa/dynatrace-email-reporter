// excelGenerator.js
import xlsx from 'xlsx';
import logger, { logToDynatrace } from './logger.js';

export async function generateExcel(data, filePath, requestId) {
  try {
    const worksheet = xlsx.utils.json_to_sheet(data);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Report');
    xlsx.writeFile(workbook, filePath);
  } catch (error) {
    const msg = `❌ Excel generation failed: ${error.stack || error}`;
    logger.error(`[${requestId}] ${msg}`);
    await logToDynatrace('error', msg, requestId);
    throw error;
  }
}
