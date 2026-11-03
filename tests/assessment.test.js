const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const assessment = require('../src/modules/examMarks/services/assessment');
const config = { id: 9, examId: 1, classId: 2, subjectId: 3, departmentId: 4, hasTheory: true, hasPractical: true, theoryMaxMarks: 60, practicalMaxMarks: 30, hasMonthlyAssessment: true, monthlyAssessmentMaxMarks: 30, totalMaxMarks: 120, passMark: 60, isActive: true, subject: { id: 3, _id: 3, code: 'SCI', name: 'Science', isActive: true } };
const student = { id: 5, _id: 5, admissionNo: 'S5', fullName: 'Student', isActive: true };
const exam = { id: 1, _id: 1, academicYearId: 7, termId: 8, status: 'Open', name: 'Term exam' };
const record = value => ({ ...value, get: () => ({ ...value }) });
function load(relative, mocks = {}) {
  const filename = path.join(__dirname, '../src', relative);
  const localRequire = createRequire(filename);
  const sandbox = { module: { exports: {} }, exports: {}, require: name => Object.hasOwn(mocks, name) ? mocks[name] : localRequire(name), console, Buffer, Date, process };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  return sandbox.module.exports;
}
function database(options = {}) {
  const saved = [], audits = [];
  const models = {
    Exam: { findByPk: async () => record(options.exam || exam), update: async value => saved.push(value) },
    Class: { findByPk: async () => record({ id: 2, name: 'Class', departmentId: 4, academicYearId: 7 }) },
    ExamSubject: { findOne: async () => record(options.config || config), findAll: async () => [record(options.config || config)] },
    Subject: { findAll: async () => [record(config.subject)] },
    Student: { findAll: async () => [record(student)] },
    StudentMark: { findAll: async () => (options.marks || []).map(record), findOne: async () => options.latest || null,
      create: async value => { saved.push(value); if (options.failWrite) throw Error('write failed'); }, update: async value => saved.push(value) },
    MarkEditHistory: { create: async value => audits.push(value) },
    ResultSummary: { findAll: async () => options.summaries || [] },
  };
  let rolledBack = false;
  const db = { initializeModels: () => models, sequelize: { transaction: async fn => {
    const before = saved.length, beforeAudits = audits.length;
    try { return await fn({}); } catch (e) { saved.splice(before); audits.splice(beforeAudits); rolledBack = true; throw e; }
  } } };
  return { db, saved, audits, models, get rolledBack() { return rolledBack; } };
}
const service = (name, state) => load('modules/examMarks/services/' + name + '.js', { '../../../config/mysql': state.db });
const values = { theoryMark: 30, practicalMark: 15, monthlyAssessmentMark: 15 };

test('subject type rules, optional monthly defaults and explicit allocation', () => {
  const general = assessment.subjectDefaults({ subjectType: 'General', theoryMaxMarks: 80, practicalMaxMarks: 0, passMark: 40 });
  assert.equal(general.hasTheory, true); assert.equal(general.hasPractical, false); assert.equal(general.hasMonthlyAssessment, false);
  assert.throws(() => assessment.subjectDefaults({ subjectType: 'Core', theoryMaxMarks: 80, practicalMaxMarks: 0, passMark: 40 }), /positive/);
  assert.throws(() => assessment.subjectDefaults({ subjectType: 'General', passMark: 0 }), /configure subject defaults/);
  assert.equal(assessment.subjectDefaults({ ...config, subjectType: 'Core' }).hasPractical, true);
  for (const bad of [-1, NaN, Infinity, 'bad', true]) assert.throws(() => assessment.configuration({ ...config, monthlyAssessmentMaxMarks: bad }));
  for (const bad of [-1, 121, NaN, Infinity, null]) assert.throws(() => assessment.configuration({ ...config, passMark: bad }));
  assert.throws(() => assessment.configuration({ ...config, hasMonthlyAssessment: 'yes' }));
});

