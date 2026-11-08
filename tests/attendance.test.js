const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { Op } = require("sequelize");
const domain = require("../src/modules/attendance/attendanceDomain");

function harness() {
  const state = {};
  const match = (row, where = {}) => Reflect.ownKeys(where).every(k => {
    if (k === Op.or) return where[k].some(w => match(row, w));
    if (k === Op.and) return where[k].every(w => match(row, w));
    const v = where[k], actual = row[k];
    if (v && typeof v === "object" && !(v instanceof Date)) return Reflect.ownKeys(v).every(op => {
      if (op === Op.in) return v[op].includes(actual);
      if (op === Op.gte) return actual >= v[op];
      if (op === Op.lt) return actual < v[op];
      if (op === Op.like) return String(actual).startsWith(String(v[op]).replace(/%$/, ""));
      throw new Error(`Unexpected operator ${String(op)}`);
    });
    return actual instanceof Date || v instanceof Date ? new Date(actual).getTime() === new Date(v).getTime() : actual === v;
  });
  const M = {};
  let clock = 0;
  function wrap(table, data) {
    Object.defineProperty(data, "get", { configurable: true, value: () => ({ ...data }) });
    Object.defineProperty(data, "update", { configurable: true, value: async values => { Object.assign(data, values, { updatedAt: new Date(1700000000000 + ++clock) }); return data; } });
    return data;
  }
  for (const name of ["Department", "Class", "ClassSection", "Term", "User", "Student", "Teacher", "Subject", "TeacherAssignment", "AttendanceClassAssignment", "Attendance", "DailyAttendance", "AttendanceAudit", "AttendanceSchedule", "AttendanceCoverage"]) {
    state[name] = [];
    M[name] = {
      async findAll({ where = {} } = {}) { return state[name].filter(r => match(r, where)); },
      async findByPk(id) { return state[name].find(r => r.id === id) || null; },
      async findOne({ where }) { return state[name].find(r => match(r, where)) || null; },
      async create(values) {
        if (values.contextKey && state[name].some(r => r.contextKey === values.contextKey)) throw Object.assign(new Error("Duplicate"), { name: "SequelizeUniqueConstraintError" });
        const row = wrap(name, { id: state[name].length + 1, updatedAt: new Date(1700000000000 + ++clock), ...values }); state[name].push(row); return row;
      },
      async bulkCreate(rows) { for (const row of rows) await this.create(row); },
      async destroy({ where }) { state[name] = state[name].filter(r => !match(r, where)); },
      async upsert(values) { const row = state[name].find(r => r.contextKey === values.contextKey); return row ? row.update(values) : this.create(values); },
      async findOrCreate({ where, defaults }) { const row = await this.findOne({ where }); return [row || await this.create({ ...where, ...defaults }), !row]; },
    };
  }
  const sequelize = { transaction: async fn => {
    const snapshot = structuredClone(state);
    try { return await fn({ LOCK: { UPDATE: "UPDATE" } }); }
    catch (e) { for (const name of Object.keys(state)) state[name] = snapshot[name].map(r => wrap(name, r)); throw e; }
  } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/modules/attendance/attendanceService.js"), "utf8"), {
    module, require: name => name === "sequelize" ? { Op } : name === "../../config/mysql" ? { sequelize, initializeModels: () => M } : name === "./attendanceDomain" ? domain : require(name), Date, Intl, Map, Set,
  });
  return { service: module.exports, M, state, sequelize };
}
const admin = { id: 1, role: "SuperAdmin" }, teacher = { id: 2, role: "Teacher", teacherId: 20 }, taker = { id: 3, role: "AttendanceTaker", departmentIds: [5] };
async function setup() {
  const h = harness();
  await h.M.Class.create({ id: 10, academicYearId: 2025, departmentId: 5, isActive: true });
  await h.M.Class.create({ id: 11, academicYearId: 2025, departmentId: 6, isActive: true });
  await h.M.Term.create({ id: 1, academicYearId: 2025, startDate: new Date("2025-01-01"), endDate: new Date("2025-12-31") });
  await h.M.Student.create({ id: 100, fullName: "Abdisamad", admissionNo: "F1-001", classId: 10, academicYearId: 2025, isActive: true });
  for (let subjectId = 1; subjectId <= 3; subjectId++) await h.M.TeacherAssignment.create({ id: subjectId, teacherId: subjectId === 1 ? 20 : 21, classId: 10, academicYearId: 2025, termId: 1, departmentId: 5, subjectId, isActive: true });
  await h.M.AttendanceClassAssignment.create({ userId: 3, classId: 10, academicYearId: 2025, termId: 1, isActive: true });
  return h;
}
const dailyInput = { classId: 10, academicYearId: 2025, termId: 1, date: "2025-01-02", session: "BeforeBreak", records: [{ studentId: 100, status: "Present" }] };

