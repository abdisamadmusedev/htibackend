const ExcelJS = require("exceljs");
const { sequelize, initializeModels } = require("../../../config/mysql");
const { loadClassTemplateData, buildClassMarksWorkbook } = require("../controllers/classMarksTemplateController");
const { inspectClassMarksWorkbook, classPreviewResponse, importClassMarksWorkbook } = require("./classMarksImportService");
const { assertDepartmentAccess } = require("./manualMarkService");
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const positiveId = (value, field) => {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) fail(`${field} must be a positive integer`);
  return Number(value);
};
const sheets = ["Marks", "Template Information", "Subject Configuration"];
const sheetName = (term, name) => name === "Marks" ? `Term ${term}` : `T${term} ${name === "Template Information" ? "Information" : "Subjects"}`;
function copySheet(source, targetBook, name) {
  const target = targetBook.addWorksheet(name);
  target.state = source.state;
  target.views = source.views;
  target.properties = { ...source.properties };
  target.pageSetup = { ...source.pageSetup };
  (source.columns || []).forEach((column, index) => {
    target.getColumn(index + 1).width = column.width;
    target.getColumn(index + 1).hidden = column.hidden;
  });
  source.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    target.getRow(rowNumber).height = row.height;
    row.eachCell({ includeEmpty: true }, (cell, column) => {
      if (cell.type === ExcelJS.ValueType.Merge) return;
      const dest = target.getCell(rowNumber, column);
      dest.value = cell.value;
      dest.style = JSON.parse(JSON.stringify(cell.style));
      dest.dataValidation = cell.dataValidation;
    });
  });
  for (const range of source.model.merges || []) target.mergeCells(range);
  target.autoFilter = source.autoFilter;
  target.sheetProtection = { ...source.sheetProtection };
  return target;
}
async function buildAnnualWorkbook(query, user) {
  const academicYearId = positiveId(query.academicYearId, "academicYearId");
  const classId = positiveId(query.classId, "classId");
  const classSectionId = positiveId(query.classSectionId || query.sectionId, "classSectionId");
  const models = initializeModels();
  const terms = await models.Term.findAll({ where: { academicYearId, isActive: true } });
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "HTI School Management System";
  workbook.calcProperties.fullCalcOnLoad = true;
  for (const number of [1, 2]) {
    const matches = terms.filter(term => term.name === `Term ${number}`);
    if (matches.length !== 1) fail(`Configure exactly one active Term ${number} for this academic year`);
    const term = matches[0];
    const explicitId = query[`term${number}ExamId`];
    const exams = await models.Exam.findAll({ where: { academicYearId, termId: term.id, ...(explicitId ? { id: positiveId(explicitId, `term${number}ExamId`) } : {}) } });
    const eligible = exams.filter(exam => exam.status === "Open" && !exam.resultsPublished);
    if (eligible.length !== 1) fail(`Select term${number}ExamId: exactly one unpublished Open exam is required for Term ${number}`, 409);
    const data = await loadClassTemplateData({ examId: eligible[0].id, classId, classSectionId });
    assertDepartmentAccess(user, data.selectedClass.departmentId);
    const single = await buildClassMarksWorkbook(data);
    const marks = single.getWorksheet("Marks");
    marks.getCell("A2").value = `${data.academicYear?.name || ""} | Term ${number} | ${data.department?.name || ""} | Section: ${data.section.name}`;
    marks.getCell("A3").value = "Enter numeric component marks or NG (missing, calculated as zero). Blank marks are invalid.";
    marks.eachRow((row, rowNumber) => {
      if (rowNumber < 6) return;
      row.eachCell({ includeEmpty: true }, (cell, column) => {
        if (column < 4 || !cell.dataValidation?.type) return;
        const max = cell.dataValidation.formulae[1];
        cell.dataValidation = { type: "custom", allowBlank: true, showErrorMessage: true,
          errorTitle: "Invalid mark", error: `Enter 0 to ${max}, or NG`,
          formulae: [`OR(UPPER(TRIM(${cell.address}))="NG",AND(ISNUMBER(${cell.address}),${cell.address}>=0,${cell.address}<=${max}))`] };
      });
      row.eachCell(cell => {
        if (cell.value?.formula) cell.value = { formula: cell.value.formula.replace(/COUNT\(/g, "COUNTA(") };
      });
    });
    for (const name of sheets) copySheet(single.getWorksheet(name), workbook, sheetName(number, name));
  }
  const instructions = workbook.addWorksheet("Instructions");
  instructions.getColumn(1).width = 120;
  ["Complete Term 1 and Term 2 in this workbook, then upload the file once.",
    "Enter each enabled component mark, or NG for missing. NG counts as 0 in totals and averages and is retained in mark remarks.",
    "Do not change students, headings, configuration sheets or calculated totals. Blank marks and unknown codes are rejected.",
    "Both exams must remain Open and unpublished. Validation errors prevent all writes; re-imports update marks with audit history."
  ].forEach(line => instructions.addRow([line]));
  return workbook;
}
async function inspectAnnualWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(buffer); } catch (_) { fail("The uploaded file is not a valid .xlsx workbook"); }
  const inspections = [];
  for (const number of [1, 2]) {
    const single = new ExcelJS.Workbook();
    for (const name of sheets) {
      const source = workbook.getWorksheet(sheetName(number, name));
      if (!source) fail(`Missing ${sheetName(number, name)} worksheet`);
      copySheet(source, single, name);
    }
    const inspection = await inspectClassMarksWorkbook(await single.xlsx.writeBuffer());
    const metadata = inspection.metadata;
    positiveId(metadata["Class Section ID"], "Class Section ID");
    const { exam } = inspection.context;
    const term = await initializeModels().Term.findByPk(exam.termId);
    if (!term || term.name !== `Term ${number}` || Number(term.academicYearId) !== Number(exam.academicYearId)) fail(`Term ${number} exam does not match the academic year`);
    if (exam.resultsPublished) fail("Published exam marks cannot be imported", 409);
    if (Number(metadata["Academic Year ID"]) !== Number(exam.academicYearId)) fail("Academic year metadata does not match the exam");
    inspections.push(inspection);
  }
  const [first, second] = inspections;
  for (const key of ["Class ID", "Academic Year ID", "Class Section ID"]) {
    if (Number(first.metadata[key]) !== Number(second.metadata[key])) fail(`Both terms must have the same ${key}`);
  }
  return inspections;
}
const annualPreview = inspections => ({
  valid: inspections.every(item => !item.errors.length),
  terms: inspections.map((item, index) => ({ term: `Term ${index + 1}`, ...classPreviewResponse(item) })),
});
async function importAnnualWorkbook(inspections, filename, userId) {
  if (inspections.some(item => item.errors.length)) throw Object.assign(new Error("Correct workbook validation errors before importing"), { status: 422, details: annualPreview(inspections) });
  return sequelize.transaction(async transaction => {
    const summaries = [];
    // Lock both exams before writing either term, so publication cannot race this import.
    for (const inspection of inspections) {
      const exam = await inspection.context.models.Exam.findByPk(inspection.context.exam.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!exam || exam.status !== "Open" || exam.resultsPublished) fail("Both exams must remain Open and unpublished", 409);
    }
    for (const inspection of inspections) summaries.push(await importClassMarksWorkbook(inspection, filename, userId, transaction));
    return { terms: summaries };
  });
}
module.exports = { buildAnnualWorkbook, inspectAnnualWorkbook, annualPreview, importAnnualWorkbook };