test('enabled components require scores, zero is valid, invalid numbers and statuses reject', () => {
  assert.equal(assessment.calculateMark(values, config).values.totalMark, 60);
  assert.equal(assessment.calculateMark(values, config).values.percentage, 50);
  assert.equal(assessment.calculateMark({ theoryMark: 0, practicalMark: 0, monthlyAssessmentMark: 0 }, config).errors.length, 0);
  for (const bad of [undefined, null, '', ' ', -1, 31, NaN, Infinity, true, [], 'bad']) assert.ok(assessment.calculateMark({ ...values, monthlyAssessmentMark: bad }, config).errors.length);
  for (const status of ['Absent', 'Exempted']) {
    assert.equal(assessment.calculateMark({ markStatus: status }, config).values.totalMark, null);
    assert.equal(assessment.calculateMark({ markStatus: status }, config).errors.length, 0);
    assert.ok(assessment.calculateMark({ markStatus: status, monthlyAssessmentMark: 0 }, config).errors.length);
    assert.ok(assessment.calculateMark({ markStatus: status, theoryMark: 0 }, config).errors.length);
  }
});

test('disabled monthly and legacy configuration excludes maximum and rejects supplied numeric mark', () => {
  const legacy = { ...config, hasMonthlyAssessment: undefined, monthlyAssessmentMaxMarks: undefined, totalMaxMarks: 90 };
  const result = assessment.calculateMark({ theoryMark: 45, practicalMark: 0 }, legacy);
  assert.equal(result.errors.length, 0); assert.equal(result.values.percentage, 50);
  assert.equal(result.values.monthlyAssessmentMark, null);
  assert.ok(assessment.calculateMark({ ...values, monthlyAssessmentMark: 0 }, legacy).errors.length);
  assert.equal(assessment.configuration({ ...config, hasMonthlyAssessment: false }).totalMaxMarks, 90);
});

test('manual save, monthly-only correction audit, no-op and lifecycle guard', async () => {
  const old = { id: 44, studentId: 5, ...values, monthlyAssessmentMark: 10, totalMark: 55, resultStatus: 'Fail', remarks: '', enteredBy: 6 };
  const state = database(); const manual = service('manualMarkService', state);
  const context = { models: state.models, exam, examSubject: config, students: [student], existingMarks: [old] };
  const validated = manual.validateEntries([{ studentId: 5, ...values, reason: 'Verified term score' }], context);
  assert.equal(validated.errors.length, 0);
  await manual.saveEntries(context, validated, 12);
  assert.equal(state.saved[0].monthlyAssessmentMark, 15); assert.equal(state.audits[0].oldMonthlyAssessmentMark, 10);
  assert.equal(state.audits[0].newMonthlyAssessmentMark, 15); assert.equal(state.audits[0].reason, 'Verified term score');
  await assert.rejects(manual.saveEntries({ ...context, exam: { ...exam, status: 'Published' } }, validated, 12), /Open/);
  const invalid = manual.validateEntries([{ studentId: 5, ...values, monthlyAssessmentMark: null }], context);
  await assert.rejects(manual.saveEntries(context, invalid, 12), /invalid/);
  assert.throws(() => manual.assertDepartmentAccess({ role: 'HeadDepartment', departmentId: 99 }, 4), /outside your department/);
});