test("past-date roster returns existing marks and revisions; reads and writes reject out-of-term dates", async () => {
  const { service } = await setup();
  await service.mark(taker, "daily", dailyInput);
  const roster = await service.roster({ ...taker, id: 4 }, "daily", dailyInput);
  assert.equal(roster[0].attendance.status, "Present");
  assert.equal(roster[0].attendance.revision, 0);
  for (const date of ["2024-12-31", "2099-01-01", "2025-02-30"]) {
    await assert.rejects(service.roster(taker, "daily", { ...dailyInput, date }), { status: 400 });
    await assert.rejects(service.mark(taker, "daily", { ...dailyInput, date }), { status: 400 });
  }
});

test("offline sync is idempotent and conflicts roll back the entire batch for review", async () => {
  const { service, state, M } = await setup();
  await M.Student.create({ id: 101, classId: 10, academicYearId: 2025, isActive: true });
  const input = { ...dailyInput, offline: true };
  await service.mark(taker, "daily", input);
  await service.mark(taker, "daily", input);
  assert.equal(state.AttendanceAudit.length, 1);
  const conflicting = { ...input, correctionReason: "Cannot bypass offline review", versions: { 100: 0 }, records: [
    { studentId: 101, status: "Present" }, { studentId: 100, status: "Absent" },
  ] };
  await assert.rejects(service.mark({ ...taker, id: 4 }, "daily", conflicting), error => {
    assert.equal(error.status, 409);
    assert.equal(error.code, "ATTENDANCE_CONFLICT");
    assert.equal(error.reviewRequired, true);
    assert.equal(error.conflict.existing.status, "Present");
    assert.equal(error.conflict.submitted.status, "Absent");
    assert.equal(error.conflict.date, dailyInput.date);
    return true;
  });
  assert.equal(state.DailyAttendance.length, 1);
  assert.equal(state.DailyAttendance[0].status, "Present");
  assert.equal(state.AttendanceAudit.length, 1);
  await assert.rejects(service.mark(taker, "daily", { ...input, offline: "true" }), { status: 400 });
  await service.mark(taker, "daily", { ...dailyInput, records: [{ studentId: 100, status: "Absent" }], correctionReason: "Reviewed conflict", versions: { 100: 0 } });
  assert.equal(state.DailyAttendance[0].status, "Absent");
});

test("mobile selected-date reads include other takers' submissions and revision metadata", async () => {
  const module = { exports: {} };
  const date = "2025-01-02";
  const classItem = { _id: 10, name: "Class 1", academicYearId: { _id: 2025 }, departmentId: { _id: 5, name: "Nursing" } };
  const student = { _id: 100, fullName: "Student", classSectionId: null };
  const attendance = { _id: 1, studentId: 100, takenBy: 99, attendanceSession: "BeforeBreak", status: "Absent", revision: 2, termId: 1, attendanceDate: new Date(`${date}T00:00:00Z`) };
  const attendanceFilters = [];
  const query = result => ({ populate() { return this; }, sort: async () => result, then: resolve => Promise.resolve(result).then(resolve) });
  const attendanceModel = {
    find: async filters => { attendanceFilters.push(filters); return [attendance]; },
    aggregate: async pipeline => { attendanceFilters.push(pipeline[0].$match); return [{ _id: { classId: 10, attendanceSession: "BeforeBreak" }, count: 1 }]; },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/modules/mobile/controllers/mobileAttendanceController.js"), "utf8"), {
    module, exports: module.exports,
    require: name => name === "../../attendance/attendanceDomain" ? domain
      : name === "../../../config/mysql" ? { model: () => attendanceModel }
      : name.includes("classSections") ? { find: () => query([]) }
      : name.includes("classes/models") ? { find: () => query([classItem]), findOne: () => query(classItem) }
      : name.includes("students/models") ? { find: () => query([student]), aggregate: async () => [{ _id: 10, count: 1 }] } : {},
  });
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  const req = { user: taker, params: { classId: "10" }, query: { date } };
  await module.exports.getAssignedClassStudents(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.attendanceDate, date);
  assert.equal(res.body.students[0].attendanceToday.beforeBreak.status, "Absent");
  assert.equal(res.body.students[0].attendanceToday.beforeBreak.revision, 2);
  await module.exports.getAssignedAttendanceClasses(req, res);
  assert.equal(res.body.attendanceDate, date);
  assert.equal(res.body.classes[0].attendanceToday.beforeBreak.done, true);
  for (const filters of attendanceFilters) {
    assert.equal(filters.takenBy, undefined);
    assert.equal(filters.attendanceDate.$gte.toISOString(), `${date}T00:00:00.000Z`);
    assert.equal(filters.attendanceDate.$lt.toISOString(), "2025-01-03T00:00:00.000Z");
  }
  for (const handler of [module.exports.getAssignedClassStudents, module.exports.getAssignedAttendanceClasses]) {
    for (const invalidDate of ["2099-01-01", "2025-02-30", ""]) {
      await handler({ ...req, query: { date: invalidDate } }, res);
      assert.equal(res.statusCode, 400);
    }
  }
});

