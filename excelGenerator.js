import xlsx from 'xlsx';
import logger from './logger.js';

export async function generateExcel(data, filePath, requestId) {
  try {
    const worksheet = xlsx.utils.json_to_sheet(data);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Report');
    xlsx.writeFile(workbook, filePath);
  } catch (error) {
    logger.error(`[${requestId}] ❌ Excel generation failed: ${error.stack || error}`);
    throw error;
  }
}