for (const kind of ['single', 'class']) test(kind + ' Excel round trip, validation parity, metadata, atomicity and correction history', async () => {
  const data = { examSubject: config, configurations: [config], exam, selectedClass: { id: 2, _id: 2, name: 'Class', departmentId: 4 }, subject: config.subject, students: [student] };
  const workbook = kind === 'single' ? await require('../src/modules/examMarks/controllers/examTemplateController').buildWorkbook(data) : await require('../src/modules/examMarks/controllers/classMarksTemplateController').buildClassMarksWorkbook(data);
  const marks = workbook.getWorksheet('Marks');
  assert.ok(marks.sheetProtection.sheet);
  assert.equal(marks.getCell(6, 6).protection.locked, false);
  assert.match(String(marks.getCell(5, 6).value), /Monthly Assessment/);
  marks.getCell(6, 4).value = 30; marks.getCell(6, 5).value = 15; marks.getCell(6, 6).value = 15;
  const old = { id: 44, studentId: 5, subjectId: 3, ...values, monthlyAssessmentMark: 10, totalMark: 55, resultStatus: 'Fail', remarks: '' };
  const state = database({ marks: [old] });
  const imports = service(kind === 'single' ? 'examExcelImportService' : 'classMarksImportService', state);
  const inspect = kind === 'single' ? imports.inspectExcel : imports.inspectClassMarksWorkbook;
  const confirm = kind === 'single' ? imports.importExcel : imports.importClassMarksWorkbook;
  const inspectBuffer = async () => inspect(await workbook.xlsx.writeBuffer());
  let inspection = await inspectBuffer();
  assert.equal(inspection.errors.length, 0, JSON.stringify(inspection.errors));
  assert.equal(inspection.rows[0].totalMark, 60);
  await confirm(inspection, 'marks.xlsx', 12);
  assert.equal(state.saved[0].monthlyAssessmentMark, 15);
  assert.equal(state.audits[0].oldMonthlyAssessmentMark, 10); assert.equal(state.audits[0].newMonthlyAssessmentMark, 15);
  marks.getCell(6, 6).value = null;
  inspection = await inspectBuffer(); assert.ok(inspection.errors.some(e => /required/.test(e.message)));
  const before = state.saved.length;
  await assert.rejects(confirm(inspection, 'marks.xlsx', 12), /validation errors/);
  assert.equal(state.saved.length, before);
  marks.getCell(6, 6).value = 0;
  inspection = await inspectBuffer(); assert.equal(inspection.errors.length, 0);
  const broken = database({ failWrite: true });
  const failing = service(kind === 'single' ? 'examExcelImportService' : 'classMarksImportService', broken);
  const brokenInspection = await (kind === 'single' ? failing.inspectExcel : failing.inspectClassMarksWorkbook)(await workbook.xlsx.writeBuffer());
  await assert.rejects((kind === 'single' ? failing.importExcel : failing.importClassMarksWorkbook)(brokenInspection, 'marks.xlsx', 12), /write failed/);
  assert.equal(broken.rolledBack, true); assert.equal(broken.saved.length, 0);
  if (kind === 'single') {
    workbook.getWorksheet('Template Information').eachRow(row => { if (row.getCell(1).value === 'Monthly Assessment Maximum') row.getCell(2).value = 50; });
  } else workbook.getWorksheet('Subject Configuration').getCell(2, 15).value = 50;
  inspection = await inspectBuffer(); assert.ok(inspection.errors.some(e => /maximum|Maximum/.test(e.message)));
});

test('result calculation uses 120 maximum, retains grade ranges and competition ranking', () => {
  const results = load('modules/results/services/resultCalculationService.js');
  const context = { exam, selectedClass: { id: 2 }, examSubjects: [config], students: [student, { ...student, id: 6 }, { ...student, id: 7 }],
    marks: [5, 6, 7].map((id, i) => ({ id, studentId: id, subjectId: 3, ...values, monthlyAssessmentMark: i === 2 ? 0 : 15, totalMark: i === 2 ? 45 : 60, resultStatus: i === 2 ? 'Fail' : 'Pass' })),
    gradingScales: [{ minimumPercentage: 50, maximumPercentage: 100, grade: 'P', isPass: true }, { minimumPercentage: 0, maximumPercentage: 49.99, grade: 'F', isPass: false }] };
  const calculation = results.calculateStudents(context);
  assert.equal(calculation.summaries[0].totalMaximumMarks, 120);
  assert.equal(calculation.summaries[0].averagePercentage, 50);
  assert.equal(calculation.summaries[0].grade, 'P');
  assert.equal(calculation.summaries[0].classPosition, 1); assert.equal(calculation.summaries[1].classPosition, 1); assert.equal(calculation.summaries[2].classPosition, 3);
  context.marks[0].monthlyAssessmentMark = null;
  assert.equal(results.calculateStudents(context).summaries[0].overallStatus, 'Incomplete');
});