test("mark HTTP responses flag offline and concurrent duplicate conflicts for review", async () => {
  const { service, sequelize } = await setup();
  await service.mark(taker, "daily", dailyInput);
  const express = require("express");
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/modules/attendance/attendanceRoutesV2.js"), "utf8"), {
    module, require: name => name === "express" ? express : name === "sequelize" ? { Op }
      : name === "../../config/mysql" ? { sequelize } : name === "./attendanceService" ? service : domain,
  });
  const app = express();
  app.use(express.json(), (req, res, next) => { req.user = taker; next(); }, module.exports);
  const server = await new Promise(resolve => { const server = app.listen(0, "127.0.0.1", () => resolve(server)); });
  try {
    const url = `http://127.0.0.1:${server.address().port}/daily/mark`;
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...dailyInput, offline: true, records: [{ studentId: 100, status: "Absent" }] }) });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.code, "ATTENDANCE_CONFLICT");
    assert.equal(body.reviewRequired, true);
    assert.equal(body.conflict.existing.status, "Present");
    service.mark = async () => { throw Object.assign(new Error("Duplicate"), { name: "SequelizeUniqueConstraintError" }); };
    const duplicate = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(dailyInput) });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).reviewRequired, true);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("daily access follows multiple departments and shift, without class assignments", async () => {
  const { service, state, M } = await setup();
  state.AttendanceClassAssignment = [];
  await M.Class.create({ id: 12, academicYearId: 2025, departmentId: 5, shift: "Afternoon", isActive: true });
  state.Class[0].shift = "Morning";
  state.Class[1].shift = "Morning";
  const user = { ...taker, departmentIds: [5, 6] };
  assert.deepEqual(Array.from(await service.scopes(user, "daily"), s => s.classId), [10, 11, 12]);
  assert.deepEqual(Array.from(await service.scopes(user, "daily", { departmentId: 6 }), s => s.classId), [11]);
  assert.deepEqual(Array.from(await service.scopes({ ...user, attendanceShift: "Morning" }, "daily"), s => s.classId), [10, 11]);
  await service.mark(taker, "daily", dailyInput);
  await assert.rejects(service.roster(taker, "daily", { ...dailyInput, classId: 11 }), { status: 403 });
  await assert.rejects(service.mark({ ...taker, departmentIds: [] }, "daily", dailyInput), { status: 403 });
  await assert.rejects(service.mark({ ...taker, attendanceShift: "Afternoon" }, "daily", dailyInput), { status: 403 });
  const removed = { ...taker, departmentIds: [6] };
  await assert.rejects(service.mark(removed, "daily", { ...dailyInput, correctionReason: "Review", versions: { 100: 0 }, records: [{ studentId: 100, status: "Absent" }] }), { status: 403 });
  assert.equal((await service.report(removed, "daily", { academicYearId: 2025, month: "2025-01" })).details.length, 0);
});

test("department normalization supports stored JSON, legacy department and populated IDs", () => {
  assert.deepEqual(domain.departmentIds({ departmentId: 5, departmentIds: '[5,6]' }), [5, 6]);
  assert.deepEqual(domain.departmentIds({ departmentIds: [{ id: 6 }, { _id: '7' }, null, 'invalid'] }), [6, 7]);
});

