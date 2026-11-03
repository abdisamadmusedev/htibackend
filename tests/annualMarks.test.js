const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const ExcelJS = require('exceljs');
function setup() {
  const writes = [], audits = [], queries = [];
  let failSecond = false;
  const record = data => ({ ...data, get: () => ({ ...data }) });
  const exams = [1, 2].map(id => ({ id, termId: id, academicYearId: 7, name: `Exam ${id}`, status: 'Open', resultsPublished: false }));
  const config = id => ({ id, examId: id, classId: 2, subjectId: 3, hasTheory: true, hasPractical: false, hasMonthlyAssessment: false, theoryMaxMarks: 100, practicalMaxMarks: 0, monthlyAssessmentMaxMarks: 0, totalMaxMarks: 100, passMark: 50 });
  const models = {
    Exam: { findByPk: async id => record(exams.find(e => e.id === Number(id))), findAll: async ({where}) => exams.filter(e => e.termId === where.termId).map(record) },
    Term: { findAll: async () => [1,2].map(id => record({id, name:`Term ${id}`, academicYearId:7})), findByPk: async id => record({id, name:`Term ${id}`, academicYearId:7}) },
    Class: { findByPk: async () => record({id:2, name:'1A', academicYearId:7, departmentId:4}) },
    ClassSection: { findByPk: async id => record({id:Number(id), classId:2, name:'A', isActive:true}) },
    ExamSubject: { findAll: async ({where}) => [record(config(Number(where.examId)))] },
    Subject: { findAll: async () => [record({id:3, code:'MATH', name:'Maths'})] },
    Student: { findAll: async ({where}) => { queries.push(where); return [record({id:5, admissionNo:'S5', fullName:'Student'})]; } },
    StudentMark: { findAll: async () => [], create: async value => { if(failSecond && value.examId===2) throw Error('second term failed'); writes.push(value); } },
    MarkEditHistory: { create: async value => audits.push(value) },
    AcademicYear: { findByPk: async () => record({id:7,name:'2024/2025'}) },
    Department: { findByPk: async () => record({id:4,name:'General Mechanic'}) },
  };
  const db = { initializeModels: () => models, sequelize: { transaction: async fn => { const before=writes.length; try { return await fn({LOCK:{UPDATE:'UPDATE'}}); } catch(e) { writes.splice(before); throw e; } } } };
  const cache = new Map();
  function load(filename) {
    filename = path.resolve(filename);
    if(cache.has(filename)) return cache.get(filename).exports;
    const module = {exports:{}}; cache.set(filename,module);
    const req = createRequire(filename);
    const sandbox = {module, exports:module.exports, Buffer, console, Date, process, require: name => {
      if(name === '../../../config/mysql') return db;
      if(name.startsWith('.')) return load(req.resolve(name));
      return req(name);
    }};
    new Function('module', 'exports', 'require', 'Buffer', 'console', 'Date', 'process', fs.readFileSync(filename,'utf8'))(module, module.exports, sandbox.require, Buffer, console, Date, process);
    return module.exports;
  }
  return {service:load(path.join(__dirname,'../src/modules/examMarks/services/annualMarksService.js')), writes, queries, exams, failSecond: () => {failSecond=true;} };
}
const query = { academicYearId:7, classId:2, classSectionId:8 };
const user = {role:'SuperAdmin'};
async function completed(state) {
  const workbook = await state.service.buildAnnualWorkbook(query,user);
  workbook.getWorksheet('Term 1').getCell('D6').value='NG';
  workbook.getWorksheet('Term 2').getCell('D6').value=75;
  return workbook;
}
test('both-term workbook round trips, filters section, and imports NG as zero with missing remarks', async () => {
  const state=setup(); const workbook=await completed(state);
  const inspections=await state.service.inspectAnnualWorkbook(await workbook.xlsx.writeBuffer());
  assert.equal(state.service.annualPreview(inspections).valid,true);
  assert.ok(state.queries.every(q => Number(q.classSectionId)===8 && Number(q.academicYearId)===7));
  await state.service.importAnnualWorkbook(inspections,'marks.xlsx',1);
  assert.equal(state.writes.length,2);
  assert.equal(state.writes[0].totalMark,0);
  assert.match(state.writes[0].remarks,/NG: theoryMark/);
  assert.equal(state.writes[1].totalMark,75);
});
test('invalid second-term mark prevents writes to either term', async () => {
  const state=setup();const workbook=await completed(state);
  workbook.getWorksheet('Term 2').getCell('D6').value=101;
  const inspections=await state.service.inspectAnnualWorkbook(await workbook.xlsx.writeBuffer());
  assert.equal(state.service.annualPreview(inspections).valid,false);
  await assert.rejects(state.service.importAnnualWorkbook(inspections,'marks.xlsx',1),/validation/);
  assert.equal(state.writes.length,0);
});
test('second-term persistence failure rolls back first term', async () => {
  const state=setup(); const workbook=await completed(state);
  const inspections=await state.service.inspectAnnualWorkbook(await workbook.xlsx.writeBuffer());
  state.failSecond();
  await assert.rejects(state.service.importAnnualWorkbook(inspections,'marks.xlsx',1),/second term failed/);
  assert.equal(state.writes.length,0);
});
test('download enforces department access and import rejects mismatched sections', async () => {
  const state=setup();
  await assert.rejects(state.service.buildAnnualWorkbook(query,{role:'HeadDepartment',departmentId:99}),/outside your department/);
  const workbook=await completed(state);
  const info=workbook.getWorksheet('T2 Information');
  info.eachRow(row=>{if(row.getCell(1).value==='Class Section ID') row.getCell(2).value=9;});
  await assert.rejects(state.service.inspectAnnualWorkbook(await workbook.xlsx.writeBuffer()),/same Class Section ID/);
});
