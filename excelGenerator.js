import xlsx from 'xlsx';

export async function generateExcel(data, filePath) {
  const worksheet = xlsx.utils.json_to_sheet(data);
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, 'Report');
  xlsx.writeFile(workbook, filePath);
}