test("directory endpoints restrict departments, filtered classes and direct student access", async () => {
  const { M } = await setup();
  for (const id of [5, 6, 7]) await M.Department.create({ id });
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/middleware/attendanceResourceScope.js"), "utf8"), {
    module, require: name => name === "sequelize" ? { Op } : name === "../config/mysql" ? { initializeModels: () => M } : domain,
  });
  async function request(path, query = {}, user = { ...taker, departmentIds: [5, 6] }) {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await module.exports({ path, query, user, method: "GET" }, res, () => { throw new Error("Unexpected unrestricted access"); });
    return res;
  }
  assert.deepEqual(Array.from((await request("/departments")).body, d => d.id), [5, 6]);
  assert.equal((await request("/departments/7")).statusCode, 403);
  assert.deepEqual(Array.from((await request("/classes", { departmentId: "6" })).body, c => c.id), [11]);
  assert.equal((await request("/classes/11", {}, taker)).statusCode, 403);
  assert.equal((await request("/students/100", { departmentId: "6" })).statusCode, 403);
  assert.equal((await request("/students/class/10", {}, { ...taker, departmentIds: [] })).statusCode, 403);
});

test("mobile department list and class filter reject unassigned department IDs", async () => {
  const module = { exports: {} };
  const model = { find: filters => ({ sort: async () => [5, 6, 7].filter(id => filters._id.$in.includes(id)).map(id => ({ id })) }) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/modules/mobile/controllers/mobileAttendanceController.js"), "utf8"), {
    module, exports: module.exports,
    require: name => name === "../../attendance/attendanceDomain" ? domain : name === "../../../config/mysql" ? { model: () => model } : {},
  });
  const user = { ...taker, departmentIds: [5, 6] };
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await module.exports.getAssignedAttendanceDepartments({ user }, res);
  assert.deepEqual(Array.from(res.body.departments, d => d.id), [5, 6]);
  await module.exports.getAssignedAttendanceClasses({ user, query: { departmentId: "7" } }, res);
  assert.equal(res.statusCode, 403);
  await module.exports.getAssignedAttendanceClasses({ user, query: { departmentId: "invalid" } }, res);
  assert.equal(res.statusCode, 400);
});

test("acceptance: 40 daily Present, Mathematics 4/12, Computer 8/8, English 10/10 and eight review differences", async () => {
  const { service, state } = await setup();
  const days = Array.from({ length: 31 }, (_, i) => `2025-01-${String(i + 1).padStart(2, "0")}`).filter(d => ![0, 6].includes(new Date(d).getUTCDay())).slice(0, 20);
  for (const date of days) for (const session of domain.SESSIONS) await service.mark(taker, "daily", { ...dailyInput, date, session });
  for (const [assignmentId, count] of [[1, 12], [2, 8], [3, 10]]) for (let i = 0; i < count; i++) await service.mark(admin, "lesson", { assignmentId, date: days[i], session: "BeforeBreak", lessonId: "P1", records: [{ studentId: 100, status: assignmentId === 1 && i >= 4 ? "Absent" : "Present" }] });
  const query = { academicYearId: 2025, termId: 1, month: "2025-01" };
  const daily = await service.report(admin, "daily", query), lesson = await service.report(admin, "lesson", query);
  assert.equal(daily.data[0].Present, 40); assert.equal(daily.data[0].Absent, 0); assert.equal(daily.data[0].percentage, 100); assert.equal(daily.data[0].uniqueAbsentDates.length, 0);
  const math = lesson.data.find(r => r.subjectId === 1);
  assert.equal(math.recorded, 12); assert.equal(math.Absent, 8); assert.equal(math.percentage, 33.3);
  for (const subjectId of [2, 3]) assert.equal(lesson.data.find(r => r.subjectId === subjectId).percentage, 100);
  assert.equal(lesson.review.length, 8); assert.equal(lesson.followUp[0].missedLessonsWhileDailyPresent, 8);
  assert.equal(state.DailyAttendance.length, 40); assert.equal(state.Attendance.length, 30);
  assert.equal(daily.data[0].notTaken, null);
});