test('publication rejects stale summaries and invalid monthly marks; accepts fresh complete results', async () => {
  const old = new Date('2020-01-01'), recent = new Date('2020-01-02');
  const state = database({ marks: [{ studentId: 5, subjectId: 3, ...values, totalMark: 60, resultStatus: 'Pass' }], latest: { updatedAt: recent }, summaries: [{ studentId: 5, overallStatus: 'Pass', subjectsMissing: 0, calculatedAt: old }] });
  const publication = load('modules/results/services/resultPublicationService.js', { '../../../config/mysql': state.db });
  assert.ok((await publication.validatePublication(1)).errors.some(e => /recalculated/.test(e.message)));
  await assert.rejects(publication.publishExam(1), /problems/);
  state.models.ResultSummary.findAll = async () => [{ studentId: 5, overallStatus: 'Pass', subjectsMissing: 0, calculatedAt: new Date('2020-01-03') }];
  assert.equal((await publication.validatePublication(1)).errors.length, 0);
  state.models.StudentMark.findAll = async () => [record({ studentId: 5, subjectId: 3, theoryMark: 30, practicalMark: 15, resultStatus: 'Pass' })];
  assert.ok((await publication.validatePublication(1)).errors.some(e => /monthlyAssessmentMark is required/.test(e.message)));
});

test('exam defaults snapshot and partial Draft edits survive later subject default changes', async () => {
  let defaults = { ...config, subjectType: 'Core', isActive: true };
  let snapshot;
  const query = value => { const q = { then: resolve => Promise.resolve(value).then(resolve), populate: () => q }; return q; };
  const models = {
    '../models/ExamSubject': {
      create: async value => { snapshot = { ...value, id: 9, _id: 9 }; return snapshot; },
      findById: () => query(snapshot),
      findByIdAndUpdate: (id, value) => { snapshot = { ...snapshot, ...value }; return query(snapshot); },
    },
    '../../exams/models/Exam': { findById: async () => ({ ...exam, status: 'Draft' }) },
    '../../classes/models/Class': { findById: async () => ({ academicYearId: 7, departmentId: 4, isActive: true }) },
    '../../subjects/models/Subject': { findById: async () => defaults },
  };
  const controller = load('modules/examSubjects/controllers/examSubjectController.js', models);
  const response = () => ({ status(value) { this.code = value; return this; }, json(value) { this.body = value; return this; } });
  const created = response();
  await controller.createExamSubject({ params: {}, body: { examId: 1, classId: 2, subjectId: 3 } }, created);
  assert.equal(created.code, 201); assert.equal(snapshot.totalMaxMarks, 120);
  defaults = { ...defaults, theoryMaxMarks: 100, monthlyAssessmentMaxMarks: 50, passMark: 100 };
  const updated = response();
  await controller.updateExamSubject({ params: { id: 9 }, body: { hasMonthlyAssessment: false } }, updated);
  assert.equal(updated.code, 200); assert.equal(snapshot.theoryMaxMarks, 60); assert.equal(snapshot.passMark, 60); assert.equal(snapshot.totalMaxMarks, 90);
  models['../../exams/models/Exam'].findById = async () => exam;
  const forbidden = response();
  await controller.updateExamSubject({ params: { id: 9 }, body: { passMark: 0 } }, forbidden);
  assert.equal(forbidden.code, 409);
});

