const { Op } = require("sequelize");
const { initializeModels, sequelize } = require("../../config/mysql");
const { STATUSES, SESSIONS, ADMINS, fail, id, dateOnly, day, attendanceDate, contextKey, summarize, differences, attendanceClassAllowed } = require("./attendanceDomain");
const models = () => initializeModels();
const plain = row => row?.get ? row.get({ plain: true }) : row;
const isAdmin = user => ADMINS.includes(user.role);
function requireAdmin(user) { if (!isAdmin(user)) fail("Administrator access required", 403); }
function requireKind(kind) { if (!["daily", "lesson"].includes(kind)) fail("Invalid attendance kind"); }
async function scopes(user, kind, filters = {}, includeHistory = false) {
  requireKind(kind);
  const M = models();
  const where = { isActive: true };
  for (const key of ["academicYearId", "termId", "classId"]) if (filters[key]) where[key] = id(filters[key]);
  if (kind === "lesson") {
    if (includeHistory && (isAdmin(user) || user.role === "HeadDepartment")) delete where.isActive;
    if (!isAdmin(user) && user.role !== "HeadDepartment") {
      if (!["Teacher", "AttendanceTaker"].includes(user.role) || !user.teacherId) return [];
      where.teacherId = user.teacherId;
    }
    if (filters.teacherId) {
      const requested = id(filters.teacherId);
      if (where.teacherId && Number(where.teacherId) !== requested) return [];
      where.teacherId = requested;
    }
    if (filters.subjectId) where.subjectId = id(filters.subjectId);
    const rows = (await M.TeacherAssignment.findAll({ where })).map(plain);
    return departmentScope(user, rows, filters);
  }
  let classes = (await M.Class.findAll({ where: Object.fromEntries(Object.entries(where).filter(([k]) => ["isActive", "academicYearId"].includes(k))) })).map(plain);
  if (where.classId) classes = classes.filter(c => c.id === where.classId);
  if (!isAdmin(user) && user.role !== "HeadDepartment") {
    if (user.role !== "AttendanceTaker") return [];
    classes = classes.filter(c => attendanceClassAllowed(user, c));
  }
  // A daily scope always has a concrete term, including administrative entry.
  const terms = await M.Term.findAll({ where: filters.termId ? { id: id(filters.termId) } : filters.academicYearId ? { academicYearId: id(filters.academicYearId) } : {} });
  return departmentScope(user, classes.flatMap(c => terms.filter(t => t.academicYearId === c.academicYearId).map(t => ({ classId: c.id, academicYearId: c.academicYearId, termId: t.id, departmentId: c.departmentId }))), filters);
}
function departmentScope(user, rows, filters) {
  const departments = [user.departmentId, ...(Array.isArray(user.departmentIds) ? user.departmentIds : [])].map(Number);
  return rows.filter(r => (!filters.departmentId || Number(r.departmentId) === id(filters.departmentId)) && (user.role !== "HeadDepartment" || departments.includes(Number(r.departmentId))));
}
async function resolveScope(user, kind, input) {
  if (user.role === "HeadDepartment") fail("Review-only access", 403);
  if (kind === "lesson") {
    const assignment = await models().TeacherAssignment.findByPk(id(input.assignmentId));
    if (!assignment?.isActive) fail("Active teacher assignment not found", 404);
    if (!isAdmin(user) && (!["Teacher", "AttendanceTaker"].includes(user.role) || !user.teacherId || Number(assignment.teacherId) !== Number(user.teacherId))) fail("Subject and class are not assigned to this teacher", 403);
    return plain(assignment);
  }
  const rows = await scopes(user, kind, { classId: id(input.classId), academicYearId: id(input.academicYearId), termId: id(input.termId) });
  if (!rows.length) fail("Class is not assigned to this attendance taker", 403);
  return rows[0];
}
function entryContext(kind, input) {
  requireKind(kind);
  const date = attendanceDate(input.date);
  const session = input.session || "BeforeBreak";
  if (!SESSIONS.includes(session)) fail("Invalid attendance session");
  const lessonId = String(input.lessonId || "legacy").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(lessonId)) fail("Lesson identifier must contain 1–64 letters, digits, hyphens or underscores");
  return { date, session, lessonId };
}
// Read-only section filtering uses current student membership; old records have no section snapshot.
async function sections(user, kind, query) {
  const classId = id(query.classId);
  const allowed = await scopes(user, kind, query, true);
  if (!allowed.some(s => s.classId === classId)) fail("Class is outside your attendance scope", 403);
  return (await models().ClassSection.findAll({ where: { classId, isActive: true }, order: [["name", "ASC"]] })).map(s => ({ id: s.id, name: s.name }));
}
async function sectionSelection(user, kind, query, allowed) {
  if (query.classSectionId == null || query.classSectionId === "") return null;
  const sectionId = id(query.classSectionId), classId = id(query.classId);
  const permitted = allowed || await scopes(user, kind, query, true);
  if (!permitted.some(s => s.classId === classId)) fail("Class is outside your attendance scope", 403);
  const section = await models().ClassSection.findByPk(sectionId);
  if (!section || !section.isActive || section.classId !== classId) fail("Section not found in the selected class", 404);
  const students = await models().Student.findAll({ where: { classId, classSectionId: sectionId } });
  return { id: sectionId, name: section.name, studentIds: students.map(s => s.id) };
}
async function roster(user, kind, input) {
  const scope = await resolveScope(user, kind, input);
  const { date, session, lessonId } = entryContext(kind, input);
  const M = models();
  const term = scope.termId ? await M.Term.findByPk(scope.termId) : null;
  if (term && (date < day(term.startDate) || date > day(term.endDate))) fail("Date is outside the assigned term");
  const section = await sectionSelection(user, kind, { ...input, classId: scope.classId }, [scope]);
  const students = await M.Student.findAll({ where: { classId: scope.classId, academicYearId: scope.academicYearId, isActive: true, ...(section ? { classSectionId: section.id } : {}) }, order: [["fullName", "ASC"]] });
  const table = kind === "daily" ? M.DailyAttendance : M.Attendance;
  const records = await table.findAll({ where: { classId: scope.classId, academicYearId: scope.academicYearId, termId: scope.termId || null, attendanceDate: new Date(`${date}T00:00:00Z`), attendanceSession: session, ...(kind === "lesson" ? { subjectId: scope.subjectId, lessonId } : {}) } });
  return students.map(student => ({ ...plain(student), attendance: records.find(r => r.studentId === student.id) || null }));
}
async function mark(user, kind, input, outerTransaction = null) {
  if (input.offline !== undefined && typeof input.offline !== "boolean") fail("offline must be a boolean");
  const scope = await resolveScope(user, kind, input);
  const { date, session, lessonId } = entryContext(kind, input);
  const records = input.records;
  if (!Array.isArray(records) || !records.length || records.length > 2000) fail("A non-empty records array (maximum 2000) is required");
  const ids = records.map(r => id(r.studentId));
  if (new Set(ids).size !== ids.length) fail("Duplicate students in submission");
  for (const record of records) {
    if (!STATUSES.includes(record.status)) fail("Invalid attendance status");
    if (typeof (record.remarks || "") !== "string" || (record.remarks || "").length > 2000) fail("Remarks must be text up to 2000 characters");
    if (record.status === "Free") {
      if (kind !== "daily" || ![...ADMINS, "AttendanceTaker"].includes(user.role)) fail("Free is available for daily attendance takers and administrators only", 403);
      if (!record.remarks?.trim()) fail("A reason is required in remarks for Free attendance");
    }
    if (record.status === "InternshipVisit") {
      if (kind !== "daily" || ![...ADMINS, "AttendanceTaker"].includes(user.role)) fail("Internship Visit is for daily attendance only", 403);
      if (!record.remarks?.trim()) fail("An internship reason is required in remarks");
    }
  }
  const M = models();
  const section = await sectionSelection(user, kind, { ...input, classId: scope.classId }, [scope]);
  const students = await M.Student.findAll({ where: { id: { [Op.in]: ids }, classId: scope.classId, academicYearId: scope.academicYearId, isActive: true, ...(section ? { classSectionId: section.id } : {}) } });
  if (students.length !== ids.length) fail("Students must be active members of the assigned class and year");
  const term = scope.termId ? await M.Term.findByPk(scope.termId) : null;
  if (term && (date < day(term.startDate) || date > day(term.endDate))) fail("Date is outside the assigned term");
  const saveRecords = async transaction => {
    const table = kind === "daily" ? M.DailyAttendance : M.Attendance;
    const saved = [];
    for (const record of records) {
      const key = contextKey(kind, scope, record.studentId, date, session, lessonId);
      const existing = await table.findOne({ where: { contextKey: key }, transaction, lock: transaction.LOCK.UPDATE });
      if (kind === "lesson" && existing?.teacherAssignmentId && existing.teacherAssignmentId !== scope.id && !isAdmin(user)) fail("This lesson belongs to another teaching assignment", 403);
      const values = { revision: existing ? existing.revision + 1 : 0, contextKey: key, studentId: id(record.studentId), academicYearId: scope.academicYearId, termId: scope.termId || null, classId: scope.classId, departmentId: scope.departmentId, attendanceDate: new Date(`${date}T00:00:00Z`), attendanceSession: session, status: record.status, remarks: record.remarks || "", takenBy: user.id,
        ...(kind === "lesson" ? { subjectId: scope.subjectId, teacherAssignmentId: existing?.teacherAssignmentId || scope.id, lessonId } : {}) };
      if (existing && existing.status === values.status && (existing.remarks || "") === values.remarks) { saved.push(existing); continue; }
      if (existing && input.offline) {
        throw Object.assign(new Error("Offline attendance conflicts with an existing submission. Reload and review before correcting."), {
          status: 409, code: "ATTENDANCE_CONFLICT", reviewRequired: true,
          conflict: { studentId: values.studentId, date, session, ...(kind === "lesson" ? { lessonId } : {}), existing: plain(existing), submitted: { status: values.status, remarks: values.remarks } },
        });
      }
      if (existing && (typeof input.correctionReason !== "string" || !input.correctionReason.trim())) fail("A correction reason is required for changes to recorded attendance", 409);
      if (existing && input.versions?.[record.studentId] !== existing.revision) fail("Attendance changed since it was loaded. Reload before correcting.", 409);
      const before = existing ? plain(existing) : null;
      const row = existing ? await existing.update(values, { transaction }) : await table.create(values, { transaction });
      await M.AttendanceAudit.create({ kind, recordId: row.id, actorId: user.id, reason: existing ? input.correctionReason.trim() : record.status === "Free" ? record.remarks.trim() : "Initial recording", before, after: plain(row) }, { transaction });
      saved.push(row);
    }
    return saved;
  };
  return outerTransaction ? saveRecords(outerTransaction) : sequelize.transaction(saveRecords);
}
async function report(user, kind, query) {
  requireKind(kind);
  id(query.academicYearId);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(query.month || "")) fail("month must be YYYY-MM");
  const M = models();
  const allowed = await scopes(user, kind, query, true);
  const section = await sectionSelection(user, kind, query, allowed);
  if (query.attendanceDate && !dateOnly(query.attendanceDate).startsWith(query.month + "-")) fail("Attendance date must fall in the selected month");
  if (query.attendanceSession && !SESSIONS.includes(query.attendanceSession)) fail("Invalid attendance session");
  const selectionWhere = { ...(query.attendanceDate ? { attendanceDate: new Date(dateOnly(query.attendanceDate) + "T00:00:00Z") } : {}), ...(query.attendanceSession ? { attendanceSession: query.attendanceSession } : {}) };
  const start = new Date(`${query.month}-01T00:00:00Z`), end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1);
  const scopeWhere = allowed.map(s => ({ classId: s.classId, academicYearId: s.academicYearId, termId: s.termId || null, ...(kind === "lesson" ? { subjectId: s.subjectId, ...(query.teacherId || !isAdmin(user) && user.role !== "HeadDepartment" ? { [Op.or]: [{ teacherAssignmentId: s.id }, ...(!isAdmin(user) && user.role !== "HeadDepartment" ? [{ teacherAssignmentId: null, takenBy: user.id }] : [])] } : {}) } : {}) }));
  // Historical lessons remain reportable even after a subject assignment ends.
  // Unknown historical teacher/period information is never invented.
  if (kind === "lesson" && (isAdmin(user) || user.role === "HeadDepartment") && !query.teacherId) {
    const historicalClasses = departmentScope(user, (await M.Class.findAll({ where: { academicYearId: id(query.academicYearId), ...(query.classId ? { id: id(query.classId) } : {}) } })).map(c => ({ ...plain(c), classId: c.id })), query);
    for (const c of historicalClasses) {
      scopeWhere.push({ classId: c.classId, academicYearId: id(query.academicYearId), ...(query.termId ? { termId: id(query.termId) } : {}), ...(query.subjectId ? { subjectId: id(query.subjectId) } : {}) });
      if (!allowed.some(a => a.classId === c.classId)) allowed.push({ classId: c.classId, academicYearId: id(query.academicYearId), departmentId: c.departmentId });
    }
  }
  if (!scopeWhere.length) return { data: [], details: [], review: [], followUp: [], totals: { students: 0, Present: 0, Absent: 0, Late: 0, Permission: 0, Free: 0, InternshipVisit: 0, notTaken: null }, formula: "Present / (Present + Absent + Late + Permission) × 100; Free, Internship Visit and Not taken excluded" };
  const where = { [Op.or]: scopeWhere, attendanceDate: { [Op.gte]: start, [Op.lt]: end }, ...selectionWhere };
  if (section) where.studentId = { [Op.in]: section.studentIds.filter(studentId => !query.studentId || studentId === id(query.studentId)) };
  else if (query.studentId) where.studentId = id(query.studentId);
  const table = kind === "daily" ? M.DailyAttendance : M.Attendance;
  const records = (await table.findAll({ where })).map(plain);
  const classes = [...new Set(allowed.map(s => s.classId))];
  const students = (await M.Student.findAll({ where: { academicYearId: id(query.academicYearId), classId: { [Op.in]: classes }, ...(query.studentId ? { id: id(query.studentId) } : {}), ...(section ? { classSectionId: section.id } : {}) } })).map(plain);
  // Include historical students that have since moved class/year.
  const missing = records.map(r => r.studentId).filter(studentId => !students.some(s => s.id === studentId));
  if (missing.length) students.push(...(await M.Student.findAll({ where: { id: { [Op.in]: missing } } })).map(plain));
  const schedules = (await M.AttendanceSchedule.findAll({ where: { kind, academicYearId: id(query.academicYearId), classId: { [Op.in]: classes }, date: { [Op.gte]: `${query.month}-01`, [Op.lt]: day(end) }, ...(query.termId ? { termId: id(query.termId) } : {}) } })).map(plain);
  const coverage = (await M.AttendanceCoverage.findAll({ where: { kind, academicYearId: id(query.academicYearId), month: query.month, classId: { [Op.in]: classes } } })).map(plain);
  const groups = new Map();
  const groupKey = r => [r.studentId, r.classId, r.termId || 0, kind === "lesson" ? r.subjectId : "daily"].join(":");
  for (const student of students) for (const scope of allowed.filter(s => s.classId === student.classId && (kind === "daily" || s.subjectId))) {
    const base = { studentId: student.id, classId: scope.classId, termId: scope.termId || null, subjectId: kind === "lesson" ? scope.subjectId : null, departmentId: scope.departmentId };
    groups.set(groupKey(base), { ...base, fullName: student.fullName, admissionNo: student.admissionNo, records: [] });
  }
  for (const record of records) {
    const key = groupKey(record);
    if (!groups.has(key)) { const student = students.find(s => s.id === record.studentId); groups.set(key, { studentId: record.studentId, classId: record.classId, termId: record.termId, subjectId: record.subjectId || null, departmentId: record.departmentId, fullName: student?.fullName || "Unknown", admissionNo: student?.admissionNo, records: [] }); }
    groups.get(key).records.push(record);
  }
  const now = new Date();
  const [subjectNames, classNames, termNames] = await Promise.all([M.Subject.findAll(), M.Class.findAll(), M.Term.findAll()]);
  const data = [...groups.values()].map(({ records: rows, ...group }) => {
    const covered = coverage.some(c => c.classId === group.classId && c.termId === group.termId);
    const expected = schedules.filter(s => (!query.attendanceDate || s.date === query.attendanceDate) && (!query.attendanceSession || s.session === query.attendanceSession) && s.classId === group.classId && s.termId === group.termId && s.isSchoolDay && new Date(s.endsAt) <= now && (kind === "daily" || allowed.some(a => a.id === s.teacherAssignmentId && a.subjectId === group.subjectId)));
    const notTaken = !covered ? null : expected.filter(s => !rows.some(r => day(r.attendanceDate) === s.date && r.attendanceSession === s.session && (kind === "daily" || r.lessonId === s.lessonId))).length;
    return { ...group, ...(section ? { classSectionId: section.id, sectionName: section.name } : {}), subjectName: subjectNames.find(s => s.id === group.subjectId)?.name || null, className: classNames.find(c => c.id === group.classId)?.name || null, termName: termNames.find(t => t.id === group.termId)?.name || null, ...summarize(rows, notTaken), coverage: covered ? "available" : "unavailable" };
  });
  // Daily and lesson monitoring remain separate. Restrict counterpart records to visible contexts.
  const counterpart = kind === "lesson" ? M.DailyAttendance : M.Attendance;
  const other = (await counterpart.findAll({ where: { academicYearId: id(query.academicYearId), classId: { [Op.in]: classes }, attendanceDate: { [Op.gte]: start, [Op.lt]: end }, ...(query.termId ? { termId: id(query.termId) } : {}), ...(section ? { studentId: { [Op.in]: section.studentIds.filter(studentId => !query.studentId || studentId === id(query.studentId)) } } : query.studentId ? { studentId: id(query.studentId) } : {}), ...selectionWhere } })).map(plain);
  const daily = kind === "daily" ? records : other;
  const lessons = kind === "lesson" ? records : other;
  const review = differences(daily, lessons).filter(r => allowed.some(s => s.classId === r.classId && (s.termId === undefined || (s.termId || null) === r.termId)));
  const follow = new Map();
  for (const r of review) {
    const key = `${r.studentId}:${r.subjectId}`;
    const group = follow.get(key) || { studentId: r.studentId, subjectId: r.subjectId, missedLessonsWhileDailyPresent: 0 };
    group.missedLessonsWhileDailyPresent++; follow.set(key, group);
  }
  const totals = { students: new Set(data.map(r => r.studentId)).size, Present: 0, Absent: 0, Late: 0, Permission: 0, Free: 0, InternshipVisit: 0, notTaken: data.length && data.every(r => r.notTaken !== null) ? data.reduce((n, r) => n + r.notTaken, 0) : null };
  for (const row of data) for (const status of STATUSES) totals[status] += row[status];
  return { totals, context: { classId: query.classId ? id(query.classId) : null, classSectionId: section?.id || null, sectionName: section?.name || null, attendanceDate: query.attendanceDate || null, attendanceSession: query.attendanceSession || null }, data, details: records, review, followUp: [...follow.values()].filter(r => r.missedLessonsWhileDailyPresent >= 2).map(r => ({ ...r, fullName: students.find(s => s.id === r.studentId)?.fullName || null, subjectName: subjectNames.find(s => s.id === r.subjectId)?.name || null, message: "Repeated missed subject lessons during sessions recorded Present in daily attendance; review required." })), formula: "Present / (Present + Absent + Late + Permission) × 100; Free, Internship Visit and Not taken excluded" };
}
async function absenceReport(user, query) {
  const selectedDate = dateOnly(query.date || query.attendanceDate);
  // Reuse the monthly report's authorization, but retain the whole month's history.
  const monthly = await report(user, "daily", {
    academicYearId: query.academicYearId, termId: query.termId,
    departmentId: query.departmentId, classId: query.classId,
    classSectionId: query.classSectionId, studentId: query.studentId,
    month: selectedDate.slice(0, 7),
  });
  const M = models();
  const departments = await M.Department.findAll();
  const selected = monthly.details.filter(r => day(r.attendanceDate) === selectedDate && r.status === "Absent" && SESSIONS.includes(r.attendanceSession));
  const groups = new Map();
  for (const record of selected) {
    const key = `${record.departmentId}:${record.studentId}`;
    if (groups.has(key)) continue;
    const student = monthly.data.find(r => r.studentId === record.studentId && r.classId === record.classId);
    const records = monthly.details.filter(r => r.studentId === record.studentId && r.departmentId === record.departmentId && day(r.attendanceDate) <= selectedDate);
    const dates = [...new Set(records.filter(r => r.status === "Absent" && SESSIONS.includes(r.attendanceSession)).map(r => day(r.attendanceDate)))].sort();
    const history = dates.map(date => {
      const sessions = [...new Set(records.filter(r => day(r.attendanceDate) === date && r.status === "Absent" && SESSIONS.includes(r.attendanceSession)).map(r => r.attendanceSession))].sort();
      return { date, sessions, absentDays: sessions.length / 2 };
    });
    const sessionStatus = session => {
      const statuses = [...new Set(records.filter(r => day(r.attendanceDate) === selectedDate && r.attendanceSession === session).map(r => r.status))];
      return statuses.length > 1 ? "Review required" : statuses[0] || "Not recorded";
    };
    groups.set(key, {
      studentId: record.studentId, fullName: student?.fullName || "Unknown", admissionNo: student?.admissionNo || "",
      className: student?.className || String(record.classId), departmentId: record.departmentId,
      beforeBreak: sessionStatus("BeforeBreak"), afterBreak: sessionStatus("AfterBreak"),
      selectedDateAbsentDays: history.find(r => r.date === selectedDate).absentDays,
      monthlyAbsentDays: history.reduce((sum, r) => sum + r.absentDays, 0), absentDatesCount: history.length, history,
    });
  }
  const data = [...groups.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
  return {
    selectedDate, historyStart: `${selectedDate.slice(0, 7)}-01`, historyEnd: selectedDate,
    formula: "One absent daily session = 0.5 day; both sessions = 1 day. Missing records are not absences. Lesson attendance is excluded.",
    totals: { students: new Set(data.map(r => r.studentId)).size, fullDay: data.filter(r => r.selectedDateAbsentDays === 1).length, halfDay: data.filter(r => r.selectedDateAbsentDays === 0.5).length },
    departments: [...new Set(data.map(r => r.departmentId))].map(departmentId => ({
      departmentId, departmentName: departments.find(d => d.id === departmentId)?.name || `Department ${departmentId}`,
      students: data.filter(r => r.departmentId === departmentId),
    })),
  };
}
module.exports = { absenceReport, scopes, resolveScope, roster, mark, report, requireAdmin, models, plain, sections, sectionSelection };