test("backend scopes: taker without teacher profile, unassigned classes, teachers, administrator and department reviewer", async () => {
  const { service } = await setup();
  await service.mark(taker, "daily", dailyInput);
  await assert.rejects(service.mark(taker, "daily", { ...dailyInput, classId: 11 }), { status: 403 });
  await assert.rejects(service.mark(teacher, "daily", dailyInput), { status: 403 });
  await assert.rejects(service.mark(taker, "lesson", { assignmentId: 1, ...dailyInput }), { status: 403 });
  await assert.rejects(service.mark(teacher, "lesson", { assignmentId: 2, ...dailyInput }), { status: 403 });
  await service.mark(teacher, "lesson", { assignmentId: 1, ...dailyInput });
  assert.equal((await service.report(teacher, "lesson", { academicYearId: 2025, month: "2025-01" })).data.length, 1);
  assert.equal((await service.report(teacher, "lesson", { academicYearId: 2025, month: "2025-01", teacherId: 21 })).data.length, 0);
  assert.equal((await service.report(taker, "daily", { academicYearId: 2025, classId: 11, month: "2025-01" })).data.length, 0);
  assert.equal((await service.report({ id: 5, role: "HeadDepartment", departmentIds: [6] }, "daily", { academicYearId: 2025, month: "2025-01" })).details.length, 0);
  await assert.rejects(service.mark({ id: 5, role: "HeadDepartment" }, "daily", dailyInput), { status: 403 });
  assert.throws(() => service.requireAdmin(taker), { status: 403 });
  assert.throws(() => service.requireAdmin(teacher), { status: 403 });
});

test("correction requires reason and current version; preserves before/after audit and daily/lesson isolation", async () => {
  const { service, state } = await setup();
  const [row] = await service.mark(taker, "daily", dailyInput);
  await service.mark(taker, "daily", dailyInput); // idempotent retry
  assert.equal(state.DailyAttendance.length, 1); assert.equal(state.AttendanceAudit.length, 1);
  const correction = { ...dailyInput, records: [{ studentId: 100, status: "Absent", remarks: "Corrected" }] };
  await assert.rejects(service.mark(taker, "daily", correction), { status: 409 });
  await assert.rejects(service.mark(taker, "daily", { ...correction, correctionReason: "Register review", versions: { 100: -1 } }), { status: 409 });
  const [updated] = await service.mark(taker, "daily", { ...correction, correctionReason: "Register review", versions: { 100: row.revision } });
  assert.equal(updated.status, "Absent"); assert.equal(state.AttendanceAudit.length, 2);
  await assert.rejects(service.mark(taker, "daily", { ...dailyInput, correctionReason: "Stale correction", versions: { 100: row.revision } }), { status: 409 });
  assert.equal(state.AttendanceAudit[1].before.status, "Present"); assert.equal(state.AttendanceAudit[1].after.status, "Absent"); assert.equal(state.AttendanceAudit[1].actorId, 3);
  await service.mark(teacher, "lesson", { ...dailyInput, assignmentId: 1, lessonId: "P1" });
  await service.mark(teacher, "lesson", { ...dailyInput, assignmentId: 1, lessonId: "P2" });
  assert.equal(state.Attendance.length, 2); assert.equal(state.DailyAttendance[0].status, "Absent");
});

test("duplicate students, invalid status/date/session, future date and cross-class students are rejected atomically", async () => {
  const { service, state } = await setup();
  for (const change of [
    { records: [dailyInput.records[0], dailyInput.records[0]] }, { records: [{ studentId: 100, status: "Unknown" }] },
    { date: "2025-02-30" }, { date: "2025-99-01" }, { date: "2099-01-01" }, { session: "Other" },
    { records: [{ studentId: 999, status: "Present" }] }, { records: [{ studentId: 100, status: "Present", remarks: {} }] },
  ]) await assert.rejects(service.mark(taker, "daily", { ...dailyInput, ...change }), { status: 400 });
  assert.equal(state.DailyAttendance.length, 0); assert.equal(state.AttendanceAudit.length, 0);
});

test("unique absent dates count once and missing daily records never confirm a difference", async () => {
  const { service } = await setup();
  for (const session of domain.SESSIONS) await service.mark(taker, "daily", { ...dailyInput, session, records: [{ studentId: 100, status: "Absent" }] });
  await service.mark(teacher, "lesson", { ...dailyInput, date: "2025-01-03", assignmentId: 1, records: [{ studentId: 100, status: "Absent" }] });
  const report = await service.report(admin, "daily", { academicYearId: 2025, month: "2025-01" });
  assert.equal(report.data[0].Absent, 2); assert.equal(report.data[0].uniqueAbsentDates.length, 1); assert.equal(report.review.length, 0);
});