test('additive migration is idempotent and leaves historical allocations/totals alone', async () => {
  const migration = require('../src/config/assessmentMigration');
  const columns = Object.fromEntries(['subjects', 'examsubjects', 'studentmarks', 'markedithistorys'].map(table => [table, {}]));
  const added = [];
  const qi = { showAllTables: async () => Object.keys(columns), describeTable: async table => columns[table], addColumn: async (table, name, definition) => { columns[table][name] = definition; added.push([table, name]); } };
  await migration({ getQueryInterface: () => qi });
  assert.equal(added.length, 10);
  assert.equal(columns.subjects.theoryMaxMarks.allowNull, true);
  assert.equal(columns.examsubjects.hasMonthlyAssessment.defaultValue, false);
  assert.equal(added.some(([table, name]) => name === 'totalMaxMarks' || name === 'totalMark'), false);
  await migration({ getQueryInterface: () => qi }); assert.equal(added.length, 10);
});

test('authentication, exam roles, cross-department and attendance account restrictions remain', async () => {
  const middleware = load('middleware/authMiddleware.js', { '../modules/users/models/User': { findById: () => { throw Error('unexpected user lookup'); } } });
  const response = () => ({ status(value) { this.code = value; return this; }, json(value) { this.body = value; return this; } });
  const unauthenticated = response();
  await middleware.protect({ headers: {} }, unauthenticated, () => assert.fail('unauthenticated'));
  assert.equal(unauthenticated.code, 401);
  const denied = response(); middleware.examManagerOnly({ user: { role: 'AttendanceTaker' } }, denied, () => assert.fail('unauthorized'));
  assert.equal(denied.code, 403);
  let authorized = false; middleware.examManagerOnly({ user: { role: 'ExamManager' } }, response(), () => { authorized = true; }); assert.ok(authorized);
  const access = require('../src/middleware/portalAccessMiddleware');
  const blocked = response(); access.portalRoleAccess({ user: { role: 'AttendanceTaker', teacherId: 4 }, path: '/exam-marks/manual' }, blocked, () => assert.fail('teacher bypass'));
  assert.equal(blocked.code, 403);
  const department = response(); access.headDepartmentAccess({ user: { role: 'HeadDepartment', departmentId: 4 }, method: 'GET', path: '/exam-marks/entry-sheet' }, department, () => assert.fail('department bypass'));
  assert.equal(department.code, 403);
});

for (const kind of ['single', 'class']) test(kind + ' legacy workbook with monthly disabled stays compatible', async () => {
  const legacy = { ...config, hasMonthlyAssessment: false, monthlyAssessmentMaxMarks: 0, totalMaxMarks: 90 };
  const data = { examSubject: legacy, configurations: [legacy], exam, selectedClass: { id: 2, _id: 2, name: 'Class', departmentId: 4 }, subject: config.subject, students: [student] };
  const workbook = kind === 'single' ? await require('../src/modules/examMarks/controllers/examTemplateController').buildWorkbook(data) : await require('../src/modules/examMarks/controllers/classMarksTemplateController').buildClassMarksWorkbook(data);
  workbook.getWorksheet('Template Information').eachRow(row => { if (row.getCell(1).value === 'Template Version') row.getCell(2).value = kind === 'single' ? '1.0' : 'CLASS-1.1'; });
  if (kind === 'class') {
    const subjectInfo = workbook.getWorksheet('Subject Configuration');
    for (const row of [1, 2]) for (let column = 14; column <= 16; column++) subjectInfo.getCell(row, column).value = null;
  }
  const marks = workbook.getWorksheet('Marks'); marks.getCell(6, 4).value = 45; marks.getCell(6, 5).value = 0;
  const state = database({ config: legacy });
  const imports = service(kind === 'single' ? 'examExcelImportService' : 'classMarksImportService', state);
  const result = await (kind === 'single' ? imports.inspectExcel : imports.inspectClassMarksWorkbook)(await workbook.xlsx.writeBuffer());
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors)); assert.equal(result.rows[0].percentage, 50); assert.equal(result.rows[0].monthlyAssessmentMark, null);
});

