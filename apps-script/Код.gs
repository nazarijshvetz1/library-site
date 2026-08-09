function onOpen() {
  applyRevisionFilter_();
}

function onEdit(e) {
  if (!e || !e.range) return;

  const sheet = e.range.getSheet();
  if (sheet.getName() !== 'Ревізія') return;

  const rowStart = e.range.getRow();
  const rowEnd = e.range.getLastRow();
  if (rowStart > 1 || rowEnd < 1) return;

  const colStart = e.range.getColumn();
  const colEnd = e.range.getLastColumn();
  const touchesRubric = colStart <= 2 && colEnd >= 2;
  const touchesClass = colStart <= 4 && colEnd >= 4;
  if (!touchesRubric && !touchesClass) return;

  applyRevisionFilter_();
}

function applyRevisionFilter_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Ревізія');
  if (!sheet) return;

  const firstDataRow = 4;
  const rowCount = sheet.getMaxRows() - firstDataRow + 1;
  if (rowCount <= 0) return;

  const filter = sheet.getFilter();
  if (filter) filter.remove();

  sheet.showRows(firstDataRow, rowCount);

  const rubricChoice = String(sheet.getRange('B1').getDisplayValue()).trim();
  const classChoice = String(sheet.getRange('D1').getDisplayValue()).trim();
  const gradeMatch = classChoice.match(/\d+/);
  const grade = gradeMatch ? Number(gradeMatch[0]) : null;

  const rows = sheet.getRange(firstDataRow, 3, rowCount, 17).getDisplayValues();
  const groupsToHide = [];
  let groupStart = null;

  rows.forEach((row, index) => {
    const rubric = String(row[0]).trim();
    const materialId = String(row[6]).trim();
    const gradeFrom = Number(row[15]);
    const gradeTo = Number(row[16]);

    const rubricMatches = rubricChoice === 'Усі' || rubric === rubricChoice;
    const classMatches =
      classChoice === 'Усі' ||
      (grade !== null &&
        Number.isFinite(gradeFrom) &&
        Number.isFinite(gradeTo) &&
        gradeFrom <= grade &&
        grade <= gradeTo);

    const shouldHide = !materialId || !rubricMatches || !classMatches;

    if (shouldHide && groupStart === null) {
      groupStart = firstDataRow + index;
    }

    const isLast = index === rows.length - 1;
    if (groupStart !== null && (!shouldHide || isLast)) {
      const groupEnd = shouldHide && isLast ? firstDataRow + index + 1 : firstDataRow + index;
      groupsToHide.push({
        start: groupStart,
        count: groupEnd - groupStart
      });
      groupStart = null;
    }
  });

  groupsToHide.forEach(group => {
    if (group.count > 0) sheet.hideRows(group.start, group.count);
  });
}