test("expected coverage uses only elapsed school sessions and matches distinct timetable lesson periods", async () => {
  const { service, M } = await setup();
  await service.mark(taker, "daily", dailyInput);
  await M.AttendanceCoverage.create({ kind: "daily", academicYearId: 2025, termId: 1, classId: 10, month: "2025-01" });
  for (const entry of [
    { date: "2025-01-02", session: "BeforeBreak", isSchoolDay: true, endsAt: new Date("2025-01-02T09:00Z") },
    { date: "2025-01-02", session: "AfterBreak", isSchoolDay: true, endsAt: new Date("2025-01-02T13:00Z") },
    { date: "2025-01-04", session: "BeforeBreak", isSchoolDay: false, endsAt: new Date("2025-01-04T09:00Z") },
    { date: "2025-01-03", session: "BeforeBreak", isSchoolDay: true, endsAt: new Date("2099-01-03T09:00Z") },
  ]) await M.AttendanceSchedule.create({ kind: "daily", academicYearId: 2025, termId: 1, classId: 10, ...entry });
  const daily = await service.report(admin, "daily", { academicYearId: 2025, month: "2025-01" });
  assert.equal(daily.data[0].notTaken, 1); assert.equal(daily.data[0].percentage, 100);
  await M.AttendanceCoverage.create({ kind: "lesson", academicYearId: 2025, termId: 1, classId: 10, month: "2025-01" });
  for (const lessonId of ["P1", "P2"]) await M.AttendanceSchedule.create({ kind: "lesson", academicYearId: 2025, termId: 1, classId: 10, teacherAssignmentId: 1, lessonId, date: "2025-01-02", session: "BeforeBreak", isSchoolDay: true, endsAt: new Date("2025-01-02T09:00Z") });
  await service.mark(teacher, "lesson", { ...dailyInput, assignmentId: 1, lessonId: "P1" });
  const lesson = await service.report(teacher, "lesson", { academicYearId: 2025, month: "2025-01" });
  assert.equal(lesson.data[0].notTaken, 1); assert.equal(lesson.data[0].recorded, 1);
});

test("percentage denominator includes Late and Permission, excluding Not taken", () => {
  const summary = domain.summarize(domain.STATUSES.map(status => ({ status, attendanceDate: "2025-01-02" })), 100);
  assert.equal(summary.percentage, 25); assert.equal(summary.notTaken, 100);
  assert.equal(domain.summarize([]).percentage, null);
});

test("Free release requires a reason and daily access; retries and audited corrections remain safe", async () => {
  const { service, state } = await setup();
  const input = { ...dailyInput, records: [{ studentId: 100, status: "Free", remarks: "Released after exam" }] };
  await assert.rejects(service.mark(taker, "daily", { ...input, records: [{ studentId: 100, status: "Free", remarks: "  " }] }), { status: 400 });
  await assert.rejects(service.mark(teacher, "lesson", { ...input, assignmentId: 1 }), { status: 403 });
  await assert.rejects(service.mark({ ...taker, departmentIds: [6] }, "daily", input), { status: 403 });
  await service.mark(taker, "daily", input);
  await service.mark(taker, "daily", input);
  assert.equal(state.DailyAttendance.length, 1);
  assert.equal(state.AttendanceAudit.length, 1);
  assert.equal(state.AttendanceAudit[0].reason, "Released after exam");
  const report = await service.report(taker, "daily", { academicYearId: 2025, month: "2025-01" });
  assert.equal(report.totals.Free, 1);
  assert.equal(report.data[0].recorded, 1);
  assert.equal(report.data[0].eligible, 0);
  assert.equal(report.data[0].percentage, null);
  await assert.rejects(service.mark(taker, "daily", dailyInput), { status: 409 });
  await service.mark(taker, "daily", { ...dailyInput, correctionReason: "Student stayed", versions: { 100: 0 } });
  assert.equal(state.AttendanceAudit[1].before.status, "Free");
  const mixed = domain.summarize([{ status: "Present" }, { status: "Free" }, { status: "Absent" }].map(r => ({ ...r, attendanceDate: "2025-01-02" })));
  assert.equal(mixed.percentage, 50);
  assert.equal(mixed.Free, 1);
});