test('Absent and Exempted retain denominator and failure policies in results', () => {
  const results = load('modules/results/services/resultCalculationService.js');
  const context = { exam, selectedClass: { id: 2 }, examSubjects: [config], students: [student], marks: [{ studentId: 5, subjectId: 3, resultStatus: 'Absent' }], gradingScales: [{ minimumPercentage: 0, maximumPercentage: 100, grade: 'P', isPass: true }] };
  let summary = results.calculateStudents(context).summaries[0]; assert.equal(summary.totalMaximumMarks, 120); assert.equal(summary.subjectsFailed, 1);
  context.marks[0].resultStatus = 'Exempted'; summary = results.calculateStudents(context).summaries[0]; assert.equal(summary.totalMaximumMarks, 0); assert.equal(summary.subjectsExempted, 1); assert.equal(summary.averagePercentage, null);
});

test('Draft must be prepared before opening; generic status updates cannot publish or unpublish', async () => {
  const response = () => ({ status(value) { this.code = value; return this; }, json(value) { this.body = value; return this; } });
  let current = { ...exam, status: 'Draft' }, configurations = [];
  const query = value => { const q = { then: resolve => Promise.resolve(value).then(resolve), populate: () => q }; return q; };
  const controller = load('modules/exams/controllers/examController.js', {
    '../models/Exam': { findById: () => query(current), findByIdAndUpdate: (id, value) => { current = { ...current, ...value }; return query(current); } },
    '../../examSubjects/models/ExamSubject': { find: async () => configurations },
  });
  let res = response(); await controller.updateExamStatus({ params: { id: 1 }, body: { status: 'Open' } }, res); assert.equal(res.code, 409);
  configurations = [config]; res = response(); await controller.updateExamStatus({ params: { id: 1 }, body: { status: 'Open' } }, res); assert.equal(res.code, 200);
  res = response(); await controller.updateExamStatus({ params: { id: 1 }, body: { status: 'Published' } }, res); assert.equal(res.code, 400);
  current.status = 'Published'; res = response(); await controller.updateExamStatus({ params: { id: 1 }, body: { status: 'Open' } }, res); assert.equal(res.code, 409);
});

test('Sequelize validates enabled and disabled monthly snapshots without connecting to a database', async () => {
  const { initializeModels } = require('../src/config/mysql');
  const models = initializeModels();
  await models.ExamSubject.build(config).validate();
  await models.ExamSubject.build({ ...config, hasMonthlyAssessment: false, totalMaxMarks: 90 }).validate();
  await assert.rejects(models.ExamSubject.build({ ...config, totalMaxMarks: 90 }).validate(), /Total maximum/);
});

test('decimal component sums match DECIMAL storage and do not falsely block readiness', async () => {
  const decimalConfig = { ...config, theoryMaxMarks: 60.1, practicalMaxMarks: 30.2, monthlyAssessmentMaxMarks: 30.3, totalMaxMarks: 120.6 };
  assert.equal(assessment.configuration(decimalConfig).totalMaxMarks, 120.6);
  const calculation = assessment.calculateMark({ theoryMark: 30.1, practicalMark: 15.2, monthlyAssessmentMark: 15.3 }, decimalConfig);
  assert.equal(calculation.values.totalMark, 60.6);
  const { initializeModels } = require('../src/config/mysql');
  await initializeModels().ExamSubject.build(decimalConfig).validate();
  const state = database({ config: decimalConfig, marks: [{ studentId: 5, subjectId: 3, ...calculation.values }], summaries: [{ studentId: 5, overallStatus: 'Pass', subjectsMissing: 0, calculatedAt: new Date() }] });
  const publication = load('modules/results/services/resultPublicationService.js', { '../../../config/mysql': state.db });
  assert.equal((await publication.validatePublication(1)).errors.length, 0);
});
