/**
 * Helper utility for exporting data to CSV with UTF-8 BOM encoding
 * so Spanish characters and accents render correctly in Microsoft Excel.
 */
export function exportToCSV(filename, headers, rows) {
  if (!rows || rows.length === 0) return;

  const escapeCell = (val) => {
    if (val === null || val === undefined) return '""';
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
  };

  const headerRow = headers.map(h => escapeCell(h.label)).join(',');
  const dataRows = rows.map(row => {
    return headers.map(h => escapeCell(row[h.key])).join(',');
  });

  const csvContent = '\uFEFF' + [headerRow, ...dataRows].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `${filename}_${new Date().toISOString().slice(0, 10)}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Helper to copy rich formatted text to clipboard
 */
export async function copyTextToClipboard(text, onSuccess, onError) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      if (onSuccess) onSuccess();
    } else {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.left = '-999999px';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      document.execCommand('copy');
      textArea.remove();
      if (onSuccess) onSuccess();
    }
  } catch (err) {
    console.error('Failed to copy: ', err);
    if (onError) onError(err);
  }
}