test("section Free batches cannot contain students from a different section and are atomic", async () => {
  const { service, state } = await sectionSetup();
  const date = "2025-01-03", beforeCount = state.DailyAttendance.length;
  await assert.rejects(service.mark(taker, "daily", { ...dailyInput, date, classSectionId: 1, records: [{ studentId: 100, status: "Free", remarks: "Exam finished" }, { studentId: 101, status: "Free", remarks: "Exam finished" }] }), { status: 400 });
  assert.equal(state.DailyAttendance.length, beforeCount);
  await service.mark({ id: 4, role: "StudentAffairs" }, "daily", { ...dailyInput, date, classSectionId: 1, records: [{ studentId: 100, status: "Free", remarks: "Exam finished" }] });
  assert.equal(state.DailyAttendance.at(-1).status, "Free");
});

async function sectionSetup() {
  const h = await setup();
  await h.M.ClassSection.create({ id: 1, classId: 10, name: "Section A", isActive: true });
  await h.M.ClassSection.create({ id: 2, classId: 10, name: "Section B", isActive: true });
  await h.M.ClassSection.create({ id: 3, classId: 11, name: "Other class", isActive: true });
  await h.M.ClassSection.create({ id: 4, classId: 10, name: "Inactive", isActive: false });
  h.state.Student[0].classSectionId = 1;
  await h.M.Student.create({ id: 101, fullName: "Section B student", classId: 10, academicYearId: 2025, classSectionId: 2, isActive: true });
  await h.M.Student.create({ id: 102, fullName: "Unassigned student", classId: 10, academicYearId: 2025, classSectionId: null, isActive: true });
  await h.service.mark(admin, "daily", { ...dailyInput, records: [{ studentId: 100, status: "Present" }, { studentId: 101, status: "Absent" }, { studentId: 102, status: "Late" }] });
  await h.service.mark(admin, "daily", { ...dailyInput, session: "AfterBreak", records: [{ studentId: 100, status: "Absent" }, { studentId: 101, status: "Present" }, { studentId: 102, status: "Permission" }] });
  await h.service.mark(admin, "lesson", { assignmentId: 1, date: dailyInput.date, session: "BeforeBreak", lessonId: "P1", records: [{ studentId: 100, status: "Absent" }, { studentId: 101, status: "Absent" }, { studentId: 102, status: "Present" }] });
  return h;
}
const sectionQuery = { academicYearId: 2025, classId: 10, classSectionId: 1, month: "2025-01", termId: 1 };
test("admin section reads enforce permitted class, section membership and active section status", async () => {
  const { service } = await sectionSetup();
  assert.deepEqual(Array.from(await service.sections(admin, "daily", sectionQuery), s => s.id), [1, 2]);
  await assert.rejects(service.sectionSelection(admin, "daily", { ...sectionQuery, classSectionId: 3 }), { status: 404 });
  await assert.rejects(service.sectionSelection(admin, "daily", { ...sectionQuery, classSectionId: 4 }), { status: 404 });
  await assert.rejects(service.sectionSelection(admin, "daily", { ...sectionQuery, classSectionId: "bad" }), { status: 400 });
  await assert.rejects(service.sectionSelection(taker, "daily", { ...sectionQuery, classId: 11, classSectionId: 3 }), { status: 403 });
  await assert.rejects(service.sectionSelection(admin, "daily", { ...sectionQuery, classId: undefined }), { status: 400 });
});
test("admin monthly summary, details, totals and differences include only selected section students", async () => {
  const { service } = await sectionSetup();
  const result = await service.report(admin, "daily", sectionQuery);
  assert.deepEqual(Array.from(result.data, s => s.studentId), [100]);
  assert.deepEqual(Array.from(result.details, s => s.studentId), [100, 100]);
  assert.deepEqual(Array.from(result.review, s => s.studentId), [100]);
  assert.equal(result.totals.students, 1);
  assert.equal(result.totals.Present, 1);
  assert.equal(result.totals.Absent, 1);
  assert.equal(result.totals.Late, 0);
  assert.equal(result.totals.notTaken, null);
  assert.equal(result.data[0].sectionName, "Section A");
  const lessons = await service.report(admin, "lesson", sectionQuery);
  assert.deepEqual(Array.from(lessons.details, s => s.studentId), [100]);
});
test("All Sections includes both sections and students without a section", async () => {
  const { service } = await sectionSetup();
  const result = await service.report(admin, "daily", { ...sectionQuery, classSectionId: undefined });
  assert.deepEqual(Array.from(result.data, s => s.studentId).sort(), [100, 101, 102]);
  assert.equal(result.totals.students, 3);
  assert.equal(result.details.length, 6);
  const roster = await service.roster(admin, "daily", { ...dailyInput, classSectionId: 1 });
  assert.deepEqual(Array.from(roster, s => s.id), [100]);
});
test("date and session filters constrain expected counts and never manufacture missing absences", async () => {
  const { service, M } = await sectionSetup();
  await M.AttendanceCoverage.create({ kind: "daily", academicYearId: 2025, classId: 10, termId: 1, month: "2025-01" });
  for (const session of ["BeforeBreak", "AfterBreak"]) await M.AttendanceSchedule.create({ kind: "daily", academicYearId: 2025, classId: 10, termId: 1, date: "2025-01-02", session, isSchoolDay: true, endsAt: new Date("2025-01-02T15:00:00Z") });
  const result = await service.report(admin, "daily", { ...sectionQuery, attendanceDate: "2025-01-02", attendanceSession: "BeforeBreak" });
  assert.equal(result.details.length, 1);
  assert.equal(result.totals.Present, 1);
  assert.equal(result.totals.Absent, 0);
  assert.equal(result.totals.notTaken, 0);
  const missing = await service.report(admin, "daily", { ...sectionQuery, attendanceDate: "2025-01-03", attendanceSession: "BeforeBreak" });
  assert.equal(missing.details.length, 0);
  assert.equal(missing.totals.Absent, 0);
  await assert.rejects(service.report(admin, "daily", { ...sectionQuery, attendanceDate: "2025-02-01" }), { status: 400 });
  await assert.rejects(service.report(admin, "daily", { ...sectionQuery, attendanceSession: "Invalid" }), { status: 400 });
});

