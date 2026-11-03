const { initializeModels, sequelize } = require("../../config/mysql");
const { id, fail, SESSIONS, day, contextKey } = require("./attendanceDomain");
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const nextDay = value => { const d = new Date(`${value}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return day(d); };
const json = value => typeof value === "string" ? JSON.parse(value) : value;
function requireManager(user) {
  if (!["SuperAdmin", "StudentAffairs"].includes(user.role)) fail("Only SuperAdmin and Student Affairs can configure internship weekdays", 403);
}
function configuration(input = {}) {
  const weekdays = input.weekdays, sessions = input.sessions;
  if (!Array.isArray(weekdays) || !weekdays.length || weekdays.some(v => !Number.isInteger(v) || v < 0 || v > 6)) fail("Select weekdays as numbers: Sunday=0 through Saturday=6");
  if (!Array.isArray(sessions) || !sessions.length || sessions.some(v => !SESSIONS.includes(v))) fail("Select BeforeBreak, AfterBreak or both");
  if (typeof input.remarks !== "string" || !input.remarks.trim() || input.remarks.length > 1000) fail("An internship location or reason (maximum 1000 characters) is required");
  return { classId: id(input.classId), academicYearId: id(input.academicYearId), classSectionId: input.classSectionId ? id(input.classSectionId) : null, weekdays: [...new Set(weekdays)].sort(), sessions: [...new Set(sessions)], remarks: input.remarks.trim() };
}
async function list(user, query = {}) {
  requireManager(user);
  const M = initializeModels();
  const [rules, classes, sections] = await Promise.all([
    M.InternshipRule.findAll({ where: query.academicYearId ? { academicYearId: id(query.academicYearId) } : {}, order: [["id", "DESC"]] }),
    M.Class.findAll({ attributes: ["id", "name"] }),
    M.ClassSection.findAll({ attributes: ["id", "name"] }),
  ]);
  return rules.map(rule => ({ ...rule.get({ plain: true }), className: classes.find(c => c.id === rule.classId)?.name || null, sectionName: sections.find(s => s.id === rule.classSectionId)?.name || null }));
}
async function create(user, input) {
  requireManager(user);
  const values = configuration(input), M = initializeModels();
  const classroom = await M.Class.findByPk(values.classId);
  if (!classroom?.isActive || classroom.academicYearId !== values.academicYearId) fail("Select an active class in the selected academic year");
  if (values.classSectionId) {
    const section = await M.ClassSection.findByPk(values.classSectionId);
    if (!section?.isActive || section.classId !== values.classId) fail("Section does not belong to the selected class");
  }
  return sequelize.transaction(async transaction => {
    const row = await M.InternshipRule.create({ ...values, createdBy: user.id, effectiveFrom: today(), isActive: true }, { transaction });
    await M.AttendanceAudit.create({ kind: "internship-rule", recordId: row.id, actorId: user.id, reason: "Recurring internship rule created", before: null, after: row.get({ plain: true }) }, { transaction });
    return row;
  });
}
async function setActive(user, ruleId, isActive) {
  requireManager(user);
  if (typeof isActive !== "boolean") fail("isActive must be true or false");
  const M = initializeModels();
  return sequelize.transaction(async transaction => {
    const row = await M.InternshipRule.findByPk(id(ruleId), { transaction, lock: transaction.LOCK.UPDATE });
    if (!row) fail("Internship rule not found", 404);
    if (row.isActive === isActive) return row;
    const before = row.get({ plain: true });
    // Resume from today: never backfill a period that was deliberately paused.
    await row.update({ isActive, ...(isActive ? { effectiveFrom: today(), processedThrough: null, createdBy: user.id } : {}) }, { transaction });
    await M.AttendanceAudit.create({ kind: "internship-rule", recordId: row.id, actorId: user.id, reason: isActive ? "Internship rule resumed" : "Internship rule paused", before, after: row.get({ plain: true }) }, { transaction });
    return row;
  });
}
async function processRule(ruleId, currentDate = today()) {
  const M = initializeModels();
  return sequelize.transaction(async transaction => {
    const rule = await M.InternshipRule.findByPk(ruleId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!rule?.isActive) return 0;
    const [year, classroom, owner] = await Promise.all([M.AcademicYear.findByPk(rule.academicYearId, { transaction }), M.Class.findByPk(rule.classId, { transaction }), M.User.findByPk(rule.createdBy, { transaction })]);
    if (!year?.isActive || !classroom?.isActive || classroom.academicYearId !== rule.academicYearId || !owner?.isActive || !["SuperAdmin", "StudentAffairs"].includes(owner.role)) return 0;
    if (rule.classSectionId) {
      const section = await M.ClassSection.findByPk(rule.classSectionId, { transaction });
      if (!section?.isActive || section.classId !== rule.classId) return 0;
    }
    const terms = await M.Term.findAll({ where: { academicYearId: rule.academicYearId }, transaction });
    const students = await M.Student.findAll({ where: { classId: rule.classId, academicYearId: rule.academicYearId, isActive: true, status: "Active", ...(rule.classSectionId ? { classSectionId: rule.classSectionId } : {}) }, transaction });
    let date = rule.processedThrough && rule.processedThrough < currentDate ? nextDay(rule.processedThrough) : rule.processedThrough || rule.effectiveFrom;
    if (date < rule.effectiveFrom) date = rule.effectiveFrom;
    let created = 0;
    // Bound each transaction. Later ticks continue any remaining outage backlog.
    for (let processed = 0; date <= currentDate && processed < 7; processed++, date = nextDay(date)) {
      if (date >= day(year.startDate) && date <= day(year.endDate) && json(rule.weekdays).includes(new Date(`${date}T00:00:00Z`).getUTCDay())) {
        const matches = terms.filter(t => date >= day(t.startDate) && date <= day(t.endDate));
        if (matches.length > 1) throw new Error(`Overlapping terms for internship rule ${rule.id}; resolve academic calendar`);
        const term = matches[0];
        if (term) for (const student of students) {
          // Do not assign newly enrolled students to days before their account existed.
          if (student.createdAt && new Date(student.createdAt) >= new Date(`${nextDay(date)}T00:00:00+03:00`)) continue;
          for (const session of json(rule.sessions)) {
            const attendanceDate = new Date(`${date}T00:00:00Z`);
            const where = { studentId: student.id, academicYearId: rule.academicYearId, attendanceDate, attendanceSession: session };
            if (await M.DailyAttendance.findOne({ where, transaction })) continue;
            const scope = { academicYearId: rule.academicYearId, termId: term.id, classId: rule.classId };
            const key = contextKey("daily", scope, student.id, date, session);
            const [row, inserted] = await M.DailyAttendance.findOrCreate({ where: { contextKey: key }, defaults: { ...where, ...scope, departmentId: classroom.departmentId, status: "InternshipVisit", remarks: `Automatically marked from internship schedule #${rule.id}: ${rule.remarks}`, takenBy: rule.createdBy, revision: 0 }, transaction });
            if (inserted) {
              await M.AttendanceAudit.create({ kind: "daily", recordId: row.id, actorId: rule.createdBy, reason: `Automatic Internship Visit (IV), rule #${rule.id}`, before: null, after: { ...row.get({ plain: true }), internshipRuleId: rule.id } }, { transaction });
              created++;
            }
          }
        }
      }
      await rule.update({ processedThrough: date }, { transaction });
    }
    return created;
  });
}
let running = false;
async function run() {
  if (running) return;
  running = true;
  try {
    const rules = await initializeModels().InternshipRule.findAll({ where: { isActive: true }, attributes: ["id"], order: [["id", "ASC"]] });
    for (const rule of rules) {
      try { await processRule(rule.id); }
      catch (error) { console.error("Internship rule processing failed", { ruleId: rule.id, code: error.original?.code || error.name }); }
    }
  } finally { running = false; }
}
function startWorker() {
  const tick = () => run().catch(error => console.error("Internship worker failed", { code: error.original?.code || error.name }));
  void tick();
  const timer = setInterval(tick, 60000);
  timer.unref();
  return () => clearInterval(timer);
}
module.exports = { requireManager, configuration, list, create, setActive, processRule, run, startWorker };