test("department absence report counts half days, retains history, excludes later dates and never changes records", async () => {
  const { service, M, state } = await setup();
  await M.Department.create({ id: 5, name: "Computing" });
  for (const [date, session, status] of [
    ["2025-01-02", "BeforeBreak", "Absent"],
    ["2025-01-03", "AfterBreak", "Absent"],
    ["2025-01-06", "BeforeBreak", "Absent"],
    ["2025-01-06", "AfterBreak", "Absent"],
    ["2025-01-07", "BeforeBreak", "Absent"],
    ["2025-01-07", "AfterBreak", "Present"],
    ["2025-01-08", "BeforeBreak", "Absent"],
  ]) await service.mark(taker, "daily", { ...dailyInput, date, session, records: [{ studentId: 100, status }] });
  await M.Student.create({ id: 101, fullName: "Present student", classId: 10, academicYearId: 2025 });
  await M.Student.create({ id: 102, fullName: "Other department", classId: 11, academicYearId: 2025 });
  await M.DailyAttendance.create({ studentId: 102, classId: 11, departmentId: 6, termId: 1, academicYearId: 2025, attendanceDate: new Date("2025-01-07"), attendanceSession: "BeforeBreak", status: "Absent" });
  const before = JSON.stringify(state);
  const result = await service.absenceReport(admin, { academicYearId: 2025, departmentId: 5, date: "2025-01-07" });
  assert.equal(result.departments.length, 1);
  assert.equal(result.departments[0].departmentName, "Computing");
  const student = result.departments[0].students[0];
  assert.equal(result.totals.students, 1);
  assert.equal(student.beforeBreak, "Absent");
  assert.equal(student.afterBreak, "Present");
  assert.equal(student.selectedDateAbsentDays, 0.5);
  assert.equal(student.monthlyAbsentDays, 2.5);
  assert.equal(student.absentDatesCount, 4);
  assert.equal(student.history.length, 4);
  const partial = await service.absenceReport(admin, { academicYearId: 2025, date: "2025-01-02" });
  assert.equal(partial.departments[0].students[0].afterBreak, "Not recorded");
  const restricted = await service.absenceReport({ id: 8, role: "HeadDepartment", departmentId: 5 }, { academicYearId: 2025, date: "2025-01-07", departmentId: 6 });
  assert.equal(restricted.departments.length, 0);
  const empty = await service.absenceReport(admin, { academicYearId: 2025, date: "2025-01-01" });
  assert.equal(empty.totals.students, 0);
  assert.equal(JSON.stringify(state), before);
  await assert.rejects(service.absenceReport(admin, { academicYearId: 2025, date: "2025-02-30" }), { status: 400 });
});

